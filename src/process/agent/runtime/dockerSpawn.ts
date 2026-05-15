/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import { PassThrough, Writable, type Readable } from 'stream';
import Docker, { type Container, type Exec } from 'dockerode';

/**
 * Subset of `node:child_process` ChildProcess that agent code actually uses.
 *
 * The fields are deliberately minimal — `aionrs` and the ACP connectors
 * touch `stdin.write`, `stdout`/`stderr` as streams, `kill()`, and the
 * `'exit'` / `'error'` events. They never call `unref`, `disconnect`,
 * `send`, etc., so we don't have to fake the long tail of ChildProcess
 * surface.
 */
export type ChildProcessLike = {
  pid: number | null;
  /** Always present and writable while the process is alive. */
  stdin: Writable;
  /** Demultiplexed stdout from `docker exec` (TTY-off). */
  stdout: Readable;
  /** Demultiplexed stderr from `docker exec`. */
  stderr: Readable;
  /** Mirrors ChildProcess.killed — true once kill() has been called. */
  readonly killed: boolean;
  /** Send a kill signal. Best-effort — see implementation note in kill(). */
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Node-style event registration. Emits 'exit' (code, signal), 'error', 'close'. */
  on: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  once: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  off: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  /** Decouple stdio from parent lifecycle — no-op for docker exec but kept for API parity with ChildProcess.unref(). */
  unref?: () => void;
};

export type DockerSpawnOptions = {
  /** Session container ID resolved by DockerSessionManager. */
  containerId: string;
  /** Optional env vars merged with the container's defaults. */
  env?: Record<string, string>;
  /** Working directory inside the container. Defaults to /workspace. */
  cwd?: string;
  /** Reused dockerode handle when present; otherwise a new one is created. */
  docker?: Docker;
};

/**
 * Singleton handle so all dockerSpawn calls share one keep-alive agent.
 * Honours DOCKER_HOST so the control-plane can go through
 * tecnativa/docker-socket-proxy (Phase 8.2) instead of /var/run/docker.sock.
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
    // ignore — fall through to the dockerode default
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

/** For tests — inject a stub docker. Reset by passing null. */
export function __setDockerForSpawnTests(docker: Docker | null): void {
  _docker = docker;
}

/**
 * Launch a process inside an existing session container, exposing a
 * ChildProcess-like API so existing agent code (aionrs, ACP connectors)
 * can swap host `child_process.spawn` for this with minimal change.
 *
 * Returns synchronously — the underlying `docker exec` start round-trip
 * happens asynchronously, but writes to `stdin` made before the stream
 * attaches are buffered and drained when it does.
 *
 * Stdout/stderr arrive via dockerode's demuxStream helper; consumers see
 * them as plain Readable streams.
 */
export function dockerSpawn(command: string, args: string[], options: DockerSpawnOptions): ChildProcessLike {
  const docker = options.docker ?? getDocker();
  const container: Container = docker.getContainer(options.containerId);

  const stdinPassthrough = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  let upstreamStdin: Writable | null = null;
  let exited = false;
  let killRequested = false;
  let killSignalUsed: NodeJS.Signals | number | undefined;
  let pid: number | null = null;
  // Buffer writes until exec.start resolves. The PassThrough naturally
  // queues but we explicitly forward chunks once upstreamStdin attaches so
  // backpressure is preserved end-to-end.
  const pending: Buffer[] = [];

  stdinPassthrough.on('data', (chunk: Buffer) => {
    if (upstreamStdin) {
      upstreamStdin.write(chunk);
    } else {
      pending.push(chunk);
    }
  });
  stdinPassthrough.on('end', () => {
    if (upstreamStdin) upstreamStdin.end();
  });

  const envArray = Object.entries(options.env ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);

  void (async () => {
    let exec: Exec | null = null;
    try {
      exec = await container.exec({
        Cmd: [command, ...args],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: options.cwd ?? '/workspace',
        Env: envArray,
      });

      const stream = await exec.start({ hijack: true, stdin: true });
      upstreamStdin = stream as unknown as Writable;
      // Flush any pre-attach writes.
      while (pending.length > 0) {
        upstreamStdin.write(pending.shift()!);
      }

      docker.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, stdout, stderr);

      (stream as unknown as Readable).on('end', () => {
        void finishWithInspect(exec!);
      });
      (stream as unknown as Readable).on('error', (err: Error) => {
        if (!exited) emitter.emit('error', err);
      });

      // Container exec doesn't surface a host PID, but `exec.inspect` does
      // after start. Resolve it best-effort so consumers that just want to
      // log a number don't see `null`.
      try {
        const info = await exec.inspect();
        const inspectPid = (info as unknown as { Pid?: number }).Pid;
        if (typeof inspectPid === 'number' && inspectPid > 0) {
          pid = inspectPid;
        }
      } catch {
        // ignore — pid is purely informational
      }
    } catch (err) {
      emitter.emit('error', err as Error);
      exited = true;
      emitter.emit('exit', 1, null);
      emitter.emit('close', 1, null);
      stdout.end();
      stderr.end();
    }
  })();

  async function finishWithInspect(exec: Exec): Promise<void> {
    if (exited) return;
    exited = true;
    let exitCode: number | null = null;
    try {
      const info = await exec.inspect();
      exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : killRequested ? 0 : 1;
    } catch {
      exitCode = killRequested ? 0 : 1;
    }
    emitter.emit('exit', exitCode, killSignalUsed ?? null);
    emitter.emit('close', exitCode, killSignalUsed ?? null);
    stdout.end();
    stderr.end();
  }

  return {
    get pid() {
      return pid;
    },
    stdin: stdinPassthrough,
    stdout,
    stderr,
    get killed() {
      return killRequested || exited;
    },
    unref() {
      // No-op — docker exec doesn't keep the parent event loop alive.
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      // `docker exec` doesn't expose a clean signal-delivery API through
      // dockerode (the underlying engine endpoint exists but is awkward).
      // We close stdin which is the agreed-upon shutdown contract for our
      // workers (see pipe.ts), and rely on container teardown for any
      // process that ignores stdin EOF.
      killRequested = true;
      killSignalUsed = signal;
      try {
        stdinPassthrough.end();
      } catch {
        // ignore
      }
      if (upstreamStdin) {
        try {
          upstreamStdin.end();
        } catch {
          // ignore
        }
      }
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    once(event, listener) {
      emitter.once(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
  };
}
