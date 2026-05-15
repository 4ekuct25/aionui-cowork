import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

function makeDockerStub(execOverrides: Partial<{ inspectResult: unknown }> = {}) {
  const stream = new PassThrough();
  const exec = {
    start: vi.fn().mockResolvedValue(stream),
    inspect: vi.fn().mockResolvedValue(execOverrides.inspectResult ?? { ExitCode: 0, Pid: 12345 }),
  };
  const container = {
    id: 'cnt_test',
    exec: vi.fn().mockResolvedValue(exec),
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      // Real demuxStream splits frames, but our tests write directly to the
      // PassThrough so a simple forward is enough.
      demuxStream: (s: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => {
        s.on('data', (chunk: Buffer) => stdout.write(chunk));
      },
    },
  };
  return { docker, container, exec, stream };
}

async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('dockerSpawn', () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    const { __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(null);
  });

  it('starts an exec with the requested command, working dir and env', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    dockerSpawn('bun', ['/opt/aionui/aionrs/main.js'], {
      containerId: 'cnt_test',
      cwd: '/workspace/project-a',
      env: { OPENAI_API_KEY: 'sk-fake' },
    });

    await flush();

    expect(stub.docker.getContainer).toHaveBeenCalledWith('cnt_test');
    const execArgs = stub.container.exec.mock.calls[0][0];
    expect(execArgs.Cmd).toEqual(['bun', '/opt/aionui/aionrs/main.js']);
    expect(execArgs.WorkingDir).toBe('/workspace/project-a');
    expect(execArgs.Env).toContain('OPENAI_API_KEY=sk-fake');
    expect(execArgs.Tty).toBe(false);
    expect(execArgs.AttachStdin).toBe(true);
  });

  it('buffers stdin writes made before the exec stream attaches', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('cat', [], { containerId: 'cnt_test' });
    child.stdin.write('hello\n');

    const writeSpy = vi.spyOn(stub.stream, 'write');
    await flush();

    expect(writeSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('hello\n');
  });

  it('routes stdout chunks through the demux helper into the child stdout stream', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('echo', ['hi'], { containerId: 'cnt_test' });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    await flush();
    stub.stream.write('first ');
    stub.stream.write('chunk\n');
    await flush();

    expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe('first chunk\n');
  });

  it('emits "exit" with the exit code reported by exec.inspect when the stream ends', async () => {
    const stub = makeDockerStub({ inspectResult: { ExitCode: 7, Pid: 0 } });
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('false', [], { containerId: 'cnt_test' });
    const events: unknown[] = [];
    child.on('exit', (code, signal) => events.push(['exit', code, signal]));
    child.on('close', (code) => events.push(['close', code]));

    await flush();
    stub.stream.end();
    await flush(2);

    expect(events).toContainEqual(['exit', 7, null]);
    expect(events).toContainEqual(['close', 7]);
  });

  it('kill() ends stdin and the exit event carries the requested signal', async () => {
    const stub = makeDockerStub();
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('sleep', ['9999'], { containerId: 'cnt_test' });
    await flush();

    const endSpy = vi.spyOn(stub.stream, 'end');
    const exits: Array<[number | null, NodeJS.Signals | number | null]> = [];
    child.on('exit', (code, signal) => exits.push([code as number | null, signal as NodeJS.Signals | null]));

    child.kill('SIGTERM');
    // Worker shuts down on stdin EOF — simulate by ending the stream too.
    stub.stream.end();
    await flush(2);

    expect(endSpy).toHaveBeenCalled();
    expect(exits).toHaveLength(1);
    expect(exits[0][1]).toBe('SIGTERM');
  });

  it('emits "error" and synthesises an exit when container.exec rejects', async () => {
    const stub = makeDockerStub();
    stub.container.exec = vi.fn().mockRejectedValue(new Error('boom'));
    const { dockerSpawn, __setDockerForSpawnTests } = await import('@process/agent/runtime/dockerSpawn');
    __setDockerForSpawnTests(stub.docker as unknown as never);

    const child = dockerSpawn('ls', [], { containerId: 'cnt_test' });
    const errors: Error[] = [];
    const exits: unknown[] = [];
    child.on('error', (err) => errors.push(err as Error));
    child.on('exit', (code) => exits.push(code));

    await flush(2);

    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('boom');
    expect(exits).toEqual([1]);
  });
});
