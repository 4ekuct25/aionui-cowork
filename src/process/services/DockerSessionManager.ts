/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type DockerOptions } from 'dockerode';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '@process/utils';

// tar-stream has no @types package; the runtime API we use is small enough
// to declare inline. `pack()` returns a Readable stream you can pipe into
// dockerode's putArchive, and `entry({name,size,mode}, data)` appends a
// single file entry.
type TarPackEntry = { name: string; size: number; mode?: number };
interface TarPack extends NodeJS.ReadableStream {
  entry(opts: TarPackEntry, data: Buffer | string): void;
  finalize(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tarStream = require('tar-stream') as { pack: () => TarPack };
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
/**
 * Build the base env passed to every session container. The main use today
 * is propagating an operator-supplied egress proxy (Phase 8.3) so the
 * sandbox can only reach allowlisted hosts (LLM providers, GitHub, npm).
 * Any agent CLI inside the container that respects HTTPS_PROXY picks this
 * up automatically — node fetch, curl, python requests, npm, pip, etc.
 *
 * Operator configures via .env:
 *   SESSION_EGRESS_PROXY=http://squid:3128
 *   SESSION_EGRESS_NO_PROXY=localhost,127.0.0.1,api.anthropic.com
 *
 * Leaving SESSION_EGRESS_PROXY unset disables filtering — useful for local
 * dev where the operator hasn't stood up a proxy yet.
 */
function buildSessionEnv(): string[] {
  const proxy = (process.env.SESSION_EGRESS_PROXY ?? '').trim();
  if (!proxy) return [];
  // NO_PROXY defaults cover container-internal addressing so DNS lookups
  // for sibling containers (`docker-proxy`, future helpers) don't get
  // bounced into the egress filter.
  const noProxy = (process.env.SESSION_EGRESS_NO_PROXY ?? 'localhost,127.0.0.1,::1').trim();
  return [
    `HTTPS_PROXY=${proxy}`,
    `HTTP_PROXY=${proxy}`,
    // Some tooling reads the lowercase form instead.
    `https_proxy=${proxy}`,
    `http_proxy=${proxy}`,
    `NO_PROXY=${noProxy}`,
    `no_proxy=${noProxy}`,
  ];
}

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
    NetworkMode: 'aionui-cowork_default',
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
 *
 * Connection target:
 *   - DOCKER_HOST=tcp://host:port — Phase 8.2 hardening path. The compose
 *     stack puts `tecnativa/docker-socket-proxy` in front of the real
 *     /var/run/docker.sock so the control-plane never gets root-equivalent
 *     access; it only sees the whitelisted endpoints
 *     (containers/exec/volumes/images) the proxy exposes.
 *   - Unset → dockerode defaults to /var/run/docker.sock (single-user dev).
 */
function parseDockerHost(env: string | undefined): DockerOptions | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === 'unix:') {
      return { socketPath: url.pathname };
    }
    if (url.protocol === 'tcp:' || url.protocol === 'http:' || url.protocol === 'https:') {
      const port = Number(url.port) || (url.protocol === 'https:' ? 2376 : 2375);
      return {
        host: url.hostname,
        port,
        protocol: url.protocol === 'https:' ? 'https' : 'http',
      };
    }
  } catch {
    // ignore — fall through to "let dockerode pick default"
  }
  return null;
}

let _docker: Docker | null = null;
function getDocker(options?: DockerOptions): Docker {
  if (!_docker) {
    const fromEnv = options ? null : parseDockerHost(process.env.DOCKER_HOST);
    _docker = new Docker(options ?? fromEnv ?? undefined);
  }
  return _docker;
}

/**
 * For tests: replace the docker handle (and reset to default in cleanup).
 */
export function __setDockerForTests(docker: Docker | null): void {
  _docker = docker;
}

/**
 * Resolve bind mounts for helper containers. In Docker mode the data directory
 * lives on a named volume, so we can't use host paths for bind mounts because
 * the Docker daemon only sees the host filesystem. Instead, we detect the
 * Docker data volume and use volume-name syntax (volumeName:containerPath)
 * which the daemon resolves against its volume store.
 */
function resolveDockerBinds(uploadsHostPath: string, workspaceVolumeName: string): string[] {
  // Non-Docker mode: use the host path directly (works for Electron/dev)
  if (process.env.AIONUI_PLATFORM !== 'docker') {
    return [`${uploadsHostPath}:/in:ro`, `${workspaceVolumeName}:/workspace`];
  }

  // Docker mode: find the data volume and use volume-name syntax.
  // The DATA_DIR env (e.g. /data) tells us where the volume is mounted inside
  // the container. The compose file mounts a volume called
  // `{project}_app-data` at that path. We derive the volume name from the
  // docker-compose project prefix in the container hostname or fall back to
  // inspecting the mount.
  const dataDir = process.env.DATA_DIR ?? '/data';
  const uploadRelPath = path.relative(dataDir, uploadsHostPath);
  const composeProject = process.env.COMPOSE_PROJECT_NAME ?? 'aionui-cowork';
  const dataVolumeName = `${composeProject}_app-data`;

  // Mount the data volume at /data and the workspace volume at /workspace.
  // The unzip command reads from /in which is a sub-path of the data volume.
  return [`${dataVolumeName}:${dataDir}:ro`, `${workspaceVolumeName}:/workspace`];
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
    console.log('[DockerSessionManager] acquire:', conversationId, userId, projectId);
    const existing = db.getDockerSessionForUser(conversationId, userId);
    if (existing.success && existing.data && existing.data.status === 'running' && existing.data.container_id) {
      // Verify the container actually exists in Docker before reusing
      const docker = getDocker(dockerOptions);
      const container = docker.getContainer(existing.data.container_id);
      try {
        const info = await container.inspect();
        if (info.State.Running) {
          console.log('[DockerSessionManager] reusing existing container:', existing.data.container_id);
          db.upsertDockerSession({ ...existing.data, last_seen_at: Date.now() });
          return { session: existing.data, created: false };
        }
        console.log('[DockerSessionManager] container exists but not running, state:', info.State.Status);
      } catch {
        console.log('[DockerSessionManager] container no longer exists in Docker, cleaning up DB');
      }
      // Container gone or not running — clean up stale DB row and fall through to create
      db.upsertDockerSession({ ...existing.data, status: 'stopped', container_id: null });
    }
    if (existing.success && existing.data) {
      console.log(
        '[DockerSessionManager] existing session status:',
        existing.data.status,
        'container:',
        existing.data.container_id
      );
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

    // 2. Extract the project zip into the volume. We mount the upload
    // directory read-only and the volume rw, then run `unzip` in the helper
    // image and wait for exit. This stays out of the long-running container
    // so its rootfs can remain read-only later (Phase 8 hardening).
    //
    // In Docker mode (AIONUI_PLATFORM=docker) the data directory lives on a
    // Docker volume, not a host path. Docker daemon resolves bind-mount
    // sources against the host filesystem, so a container-internal path like
    // /data/aionui/uploads is invisible. Fix: mount the data volume into the
    // helper container using Docker's volume:source syntax, which resolves
    // against the Docker daemon's volume store instead of the host path.
    const uploadsHostPath = path.join(getDataPath(), 'uploads');
    const binds = resolveDockerBinds(uploadsHostPath, volumeName);
    const dataDir = process.env.DATA_DIR ?? '/data';
    const zipSource =
      process.env.AIONUI_PLATFORM === 'docker'
        ? `${dataDir}/aionui/uploads/${project.project.storage_key}`
        : `/in/${project.project.storage_key}`;
    await runHelperToCompletion(docker, {
      Cmd: ['sh', '-c', `unzip -q -o "${zipSource}" -d /workspace && chown -R 10001:10001 /workspace`],
      HostConfig: {
        AutoRemove: true,
        Binds: binds,
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
      // Phase 8.3: route everything in the sandbox through the operator-
      // supplied egress proxy when SESSION_EGRESS_PROXY is set. Apps
      // that honour the HTTPS_PROXY/NO_PROXY convention (curl, fetch,
      // node, python, most CLIs) pick this up automatically. NO_PROXY
      // covers loopback + docker-internal DNS so health probes inside
      // the container don't try to traverse the filter.
      Env: buildSessionEnv(),
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_USER]: userId,
        [LABEL_CONVERSATION]: conversationId,
        [LABEL_PROJECT]: projectId,
      },
      WorkingDir: '/workspace',
      HostConfig: buildSessionHostConfig(volumeName),
    });
    console.log('[DockerSessionManager] creating container:', container.id, 'conversation:', conversationId);
    await container.start();
    console.log('[DockerSessionManager] container started:', container.id, 'conversation:', conversationId);

    const completed: IDockerSession = {
      ...startingRow,
      container_id: container.id,
      status: 'running',
      last_seen_at: Date.now(),
    };
    db.upsertDockerSession(completed);
    console.log('[DockerSessionManager] session saved:', completed.container_id);
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

  /**
   * Resolve the session container for a conversation without re-acquiring
   * it. Used by agent managers (e.g. AionrsManager) that already arranged
   * the acquire on conversation open and just need the current container id
   * when spinning up an agent process. Returns null when no session row
   * exists yet (caller should fall back to acquire if needed).
   *
   * Looks up `(user_id, project_id)` from the `conversations` table so the
   * caller doesn't have to plumb them in; FK constraints keep the join sane.
   */
  async resolveForConversation(conversationId: string): Promise<IDockerSession | null> {
    const db = await getDatabase();
    const row = db
      .getDriver()
      .prepare(
        `SELECT ds.* FROM docker_sessions ds
         INNER JOIN conversations c ON c.id = ds.conversation_id
         WHERE ds.conversation_id = ? AND ds.status = 'running'`
      )
      .get(conversationId) as IDockerSession | undefined;
    return row ?? null;
  },

  /**
   * Idempotent acquire that resolves user_id + project_id from the
   * `conversations` row itself. Lets agent managers ask "give me a session
   * for this conversation" without plumbing user/project context through
   * their constructor chain.
   *
   * Returns null when the conversation has no associated project — that's
   * the legacy single-tenant case (or a malformed setup) where the caller
   * should fall back to the host-spawn path.
   */
  /**
   * Copy a set of host files into the session container under a `.uploads/`
   * subdirectory of /workspace. Used by agent managers so uploaded files
   * (which land on the host's `/data/config/temp/` via /api/upload) become
   * visible to the agent running inside the sandbox.
   *
   * Returns the container-side absolute paths in the same order as the input.
   * Skips entries that don't exist or aren't regular files. Empty input → [].
   *
   * Implementation note: dockerode's `putArchive` accepts a tar stream and
   * extracts it under `opts.path` inside the target container. We pack each
   * file under `.uploads/<basename>` so they end up at
   * `/workspace/.uploads/<basename>`. Collisions on basename overwrite the
   * earlier entry — agents that need stable identity should be passing
   * unique names already.
   */
  async injectFilesIntoContainer(
    containerId: string,
    hostFiles: string[],
    dockerOptions?: DockerOptions
  ): Promise<string[]> {
    if (!hostFiles.length) return [];
    const pack = tarStream.pack();
    const containerPaths: string[] = [];
    for (const hostPath of hostFiles) {
      try {
        const stat = fs.statSync(hostPath);
        if (!stat.isFile()) continue;
        const basename = path.basename(hostPath);
        const data = fs.readFileSync(hostPath);
        pack.entry({ name: `.uploads/${basename}`, size: stat.size, mode: 0o644 }, data);
        containerPaths.push(`/workspace/.uploads/${basename}`);
      } catch (err) {
        console.warn('[DockerSessionManager] injectFilesIntoContainer skipped', hostPath, (err as Error).message);
      }
    }
    pack.finalize();
    if (!containerPaths.length) return [];
    const docker = getDocker(dockerOptions);
    await docker.getContainer(containerId).putArchive(pack, { path: '/workspace' });
    return containerPaths;
  },

  async ensureForConversation(conversationId: string): Promise<{ containerId: string; volumeName: string } | null> {
    const db = await getDatabase();
    const row = db
      .getDriver()
      .prepare('SELECT user_id, project_id FROM conversations WHERE id = ?')
      .get(conversationId) as { user_id: string; project_id: string | null } | undefined;
    if (!row || !row.project_id) {
      return null;
    }
    const result = await this.acquire({
      conversationId,
      userId: row.user_id,
      projectId: row.project_id,
    });
    if (!result.session.container_id) {
      return null;
    }
    return { containerId: result.session.container_id, volumeName: result.session.volume_name };
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
