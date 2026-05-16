/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import Docker, { type Container } from 'dockerode';
import type { WebSocket } from 'ws';

function parseDockerHost(env: string | undefined): import('dockerode').DockerOptions | null {
  if (!env) return null;
  try {
    const url = new URL(env);
    if (url.protocol === 'unix:') return { socketPath: url.pathname };
    if (url.protocol === 'tcp:' || url.protocol === 'http:' || url.protocol === 'https:') {
      const port = Number(url.port) || (url.protocol === 'https:' ? 2376 : 2375);
      return { host: url.hostname, port, protocol: url.protocol === 'https:' ? 'https' : 'http' };
    }
  } catch { /* ignore */ }
  return null;
}

let _docker: Docker | null = null;
function getDocker(): Docker {
  if (!_docker) {
    _docker = new Docker(parseDockerHost(process.env.DOCKER_HOST) ?? undefined);
  }
  return _docker;
}

export async function attachShellToContainer(
  ws: WebSocket,
  containerId: string,
): Promise<void> {
  console.log('[shellRoute] attachShellToContainer for container', containerId);
  const d = getDocker();
  const container = d.getContainer(containerId);

  // Start a long-running bash process in the container
  // Kill old shell servers
  await container.exec({
    Cmd: ['sh', '-c', 'for pid in $(ls /proc 2>/dev/null | grep -E "^[0-9]+$"); do if [ -f /proc/$pid/cmdline ] && tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null | grep -q "shell-server"; then kill $pid 2>/dev/null; fi; done; rm -f /tmp/shell-ws'],
    AttachStdout: false,
    AttachStderr: false,
  }).then((e) => e.start({ hijack: false }).then(() => new Promise(r => setTimeout(r, 1000))));

  // Write shell server to file (avoids inline quoting issues)
  const serverScript =
    'var net=require("net");\n' +
    'var cp=require("child_process");\n' +
    'var fs=require("fs");\n' +
    'var server=net.createServer(function(s){\n' +
    '  var buf="";\n' +
    '  var child=cp.spawn("bash",["-i"],{env:Object.assign({},process.env,{TERM:"xterm-256color"}),cwd:"/workspace",stdin:"pipe",stdout:"pipe",stderr:"pipe"});\n' +
    '  s.on("data",function(d){child.stdin.write(d)});\n' +
    '  child.stdout.on("data",function(d){s.write(d)});\n' +
    '  child.stderr.on("data",function(d){s.write(d)});\n' +
    '  child.on("exit",function(){s.end("\\r\\n[exited]\\r\\n")});\n' +
    '  s.on("end",function(){try{child.kill()}catch(e){}});\n' +
    '  s.on("close",function(){try{child.kill()}catch(e){}});\n' +
    '});\n' +
    'server.listen(0,"0.0.0.0",function(){fs.writeFileSync("/tmp/shell-ws",JSON.stringify(server.address()))});\n';

  // Write script to file
  const writeB64 = Buffer.from(serverScript).toString('base64');
  await container.exec({
    Cmd: ['sh', '-c', `echo '${writeB64}' | base64 -d > /tmp/shell-server.js`],
    AttachStdout: false,
    AttachStderr: false,
  }).then((e) => e.start({ hijack: false }));

  // Start the shell server
  const exec = await container.exec({
    Cmd: ['node', '/tmp/shell-server.js'],
    AttachStdout: false,
    AttachStderr: false,
    Detached: true,
    Tty: false,
  });

  await exec.start({ hijack: false });
  console.log('[shellRoute] Shell server process started (exec)', exec.id.substring(0, 12));

  // Helper: drain exec stream and strip Docker HDLC framing bytes (0x01 prefix + length)
  const drainExec = async (execInst: any): Promise<string> => {
    const s = await execInst.start({ hijack: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('end', resolve);
      s.on('error', resolve);
      setTimeout(resolve, 2000);
    });
    const raw = Buffer.concat(chunks);
    // Docker wraps stdout/stderr frames: frameType(1) + streamID(1) + length(4) + data
    // For non-hijacked exec, each 8-byte frame header precedes the payload
    // Strip all non-printable prefix bytes
    let start = 0;
    while (start < raw.length && raw[start] < 0x20) start++;
    return raw.slice(start).toString('utf8');
  };

  // Wait for the server to write its port file (5s total with 250ms intervals)
  let port: number | null = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const checkExec = await container.exec({
        Cmd: ['sh', '-c', 'cat /tmp/shell-ws 2>/dev/null || echo NOFILE'],
        AttachStdout: true,
      });
      const out = await drainExec(checkExec);
      const trimmed = out.trim();
      console.log(`[shellRoute] Port check attempt ${i+1}: "${trimmed.substring(0, 60)}"`);
      if (trimmed.includes('NOFILE')) continue;
      const jsonMatch = trimmed.match(/\{[^}]+\}/);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && parsed.port) {
        port = parsed.port;
        break;
      }
    } catch (err) {
      console.log(`[shellRoute] Port check attempt ${i+1} failed:`, (err as Error).message);
    }
  }

  if (!port) {
    console.error('[shellRoute] Shell server did not start in time');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n\x1b[31m[shell error] Server startup timeout\x1b[0m\r\n');
    }
    ws.close(1011, 'Shell server timeout');
    return;
  }

  console.log('[shellRoute] Shell server listening on port', port);

  // Get container IP
  const info = await container.inspect();
  const networks = info.NetworkSettings?.Networks || {};
  let containerIp: string | null = networks['aionui-cowork_default']?.IPAddress || null;
  if (!containerIp) {
    for (const [name, nw] of Object.entries(networks)) {
      if (nw.IPAddress && name !== 'bridge') { containerIp = nw.IPAddress; break; }
    }
  }
  if (!containerIp) containerIp = info.NetworkSettings?.IPAddress || '127.0.0.1';
  console.log('[shellRoute] Connecting to shell server at', containerIp, port);

  // Connect via TCP to the shell server inside the container
  const net = await import('net');
  const tcpSocket = net.createConnection({ host: containerIp, port }, () => {
    console.log('[shellRoute] Connected to shell server');
  });

  tcpSocket.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  tcpSocket.on('error', (err) => {
    console.error('[shellRoute] TCP error:', err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n\x1b[31m[shell error] ' + err.message + '\x1b[0m\r\n');
    }
  });

  tcpSocket.on('end', () => {
    console.log('[shellRoute] Shell ended');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');
    }
  });

  ws.on('message', (data) => {
    if (typeof data === 'string') return;
    const buf = Buffer.from(data as ArrayBuffer);
    if (buf[0] === 0x01 && buf.length >= 5) return; // skip resize
    if (tcpSocket.writable) {
      tcpSocket.write(buf);
    }
  });

  const cleanup = () => {
    tcpSocket.destroy();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
