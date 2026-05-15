/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type DockerOptions } from 'dockerode';
import { getDatabase } from '@process/services/database/export';

/**
 * Phase 9.1 — background sweep that cleans up Docker volumes and
 * containers that we created (labeled `aionui.managed=true`) but no
 * longer have a matching row in `docker_sessions`. Causes:
 *
 *  - app crashed mid-acquire after createVolume but before container start
 *  - DB row deleted manually (admin tooling, GDPR purge, …)
 *  - cascade DELETE on conversations removed the session row but the
 *    JS-side teardown never ran (e.g. process died before destroy)
 *
 * The sweep is purely deletion of "we have it, but nothing references it".
 * It never deletes anything that isn't tagged `aionui.managed=true`, so
 * tenants of the same docker host that aren't part of this stack are
 * unaffected.
 */
const LABEL_MANAGED = 'aionui.managed';
const LABEL_CONVERSATION = 'aionui.conversation';

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
    const summary: GcSummary = { containersRemoved: 0, volumesRemoved: 0, errors: [] };
    const docker = getDocker();
    const db = await getDatabase();

    // Build the set of conversation IDs that are still "live" in the DB.
    // We treat any row in docker_sessions as live, regardless of status —
    // a 'stopped' row is still a record that something exists / existed
    // and might be resumed; only rows that have been explicitly deleted
    // are GC candidates.
    const driver = db.getDriver();
    const rows = driver.prepare('SELECT conversation_id FROM docker_sessions').all() as Array<{
      conversation_id: string;
    }>;
    const liveConversations = new Set(rows.map((r) => r.conversation_id));

    // 1. Containers.
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

    // 2. Volumes.
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
      if (summary.containersRemoved || summary.volumesRemoved || summary.errors.length) {
        console.log(
          `[DockerGc] startup sweep: containers=${summary.containersRemoved} volumes=${summary.volumesRemoved} errors=${summary.errors.length}`
        );
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
        if (summary.containersRemoved || summary.volumesRemoved || summary.errors.length) {
          console.log(
            `[DockerGc] scheduled sweep: containers=${summary.containersRemoved} volumes=${summary.volumesRemoved} errors=${summary.errors.length}`
          );
          for (const e of summary.errors) console.warn(`[DockerGc] ${e}`);
        }
      } catch (err) {
        console.warn('[DockerGc] scheduled sweep failed (non-fatal):', err);
      }
    });
    return { stop: () => job.stop() };
  },
};
