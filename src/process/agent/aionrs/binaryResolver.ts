/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function getBinaryName(): string {
  return process.platform === 'win32' ? 'aionrs.exe' : 'aionrs';
}

/**
 * Resolve the aionrs binary path.
 *
 * Search order:
 *  1. Docker mode (AIONUI_PLATFORM=docker) — the binary lives at a fixed path
 *     inside the session container image (/opt/aionui/aionrs). The on-host
 *     existsSync check is intentionally skipped because we resolve a path
 *     inside the container, not the host.
 *  2. Bundled with app (production) — same layout as bundled-bun.
 *  3. System PATH.
 */
export function resolveAionrsBinary(): string | null {
  // 1. Docker platform: the runtime image will ship the binary at this path
  // once Phase 5C lands the cross-compile step. Returning it here lets the
  // spawn site go through dockerSpawn with the correct in-container path.
  if ((process.env.AIONUI_PLATFORM ?? '').trim().toLowerCase() === 'docker') {
    return process.env.AIONUI_AIONRS_PATH?.trim() || '/opt/aionui/aionrs';
  }

  // 2. Bundled binary (production) — same layout as bundled-bun
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const runtimeKey = `${process.platform}-${process.arch}`;
    const bundled = join(resourcesPath, 'bundled-aionrs', runtimeKey, getBinaryName());
    if (existsSync(bundled)) return bundled;
  }

  // 3. System PATH
  try {
    const cmd = process.platform === 'win32' ? 'where aionrs' : 'which aionrs';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // not found in PATH
  }

  return null;
}

export function isAionrsAvailable(): boolean {
  return resolveAionrsBinary() !== null;
}

/**
 * Detect aionrs availability and version for settings UI.
 */
export function detectAionrs(): {
  available: boolean;
  version?: string;
  path?: string;
} {
  const binaryPath = resolveAionrsBinary();
  if (!binaryPath) return { available: false };

  try {
    const version = execSync(`"${binaryPath}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return { available: true, version, path: binaryPath };
  } catch {
    return { available: true, path: binaryPath };
  }
}
