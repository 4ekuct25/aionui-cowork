import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const { mockGetDataPath, mockCreateProject, mockGetProjectForUser, mockListProjectsForUser, mockDeleteProjectForUser } =
  vi.hoisted(() => ({
    mockGetDataPath: vi.fn(),
    mockCreateProject: vi.fn(),
    mockGetProjectForUser: vi.fn(),
    mockListProjectsForUser: vi.fn(),
    mockDeleteProjectForUser: vi.fn(),
  }));

vi.mock('@process/utils', () => ({
  getDataPath: mockGetDataPath,
  ensureDirectory: (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
  },
}));

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    createProject: mockCreateProject,
    getProjectForUser: mockGetProjectForUser,
    listProjectsForUser: mockListProjectsForUser,
    deleteProjectForUser: mockDeleteProjectForUser,
  }),
}));

let scratchDir: string;

function makeTempZip(bytes: Buffer): string {
  const filePath = path.join(scratchDir, `upload-${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

const VALID_ZIP_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('ProjectIngestService.ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-project-test-'));
    mockGetDataPath.mockReturnValue(scratchDir);
    mockCreateProject.mockImplementation((input: { id: string; userId: string }) => ({
      success: true,
      data: {
        id: input.id,
        user_id: input.userId,
        name: 'n',
        storage_key: `${input.id}.zip`,
        size_bytes: 0,
        sha256: 'h',
        created_at: 1,
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('rejects a file without the PK\\x03\\x04 magic bytes', async () => {
    const tempPath = makeTempZip(Buffer.from('not a zip'));
    const { ProjectIngestService, ProjectIngestError } = await import('@process/services/ProjectIngestService');

    await expect(
      ProjectIngestService.ingest({ tempPath, userId: 'u1', name: 'x', declaredSize: 9 })
    ).rejects.toBeInstanceOf(ProjectIngestError);
    expect(mockCreateProject).not.toHaveBeenCalled();
    // Service must have cleaned up the rejected temp file.
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('rejects an archive whose declared size exceeds the cap', async () => {
    const tempPath = makeTempZip(Buffer.concat([VALID_ZIP_PREFIX, Buffer.from('rest')]));
    const { ProjectIngestService, ProjectIngestError } = await import('@process/services/ProjectIngestService');

    const oversized = 600 * 1024 * 1024;
    const err = await ProjectIngestService.ingest({
      tempPath,
      userId: 'u1',
      name: 'x',
      declaredSize: oversized,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ProjectIngestError);
    expect(err.code).toBe('oversize');
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('stores a valid archive and records sha256 + size', async () => {
    const payload = Buffer.concat([VALID_ZIP_PREFIX, Buffer.from('central-dir-placeholder')]);
    const tempPath = makeTempZip(payload);
    const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');

    const project = await ProjectIngestService.ingest({
      tempPath,
      userId: 'u1',
      name: 'My project',
      declaredSize: payload.length,
    });

    expect(project).toBeDefined();
    expect(mockCreateProject).toHaveBeenCalledOnce();
    const args = mockCreateProject.mock.calls[0][0];
    expect(args.userId).toBe('u1');
    expect(args.sha256).toBe(expectedSha);
    expect(args.sizeBytes).toBe(payload.length);
    expect(args.name).toBe('My project');

    // Final archive should land under the uploads/ directory.
    const finalPath = path.join(scratchDir, 'uploads', args.storageKey);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('rolls the file back when the DB insert fails', async () => {
    mockCreateProject.mockReturnValueOnce({ success: false, error: 'boom' });
    const tempPath = makeTempZip(Buffer.concat([VALID_ZIP_PREFIX, Buffer.from('payload')]));
    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');

    await expect(ProjectIngestService.ingest({ tempPath, userId: 'u1', name: 'x', declaredSize: 11 })).rejects.toThrow(
      /boom/
    );

    // Both temp and final file must be gone after rollback.
    expect(fs.existsSync(tempPath)).toBe(false);
    const uploads = path.join(scratchDir, 'uploads');
    if (fs.existsSync(uploads)) {
      const leftover = fs.readdirSync(uploads);
      expect(leftover).toEqual([]);
    }
  });
});

describe('ProjectIngestService.findForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-project-test-'));
    mockGetDataPath.mockReturnValue(scratchDir);
  });
  afterEach(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

  it('returns null when the project belongs to a different user', async () => {
    mockGetProjectForUser.mockReturnValue({ success: true, data: null });
    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');
    const result = await ProjectIngestService.findForUser('prj_x', 'other-user');
    expect(result).toBeNull();
  });

  it('returns the resolved archive path when ownership matches', async () => {
    mockGetProjectForUser.mockReturnValue({
      success: true,
      data: {
        id: 'prj_x',
        user_id: 'u1',
        name: 'p',
        storage_key: 'prj_x.zip',
        size_bytes: 10,
        sha256: 'abc',
        created_at: 1,
      },
    });
    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');
    const result = await ProjectIngestService.findForUser('prj_x', 'u1');
    expect(result).not.toBeNull();
    expect(result!.archivePath.endsWith('uploads/prj_x.zip')).toBe(true);
  });
});

describe('ProjectIngestService.deleteForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-project-test-'));
    mockGetDataPath.mockReturnValue(scratchDir);
  });
  afterEach(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

  it('returns false when the project is not owned by the requester', async () => {
    mockGetProjectForUser.mockReturnValue({ success: true, data: null });
    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');
    const result = await ProjectIngestService.deleteForUser('prj_x', 'u1');
    expect(result).toBe(false);
    expect(mockDeleteProjectForUser).not.toHaveBeenCalled();
  });

  it('removes the archive file from disk on successful delete', async () => {
    const uploads = path.join(scratchDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    const archive = path.join(uploads, 'prj_x.zip');
    fs.writeFileSync(archive, 'bytes');

    mockGetProjectForUser.mockReturnValue({
      success: true,
      data: {
        id: 'prj_x',
        user_id: 'u1',
        name: 'p',
        storage_key: 'prj_x.zip',
        size_bytes: 5,
        sha256: 'abc',
        created_at: 1,
      },
    });
    mockDeleteProjectForUser.mockReturnValue({ success: true, data: true });

    const { ProjectIngestService } = await import('@process/services/ProjectIngestService');
    const result = await ProjectIngestService.deleteForUser('prj_x', 'u1');

    expect(result).toBe(true);
    expect(mockDeleteProjectForUser).toHaveBeenCalledWith('prj_x', 'u1');
    expect(fs.existsSync(archive)).toBe(false);
  });
});
