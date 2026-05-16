import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetDockerSessionForUser,
  mockUpsertDockerSession,
  mockMarkStopped,
  mockDeleteDockerSession,
  mockListByStatus,
  mockFindProjectForUser,
} = vi.hoisted(() => ({
  mockGetDockerSessionForUser: vi.fn(),
  mockUpsertDockerSession: vi.fn(),
  mockMarkStopped: vi.fn(),
  mockDeleteDockerSession: vi.fn(),
  mockListByStatus: vi.fn(),
  mockFindProjectForUser: vi.fn(),
}));

vi.mock('@process/utils', () => ({ getDataPath: () => '/var/lib/aionui' }));

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    getDockerSessionForUser: mockGetDockerSessionForUser,
    upsertDockerSession: mockUpsertDockerSession,
    markDockerSessionStopped: mockMarkStopped,
    deleteDockerSession: mockDeleteDockerSession,
    listDockerSessionsByStatus: mockListByStatus,
  }),
}));

vi.mock('@process/services/ProjectIngestService', () => ({
  ProjectIngestService: { findForUser: mockFindProjectForUser },
}));

function makeDockerStub() {
  const containerStub = {
    id: 'cnt_new_123',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    // Phase 9.2 Fix 2: acquire() now inspects an existing container before
    // reusing the DB row. Default to "running" so the warm-reuse path works;
    // tests that need the "container vanished" branch can override per-test.
    inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
  };
  const volumeStub = { remove: vi.fn().mockResolvedValue(undefined) };
  return {
    createVolume: vi.fn().mockResolvedValue({}),
    run: vi.fn().mockResolvedValue([{ StatusCode: 0 }, {}]),
    createContainer: vi.fn().mockResolvedValue(containerStub),
    getContainer: vi.fn(() => containerStub),
    getVolume: vi.fn(() => volumeStub),
    _containerStub: containerStub,
    _volumeStub: volumeStub,
  };
}

describe('DockerSessionManager.acquire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertDockerSession.mockImplementation((row) => ({ success: true, data: row }));
  });

  afterEach(async () => {
    const { __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(null);
  });

  it('returns the existing session without restarting when one is already running', async () => {
    mockGetDockerSessionForUser.mockReturnValue({
      success: true,
      data: {
        conversation_id: 'c1',
        user_id: 'u1',
        project_id: 'p1',
        container_id: 'cnt_old',
        volume_name: 'aionui-u1-c1',
        status: 'running',
        started_at: 1,
        last_seen_at: 1,
      },
    });
    const docker = makeDockerStub();
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    const result = await DockerSessionManager.acquire({ conversationId: 'c1', userId: 'u1', projectId: 'p1' });

    expect(result.created).toBe(false);
    expect(result.session.container_id).toBe('cnt_old');
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    // Heartbeat update still happens so eviction stays accurate.
    expect(mockUpsertDockerSession).toHaveBeenCalledOnce();
  });

  it('throws SessionProjectNotFoundError when the project is missing or owned by someone else', async () => {
    mockGetDockerSessionForUser.mockReturnValue({ success: true, data: null });
    mockFindProjectForUser.mockResolvedValue(null);
    const docker = makeDockerStub();
    const { DockerSessionManager, SessionProjectNotFoundError, __setDockerForTests } =
      await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    await expect(
      DockerSessionManager.acquire({ conversationId: 'c1', userId: 'u1', projectId: 'p_missing' })
    ).rejects.toBeInstanceOf(SessionProjectNotFoundError);

    // No starting row should have been written when the project check fails.
    expect(mockUpsertDockerSession).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it('creates volume, extracts zip and starts container on cold acquire', async () => {
    mockGetDockerSessionForUser.mockReturnValue({ success: true, data: null });
    mockFindProjectForUser.mockResolvedValue({
      project: {
        id: 'p1',
        storage_key: 'p1.zip',
        user_id: 'u1',
        name: 'p',
        size_bytes: 10,
        sha256: 'x',
        created_at: 1,
      },
      archivePath: '/var/lib/aionui/uploads/p1.zip',
    });
    const docker = makeDockerStub();
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    const result = await DockerSessionManager.acquire({ conversationId: 'c1', userId: 'u1', projectId: 'p1' });

    expect(result.created).toBe(true);
    expect(result.session.container_id).toBe('cnt_new_123');
    expect(result.session.status).toBe('running');

    expect(docker.createVolume).toHaveBeenCalledOnce();
    const volumeCall = docker.createVolume.mock.calls[0][0];
    expect(volumeCall.Name).toBe('aionui-u1-c1');

    // Helper container ran unzip with the upload path bind-mounted.
    expect(docker.run).toHaveBeenCalledOnce();
    const helperArgs = docker.run.mock.calls[0];
    // Path is shell-quoted defensively against injection; chown was added in
    // Phase 9.2 Fix 5 so the runtime user (uid 10001) can write to /workspace.
    expect(helperArgs[1][0]).toBe('sh');
    expect(helperArgs[1][1]).toBe('-c');
    expect(helperArgs[1][2]).toContain('unzip -q -o');
    expect(helperArgs[1][2]).toContain('p1.zip');
    expect(helperArgs[1][2]).toContain('-d /workspace');
    expect(helperArgs[1][2]).toContain('chown -R 10001:10001 /workspace');

    // Session container started with sleep infinity + volume bind plus the
    // Phase 8.1 hardening: non-root user, read-only rootfs + tmpfs, dropped
    // caps, no-new-privileges, and explicit resource limits.
    expect(docker.createContainer).toHaveBeenCalledOnce();
    const containerArgs = docker.createContainer.mock.calls[0][0];
    expect(containerArgs.Cmd).toEqual(['sleep', 'infinity']);
    expect(containerArgs.User).toBe('10001:10001');
    expect(containerArgs.HostConfig.Binds).toContain('aionui-u1-c1:/workspace');
    expect(containerArgs.HostConfig.ReadonlyRootfs).toBe(true);
    expect(containerArgs.HostConfig.Tmpfs).toMatchObject({ '/tmp': expect.any(String) });
    expect(containerArgs.HostConfig.CapDrop).toEqual(['ALL']);
    expect(containerArgs.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(containerArgs.HostConfig.Memory).toBeGreaterThan(0);
    expect(containerArgs.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(docker._containerStub.start).toHaveBeenCalledOnce();

    // Two upserts: starting then running.
    expect(mockUpsertDockerSession).toHaveBeenCalledTimes(2);
    expect(mockUpsertDockerSession.mock.calls[0][0].status).toBe('starting');
    expect(mockUpsertDockerSession.mock.calls[1][0].status).toBe('running');
  });

  it('fails the helper step when the unzip helper exits non-zero', async () => {
    mockGetDockerSessionForUser.mockReturnValue({ success: true, data: null });
    mockFindProjectForUser.mockResolvedValue({
      project: {
        id: 'p1',
        storage_key: 'p1.zip',
        user_id: 'u1',
        name: 'p',
        size_bytes: 10,
        sha256: 'x',
        created_at: 1,
      },
      archivePath: '/var/lib/aionui/uploads/p1.zip',
    });
    const docker = makeDockerStub();
    docker.run = vi.fn().mockResolvedValue([{ StatusCode: 1 }, {}]);
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    await expect(DockerSessionManager.acquire({ conversationId: 'c1', userId: 'u1', projectId: 'p1' })).rejects.toThrow(
      /Helper container exited with status 1/
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});

describe('DockerSessionManager.release', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    const { __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(null);
  });

  it('is a no-op when no session exists for the user', async () => {
    mockGetDockerSessionForUser.mockReturnValue({ success: true, data: null });
    const docker = makeDockerStub();
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    await DockerSessionManager.release('c1', 'u1');

    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(mockMarkStopped).not.toHaveBeenCalled();
  });

  it('stops and removes the container then marks the row stopped', async () => {
    mockGetDockerSessionForUser.mockReturnValue({
      success: true,
      data: {
        conversation_id: 'c1',
        user_id: 'u1',
        project_id: 'p1',
        container_id: 'cnt_live',
        volume_name: 'aionui-u1-c1',
        status: 'running',
        started_at: 1,
        last_seen_at: 1,
      },
    });
    const docker = makeDockerStub();
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    await DockerSessionManager.release('c1', 'u1');

    expect(docker.getContainer).toHaveBeenCalledWith('cnt_live');
    expect(docker._containerStub.stop).toHaveBeenCalled();
    expect(docker._containerStub.remove).toHaveBeenCalled();
    expect(mockMarkStopped).toHaveBeenCalledWith('c1');
  });
});

describe('DockerSessionManager.destroy', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    const { __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(null);
  });

  it('removes container, volume and DB row in that order', async () => {
    mockGetDockerSessionForUser.mockReturnValue({
      success: true,
      data: {
        conversation_id: 'c1',
        user_id: 'u1',
        project_id: 'p1',
        container_id: 'cnt_live',
        volume_name: 'aionui-u1-c1',
        status: 'running',
        started_at: 1,
        last_seen_at: 1,
      },
    });
    const docker = makeDockerStub();
    const { DockerSessionManager, __setDockerForTests } = await import('@process/services/DockerSessionManager');
    __setDockerForTests(docker as unknown as never);

    await DockerSessionManager.destroy('c1', 'u1');

    expect(docker._containerStub.remove).toHaveBeenCalledWith({ force: true });
    expect(docker._volumeStub.remove).toHaveBeenCalledWith({ force: true });
    expect(mockDeleteDockerSession).toHaveBeenCalledWith('c1');
  });
});
