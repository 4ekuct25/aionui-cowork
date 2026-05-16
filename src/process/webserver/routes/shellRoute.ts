/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type Container } from 'dockerode';
import type { WebSocket } from 'ws';

/**
 * Singleton dockerode handle for shell operations.
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
 * Attach a WebSocket to a docker exec TTY session. The client sends raw
 * keystrokes and receives raw terminal output. VT100 control sequences
 * (resize, window title) are handled via binary protocol:
 *
 *   Client → Server: 0x01 + rows + cols (uint8, 2 bytes each) for resize
 *   Client → Server: anything else = stdin data
 *   Server → Client: raw stdout bytes from docker exec
 */
export async function attachShellToContainer(
  ws: WebSocket,
  containerId: string,
): Promise<void> {
  const d = getDocker();
  const container: Container = d.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['bash', '--login'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: '/workspace',
    Env: ['TERM=xterm-256color', 'LANG=en_US.UTF-8'],
  });

  const stream = await exec.start({ hijack: true, stdin: true });

  const upstream = stream as unknown as NodeJS.WritableStream;

  // Forward terminal output → WebSocket
  (stream as unknown as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    if (ws.readyState === 1) {
      ws.send(chunk, { binary: true });
    }
  });

  (stream as unknown as NodeJS.ReadableStream).on('end', () => {
    if (ws.readyState === 1) {
      ws.close();
    }
  });

  (stream as unknown as NodeJS.ReadableStream).on('error', (err: Error) => {
    if (ws.readyState === 1) {
      ws.send(`\r\n\x1b[31m[shell error] ${err.message}\x1b[0m\r\n`);
      ws.close();
    }
  });

  // Forward WebSocket → terminal stdin
  ws.on('message', (data) => {
    if (typeof data === 'string') return;

    const buf = Buffer.from(data as ArrayBuffer);

    if (buf[0] === 0x01 && buf.length >= 5) {
      const rows = buf.readUInt16LE(1);
      const cols = buf.readUInt16LE(3);
      try {
        (exec as unknown as { resize: (opts: { h: number; w: number }) => Promise<void> }).resize({ h: rows, w: cols });
      } catch {
        // ignore resize errors
      }
      return;
    }

    upstream.write(buf);
  });

  ws.on('close', () => {
    try {
      upstream.end();
    } catch {
      // ignore
    }
  });

  ws.on('error', () => {
    try {
      upstream.end();
    } catch {
      // ignore
    }
  });
}
