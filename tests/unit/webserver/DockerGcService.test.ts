import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LabelMap = Record<string, string>;

type SessionRow = {
  conversation_id: string;
  container_id: string | null;
  status?: 'starting' | 'running' | 'stopped';
  last_seen_at?: number;
};

const { mockListContainers, mockListVolumes, mockGetContainer, mockGetVolume, sessionRows, markStoppedMock } =
  vi.hoisted(() => ({
    mockListContainers: vi.fn(),
    mockListVolumes: vi.fn(),
    mockGetContainer: vi.fn(),
    mockGetVolume: vi.fn(),
    sessionRows: [] as SessionRow[],
    markStoppedMock: vi.fn(),
  }));

// SQL-aware prepare/all stub. The service uses three distinct queries:
//   - SELECT … WHERE status IN ('running','starting')   → reconcile step
//   - SELECT … WHERE status = 'running' AND last_seen_at < ?  → idle-stop
//   - SELECT conversation_id FROM docker_sessions             → orphan cleanup
// We dispatch by matching the SQL substring instead of mocking each prepare()
// individually; keeps tests readable when sessionRows already holds the truth.
vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    getDriver: () => ({
      prepare: (sql: string) => ({
        all: (...args: unknown[]) => {
          if (sql.includes("status IN ('running','starting')")) {
            return sessionRows.filter((r) => r.status === 'running' || r.status === 'starting');
          }
          if (sql.includes("status = 'running' AND last_seen_at < ?")) {
            const cutoff = args[0] as number;
            return sessionRows.filter(
              (r) => r.status === 'running' && typeof r.last_seen_at === 'number' && r.last_seen_at < cutoff
            );
          }
          // orphan-cleanup query
          return sessionRows.map((r) => ({ conversation_id: r.conversation_id }));
        },
      }),
    }),
    markDockerSessionStopped: markStoppedMock,
  }),
}));

function makeContainerStub(overrides: {
  inspect?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  remove?: () => Promise<unknown>;
}): Record<string, unknown> {
  return {
    inspect: overrides.inspect ?? (() => Promise.resolve({ State: { Running: false } })),
    stop: overrides.stop ?? (() => Promise.resolve()),
    remove: overrides.remove ?? (() => Promise.resolve()),
  };
}

function makeVolumeStub(removeMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return { remove: removeMock };
}

function makeDocker(): Record<string, unknown> {
  return {
    listContainers: mockListContainers,
    listVolumes: mockListVolumes,
    getContainer: mockGetContainer,
    getVolume: mockGetVolume,
  };
}

describe('DockerGcService.sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRows.length = 0;
    // Sensible defaults so individual tests don't need to repeat the calm
    // baseline (no orphan containers/volumes, no idle eviction needed).
    mockListContainers.mockResolvedValue([]);
    mockListVolumes.mockResolvedValue({ Volumes: [] });
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
  });

  afterEach(async () => {
    const { __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(null);
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
  });

  // --------- Orphan cleanup (Phase 9.1, original behaviour preserved) ---------

  it('removes containers whose conversation id is not in docker_sessions', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([
      { Id: 'cnt_alive', Labels: { 'aionui.conversation': 'conv_alive' } as LabelMap },
      { Id: 'cnt_orphan', Labels: { 'aionui.conversation': 'conv_orphan' } as LabelMap },
    ]);
    mockGetContainer.mockImplementation(() => makeContainerStub({ remove: removeMock }));
    sessionRows.push({ conversation_id: 'conv_alive', container_id: 'cnt_alive', status: 'stopped' });

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(mockGetContainer).toHaveBeenCalledWith('cnt_orphan');
    expect(mockGetContainer).not.toHaveBeenCalledWith('cnt_alive');
    expect(removeMock).toHaveBeenCalledOnce();
    expect(removeMock).toHaveBeenCalledWith({ force: true });
    expect(summary.containersRemoved).toBe(1);
  });

  it('removes volumes whose conversation id is not in docker_sessions', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'aionui-u1-conv_alive', Labels: { 'aionui.conversation': 'conv_alive' } as LabelMap },
        { Name: 'aionui-u1-conv_orphan', Labels: { 'aionui.conversation': 'conv_orphan' } as LabelMap },
      ],
    });
    mockGetVolume.mockImplementation(() => makeVolumeStub(removeMock));
    sessionRows.push({ conversation_id: 'conv_alive', container_id: 'cnt_alive', status: 'stopped' });

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(mockGetVolume).toHaveBeenCalledWith('aionui-u1-conv_orphan');
    expect(mockGetVolume).not.toHaveBeenCalledWith('aionui-u1-conv_alive');
    expect(removeMock).toHaveBeenCalledOnce();
    expect(summary.volumesRemoved).toBe(1);
  });

  it('collects per-item errors instead of aborting the whole sweep', async () => {
    const removeFail = vi.fn().mockRejectedValue(new Error('disk i/o'));
    const okRemove = vi.fn().mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([
      { Id: 'cnt_broken', Labels: { 'aionui.conversation': 'conv_broken' } as LabelMap },
      { Id: 'cnt_ok', Labels: { 'aionui.conversation': 'conv_ok' } as LabelMap },
    ]);
    mockGetContainer.mockImplementation((id: string) =>
      id === 'cnt_broken' ? makeContainerStub({ remove: removeFail }) : makeContainerStub({ remove: okRemove })
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(summary.containersRemoved).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatch(/cnt_broken/);
  });

  it('skips items without an aionui.conversation label entirely', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([{ Id: 'cnt_no_label', Labels: {} as LabelMap }]);
    mockGetContainer.mockImplementation(() => makeContainerStub({ remove: removeMock }));

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(removeMock).not.toHaveBeenCalled();
    expect(summary.containersRemoved).toBe(0);
  });

  // --------- DB reconciliation (Phase 9.3, new) ---------

  it('marks running rows whose container has vanished as stopped', async () => {
    const recentlySeen = Date.now();
    sessionRows.push({
      conversation_id: 'conv_phantom',
      container_id: 'cnt_phantom',
      status: 'running',
      last_seen_at: recentlySeen,
    });
    mockGetContainer.mockImplementation((id: string) =>
      id === 'cnt_phantom'
        ? makeContainerStub({ inspect: () => Promise.reject(new Error('404 no such container')) })
        : makeContainerStub({})
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(markStoppedMock).toHaveBeenCalledWith('conv_phantom');
    expect(summary.dbReconciled).toBe(1);
    expect(summary.idleStopped).toBe(0);
  });

  it('marks starting rows with no container_id as stopped', async () => {
    sessionRows.push({
      conversation_id: 'conv_stuck',
      container_id: null,
      status: 'starting',
      last_seen_at: Date.now(),
    });

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(markStoppedMock).toHaveBeenCalledWith('conv_stuck');
    expect(summary.dbReconciled).toBe(1);
  });

  it('leaves rows alone when the container is actually running', async () => {
    sessionRows.push({
      conversation_id: 'conv_live',
      container_id: 'cnt_live',
      status: 'running',
      last_seen_at: Date.now(),
    });
    mockGetContainer.mockImplementation(() =>
      makeContainerStub({ inspect: () => Promise.resolve({ State: { Running: true } }) })
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(markStoppedMock).not.toHaveBeenCalled();
    expect(summary.dbReconciled).toBe(0);
    expect(summary.idleStopped).toBe(0);
  });

  // --------- Idle-stop (Phase 9.3, new) ---------

  it('stops+removes containers that have been idle past the timeout', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = '1000'; // 1s — every test row beats it
    const stopMock = vi.fn().mockResolvedValue(undefined);
    const removeMock = vi.fn().mockResolvedValue(undefined);
    sessionRows.push({
      conversation_id: 'conv_idle',
      container_id: 'cnt_idle',
      status: 'running',
      last_seen_at: Date.now() - 60_000, // 1 min ago
    });
    mockGetContainer.mockImplementation(() =>
      makeContainerStub({
        inspect: () => Promise.resolve({ State: { Running: true } }),
        stop: stopMock,
        remove: removeMock,
      })
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(stopMock).toHaveBeenCalledWith({ t: 10 });
    expect(removeMock).toHaveBeenCalledWith({ force: true });
    expect(markStoppedMock).toHaveBeenCalledWith('conv_idle');
    expect(summary.idleStopped).toBe(1);
  });

  it('does not idle-stop containers touched within the timeout window', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = String(60 * 60 * 1000); // 1 hour
    const stopMock = vi.fn().mockResolvedValue(undefined);
    sessionRows.push({
      conversation_id: 'conv_active',
      container_id: 'cnt_active',
      status: 'running',
      last_seen_at: Date.now() - 5_000, // 5s ago — well within window
    });
    mockGetContainer.mockImplementation(() =>
      makeContainerStub({ inspect: () => Promise.resolve({ State: { Running: true } }), stop: stopMock })
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(stopMock).not.toHaveBeenCalled();
    expect(summary.idleStopped).toBe(0);
  });

  it('SESSION_IDLE_TIMEOUT_MS=0 disables idle eviction entirely', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = '0';
    const stopMock = vi.fn().mockResolvedValue(undefined);
    sessionRows.push({
      conversation_id: 'conv_ancient',
      container_id: 'cnt_ancient',
      status: 'running',
      last_seen_at: 0, // beginning of epoch
    });
    mockGetContainer.mockImplementation(() =>
      makeContainerStub({ inspect: () => Promise.resolve({ State: { Running: true } }), stop: stopMock })
    );

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(stopMock).not.toHaveBeenCalled();
    expect(summary.idleStopped).toBe(0);
  });
});
