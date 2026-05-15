/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type DockerOptions } from 'dockerode';
import path from 'path';
import { getDataPath } from '@process/utils';
import { getDatabase } from '@process/services/database/export';
import { ProjectIngestService } from '@process/services/ProjectIngestService';
import type { IDockerSession } from '@process/services/database/types';

/**
 * Image to run for each chat-session sandbox. Built from
 * Dockerfile.session-runtime and published to GHCR by the runtime-image
 * workflow. Overridable per-deployment via env (compose / k8s manifest).
 */
const SESSION_RUNTIME_IMAGE = process.env.SESSION_RUNTIME_IMAGE ?? 'ghcr.io/4ekuct25/aionui-cowork-runtime:dev';

/** Lightweight image used as a temp helper to unzip archives into volumes. */
const HELPER_IMAGE = process.env.SESSION_HELPER_IMAGE ?? 'alpine:3.20';

/** Stable label namespace — picked up by docker ps filters and GC. */
const LABEL_USER = 'aionui.user';
const LABEL_CONVERSATION = 'aionui.conversation';
const LABEL_PROJECT = 'aionui.project';
const LABEL_MANAGED = 'aionui.managed';

/**
 * Read a positive integer from env, falling back to `fallback`. Returns
 * `undefined` when the env var is absent/zero so dockerode treats the field
 * as "unset" rather than "explicit 0" — `Memory: 0` means *unlimited*.
 */
function envInt(name: string, fallback?: number): number | undefined {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Build the hardened HostConfig applied to every session container.
 * Sensible defaults out of the box; each cap can be tuned per-deployment via
 * env to match the host's capacity.
 *
 * Notes on the defaults:
 *  - read-only rootfs + tmpfs(/tmp) — keep the filesystem inside the
 *    container immutable except for /workspace (where the project lives)
 *    and /tmp (where many CLIs cache).
 *  - cap-drop ALL — agents don't need raw network or kernel privileges.
 *  - no-new-privileges — defence-in-depth against setuid binaries.
 *  - User 10001:10001 — matches the `aionui` user baked into
 *    Dockerfile.session-runtime.
 *  - PidsLimit — caps fork bombs.
 */
function buildSessionHostConfig(volumeName: string): Docker.HostConfig {
  // Default 1 GiB memory / 0.5 CPU shares / 512 pids. Tunable via env.
  const memBytes = envInt('SESSION_MEMORY_BYTES', 1024 * 1024 * 1024);
  const cpuShares = envInt('SESSION_CPU_SHARES', 512);
  const pidsLimit = envInt('SESSION_PIDS_LIMIT', 512);

  return {
    Binds: [`${volumeName}:/workspace`],
    AutoRemove: false,
    ReadonlyRootfs: true,
    // Mount a writable tmpfs for /tmp + /home/aionui/.cache so npm/pip/bun
    // can write metadata without breaking the read-only rootfs guarantee.
    Tmpfs: {
      '/tmp': 'rw,nosuid,nodev,size=512m',
      '/home/aionui/.cache': 'rw,nosuid,nodev,size=256m',
    },
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Memory: memBytes,
    CpuShares: cpuShares,
    PidsLimit: pidsLimit,
  };
}

export type AcquireInput = {
  conversationId: string;
  userId: string;
  projectId: string;
};

export type AcquireResult = {
  session: IDockerSession;
  /** True when the call actually started a new container. */
  created: boolean;
};

/**
 * Thrown when the requested project does not exist for the user. Kept as a
 * named class so callers can `instanceof` it without string matching.
 */
export class SessionProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found for the requesting user`);
    this.name = 'SessionProjectNotFoundError';
  }
}

/**
 * Per-process Docker handle. We keep one instance so dockerode's underlying
 * keep-alive agent is reused across calls.
 */
let _docker: Docker | null = null;
function getDocker(options?: DockerOptions): Docker {
  if (!_docker) {
    _docker = new Docker(options);
  }
  return _docker;
}

/**
 * For tests: replace the docker handle (and reset to default in cleanup).
 */
export function __setDockerForTests(docker: Docker | null): void {
  _docker = docker;
}

function volumeNameFor(userId: string, conversationId: string): string {
  // Volume names must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (Docker rule). User
  // and conversation IDs are app-controlled so we just sanitise defensively.
  const sanitise = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `aionui-${sanitise(userId)}-${sanitise(conversationId)}`;
}

/**
 * High-level lifecycle for per-conversation sandbox containers. Phase 3A
 * exposes acquire / release / destroy / listActive; Phase 3B will add the
 * `exec` plumbing that the new DockerPlatformServices.worker.fork uses.
 */
export const DockerSessionManager = {
  /**
   * Idempotently bring up a session container for the given conversation.
   *
   * - If a `running` session already exists, returns it untouched
   *   (`created=false`).
   * - Otherwise creates a named volume, extracts the project zip into it,
   *   launches a long-lived `sleep infinity` container with the volume
   *   mounted at /workspace, and records the resulting row.
   *
   * Throws `SessionProjectNotFoundError` when the project is unknown or
   * owned by someone else. Other errors propagate as plain Error.
   */
  async acquire(input: AcquireInput, dockerOptions?: DockerOptions): Promise<AcquireResult> {
    const { conversationId, userId, projectId } = input;
    const db = await getDatabase();
    const existing = db.getDockerSessionForUser(conversationId, userId);
    if (existing.success && existing.data && existing.data.status === 'running' && existing.data.container_id) {
      // Touch the heartbeat so eviction stays accurate, but don't bounce the
      // container — the caller just wants to send work to it.
      db.upsertDockerSession({ ...existing.data, last_seen_at: Date.now() });
      return { session: existing.data, created: false };
    }

    // Look up the project up-front so a missing/unauthorised project never
    // results in a half-created session row.
    const project = await ProjectIngestService.findForUser(projectId, userId);
    if (!project) {
      throw new SessionProjectNotFoundError(projectId);
    }

    const docker = getDocker(dockerOptions);
    const volumeName = volumeNameFor(userId, conversationId);
    const startedAt = Date.now();

    // Persist the starting state before any docker calls so that a crash
    // mid-acquire still leaves an audit trail for GC.
    const startingRow: IDockerSession = {
      conversation_id: conversationId,
      user_id: userId,
      project_id: projectId,
      container_id: null,
      volume_name: volumeName,
      status: 'starting',
      started_at: startedAt,
      last_seen_at: startedAt,
    };
    db.upsertDockerSession(startingRow);

    // 1. Ensure the named volume exists. createVolume is idempotent when the
    // name matches an existing volume.
    await docker.createVolume({
      Name: volumeName,
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_USER]: userId,
        [LABEL_CONVERSATION]: conversationId,
        [LABEL_PROJECT]: projectId,
      },
    });

    // 2. Extract the project zip into the volume. We mount the host upload
    // path read-only and the volume rw, then run `unzip` in the helper image
    // and wait for exit. This stays out of the long-running container so
    // its rootfs can remain read-only later (Phase 8 hardening).
    const uploadsDir = path.join(getDataPath(), 'uploads');
    await runHelperToCompletion(docker, {
      Cmd: ['sh', '-c', `unzip -q -o /in/${project.project.storage_key} -d /workspace`],
      HostConfig: {
        AutoRemove: true,
        Binds: [`${uploadsDir}:/in:ro`, `${volumeName}:/workspace`],
      },
      Labels: {
        [LABEL_MANAGED]: 'true',
        'aionui.role': 'helper-extract',
        [LABEL_USER]: userId,
        [LABEL_CONVERSATION]: conversationId,
      },
    });

    // 3. Start the long-lived session container. Cmd is sleep infinity so
    // it stays up; agent processes attach via `docker exec` later. The
    // HostConfig builder applies the hardening defaults (read-only rootfs,
    // capability drops, resource caps) — see buildSessionHostConfig.
    const container = await docker.createContainer({
      Image: SESSION_RUNTIME_IMAGE,
      Cmd: ['sleep', 'infinity'],
      // Run as the non-root `aionui` user baked into the runtime image.
      // SecurityOpt='no-new-privileges' relies on the process never being
      // able to escalate; matching the image's USER directive keeps the
      // chain consistent end-to-end.
      User: '10001:10001',
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_USER]: userId,
        [LABEL_CONVERSATION]: conversationId,
        [LABEL_PROJECT]: projectId,
      },
      WorkingDir: '/workspace',
      HostConfig: buildSessionHostConfig(volumeName),
    });
    await container.start();

    const completed: IDockerSession = {
      ...startingRow,
      container_id: container.id,
      status: 'running',
      last_seen_at: Date.now(),
    };
    db.upsertDockerSession(completed);
    return { session: completed, created: true };
  },

  /**
   * Stop and remove the container while keeping the volume + row. Used when
   * the user closes a chat tab — re-opening it should be cheap.
   */
  async release(conversationId: string, userId: string, dockerOptions?: DockerOptions): Promise<void> {
    const db = await getDatabase();
    const lookup = db.getDockerSessionForUser(conversationId, userId);
    if (!lookup.success || !lookup.data) {
      return;
    }
    const row = lookup.data;
    if (row.container_id) {
      const docker = getDocker(dockerOptions);
      const container = docker.getContainer(row.container_id);
      try {
        await container.stop({ t: 10 });
      } catch {
        // ignore — container may already be gone
      }
      try {
        await container.remove({ force: true });
      } catch {
        // ignore
      }
    }
    db.markDockerSessionStopped(conversationId);
  },

  /**
   * Full teardown — drop the volume, the row, and any lingering container.
   * Use when the conversation itself is being deleted.
   */
  async destroy(conversationId: string, userId: string, dockerOptions?: DockerOptions): Promise<void> {
    const db = await getDatabase();
    const lookup = db.getDockerSessionForUser(conversationId, userId);
    if (!lookup.success || !lookup.data) {
      return;
    }
    const row = lookup.data;
    const docker = getDocker(dockerOptions);
    if (row.container_id) {
      const container = docker.getContainer(row.container_id);
      try {
        await container.remove({ force: true });
      } catch {
        // ignore
      }
    }
    try {
      await docker.getVolume(row.volume_name).remove({ force: true });
    } catch {
      // ignore — volume might already be gone
    }
    db.deleteDockerSession(conversationId);
  },

  /**
   * Snapshot of sessions in the given status. Backs admin endpoints and the
   * idle-eviction job in Phase 8.
   */
  async listActive(): Promise<IDockerSession[]> {
    const db = await getDatabase();
    const result = db.listDockerSessionsByStatus('running');
    if (!result.success) {
      throw new Error(result.error || 'Failed to list active sessions');
    }
    return result.data ?? [];
  },
};

/**
 * Run a short-lived helper container to completion and surface a non-zero
 * exit as an error. dockerode's `docker.run` swallows the exit code into the
 * resolved value, so we have to inspect it ourselves.
 */
async function runHelperToCompletion(
  docker: Docker,
  options: { Cmd: string[]; HostConfig: Docker.HostConfig; Labels: Record<string, string> }
): Promise<void> {
  // `docker.run` returns [data, container]; data.StatusCode carries the exit.
  // We pass /dev/null-equivalent for stdout to avoid polluting the parent
  // process when run inside server mode.
  const result = (await docker.run(HELPER_IMAGE, options.Cmd, process.stderr, {
    HostConfig: options.HostConfig,
    Labels: options.Labels,
  })) as unknown as [{ StatusCode: number }, unknown];
  const exitCode = result?.[0]?.StatusCode ?? 1;
  if (exitCode !== 0) {
    throw new Error(`Helper container exited with status ${exitCode}`);
  }
}
