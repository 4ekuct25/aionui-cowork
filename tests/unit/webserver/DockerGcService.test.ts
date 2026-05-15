import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LabelMap = Record<string, string>;

const { mockListContainers, mockListVolumes, mockGetContainer, mockGetVolume, dbRows } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockListVolumes: vi.fn(),
  mockGetContainer: vi.fn(),
  mockGetVolume: vi.fn(),
  dbRows: [] as Array<{ conversation_id: string }>,
}));

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    getDriver: () => ({
      prepare: (_sql: string) => ({
        all: () => dbRows,
      }),
    }),
  }),
}));

function makeContainerStub(removeMock: ReturnType<typeof vi.fn>) {
  return { remove: removeMock };
}

function makeVolumeStub(removeMock: ReturnType<typeof vi.fn>) {
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
    dbRows.length = 0;
  });

  afterEach(async () => {
    const { __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(null);
  });

  it('removes containers whose conversation id is not in docker_sessions', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([
      { Id: 'cnt_alive', Labels: { 'aionui.conversation': 'conv_alive' } as LabelMap },
      { Id: 'cnt_orphan', Labels: { 'aionui.conversation': 'conv_orphan' } as LabelMap },
    ]);
    mockListVolumes.mockResolvedValue({ Volumes: [] });
    mockGetContainer.mockImplementation(() => makeContainerStub(removeMock));
    dbRows.push({ conversation_id: 'conv_alive' });

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
    mockListContainers.mockResolvedValue([]);
    mockListVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'aionui-u1-conv_alive', Labels: { 'aionui.conversation': 'conv_alive' } as LabelMap },
        { Name: 'aionui-u1-conv_orphan', Labels: { 'aionui.conversation': 'conv_orphan' } as LabelMap },
      ],
    });
    mockGetVolume.mockImplementation(() => makeVolumeStub(removeMock));
    dbRows.push({ conversation_id: 'conv_alive' });

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
    mockListContainers.mockResolvedValue([
      { Id: 'cnt_broken', Labels: { 'aionui.conversation': 'conv_broken' } as LabelMap },
      { Id: 'cnt_ok', Labels: { 'aionui.conversation': 'conv_ok' } as LabelMap },
    ]);
    mockListVolumes.mockResolvedValue({ Volumes: [] });
    const okRemove = vi.fn().mockResolvedValue(undefined);
    mockGetContainer.mockImplementation((id: string) =>
      id === 'cnt_broken' ? makeContainerStub(removeFail) : makeContainerStub(okRemove)
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
    mockListVolumes.mockResolvedValue({ Volumes: [] });
    mockGetContainer.mockImplementation(() => makeContainerStub(removeMock));

    const { DockerGcService, __setDockerForGcTests } = await import('@process/services/DockerGcService');
    __setDockerForGcTests(makeDocker() as unknown as never);

    const summary = await DockerGcService.sweep();

    expect(removeMock).not.toHaveBeenCalled();
    expect(summary.containersRemoved).toBe(0);
  });
});
