/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type DockerOptions } from 'dockerode';
import { getDatabase } from '@process/services/database/export';

/**
 * Background sweep covering three concerns:
 *
 *  1. **DB reconciliation** (Phase 9.3) — any session row claiming the
 *     container is `running` / `starting` but whose container is gone or
 *     stopped in Docker gets marked `stopped`. Without this, phantom rows
 *     pin the orphan-cleanup step (#3) and silently leak volumes.
 *
 *  2. **Idle-stop** (Phase 9.3) — rows still legitimately `running` but
 *     untouched for `SESSION_IDLE_TIMEOUT_MS` (default 30 min) get the
 *     container stopped+removed. The volume + DB row remain so the next
 *     `DockerSessionManager.acquire()` rebuilds a fresh container against
 *     the same workspace. Without this, every chat ever opened pins ~1 GiB
 *     of RAM until the operator reboots the host.
 *
 *  3. **Orphan cleanup** (Phase 9.1, original) — Docker objects tagged
 *     `aionui.managed=true` whose conversation has been fully deleted from
 *     the DB get force-removed. Causes:
 *      - app crashed mid-acquire after createVolume but before container start
 *      - DB row deleted manually (admin tooling, GDPR purge, …)
 *      - cascade DELETE on conversations removed the session row but the
 *        JS-side teardown never ran (e.g. process died before destroy)
 *
 * The sweep never deletes anything that isn't tagged `aionui.managed=true`,
 * so tenants of the same docker host that aren't part of this stack are
 * unaffected.
 */
const LABEL_MANAGED = 'aionui.managed';
const LABEL_CONVERSATION = 'aionui.conversation';

const IDLE_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000; // 30 minutes

/**
 * Idle-stop cutoff. Set `SESSION_IDLE_TIMEOUT_MS=0` to disable idle eviction
 * (legacy "keep forever" behaviour). Negative / non-numeric values fall back
 * to the default so a typo can't accidentally disable the safeguard.
 */
function getIdleTimeoutMs(): number {
  const raw = (process.env.SESSION_IDLE_TIMEOUT_MS ?? '').trim();
  if (!raw) return IDLE_TIMEOUT_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return IDLE_TIMEOUT_MS_DEFAULT;
  return parsed;
}

/**
 * Mirror of parseDockerHost in DockerSessionManager — keeps the GC sweep
 * honouring DOCKER_HOST (Phase 8.2 hardening) without importing private
 * helpers across modules.
 */
function parseDockerHost(env: string | undefined): DockerOptions | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === 'unix:') return { socketPath: url.pathname };
    if (url.protocol === 'tcp:' || url.protocol === 'http:' || url.protocol === 'https:') {
      const port = Number(url.port) || (url.protocol === 'https:' ? 2376 : 2375);
      return { host: url.hostname, port, protocol: url.protocol === 'https:' ? 'https' : 'http' };
    }
  } catch {
    // fall through to default
  }
  return null;
}

let _docker: Docker | null = null;
function getDocker(): Docker {
  if (!_docker) {
    _docker = new Docker(parseDockerHost(process.env.DOCKER_HOST) ?? undefined);
  }
  return _docker;
}

/** For tests — inject a stub docker handle. */
export function __setDockerForGcTests(docker: Docker | null): void {
  _docker = docker;
}

export type GcSummary = {
  containersRemoved: number;
  volumesRemoved: number;
  /** Rows transitioned from running/starting → stopped because Docker had no live container for them. */
  dbReconciled: number;
  /** Containers stopped+removed because their row was idle past SESSION_IDLE_TIMEOUT_MS. */
  idleStopped: number;
  errors: string[];
};

export const DockerGcService = {
  /**
   * Single sweep. Returns a summary the caller (cron job, admin tool) can
   * log or report. Never throws on per-item failures — each error is
   * collected so a single broken volume doesn't abort the rest of the
   * cleanup.
   */
  async sweep(): Promise<GcSummary> {
    const summary: GcSummary = {
      containersRemoved: 0,
      volumesRemoved: 0,
      dbReconciled: 0,
      idleStopped: 0,
      errors: [],
    };
    const docker = getDocker();
    const db = await getDatabase();
    const driver = db.getDriver();

    // 1. Reconcile DB. A row with status='running' or 'starting' should map
    // to a Docker container that's actually up; anything else is a phantom
    // (process died, host restarted with no DB restore, manual `docker rm`).
    // We mark these stopped so step 3 can GC the volume once the row itself
    // is deleted, and so the user's next acquire() builds a fresh container.
    try {
      const liveRows = driver
        .prepare("SELECT conversation_id, container_id FROM docker_sessions WHERE status IN ('running','starting')")
        .all() as Array<{ conversation_id: string; container_id: string | null }>;
      for (const row of liveRows) {
        let alive = false;
        if (row.container_id) {
          try {
            const info = await docker.getContainer(row.container_id).inspect();
            alive = Boolean(info.State?.Running);
          } catch {
            alive = false;
          }
        }
        if (!alive) {
          db.markDockerSessionStopped(row.conversation_id);
          summary.dbReconciled += 1;
        }
      }
    } catch (err) {
      summary.errors.push(`reconcileDb: ${(err as Error).message}`);
    }

    // 2. Idle-stop. After reconciliation any row still 'running' truly has a
    // live container; check last_seen_at to decide whether the user has
    // touched the chat recently. acquire() bumps last_seen_at on every
    // ensureForConversation call (i.e. every agent message), so a 30-min
    // cutoff translates to "no agent activity for 30 min".
    const idleMs = getIdleTimeoutMs();
    if (idleMs > 0) {
      const cutoff = Date.now() - idleMs;
      try {
        const idleRows = driver
          .prepare(
            "SELECT conversation_id, container_id FROM docker_sessions WHERE status = 'running' AND last_seen_at < ?"
          )
          .all(cutoff) as Array<{ conversation_id: string; container_id: string | null }>;
        for (const row of idleRows) {
          if (!row.container_id) continue;
          try {
            const container = docker.getContainer(row.container_id);
            try {
              await container.stop({ t: 10 });
            } catch {
              // ignore — already gone is fine
            }
            try {
              await container.remove({ force: true });
            } catch {
              // ignore
            }
            db.markDockerSessionStopped(row.conversation_id);
            summary.idleStopped += 1;
          } catch (err) {
            summary.errors.push(`idleStop ${row.conversation_id}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        summary.errors.push(`listIdle: ${(err as Error).message}`);
      }
    }

    // 3. Orphan cleanup. Build the set of conversation IDs that are still
    // "live" in the DB (any status — 'stopped' rows still pin their volume
    // so the user can resume). Only Docker objects whose conversation has
    // been fully deleted are GC candidates.
    const rows = driver.prepare('SELECT conversation_id FROM docker_sessions').all() as Array<{
      conversation_id: string;
    }>;
    const liveConversations = new Set(rows.map((r) => r.conversation_id));

    // 3a. Containers.
    try {
      const list = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MANAGED}=true`] },
      });
      for (const info of list) {
        const conv = info.Labels?.[LABEL_CONVERSATION];
        if (!conv || liveConversations.has(conv)) continue;
        try {
          await docker.getContainer(info.Id).remove({ force: true });
          summary.containersRemoved += 1;
        } catch (err) {
          summary.errors.push(`container ${info.Id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      summary.errors.push(`listContainers: ${(err as Error).message}`);
    }

    // 3b. Volumes.
    try {
      const result = await docker.listVolumes({ filters: { label: [`${LABEL_MANAGED}=true`] } });
      const volumes = result.Volumes ?? [];
      for (const vol of volumes) {
        const conv = vol.Labels?.[LABEL_CONVERSATION];
        if (!conv || liveConversations.has(conv)) continue;
        try {
          await docker.getVolume(vol.Name).remove({ force: true });
          summary.volumesRemoved += 1;
        } catch (err) {
          summary.errors.push(`volume ${vol.Name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      summary.errors.push(`listVolumes: ${(err as Error).message}`);
    }

    return summary;
  },

  /**
   * Fire-and-forget startup hook: run once on boot, swallow the result so
   * a slow Docker daemon doesn't block server startup. Returns the promise
   * so tests can await it explicitly.
   */
  async startupSweep(): Promise<void> {
    try {
      const summary = await this.sweep();
      if (summarisable(summary)) {
        console.log(`[DockerGc] startup sweep: ${formatSummary(summary)}`);
        for (const e of summary.errors) console.warn(`[DockerGc] ${e}`);
      }
    } catch (err) {
      console.warn('[DockerGc] startup sweep failed (non-fatal):', err);
    }
  },

  /**
   * Schedule the sweep on a cron expression. Caller is responsible for the
   * lifecycle — the returned `stop()` callback unbinds the timer (used by
   * tests; in production the scheduler lives for the process lifetime).
   *
   * The default expression `0 * * * *` runs hourly at the top of the hour.
   * Operators with very volatile workloads might pick a 15-minute cadence
   * (the "every-15-minutes" expression — escaped here so the JSDoc parser
   * doesn't close the block early). Stable deployments can disable
   * scheduling entirely by not setting SESSION_GC_CRON.
   */
  schedulePeriodic(cronExpression: string): { stop: () => void } {
    // Lazy import so the croner dep is only loaded when actually scheduled.
    // Avoids pulling it into single-user / Electron paths that never GC.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Cron } = require('croner') as typeof import('croner');
    const job = new Cron(cronExpression, async () => {
      try {
        const summary = await this.sweep();
        if (summarisable(summary)) {
          console.log(`[DockerGc] scheduled sweep: ${formatSummary(summary)}`);
          for (const e of summary.errors) console.warn(`[DockerGc] ${e}`);
        }
      } catch (err) {
        console.warn('[DockerGc] scheduled sweep failed (non-fatal):', err);
      }
    });
    return { stop: () => job.stop() };
  },
};

function summarisable(s: GcSummary): boolean {
  return Boolean(s.containersRemoved || s.volumesRemoved || s.dbReconciled || s.idleStopped || s.errors.length);
}

function formatSummary(s: GcSummary): string {
  return `reconciled=${s.dbReconciled} idleStopped=${s.idleStopped} containers=${s.containersRemoved} volumes=${s.volumesRemoved} errors=${s.errors.length}`;
}
