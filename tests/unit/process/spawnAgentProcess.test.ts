import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNodeSpawn, mockDockerSpawn } = vi.hoisted(() => ({
  mockNodeSpawn: vi.fn(),
  mockDockerSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mockNodeSpawn }));

vi.mock('@process/agent/runtime/dockerSpawn', () => ({
  dockerSpawn: mockDockerSpawn,
}));

describe('spawnAgentProcess routing', () => {
  const originalPlatform = process.env.AIONUI_PLATFORM;
  const originalContainer = process.env.AIONUI_CONTAINER_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNodeSpawn.mockReturnValue({ pid: 4242 });
    mockDockerSpawn.mockReturnValue({ pid: 1, stdin: {}, stdout: {}, stderr: {} });
  });

  afterEach(() => {
    process.env.AIONUI_PLATFORM = originalPlatform;
    process.env.AIONUI_CONTAINER_ID = originalContainer;
  });

  it('falls back to child_process.spawn when AIONUI_PLATFORM is not set', async () => {
    delete process.env.AIONUI_PLATFORM;
    const { spawnAgentProcess } = await import('@process/agent/runtime/spawnAgentProcess');

    spawnAgentProcess('node', ['--version'], { env: { FOO: 'bar' } });

    expect(mockNodeSpawn).toHaveBeenCalledOnce();
    expect(mockDockerSpawn).not.toHaveBeenCalled();
  });

  it('falls back to child_process.spawn when AIONUI_PLATFORM=docker but no container id present', async () => {
    process.env.AIONUI_PLATFORM = 'docker';
    delete process.env.AIONUI_CONTAINER_ID;
    const { spawnAgentProcess } = await import('@process/agent/runtime/spawnAgentProcess');

    spawnAgentProcess('node', ['--version'], { env: {} });

    expect(mockNodeSpawn).toHaveBeenCalledOnce();
    expect(mockDockerSpawn).not.toHaveBeenCalled();
  });

  it('routes through dockerSpawn when AIONUI_CONTAINER_ID is passed via opts.env', async () => {
    process.env.AIONUI_PLATFORM = 'docker';
    delete process.env.AIONUI_CONTAINER_ID;
    const { spawnAgentProcess } = await import('@process/agent/runtime/spawnAgentProcess');

    spawnAgentProcess('bun', ['/opt/aionui/dist-server/gemini.js'], {
      env: { AIONUI_CONTAINER_ID: 'cnt_abc', SHELL: '/bin/bash' },
      cwd: '/workspace',
    });

    expect(mockDockerSpawn).toHaveBeenCalledOnce();
    const callArgs = mockDockerSpawn.mock.calls[0];
    expect(callArgs[0]).toBe('bun');
    expect(callArgs[1]).toEqual(['/opt/aionui/dist-server/gemini.js']);
    expect(callArgs[2]).toMatchObject({
      containerId: 'cnt_abc',
      cwd: '/workspace',
      env: { AIONUI_CONTAINER_ID: 'cnt_abc', SHELL: '/bin/bash' },
    });
    expect(mockNodeSpawn).not.toHaveBeenCalled();
  });

  it('reads AIONUI_CONTAINER_ID from process.env when opts.env does not provide it', async () => {
    process.env.AIONUI_PLATFORM = 'docker';
    process.env.AIONUI_CONTAINER_ID = 'cnt_from_proc';
    const { spawnAgentProcess } = await import('@process/agent/runtime/spawnAgentProcess');

    spawnAgentProcess('ls', [], {});

    expect(mockDockerSpawn).toHaveBeenCalledOnce();
    expect(mockDockerSpawn.mock.calls[0][2].containerId).toBe('cnt_from_proc');
  });
});
