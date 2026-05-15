import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

/**
 * Build a stub dockerode where the exec stream is a real Node PassThrough.
 * The test interacts with it as if it were the worker's stdin/stdout pair
 * inside the container.
 */
function makeDockerStub() {
  const stream = new PassThrough();
  // Track stderr separately so the demux assertion can run.
  const execInspect = vi.fn().mockResolvedValue({ ExitCode: 0 });
  const exec = {
    start: vi.fn().mockResolvedValue(stream),
    inspect: execInspect,
  };
  const container = {
    id: 'cnt_test',
    exec: vi.fn().mockResolvedValue(exec),
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      // For the test we splice the muxed stream as raw stdout — the real
      // dockerode demuxStream skips frame headers, but our protocol layer
      // tolerates both because it splits on newlines.
      demuxStream: (s: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => {
        s.on('data', (chunk: Buffer) => stdout.write(chunk));
      },
    },
  };
  return { docker, container, exec, stream };
}

describe('DockerPlatformServices.worker.fork', () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    const { __setDockerForPlatformTests } = await import('@/common/platform/DockerPlatformServices');
    __setDockerForPlatformTests(null);
  });

  it('falls back to host child_process.fork when AIONUI_CONTAINER_ID is missing from opts.env', async () => {
    // Auto-fork pathways (e.g. ForkTask.init() inside a constructor) can't
    // resolve a session container synchronously. Without a fallback every
    // such worker would crash on boot — instead the docker implementation
    // delegates to NodePlatformServices.worker.fork so the worker still
    // launches (just without container isolation, until Phase 4B.2 lands
    // an async resolver hook).
    const { DockerPlatformServices } = await import('@/common/platform/DockerPlatformServices');
    const platform = new DockerPlatformServices();
    expect(() => platform.worker.fork('worker.js', [], { env: {} })).not.toThrow();
  });

  it('starts a docker exec with the requested command and AIONUI_TRANSPORT=docker', async () => {
    const stub = makeDockerStub();
    const { DockerPlatformServices, __setDockerForPlatformTests } =
      await import('@/common/platform/DockerPlatformServices');
    __setDockerForPlatformTests(stub.docker as unknown as never);
    const platform = new DockerPlatformServices();

    platform.worker.fork('/host/dist-server/gemini.js', ['--flag'], {
      env: { AIONUI_CONTAINER_ID: 'cnt_test', FOO: 'bar' },
    });

    // exec.start happens async; flush microtasks.
    await new Promise((r) => setImmediate(r));

    expect(stub.docker.getContainer).toHaveBeenCalledWith('cnt_test');
    expect(stub.container.exec).toHaveBeenCalledOnce();
    const execArgs = stub.container.exec.mock.calls[0][0];
    expect(execArgs.Cmd).toEqual(['bun', '/opt/aionui/dist-server/gemini.js', '--flag']);
    expect(execArgs.Env).toContain('AIONUI_TRANSPORT=docker');
    expect(execArgs.Env).toContain('FOO=bar');
    expect(execArgs.AttachStdin).toBe(true);
    expect(execArgs.AttachStdout).toBe(true);
    expect(execArgs.Tty).toBe(false);
  });

  it('emits a "message" event for each NDJSON line received on stdout', async () => {
    const stub = makeDockerStub();
    const { DockerPlatformServices, __setDockerForPlatformTests } =
      await import('@/common/platform/DockerPlatformServices');
    __setDockerForPlatformTests(stub.docker as unknown as never);

    const platform = new DockerPlatformServices();
    const worker = platform.worker.fork('worker.js', [], { env: { AIONUI_CONTAINER_ID: 'cnt_test' } });
    const messages: unknown[] = [];
    worker.on('message', (msg) => messages.push(msg));

    await new Promise((r) => setImmediate(r));

    // Worker writes two complete JSON lines + one partial.
    stub.stream.write('{"type":"hello","data":1}\n');
    stub.stream.write('{"type":"second","data":2}\n{"type":"partial"');
    await new Promise((r) => setImmediate(r));
    stub.stream.write(',"data":3}\n');
    await new Promise((r) => setImmediate(r));

    expect(messages).toEqual([
      { type: 'hello', data: 1 },
      { type: 'second', data: 2 },
      { type: 'partial', data: 3 },
    ]);
  });

  it('buffers postMessage calls made before the exec stream is ready', async () => {
    const stub = makeDockerStub();
    const { DockerPlatformServices, __setDockerForPlatformTests } =
      await import('@/common/platform/DockerPlatformServices');
    __setDockerForPlatformTests(stub.docker as unknown as never);
    const platform = new DockerPlatformServices();
    const worker = platform.worker.fork('worker.js', [], { env: { AIONUI_CONTAINER_ID: 'cnt_test' } });

    // Synchronously post a message right after fork — stream not attached yet.
    worker.postMessage({ type: 'start', data: { x: 1 } });

    // Capture everything written to the duplex.
    const writeSpy = vi.spyOn(stub.stream, 'write');
    await new Promise((r) => setImmediate(r));

    // After the stream attaches the buffered message must have been drained.
    const drained = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(drained.some((line) => line.includes('"type":"start"'))).toBe(true);
  });

  it('fires the "exit" event with the inspect exit code when the stream ends', async () => {
    const stub = makeDockerStub();
    stub.exec.inspect.mockResolvedValue({ ExitCode: 42 });
    const { DockerPlatformServices, __setDockerForPlatformTests } =
      await import('@/common/platform/DockerPlatformServices');
    __setDockerForPlatformTests(stub.docker as unknown as never);
    const platform = new DockerPlatformServices();
    const worker = platform.worker.fork('worker.js', [], { env: { AIONUI_CONTAINER_ID: 'cnt_test' } });

    const exits: unknown[] = [];
    worker.on('exit', (code) => exits.push(code));
    await new Promise((r) => setImmediate(r));

    stub.stream.end();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([42]);
  });
});
