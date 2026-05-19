/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type Container, type Exec } from 'dockerode';
import type { Readable, Writable } from 'stream';
import { PassThrough } from 'stream';
import { toContainerPath, CONTAINER_WORKSPACE } from '@process/runtime/pathMap';

/**
 * Singleton dockerode handle for container fs operations. Honours DOCKER_HOST
 * so the control-plane can go through docker-socket-proxy.
 */
function parseDockerHost(env: string | undefined): import('dockerode').DockerOptions | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === 'unix:') return { socketPath: url.pathname };
    if (url.protocol === 'tcp:' || url.protocol === 'http:' || url.protocol === 'https:') {
      const port = Number(url.port) || (url.protocol === 'https:' ? 2376 : 2375);
      return { host: url.hostname, port, protocol: url.protocol === 'https:' ? 'https' : 'http' };
    }
  } catch {
    // ignore
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

/**
 * Auto-resolve the container for a given path by scanning active sessions.
 */
async function resolveSessionForPath(
  conversationId: string | undefined,
  _filePath: string
): Promise<{ containerId: string } | null> {
  if (conversationId) {
    return resolveSession(conversationId);
  }
  try {
    const { DockerSessionManager } = await import('@process/services/DockerSessionManager');
    const sessions = await DockerSessionManager.listActive();
    if (sessions.length === 1 && sessions[0].container_id) {
      return { containerId: sessions[0].container_id };
    }
  } catch {
    // ignore
  }
  return null;
}

/** Resolve the active session for a conversation. Returns null when no project-linked session exists. */
async function resolveSession(conversationId: string): Promise<{ containerId: string } | null> {
  try {
    const { DockerSessionManager } = await import('@process/services/DockerSessionManager');
    const session = await DockerSessionManager.resolveForConversation(conversationId);
    if (session?.container_id && session.status === 'running') {
      return { containerId: session.container_id };
    }
  } catch {
    // ignore — fall through to host
  }
  return null;
}

/**
 * Execute a command inside a container and capture stdout/stderr.
 */
async function execInContainer(
  containerId: string,
  command: string,
  args: string[],
  input?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const d = getDocker();
  const container: Container = d.getContainer(containerId);

  const exec = await container.exec({
    Cmd: [command, ...args],
    AttachStdin: !!input,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stream = await exec.start({ hijack: true, stdin: input ? true : undefined });

  if (input) {
    (stream as unknown as Writable).write(input);
  }

  d.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderr);

  const [outChunks, errChunks] = await Promise.all([collectStream(stdout), collectStream(stderr)]);

  const info = await exec.inspect();
  return {
    stdout: Buffer.concat(outChunks).toString('utf-8'),
    stderr: Buffer.concat(errChunks).toString('utf-8'),
    exitCode: (info as unknown as { ExitCode?: number }).ExitCode ?? 0,
  };
}

/**
 * Execute a command inside a container and return raw stdout buffer (for binary data).
 */
async function execRawInContainer(containerId: string, command: string, args: string[]): Promise<Buffer> {
  const d = getDocker();
  const container: Container = d.getContainer(containerId);

  const exec = await container.exec({
    Cmd: [command, ...args],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stream = await exec.start({ hijack: true });

  d.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderr);

  const [outChunks] = await Promise.all([collectStream(stdout), collectStream(stderr)]);

  return Buffer.concat(outChunks);
}

async function collectStream(stream: Readable): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks));
    stream.on('error', () => resolve(chunks));
  });
}

// ============================================================================
// Public API — mirrors fsBridge interface, operates inside container
// ============================================================================

/**
 * Try to route a file read through the container. Returns `{ ok: true, data }` on success,
 * `{ ok: false }` to signal the caller should fall back to the host FS.
 */
export async function tryReadFileInContainer(
  conversationId: string | undefined,
  filePath: string
): Promise<{ ok: true; data: string } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
      const fs = require('fs');
      const data = fs.readFileSync(process.argv[1], 'utf-8');
      process.stdout.write(data);
    `,
      cp,
    ]);
    if (result.exitCode === 0) {
      return { ok: true, data: result.stdout };
    }
  } catch {
    // fall through to host
  }
  return { ok: false };
}

/**
 * Try to route a binary file read through the container.
 */
export async function tryReadFileBufferInContainer(
  conversationId: string | undefined,
  filePath: string
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const buf = await execRawInContainer(session.containerId, 'cat', [cp]);
    if (buf.length > 0) {
      const ab = new ArrayBuffer(buf.byteLength);
      const view = new Uint8Array(ab);
      view.set(buf);
      return { ok: true, data: ab };
    }
  } catch {
    // fall through to host
  }
  return { ok: false };
}

/**
 * Try to route a file write through the container.
 */
export async function tryWriteFileInContainer(
  conversationId: string | undefined,
  filePath: string,
  data: string
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return false;
  const cp = toContainerPath(filePath);
  if (!cp) return false;

  try {
    // Ensure parent directory exists
    const parent = cp.substring(0, cp.lastIndexOf('/'));
    await execInContainer(session.containerId, 'mkdir', ['-p', parent]);

    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
        const fs = require('fs');
        const data = Buffer.from(process.argv[2], 'base64');
        fs.writeFileSync(process.argv[1], data);
      `,
      cp,
      Buffer.from(data).toString('base64'),
    ]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Try to route file metadata (stat) through the container.
 */
export interface IFileMetadataResult {
  size: number;
  mtime: number;
  isDirectory: boolean;
  isFile: boolean;
}

export async function tryGetFileMetadataInContainer(
  conversationId: string | undefined,
  filePath: string
): Promise<{ ok: true; data: IFileMetadataResult } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
      const fs = require('fs');
      const s = fs.statSync(process.argv[1]);
      console.log(JSON.stringify({
        size: s.size,
        mtime: s.mtimeMs,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
      }));
    `,
      cp,
    ]);
    if (result.exitCode === 0) {
      try {
        return { ok: true, data: JSON.parse(result.stdout) };
      } catch {
        return { ok: false };
      }
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Try to route file removal through the container.
 */
export async function tryRemoveEntryInContainer(
  conversationId: string | undefined,
  filePath: string
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return false;
  const cp = toContainerPath(filePath);
  if (!cp) return false;

  try {
    const result = await execInContainer(session.containerId, 'rm', ['-rf', cp]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Try to route file rename through the container.
 */
export async function tryRenameEntryInContainer(
  conversationId: string | undefined,
  filePath: string,
  newName: string
): Promise<{ ok: true; newPath: string } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  const dir = cp.substring(0, cp.lastIndexOf('/'));
  const newCp = `${dir}/${newName}`;

  try {
    const result = await execInContainer(session.containerId, 'mv', [cp, newCp]);
    if (result.exitCode === 0) {
      return { ok: true, newPath: newCp };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Try to list directory contents through the container.
 */
export async function tryGetFilesByDirInContainer(
  conversationId: string | undefined,
  dirPath: string
): Promise<
  | { ok: true; data: Array<{ name: string; fullPath: string; relativePath: string; isDir: boolean; isFile: boolean }> }
  | { ok: false }
> {
  const session = await resolveSessionForPath(conversationId, dirPath);
  if (!session) return { ok: false };
  const cp = toContainerPath(dirPath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
      const fs = require('fs');
      const path = require('path');
      function walk(dir, base) {
        let entries = [];
        try {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const full = path.join(dir, item.name);
            const rel = base ? path.posix.join(base, item.name) : item.name;
            try {
              const s = fs.statSync(full);
              entries.push({
                name: item.name,
                fullPath: full,
                relativePath: rel,
                isDir: item.isDirectory(),
                isFile: item.isFile(),
              });
              if (item.isDirectory()) {
                entries = entries.concat(walk(full, rel));
              }
            } catch {
              // skip unreadable
            }
          }
        } catch {
          // skip unreadable dir
        }
        return entries;
      }
      console.log(JSON.stringify(walk(process.argv[1], '')));
    `,
      cp,
    ]);
    if (result.exitCode === 0) {
      try {
        return { ok: true, data: JSON.parse(result.stdout) };
      } catch {
        return { ok: false };
      }
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Try to read an image as base64 through the container.
 */
export async function tryGetImageBase64InContainer(
  conversationId: string | undefined,
  filePath: string
): Promise<{ ok: true; data: string } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const buf = await execRawInContainer(session.containerId, 'cat', [cp]);
    if (buf.length > 0) {
      const ext = pathExt(cp).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
      };
      const mime = mimeMap[ext] || 'image/png';
      return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}` };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Try to create a zip archive of files through the container.
 */
export async function tryCreateZipInContainer(
  conversationId: string | undefined,
  zipPath: string,
  files: Array<{ path: string; content?: string }>
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, zipPath);
  if (!session) return false;
  const cp = toContainerPath(zipPath);
  if (!cp) return false;

  try {
    // Use node to create zip in container
    const fileJson = JSON.stringify(
      files.map((f) => ({
        path: toContainerPath(f.path) || f.path,
        content: f.content,
      }))
    );

    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
        const fs = require('fs');
        const path = require('path');
        const zipPath = process.argv[1];
        const files = JSON.parse(process.argv[2]);
        // Simple zip using JSZip-like approach or just tar
        const zlib = require('zlib');
        // Create a simple zip
        const entries = [];
        for (const f of files) {
          if (f.content !== undefined) {
            entries.push(f);
          } else {
            try {
              entries.push({ path: f.path, content: fs.readFileSync(f.path, 'utf-8') });
            } catch {}
          }
        }
        // Use a simple approach: write files then zip
        const tmpDir = '/tmp/zip_' + Date.now();
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const e of entries) {
          const p = path.join(tmpDir, path.basename(e.path));
          fs.writeFileSync(p, e.content);
        }
        // Simple zip: use zlib to create a basic archive
        // Actually let's just use tar if available, or fall back
        const { execSync } = require('child_process');
        try {
          execSync(\`tar -czf "\${zipPath}" -C "\${tmpDir}" .\`, { stdio: 'pipe' });
        } catch {
          // If tar fails, try creating a simple zip
          throw new Error('Compression failed');
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      `,
      cp,
      fileJson,
    ]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function pathExt(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx >= 0 ? p.substring(idx) : '';
}

/**
 * Try to copy files into the container workspace.
 */
export async function tryCopyFilesToWorkspaceInContainer(
  conversationId: string | undefined,
  filePaths: string[],
  workspace: string
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, workspace);
  if (!session) return false;
  if (!session) return false;

  // In docker mode, workspace should be /workspace
  const destWorkspace = toContainerPath(workspace) || CONTAINER_WORKSPACE;

  try {
    const d = getDocker();
    const container = d.getContainer(session.containerId);

    for (const fp of filePaths) {
      const basename = fp.substring(fp.lastIndexOf('/') + 1) || fp.substring(fp.lastIndexOf('\\') + 1);
      const destPath = `${destWorkspace}/${basename}`;

      // Read file from host, write into container
      const { execSync } = await import('child_process');
      const content = execSync(`cat "${fp}"`, { encoding: 'utf-8' });
      await execInContainer(session.containerId, 'node', [
        '-e',
        `
          const fs = require('fs');
          fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));
        `,
        destPath,
        Buffer.from(content).toString('base64'),
      ]);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to list workspace files (flat listing with caching) through the container.
 */
export async function tryListWorkspaceFilesInContainer(
  conversationId: string | undefined,
  rootPath: string
): Promise<{ ok: true; data: Array<{ name: string; fullPath: string; relativePath: string }> } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, rootPath);
  if (!session) return { ok: false };
  const cp = toContainerPath(rootPath) || CONTAINER_WORKSPACE;

  try {
    const result = await execInContainer(session.containerId, 'node', [
      '-e',
      `
      const fs = require('fs');
      const path = require('path');
      function walk(dir, base) {
        let entries = [];
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const full = path.join(dir, item);
            const rel = base ? path.posix.join(base, item) : item;
            try {
              const s = fs.statSync(full);
              if (s.isFile()) {
                entries.push({ name: item, fullPath: full, relativePath: rel });
              }
            } catch {}
          }
          for (const item of items) {
            const full = path.join(dir, item);
            try {
              const s = fs.statSync(full);
              if (s.isDirectory()) {
                entries = entries.concat(walk(full, rel));
              }
            } catch {}
          }
        } catch {}
        return entries;
      }
      console.log(JSON.stringify(walk(process.argv[1], '')));
    `,
      cp,
    ]);
    if (result.exitCode === 0) {
      try {
        return { ok: true, data: JSON.parse(result.stdout) };
      } catch {
        return { ok: false };
      }
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Try to walk a directory tree through the container, returning the same
 * `IDirOrFile` shape that `readDirectoryRecursive` produces on the host.
 * Backs the renderer's left-side workspace panel
 * (`conversation.getWorkspace`) for chats that have a session container.
 *
 * Path semantics: when a session exists for the conversation, the
 * renderer-visible workspace (`conversation.extra.workspace`) is a stale
 * legacy host path. We remap it to `/workspace` (the project bind inside
 * the container) and accept the requested subpath either as a
 * `/workspace`-prefixed path or as the same legacy host path the renderer
 * passed us — in either case the listing comes from inside the container.
 *
 * Doesn't implement search yet — the host walker uses `fileService` /
 * `.gitignore` rules that don't transfer cleanly into `node -e`. Search
 * is rare enough that falling back to the host walk for now is fine.
 */
export async function tryReadDirectoryRecursiveInContainer(
  conversationId: string | undefined,
  rootPath: string,
  startPath: string,
  maxDepth: number
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  if (!conversationId) return { ok: false };
  const session = await resolveSession(conversationId);
  if (!session) return { ok: false };
  const containerRoot = CONTAINER_WORKSPACE;
  let containerStart = toContainerPath(startPath);
  if (!containerStart) {
    if (startPath === rootPath) {
      containerStart = containerRoot;
    } else {
      return { ok: false };
    }
  }

  const script = `
    const fs = require('fs');
    const path = require('path');
    const root = process.argv[1];
    const startPath = process.argv[2];
    const maxDepth = Number(process.argv[3]);
    function walk(dir, depth) {
      let stats;
      try { stats = fs.statSync(dir); } catch { return null; }
      if (!stats.isDirectory()) return null;
      const node = {
        name: path.basename(dir) || dir,
        fullPath: dir,
        relativePath: path.relative(root, dir),
        isDir: true,
        isFile: false,
        children: [],
      };
      if (depth <= 0) return node;
      let items;
      try { items = fs.readdirSync(dir); } catch { return node; }
      for (const item of items) {
        if (item === 'node_modules') continue;
        const full = path.join(dir, item);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          const child = walk(full, depth - 1);
          if (child) node.children.push(child);
        } else {
          node.children.push({
            name: item,
            fullPath: full,
            relativePath: path.relative(root, full),
            isDir: false,
            isFile: true,
          });
        }
      }
      node.children.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      return node;
    }
    console.log(JSON.stringify(walk(startPath, maxDepth)));
  `;

  try {
    const result = await execInContainerTty(session.containerId, 'node', [
      '-e',
      script,
      containerRoot,
      containerStart,
      String(maxDepth),
    ]);
    if (result.exitCode === 0) {
      try {
        return { ok: true, data: JSON.parse(result.stdout) };
      } catch {
        return { ok: false };
      }
    }
  } catch {
    // fall through to host walk
  }
  return { ok: false };
}

/**
 * TTY-mode exec via raw fetch to the docker proxy. We bypass dockerode's
 * hijack/upgrade path because tecnativa/docker-socket-proxy doesn't
 * fully tunnel the HTTP 101 Switching Protocols dockerode expects — it
 * answers 200 with the body as raw bytes instead. Dockerode treats 200
 * as "unexpected" and throws even though the body is the actual command
 * output. So we issue the two HTTP calls (create + start) ourselves and
 * read the body straight off the response.
 *
 * Trade-off: stdout+stderr come back interleaved (Tty: true → no
 * demux frame headers). Only suitable for command output we control
 * where stderr is empty on success.
 */
async function execInContainerTty(
  containerId: string,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dockerHostEnv = process.env.DOCKER_HOST ?? '';
  // tcp://host:port → http://host:port — fetch needs an http(s) scheme.
  const httpBase = dockerHostEnv.startsWith('tcp://')
    ? `http://${dockerHostEnv.slice('tcp://'.length)}`
    : dockerHostEnv;
  if (!httpBase) {
    // No proxy — fall back to dockerode (path used in tests / local dev
    // where DOCKER_HOST is unset and dockerode talks to the socket
    // directly without proxy-induced 101 quirks).
    return execInContainerTtyViaDockerode(containerId, command, args);
  }

  const createRes = await fetch(`${httpBase}/containers/${containerId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Cmd: [command, ...args],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    }),
  });
  if (!createRes.ok) {
    return { stdout: '', stderr: `exec create failed: ${createRes.status}`, exitCode: 1 };
  }
  const { Id: execId } = (await createRes.json()) as { Id: string };

  const startRes = await fetch(`${httpBase}/exec/${execId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'Upgrade', Upgrade: 'tcp' },
    body: JSON.stringify({ Detach: false, Tty: true }),
  });
  const stdout = await startRes.text();

  const inspectRes = await fetch(`${httpBase}/exec/${execId}/json`);
  const info = inspectRes.ok
    ? ((await inspectRes.json()) as { ExitCode?: number })
    : { ExitCode: undefined };
  return { stdout, stderr: '', exitCode: info.ExitCode ?? 0 };
}

async function execInContainerTtyViaDockerode(
  containerId: string,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const d = getDocker();
  const container: Container = d.getContainer(containerId);
  const exec = await container.exec({
    Cmd: [command, ...args],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = (await exec.start({ hijack: true })) as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve());
    stream.on('error', (e: Error) => reject(e));
  });
  const info = await exec.inspect();
  return {
    stdout: Buffer.concat(chunks).toString('utf-8'),
    stderr: '',
    exitCode: (info as unknown as { ExitCode?: number }).ExitCode ?? 0,
  };
}
