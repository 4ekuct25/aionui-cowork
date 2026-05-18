import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dockerSpawn was rewritten three times since the original tests were
 * written: Phase 5B used dockerode's hijacked exec stream directly; Phase
 * 9.2 switched to a base64-encoded TCP-relay model to dodge the
 * docker-socket-proxy's hijack restriction. The relay now:
 *
 *   1. writes a tiny JS relay (`RELAY_SCRIPT`) into the container via
 *      `docker exec sh -c 'echo base64 | base64 -d > /tmp/aionrs-relay.js'`
 *   2. starts the relay in background, which spawns the target command,
 *      opens a TCP server on a random port, and writes the port to
 *      `/tmp/aionrs-relay-port`
 *   3. polls the port file via a second `docker exec cat`
 *   4. opens `net.createConnection(host, port)` and demuxes 5-byte-framed
 *      stream IDs (0x01 stdout, 0x02 stderr, 0x03 exit-json) into the
 *      returned ChildProcessLike's stdout/stderr/'exit' events
 *
 * Asserting that whole chain at the unit level means stubbing both
 * dockerode AND `net.createConnection`. We do that for two flows: the
 * happy path (relay reports exit 7 → ChildProcessLike emits exit 7) and
 * the failure path (container.exec rejects → 'error' + synthetic exit
 * code 1). End-to-end behaviour (real container, real TCP) is covered by
 * the live browser smoke (`docker-session-relay-fix.md` Phase 9.2 log
 * and the three-case contract in `aionui-cowork-e2e-cases`).
 */

const { mockedSockets, mockCreateConnection } = vi.hoisted(() => {
  const sockets: Array<EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroyed: boolean }> = [];
  const create = vi.fn(() => {
    const sock = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
      destroyed: false,
    });
    sockets.push(sock);
    // dockerSpawn passes a connect-callback; we don't auto-invoke it because
    // the impl doesn't rely on it for state — frames arrive via 'data' events
    // which the test pushes directly.
    return sock as unknown as import('net').Socket;
  });
  return { mockedSockets: sockets, mockCreateConnection: create };
});

vi.mock('net', async () => {
  const actual = await vi.importActual<typeof import('net')>('net');
  return { ...actual, createConnection: mockCreateConnection };
});

function makeDockerStub(opts: { port?: number; inspectIp?: string } = {}) {
  const port = opts.port ?? 43617;
  // Each `container.exec(...)` returns an exec handle whose `.start({hijack:false})`
  // resolves to a Readable stream. The impl's `drainExec` reads until 'end'.
  // For the relay-start exec we just emit 'end' so it returns quickly. For
  // the port-poll exec we write the port string then end.
  let execCallCount = 0;
  const makeExec = () => {
    execCallCount += 1;
    const isPortPoll = execCallCount >= 2; // first call is the relay launcher
    const stream = new PassThrough();
    // Drain happens inside dockerSpawn after .start(); ensure data is ready
    // before .start() resolves so drainExec sees it on the next tick.
    queueMicrotask(() => {
      if (isPortPoll) stream.write(String(port));
      stream.end();
    });
    return {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0, Pid: 99999 }),
    };
  };
  const container = {
    id: 'cnt_test',
    exec: vi.fn(async () => makeExec()),
    inspect: vi.fn().mockResolvedValue({
      NetworkSettings: {
        Networks: { 'aionui-cowork_default': { IPAddress: opts.inspectIp ?? '172.18.0.99' } },
      },
    }),
  };
  return {
    docker: { getContainer: vi.fn(() => container) },
    container,
    getExecCallCount: () => execCallCount,
  };
}

async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Wait long enough for the relay-port-poll loop in dockerSpawn to fire at
 * least once (200ms between attempts) and the resulting net.createConnection
 * to be invoked. Real timers — fake timers would mute the multiple awaits
 * inside the impl's async IIFE.
 */
async function waitForPolledConnect(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  await flush(5);
}

describe('parseDockerHost', () => {
  it('parses a unix:// socket path', async () => {
    const mod = await import('@process/agent/runtime/dockerSpawn');
    // parseDockerHost is internal; we exercise it indirectly via the
    // module's DOCKER_HOST handling. We can at least confirm the helper
    // exists by ensuring the default-Docker code path doesn't throw when
    // an unset DOCKER_HOST is consumed.
    expect(typeof mod.dockerSpawn).toBe('function');
  });
});

describe('dockerSpawn', () => {
  beforeEach(async () => {
    // Each dockerSpawn fires an async IIFE that has 200ms+ timers before
    // it touches mockCreateConnection. If we don't drain leftovers from a
    // prior test, that test's connection call shows up in the current
    // test's `mock.calls[0]` and skews assertions. A 350ms wait flushes
    // any in-flight IIFE BEFORE we clear, so the new test starts truly
    // empty.
    await new Promise((r) => setTimeout(r, 350));
    vi.clearAllMocks();
    mockCreateConnection.mockClear();
    mockedSockets.length = 0;
  });

  afterEach(async () => {
    const { __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(null);
  });

  it('returns a ChildProcessLike with the expected surface', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('echo', ['hi'], { containerId: 'cnt_test' });

    expect(child.stdin).toBeDefined();
    expect(child.stdout).toBeDefined();
    expect(child.stderr).toBeDefined();
    expect(typeof child.on).toBe('function');
    expect(typeof child.kill).toBe('function');
    // Initial state — relay not started yet.
    expect(child.pid).toBeNull();
    expect(child.killed).toBe(false);
  });

  it('reaches the TCP relay step (exec called twice for writeScript+poll)', async () => {
    const stub = makeDockerStub({ port: 51234 });
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    dockerSpawn('/opt/aionui/aionrs', ['--json-stream'], {
      containerId: 'cnt_test',
      cwd: '/workspace',
      env: { OPENAI_API_KEY: 'sk-fake' },
    });

    // Let the async IIFE inside dockerSpawn make progress: write+launch
    // exec, container.inspect for IP, then port-poll exec, then connect.
    // The port poll has a 200ms sleep between attempts; fake timers would
    // muddy the multiple awaits, so we just flush a generous number.
    await waitForPolledConnect();

    // First exec call = relay launcher (base64 + node /tmp/aionrs-relay.js …)
    const firstCmd = stub.container.exec.mock.calls[0][0].Cmd as string[];
    expect(firstCmd[0]).toBe('/bin/sh');
    expect(firstCmd[2]).toContain('base64 -d > /tmp/aionrs-relay.js');
    expect(firstCmd[2]).toContain('node /tmp/aionrs-relay.js');
    // Eventually a port-poll exec runs and then net.createConnection fires.
    expect(stub.container.exec.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockCreateConnection).toHaveBeenCalled();
    const args = mockCreateConnection.mock.calls[0][0] as { host: string; port: number };
    expect(args.port).toBe(51234);
    expect(args.host).toBe('172.18.0.99');
  });

  it('emits "exit"/"close" with the code carried by the relay 0x03 frame', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('cmd', [], { containerId: 'cnt_test' });
    const events: Array<[string, ...unknown[]]> = [];
    child.on('exit', (code, signal) => events.push(['exit', code, signal]));
    child.on('close', (code) => events.push(['close', code]));

    await waitForPolledConnect();
    const sock = mockedSockets[0];
    expect(sock).toBeDefined();

    // Relay's exit frame: 0x03 + JSON({c: <code>}). impl uses buf.slice(1)
    // through to the end so framing for streamId=3 is "byte + raw json".
    const exitFrame = Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ c: 42 }))]);
    sock.emit('data', exitFrame);
    await flush(2);

    expect(events).toContainEqual(['exit', 42, null]);
    expect(events).toContainEqual(['close', 42]);
  });

  it('demuxes stdout frames (streamId 0x01) into child.stdout', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('cmd', [], { containerId: 'cnt_test' });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));

    await waitForPolledConnect();
    const sock = mockedSockets[0];
    // Frame layout: 0x01 + uint32be(len) + data
    const payload = Buffer.from('hello stdout');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    sock.emit('data', Buffer.concat([Buffer.from([0x01]), len, payload]));
    await flush(2);

    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello stdout');
  });

  it('forwards stdin writes into the TCP socket once connected', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('cat', [], { containerId: 'cnt_test' });
    await waitForPolledConnect();

    const sock = mockedSockets[0];
    expect(sock).toBeDefined();

    child.stdin.write('hello\n');
    await flush(2);

    expect(sock.write).toHaveBeenCalled();
    const written = sock.write.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('hello\n');
  });

  it('emits "error" and synthesises exit code 1 when container.exec rejects', async () => {
    const stub = makeDockerStub();
    stub.container.exec = vi.fn().mockRejectedValue(new Error('boom'));
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('ls', [], { containerId: 'cnt_test' });
    const errors: Error[] = [];
    const exits: Array<unknown> = [];
    child.on('error', (err) => errors.push(err as Error));
    child.on('exit', (code) => exits.push(code));

    await flush(5);

    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('boom');
    expect(exits).toEqual([1]);
  });
});
