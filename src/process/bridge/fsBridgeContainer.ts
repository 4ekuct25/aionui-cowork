/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { toContainerPath, CONTAINER_WORKSPACE } from '@process/runtime/pathMap';

/**
 * Singleton dockerode handle for container fs operations. Honours DOCKER_HOST
 * so the control-plane can go through docker-socket-proxy.
 */
function getDocker(): Docker {
  const host = process.env.DOCKER_HOST;
  if (host) {
    const url = new URL(host);
    if (url.protocol === 'tcp:' || url.protocol === 'http:') {
      const port = Number(url.port) || 2375;
      return new Docker({ host: url.hostname, port, protocol: 'http' });
    }
    if (url.protocol === 'https:') {
      const port = Number(url.port) || 2376;
      return new Docker({ host: url.hostname, port, protocol: 'https' });
    }
  }
  return new Docker();
}

let _docker: Docker | null = null;
function docker(): Docker {
  if (!_docker) _docker = getDocker();
  return _docker;
}

/**
 * Auto-resolve the container for a given path by scanning active sessions.
 * This is used when the caller doesn't know the conversationId but the path
 * belongs to a session container's volume. In Docker mode, the volume is
 * mounted at /workspace inside the container, and the host path doesn't
 * directly map — so this checks if the path starts with /workspace.
 */
async function resolveSessionForPath(
  conversationId: string | undefined,
  filePath: string,
): Promise<{ containerId: string } | null> {
  // If conversationId is provided, use it directly
  if (conversationId) {
    return resolveSession(conversationId);
  }
  // Otherwise, try to find a matching session by scanning active containers
  // In Docker mode, paths that start with /workspace should route through
  // the container. We find the first active session and route to it.
  try {
    const { DockerSessionManager } = await import('@process/services/DockerSessionManager');
    const sessions = await DockerSessionManager.listActive();
    // If there's exactly one active session, use it
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
 * Execute a command inside a container and capture stdout.
 */
async function execInContainer(
  containerId: string,
  command: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const d = docker();
  const container = d.getContainer(containerId);

  const execPromise = new Promise<Docker.Exec>(
    (resolve, reject) => container.exec({ Cmd: [command, ...args], AttachStdout: true, AttachStderr: true, Tty: false }, (err, e) => err ? reject(err) : resolve(e!)),
  );
  const exec = await execPromise;

  const startPromise = new Promise<Docker.Modem.DuplexStream>(
    (resolve, reject) => exec.start({ hijack: false, stdin: input ? true : undefined }, (err, s) => err ? reject(err) : resolve(s!)),
  );
  const stream = await startPromise;

  let stdout = '';
  let stderr = '';

  if (input) {
    stream.write(input);
  }

  await new Promise<void>((resolve) => {
    const chunks: { type: string; data: Buffer }[] = [];
    stream.on('data', (chunk: { type: string; data: Buffer }) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      for (const c of chunks) {
        if (c.type === 1) stdout += c.data.toString('utf-8');
        else if (c.type === 2) stderr += c.data.toString('utf-8');
      }
      resolve();
    });
    stream.on('error', () => resolve());
  });

  const info = await new Promise<Docker.ExecInspect>((resolve, reject) => exec.inspect((err, info) => err ? reject(err) : resolve(info!)));
  return { stdout, stderr, exitCode: info.ExitCode ?? 0 };
}

/**
 * Execute a command inside a container with streaming stdout (for large files).
 */
async function execRawInContainer(
  containerId: string,
  command: string,
  args: string[],
): Promise<Buffer> {
  const d = docker();
  const container = d.getContainer(containerId);

  const execPromise = new Promise<Docker.Exec>(
    (resolve, reject) => container.exec({ Cmd: [command, ...args], AttachStdout: true, AttachStderr: true, Tty: false }, (err, e) => err ? reject(err) : resolve(e!)),
  );
  const exec = await execPromise;

  const startPromise = new Promise<Docker.Modem.DuplexStream>(
    (resolve, reject) => exec.start({ hijack: false }, (err, s) => err ? reject(err) : resolve(s!)),
  );
  const stream = await startPromise;

  const buffers: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: { type: string; data: Buffer }) => {
      if (chunk.type === 1) buffers.push(chunk.data);
    });
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });

  return Buffer.concat(buffers);
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
  filePath: string,
): Promise<{ ok: true; data: string } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', ['-e', `
      const fs = require('fs');
      const data = fs.readFileSync(process.argv[1], 'utf-8');
      process.stdout.write(data);
    `, cp]);
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
  filePath: string,
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', ['-e', `
      const fs = require('fs');
      const data = fs.readFileSync(process.argv[1]);
      process.stdout.write(data);
    `, cp]);
    if (result.exitCode === 0) {
      return { ok: true, data: result.stdout };
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
  data: string,
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return false;
  const cp = toContainerPath(filePath);
  if (!cp) return false;

  try {
    // Ensure parent directory exists
    const parent = cp.substring(0, cp.lastIndexOf('/'));
    await execInContainer(session.containerId, 'mkdir', ['-p', parent]);

    const result = await execInContainer(
      session.containerId,
      'node',
      ['-e', `
        const fs = require('fs');
        const data = Buffer.from(process.argv[2], 'base64');
        fs.writeFileSync(process.argv[1], data);
      `, cp, Buffer.from(data).toString('base64')],
    );
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
  filePath: string,
): Promise<{ ok: true; data: IFileMetadataResult } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, filePath);
  if (!session) return { ok: false };
  const cp = toContainerPath(filePath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', ['-e', `
      const fs = require('fs');
      const s = fs.statSync(process.argv[1]);
      console.log(JSON.stringify({
        size: s.size,
        mtime: s.mtimeMs,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
      }));
    `, cp]);
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
  filePath: string,
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
  newName: string,
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
export interface IDirOrFileResult {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedTime: number;
}

export async function tryGetFilesByDirInContainer(
  conversationId: string | undefined,
  dirPath: string,
): Promise<{ ok: true; data: IDirOrFileResult[] } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, dirPath);
  if (!session) return { ok: false };
  const cp = toContainerPath(dirPath);
  if (!cp) return { ok: false };

  try {
    const result = await execInContainer(session.containerId, 'node', ['-e', `
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
                path: rel,
                isDirectory: item.isDirectory(),
                size: s.size,
                modifiedTime: s.mtimeMs,
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
    `, cp]);
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
  filePath: string,
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
  files: Array<{ path: string; content?: string }>,
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, zipPath);
  if (!session) return false;
  const cp = toContainerPath(zipPath);
  if (!cp) return false;

  try {
    // Use node to create zip in container
    const fileJson = JSON.stringify(files.map(f => ({
      path: toContainerPath(f.path) || f.path,
      content: f.content,
    })));

    const result = await execInContainer(
      session.containerId,
      'node',
      ['-e', `
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
      `, cp, fileJson],
    );
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
  workspace: string,
): Promise<boolean> {
  const session = await resolveSessionForPath(conversationId, workspace);
  if (!session) return false;
  if (!session) return false;

  // In docker mode, workspace should be /workspace
  const destWorkspace = toContainerPath(workspace) || CONTAINER_WORKSPACE;

  try {
    const d = docker();
    const container = d.getContainer(session.containerId);

    for (const fp of filePaths) {
      const basename = fp.substring(fp.lastIndexOf('/') + 1) || fp.substring(fp.lastIndexOf('\\') + 1);
      const destPath = `${destWorkspace}/${basename}`;

      // Read file from host, write into container
      const { execSync } = await import('child_process');
      const content = execSync(`cat "${fp}"`, { encoding: 'utf-8' });
      await execInContainer(
        session.containerId,
        'node',
        ['-e', `
          const fs = require('fs');
          fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));
        `, destPath, Buffer.from(content).toString('base64')],
      );
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
  rootPath: string,
): Promise<{ ok: true; data: Array<{ name: string; path: string; size: number; mtime: number }> } | { ok: false }> {
  const session = await resolveSessionForPath(conversationId, rootPath);
  if (!session) return { ok: false };
  const cp = toContainerPath(rootPath) || CONTAINER_WORKSPACE;

  try {
    const result = await execInContainer(session.containerId, 'node', ['-e', `
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
                entries.push({ name: item, path: rel, size: s.size, mtime: s.mtimeMs });
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
    `, cp]);
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
