/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';

/**
 * Every session container mounts its project volume at this fixed path. The
 * DockerSessionManager hard-codes the bind, so this can be a constant rather
 * than configurable — callers should not need to know how the container is
 * stitched together.
 */
export const CONTAINER_WORKSPACE = '/workspace';

/**
 * Convert a renderer-facing path (project-relative or absolute under
 * /workspace) into the absolute path that an agent or worker inside the
 * session container should see.
 *
 * Behaviour:
 *  - Empty / `.` → `/workspace`
 *  - Already under `/workspace` → returned unchanged.
 *  - Other absolute paths (e.g. `/etc/passwd`) → `null`. Refusing to map is
 *    intentional — it prevents the renderer (or a misbehaving agent) from
 *    asking the host to peek at files outside the project.
 *  - Relative paths → joined onto `/workspace`, with parent-traversal
 *    components rejected. We collapse `.` and `..` ourselves rather than
 *    delegating to `path.posix.resolve` because resolve will happily walk
 *    above the root.
 */
export function toContainerPath(rendererPath: string): string | null {
  if (typeof rendererPath !== 'string') return null;
  const trimmed = rendererPath.trim();
  if (trimmed === '' || trimmed === '.') return CONTAINER_WORKSPACE;

  // Strip the leading `./` so `./src/x` and `src/x` are equivalent.
  const normalized = trimmed.replace(/^\.\/+/, '');

  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) {
    // Allow `/workspace`-prefixed paths through as a convenience for callers
    // that pre-resolved on the host side.
    const posix = normalized.replaceAll('\\', '/');
    if (posix === CONTAINER_WORKSPACE || posix.startsWith(`${CONTAINER_WORKSPACE}/`)) {
      // Validate the tail doesn't try to escape via `..` segments.
      return joinAndValidate(CONTAINER_WORKSPACE, posix.slice(CONTAINER_WORKSPACE.length).replace(/^\/+/, ''));
    }
    return null;
  }

  return joinAndValidate(CONTAINER_WORKSPACE, normalized);
}

/**
 * Convert a container path (`/workspace/...`) back to a renderer-friendly
 * project-relative path (without leading `./`). Returns `null` for any path
 * that lives outside `/workspace` — those are leaks we don't want to surface
 * back to the UI.
 */
export function toRendererPath(containerPath: string): string | null {
  if (typeof containerPath !== 'string') return null;
  const posix = containerPath.replaceAll('\\', '/');
  if (posix === CONTAINER_WORKSPACE) return '';
  if (!posix.startsWith(`${CONTAINER_WORKSPACE}/`)) return null;
  return posix.slice(CONTAINER_WORKSPACE.length + 1);
}

/**
 * True when `p` is an absolute path under `/workspace`. Used by bridge
 * guards that need to refuse host paths.
 */
export function isContainerPath(p: string): boolean {
  if (typeof p !== 'string') return false;
  const posix = p.replaceAll('\\', '/');
  return posix === CONTAINER_WORKSPACE || posix.startsWith(`${CONTAINER_WORKSPACE}/`);
}

/**
 * Join `base` and `rel` using POSIX rules, then assert that the result is
 * still inside `base`. Returns `null` when a `..` segment would escape.
 */
function joinAndValidate(base: string, rel: string): string | null {
  if (rel === '') return base;
  // Splitting on `/` lets us look for `..` segments without missing ones
  // hidden in patterns like `foo/../../etc`.
  const segments = rel.split(/[\\/]+/);
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.length === 0 ? base : `${base}/${stack.join('/')}`;
}
