/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import { PassThrough, Writable, type Readable } from 'stream';
import * as net from 'net';
import Docker, { type Container } from 'dockerode';

/**
 * Subset of `node:child_process` ChildProcess that agent code actually uses.
 */
export type ChildProcessLike = {
  pid: number | null;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  readonly killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  once: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  off: (event: 'exit' | 'close' | 'error', listener: (...args: unknown[]) => void) => void;
  unref?: () => void;
};

export type DockerSpawnOptions = {
  containerId: string;
  env?: Record<string, string>;
  cwd?: string;
  docker?: Docker;
};

/**
 * Node.js relay script spawned inside the container. Accepts TCP connections,
 * spawns the target command, and multiplexes stdio:
 *   - TCP input → child.stdin
 *   - child.stdout → TCP frames: 0x01 + uint32be(len) + data
 *   - child.stderr → TCP frames: 0x02 + uint32be(len) + data
 *   - child exit → TCP frame: 0x03 + JSON({code})
 */
const RELAY_SCRIPT = `
var net=require('net'),cp=require('child_process'),fs=require('fs');
var all=process.argv.slice(2);
var portFile=all[all.length-1],cwd=all[all.length-2],envFile=all[all.length-3];
var cmd=all[0],args=all.slice(1,all.length-3);
var envObj=envFile&&envFile.startsWith('/')?JSON.parse(fs.readFileSync(envFile,'utf8')||'{}'):JSON.parse(envFile||'{}');
var child=cp.spawn(cmd,args,{stdio:['pipe','pipe','pipe'],cwd:cwd,env:Object.assign({},process.env,envObj),shell:false});
var srv=net.createServer(function(s){
  s.on('data',function(d){child.stdin.write(d)});
  s.on('end',function(){child.stdin.end()});
  child.stdout.on('data',function(d){s.write(Buffer.concat([Buffer.from([1]),u32(d.length),d]))});
  child.stderr.on('data',function(d){s.write(Buffer.concat([Buffer.from([2]),u32(d.length),d]))});
  child.on('exit',function(code){
    s.write(Buffer.concat([Buffer.from([3]),Buffer.from(JSON.stringify({c:code}))]));
    s.end();
  });
});
srv.listen(0,'0.0.0.0',function(){
  fs.writeFileSync(portFile,String(srv.address().port));
});
function u32(n){var b=Buffer.alloc(4);b.writeUInt32BE(n,0);return b}
`;

/**
 * Strip Docker HDLC framing bytes from non-hijacked exec stream output.
 */
function drainExec(stream: Readable, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      finalize();
      resolve(Buffer.concat(chunks).length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
    }, timeoutMs);
    const finalize = () => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
    };
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      finalize();
      const raw = Buffer.concat(chunks);
      let start = 0;
      while (start < raw.length && (raw[start] > 127 || raw[start] < 32)) start++;
      resolve(start < raw.length ? raw.slice(start) : raw);
    });
    stream.on('error', (err) => {
      finalize();
      reject(err);
    });
  });
}

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
    return null;
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

export function __setDockerForSpawnTests(docker: Docker | null): void {
  _docker = docker;
}

async function getContainerIP(docker: Docker, containerId: string): Promise<string> {
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  const nets = (info.NetworkSettings as { Networks?: Record<string, { IPAddress?: string }> }).Networks;
  if (!nets) return '127.0.0.1';
  const main = nets['aionui-cowork_default'];
  if (main?.IPAddress) return main.IPAddress;
  for (const n of Object.values(nets)) {
    if (n.IPAddress) return n.IPAddress;
  }
  return '127.0.0.1';
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Launch a process inside an existing session container using a TCP relay
 * to avoid the docker-socket-proxy's hijacked TTY limitation.
 *
 * Tecnativa docker-socket-proxy with SESSION=0 blocks hijacked connections
 * (exec.start({ hijack: true })), so we use a TCP-based approach instead:
 * 1. Write relay script to container via base64-encoded detached exec
 * 2. Start relay (spawns target cmd, listens on random TCP port)
 * 3. Poll /tmp/aionrs-relay-port for the assigned port
 * 4. Connect via TCP from control-plane → relay → target process
 */
export function dockerSpawn(command: string, args: string[], options: DockerSpawnOptions): ChildProcessLike {
  const docker = options.docker ?? getDocker();
  const stdinPassthrough = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  let exited = false;
  let killRequested = false;
  let killSignalUsed: NodeJS.Signals | number | undefined;
  let pid: number | null = null;
  let tcpSocket: net.Socket | null = null;

  const cwd = options.cwd ?? '/workspace';
  const portFile = '/tmp/aionrs-relay-port';
  const relayB64 = Buffer.from(RELAY_SCRIPT).toString('base64');
  const envWithHome = Object.assign({}, options.env, { HOME: '/tmp' });
  const envJson = JSON.stringify(envWithHome);
  const envJsonB64 = Buffer.from(envJson).toString('base64');

  void (async () => {
    try {
      // Step 1: Write relay script and start it via detached exec
      const container: Container = docker.getContainer(options.containerId);
      // Write script + decode env from base64 to avoid shell quoting issues entirely
      const writeScript = `echo "${relayB64}" | base64 -d > /tmp/aionrs-relay.js`;
      const envDecode = `echo "${envJsonB64}" | base64 -d > /tmp/aionrs-env.json`;
      console.error('[dockerSpawn] Executing in container', options.containerId.substring(0, 12), 'cmd:', command, 'args:', args.join(' '));
      const startExec = await container.exec({
        Cmd: ['/bin/sh', '-c', `${writeScript} && ${envDecode} && node /tmp/aionrs-relay.js ${command} ${args.join(' ')} /tmp/aionrs-env.json ${cwd} ${portFile} &`],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      try {
        const startStream = await startExec.start({ hijack: false });
        const startData = await drainExec(startStream as unknown as Readable);
        if (startData.length > 0) {
          const s = startData.toString();
          console.error('[dockerSpawn] Exec output:', s.substring(0, 300));
        }
      } catch (execErr: any) {
        console.error('[dockerSpawn] Exec start error:', execErr.message, execErr.statusCode, JSON.stringify(execErr.json ?? {}).substring(0, 300));
        throw execErr;
      }

      // Step 2: Get container IP for TCP connection
      const containerIP = await getContainerIP(docker, options.containerId).catch(() => '127.0.0.1');

      // Step 3: Poll for relay port
      let port = 0;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        const portExec = await container.exec({
          Cmd: ['/bin/sh', '-c', `cat ${portFile} 2>/dev/null || echo ""`],
          AttachStdout: true,
          Tty: false,
        });
        const portStream = await portExec.start({ hijack: false });
        const portData = await drainExec(portStream as unknown as Readable);
        const portStr = portData.toString().trim();
        if (portStr && parseInt(portStr, 10) > 0) {
          port = parseInt(portStr, 10);
          break;
        }
      }

      if (!port) {
        throw new Error('Relay port not found in /tmp/aionrs-relay-port');
      }

      // Step 4: Connect via TCP to relay
      tcpSocket = net.createConnection({ host: containerIP, port }, () => {
        // Connected, stdio piping starts
      });

      // Demux incoming frames
      let buf = Buffer.alloc(0);
      tcpSocket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5) {
          const streamId = buf[0];
          if (streamId === 0x03) {
            try {
              const exitJson = buf.slice(1).toString();
              const exitData = JSON.parse(exitJson);
              finishWithCode(exitData.c ?? 1);
            } catch {
              finishWithCode(1);
            }
            buf = Buffer.alloc(0);
            break;
          }
          const dataLen = buf.readUInt32BE(1);
          if (buf.length < 5 + dataLen) break;
          const data = buf.slice(5, 5 + dataLen);
          buf = buf.slice(5 + dataLen);
          if (streamId === 0x01) {
            stdout.write(data);
          } else if (streamId === 0x02) {
            stderr.write(data);
          }
        }
      });

      tcpSocket.on('error', (err: Error) => {
        if (!exited) {
          console.error('[dockerSpawn] TCP relay error:', err.message);
          emitter.emit('error', err);
          finishWithCode(1);
        }
      });

      tcpSocket.on('end', () => {
        if (!exited) finishWithCode(null);
      });

      // stdinPassthrough → TCP
      stdinPassthrough.on('data', (chunk: Buffer) => {
        if (tcpSocket && !tcpSocket.destroyed) {
          tcpSocket.write(chunk);
        }
      });
      stdinPassthrough.on('end', () => {
        if (tcpSocket && !tcpSocket.destroyed) {
          tcpSocket.end();
        }
      });

      // Get PID from exec inspect
      try {
        const execInfo = await startExec.inspect();
        const inspectPid = (execInfo as unknown as { Pid?: number }).Pid;
        if (typeof inspectPid === 'number' && inspectPid > 0) {
          pid = inspectPid;
        }
      } catch {
        // ignore
      }
    } catch (err) {
      console.error('[dockerSpawn] Failed to spawn via relay:', err);
      emitter.emit('error', err as Error);
      if (!exited) finishWithCode(1);
    }
  })();

  function finishWithCode(code: number | null) {
    if (exited) return;
    exited = true;
    emitter.emit('exit', code, killSignalUsed ?? null);
    emitter.emit('close', code, killSignalUsed ?? null);
    stdout.end();
    stderr.end();
  }

  return {
    get pid() { return pid; },
    stdin: stdinPassthrough,
    stdout,
    stderr,
    get killed() { return killRequested || exited; },
    unref() {},
    kill(signal?: NodeJS.Signals | number): boolean {
      killRequested = true;
      killSignalUsed = signal;
      try { stdinPassthrough.end(); } catch { /* ignore */ }
      return true;
    },
    on(event, listener) { emitter.on(event, listener); },
    once(event, listener) { emitter.once(event, listener); },
    off(event, listener) { emitter.off(event, listener); },
  };
}