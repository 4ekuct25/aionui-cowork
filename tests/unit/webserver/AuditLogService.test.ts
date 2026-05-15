import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAppendAuditLog, mockListAuditLog } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn(),
  mockListAuditLog: vi.fn(),
}));

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    appendAuditLog: mockAppendAuditLog,
    listAuditLog: mockListAuditLog,
  }),
}));

describe('AuditLogService.append', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockReturnValue({ success: true, data: undefined });
  });

  it('writes the requested action with stringified meta', async () => {
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await AuditLogService.append({
      userId: 'u1',
      action: 'project.upload',
      target: 'prj_123',
      meta: { sizeBytes: 42 },
    });

    expect(mockAppendAuditLog).toHaveBeenCalledOnce();
    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.userId).toBe('u1');
    expect(call.action).toBe('project.upload');
    expect(call.target).toBe('prj_123');
    expect(call.meta).toBe(JSON.stringify({ sizeBytes: 42 }));
    expect(call.id).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(typeof call.createdAt).toBe('number');
  });

  it('defaults meta to "{}" and target to null when not provided', async () => {
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await AuditLogService.append({ userId: 'u1', action: 'auth.logout' });

    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.meta).toBe('{}');
    expect(call.target).toBeNull();
  });

  it('allows anonymous events (userId null) for failed-login traces', async () => {
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await AuditLogService.append({ userId: null, action: 'auth.login.failed', target: 'someone' });

    expect(mockAppendAuditLog.mock.calls[0][0].userId).toBeNull();
  });

  it('swallows DB failures so the caller flow is never broken by audit issues', async () => {
    mockAppendAuditLog.mockReturnValue({ success: false, error: 'disk full' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await expect(AuditLogService.append({ userId: 'u1', action: 'auth.login' })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('AuditLogService.list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clamps the limit to a safe maximum and minimum', async () => {
    mockListAuditLog.mockReturnValue({ success: true, data: [] });
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await AuditLogService.list({ limit: 99_999 });
    expect(mockListAuditLog.mock.calls[0][0].limit).toBe(500);

    await AuditLogService.list({ limit: -5 });
    expect(mockListAuditLog.mock.calls[1][0].limit).toBe(1);
  });

  it('throws when the DB layer reports an error', async () => {
    mockListAuditLog.mockReturnValue({ success: false, error: 'boom' });
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await expect(AuditLogService.list({})).rejects.toThrow(/boom/);
  });

  it('forwards an optional action filter unchanged', async () => {
    mockListAuditLog.mockReturnValue({ success: true, data: [] });
    const { AuditLogService } = await import('@process/services/AuditLogService');

    await AuditLogService.list({ action: 'project.upload', limit: 50, offset: 10 });
    const call = mockListAuditLog.mock.calls[0][0];
    expect(call.action).toBe('project.upload');
    expect(call.limit).toBe(50);
    expect(call.offset).toBe(10);
  });
});
