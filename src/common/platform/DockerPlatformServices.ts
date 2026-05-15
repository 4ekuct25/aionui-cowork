/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'os';
import path from 'path';
import { Buffer } from 'buffer';
import type { Duplex, Writable } from 'stream';
import Docker, { type Container } from 'dockerode';
import type { IPlatformServices, IWorkerProcess } from './IPlatformServices';
import { NodePlatformServices } from './NodePlatformServices';

/**
 * Env var the parent must set so each worker.fork() call can resolve which
 * session container to attach. The DockerSessionManager populates this when
 * preparing the worker environment.
 */
const ENV_CONTAINER_ID = 'AIONUI_CONTAINER_ID';
/** Optional override for the worker bundle directory inside the container. */
const ENV_WORKER_ROOT = 'AIONUI_WORKER_ROOT';

/**
 * Adapter that bridges a long-lived `docker exec` session to the synchronous
 * IWorkerProcess contract expected by ForkTask.
 *
 * The contract surface is tiny — postMessage, on, kill — so we only need to
 * handle three things robustly:
 *   1. postMessage may be called before the exec stream is attached (the
 *      exec.start round-trip is async). Queue early writes and drain when
 *      the duplex resolves.
 *   2. Stdout from `docker exec` arrives multiplexed (TTY-off) — frames carry
 *      a 1-byte stream id + 3 reserved + 4 LE length + payload. dockerode
 *      ships a `modem.demuxStream` helper that splits it; we delegate.
 *   3. NDJSON parsing on the worker→main direction lives in this class too,
 *      so callers only see typed JS objects.
 */
class DockerWorkerProcess implements IWorkerProcess {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private stdin: Writable | null = null;
  /** Buffer for partial NDJSON lines from stdout. */
  private stdoutBuffer = '';
  /** Buffered postMessage calls issued before the exec stream attached. */
  private pendingWrites: string[] = [];
  private exited = false;
  /** Captured from exec.inspect() so on('exit', code) can fire. */
  private exitCode: number | null = null;
  /** Set when kill() is called so the natural exit handler can be a no-op. */
  private killRequested = false;

  constructor(
    docker: Docker,
    private readonly container: Container,
    cmd: string[],
    env: NodeJS.ProcessEnv,
    cwd: string | undefined
  ) {
    void this.startExec(docker, cmd, env, cwd);
  }

  private async startExec(
    docker: Docker,
    cmd: string[],
    env: NodeJS.ProcessEnv,
    cwd: string | undefined
  ): Promise<void> {
    try {
      // Tell the worker process to talk NDJSON over stdio. The pipe.ts
      // module in the worker checks AIONUI_TRANSPORT=docker to switch
      // transport.
      const envArray = Object.entries({ ...env, AIONUI_TRANSPORT: 'docker' })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`);

      const exec = await this.container.exec({
        Cmd: cmd,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        WorkingDir: cwd,
        Env: envArray,
      });

      const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
      this.stdin = stream;

      // dockerode multiplexes stdout/stderr in TTY-off mode. We pipe through
      // a virtual writable that lets us own the byte stream without spawning
      // extra Node streams.
      const stdoutSink = new (require('stream').Writable)({
        write: (chunk: Buffer, _enc: string, cb: () => void) => {
          this.absorbStdout(chunk);
          cb();
        },
      });
      const stderrSink = new (require('stream').Writable)({
        write: (chunk: Buffer, _enc: string, cb: () => void) => {
          // Surface stderr as 'log' events so callers can route it without
          // hijacking on('message') handlers.
          this.dispatch('stderr', chunk.toString('utf8'));
          cb();
        },
      });
      // `modem.demuxStream(stream, stdout, stderr)` is the canonical way
      // to read non-TTY exec output.
      docker.modem.demuxStream(stream, stdoutSink, stderrSink);

      // Drain anything postMessage'd before the stream was ready.
      for (const line of this.pendingWrites) {
        this.stdin.write(line);
      }
      this.pendingWrites = [];

      stream.on('end', () => {
        void this.handleStreamEnd(exec);
      });
      stream.on('error', (err) => {
        if (!this.exited) {
          this.dispatch('error', err);
        }
      });
    } catch (err) {
      this.dispatch('error', err as Error);
      this.exited = true;
      this.dispatch('exit', 1);
    }
  }

  /** Parse multiplexed stdout into NDJSON messages. */
  private absorbStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        // Match the existing worker IPC shape: handlers get a single arg.
        this.dispatch('message', parsed);
      } catch (err) {
        console.error('[DockerWorker] malformed JSON from worker stdout, dropped:', err);
      }
    }
  }

  private async handleStreamEnd(exec: { inspect: () => Promise<{ ExitCode?: number | null }> }): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    try {
      const info = await exec.inspect();
      this.exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : this.killRequested ? 0 : 1;
    } catch {
      this.exitCode = this.killRequested ? 0 : 1;
    }
    this.dispatch('exit', this.exitCode ?? 0);
  }

  private dispatch(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    // Iterate a snapshot so handlers can off() themselves safely.
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[DockerWorker] listener for "${event}" threw:`, err);
      }
    }
  }

  postMessage(message: unknown): void {
    if (this.exited) {
      return;
    }
    const line = JSON.stringify(message) + '\n';
    if (this.stdin) {
      this.stdin.write(line);
    } else {
      // Buffer until startExec resolves. Capacity is unbounded by design;
      // ForkTask is expected to send a constant-bounded set of bootstrap
      // messages immediately after fork.
      this.pendingWrites.push(line);
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return this;
  }

  kill(): void {
    this.killRequested = true;
    if (this.exited) return;
    if (this.stdin) {
      try {
        this.stdin.end();
      } catch {
        // ignore — stream may already be torn down
      }
    }
    // The worker exits on stdin EOF (see pipe.ts handler). If it doesn't,
    // the container itself will be reaped when DockerSessionManager.destroy
    // runs; we don't issue a separate `kill -9` here because docker exec
    // doesn't expose process group control through the JS SDK.
  }
}

/**
 * Singleton Docker handle reused across all worker.fork calls in this
 * process. dockerode keeps an internal keep-alive agent so a single
 * instance is cheaper than re-creating one each time.
 */
let _dockerSingleton: Docker | null = null;
function getDocker(): Docker {
  if (!_dockerSingleton) {
    _dockerSingleton = new Docker();
  }
  return _dockerSingleton;
}

/**
 * Override the docker handle in tests. Reset by passing null.
 */
export function __setDockerForPlatformTests(docker: Docker | null): void {
  _dockerSingleton = docker;
}

/**
 * IPlatformServices implementation that hosts worker processes inside an
 * existing session container. Used in the multi-tenant web deployment when
 * AIONUI_PLATFORM=docker is set.
 *
 * Non-worker capabilities (paths, power, notification, network) are
 * delegated to NodePlatformServices because the control-plane process is
 * still a plain Node server.
 */
export class DockerPlatformServices implements IPlatformServices {
  private readonly node = new NodePlatformServices();

  paths = this.node.paths;
  power = this.node.power;
  notification = this.node.notification;
  network = this.node.network;

  worker = {
    fork: (
      modulePath: string,
      args: string[],
      opts: { cwd?: string; env?: Record<string, string> }
    ): IWorkerProcess => {
      const env = { ...(opts.env ?? {}) };
      const containerId = env[ENV_CONTAINER_ID];
      if (!containerId) {
        throw new Error(
          `DockerPlatformServices.worker.fork requires ${ENV_CONTAINER_ID} in opts.env (caller must pre-resolve the session container)`
        );
      }

      // Path inside the container where dist-server bundle is mounted. The
      // session-runtime image will mount the control-plane's worker bundle
      // at /opt/aionui by default; override via env for tests / atypical
      // deployments.
      const workerRoot = env[ENV_WORKER_ROOT] ?? '/opt/aionui';
      // Rewrite host modulePath → container path so callers can keep using
      // the same string they pass to NodePlatformServices.
      const moduleBasename = path.basename(modulePath);
      const containerModulePath = path.posix.join(workerRoot, 'dist-server', moduleBasename);

      const docker = getDocker();
      const container = docker.getContainer(containerId);
      return new DockerWorkerProcess(docker, container, ['bun', containerModulePath, ...args], env, opts.cwd);
    },
  };
}

/** Re-export the env name so callers (DockerSessionManager) can populate it. */
export const DOCKER_PLATFORM_ENV = {
  CONTAINER_ID: ENV_CONTAINER_ID,
  WORKER_ROOT: ENV_WORKER_ROOT,
} as const;

// Local stub so the symbol used above resolves; the real Buffer comes from
// global Node typings (already imported at top).
void Buffer;
void os;
