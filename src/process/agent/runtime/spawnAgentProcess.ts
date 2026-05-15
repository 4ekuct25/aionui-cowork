/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn as nodeSpawn } from 'child_process';
import { dockerSpawn, type ChildProcessLike } from './dockerSpawn';

/**
 * True when the process is running under the docker-backed platform and a
 * concrete session container has been picked for this spawn. We require BOTH:
 *   - AIONUI_PLATFORM=docker (the global mode flag set in register-node.ts)
 *   - AIONUI_CONTAINER_ID present in env (or opts.env) so we know where to
 *     exec into.
 * The second check keeps the host-path safe when something passes through
 * agents that have no associated session yet (e.g. CLI diagnostics in
 * `prepareCodex`).
 */
function shouldUseDocker(env: NodeJS.ProcessEnv | undefined): { use: boolean; containerId?: string } {
  const mode = (process.env.AIONUI_PLATFORM ?? '').trim().toLowerCase();
  if (mode !== 'docker') return { use: false };
  const containerId = env?.AIONUI_CONTAINER_ID ?? process.env.AIONUI_CONTAINER_ID;
  if (!containerId || !containerId.trim()) return { use: false };
  return { use: true, containerId };
}

function envAsRecord(env: SpawnOptions['env']): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Spawn an agent process. When the platform is docker-backed, the call is
 * routed through `dockerSpawn` so the agent runs inside the session
 * container; otherwise we fall back to plain `child_process.spawn`.
 *
 * Returns the union type so callers that already type-annotate against
 * `ChildProcess` keep working (TS structural-types over the subset
 * ChildProcessLike covers). Downstream code that needs ChildProcess-only
 * APIs (channel, send, disconnect) is unreachable for agent code today, so
 * the union is safe in practice.
 */
export function spawnAgentProcess(
  command: string,
  args: string[],
  options: SpawnOptions
): ChildProcess | ChildProcessLike {
  const env = options.env;
  const decision = shouldUseDocker(env);
  if (decision.use && decision.containerId) {
    return dockerSpawn(command, args, {
      containerId: decision.containerId,
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      env: envAsRecord(env),
    });
  }
  return nodeSpawn(command, args, options);
}
