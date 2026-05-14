/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { ensureDirectory, getDataPath } from '@process/utils';
import { getDatabase } from '@process/services/database/export';
import type { IProject } from '@process/services/database/types';

const pipelineAsync = promisify(pipeline);

/**
 * Absolute upper bound on a single uploaded archive. Per-user storage quotas
 * land in Phase 8 — this is the hard server-side ceiling.
 */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500 MB

/** First four bytes of a PKZIP archive (`PK\x03\x04`). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Errors the service raises with stable codes the route layer can map to HTTP status. */
export type IngestErrorCode = 'invalidMagic' | 'oversize' | 'storageError' | 'sha256Mismatch';

export class ProjectIngestError extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProjectIngestError';
  }
}

/**
 * Directory layout under DATA_DIR:
 *   <DATA_DIR>/uploads/<projectId>.zip
 * The storage_key column in the projects table stores just `<projectId>.zip`,
 * so the absolute path is reconstructable across DATA_DIR changes.
 */
function uploadsDir(): string {
  return path.join(getDataPath(), 'uploads');
}

function storagePath(storageKey: string): string {
  return path.join(uploadsDir(), storageKey);
}

/**
 * Validates an uploaded zip archive on disk and registers it as a project
 * owned by `userId`. The caller (route handler) is responsible for moving
 * multer's temp file to its final location, OR passing the temp path here so
 * we own the move. We accept the temp path and handle the move ourselves —
 * that way the file ends up under the canonical storage layout even if the
 * caller forgets.
 */
export const ProjectIngestService = {
  /**
   * Ingest an uploaded zip from a multer temp path. Returns the new project
   * row on success; throws ProjectIngestError on validation failure (so the
   * route layer can switch on .code) and a plain Error on unexpected storage
   * problems.
   *
   * On any error the input temp file is deleted; on success it is renamed
   * into the uploads directory (no double-copy).
   */
  async ingest(input: { tempPath: string; userId: string; name: string; declaredSize: number }): Promise<IProject> {
    const { tempPath, userId, name, declaredSize } = input;

    try {
      if (declaredSize > MAX_ARCHIVE_BYTES) {
        throw new ProjectIngestError('oversize', `Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
      }

      // Stat the actual file too — multer's declared size can lie under
      // bogus Content-Length headers.
      const stat = await fs.promises.stat(tempPath);
      if (stat.size > MAX_ARCHIVE_BYTES) {
        throw new ProjectIngestError('oversize', `Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
      }

      // Magic byte check: read the first 4 bytes and compare to PK\x03\x04.
      // A real zip-bomb defence (decompressed-vs-archived ratio) needs to
      // unpack the central directory and is deferred to Phase 8 hardening.
      const headerHandle = await fs.promises.open(tempPath, 'r');
      try {
        const header = Buffer.alloc(4);
        await headerHandle.read(header, 0, 4, 0);
        if (!header.equals(ZIP_MAGIC)) {
          throw new ProjectIngestError('invalidMagic', 'File is not a valid zip archive');
        }
      } finally {
        await headerHandle.close();
      }

      // Compute sha256 by streaming the file once (small heap footprint).
      const sha256 = await sha256OfFile(tempPath);

      // Final storage location.
      ensureDirectory(uploadsDir());
      const projectId = `prj_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const storageKey = `${projectId}.zip`;
      const finalPath = storagePath(storageKey);

      // fs.rename works across the same partition; fall back to copy+unlink
      // when multer's temp dir lives on a different volume (Docker bind
      // mounts can land that way).
      try {
        await fs.promises.rename(tempPath, finalPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
          await pipelineAsync(fs.createReadStream(tempPath), fs.createWriteStream(finalPath));
          await fs.promises.unlink(tempPath);
        } else {
          throw new ProjectIngestError('storageError', `Failed to move upload into place: ${(err as Error).message}`);
        }
      }

      const db = await getDatabase();
      const result = db.createProject({
        id: projectId,
        userId,
        name,
        storageKey,
        sizeBytes: stat.size,
        sha256,
      });
      if (!result.success || !result.data) {
        // Roll back the file write so we don't leave an orphan archive.
        await safeUnlink(finalPath);
        throw new Error(result.error || 'Failed to record project');
      }
      return result.data;
    } catch (error) {
      // Best-effort cleanup of the multer temp file when something went wrong
      // before the rename. Silent — the original error wins.
      await safeUnlink(tempPath);
      throw error;
    }
  },

  /**
   * Resolve a project row + absolute archive path for the requesting user.
   * Returns null when the project doesn't exist OR is owned by someone else.
   */
  async findForUser(projectId: string, userId: string): Promise<{ project: IProject; archivePath: string } | null> {
    const db = await getDatabase();
    const result = db.getProjectForUser(projectId, userId);
    if (!result.success || !result.data) {
      return null;
    }
    return {
      project: result.data,
      archivePath: storagePath(result.data.storage_key),
    };
  },

  async listForUser(userId: string): Promise<IProject[]> {
    const db = await getDatabase();
    const result = db.listProjectsForUser(userId);
    if (!result.success) {
      throw new Error(result.error || 'Failed to list projects');
    }
    return result.data ?? [];
  },

  /**
   * Delete the project row + its zip file. Returns true when a row was
   * actually removed (i.e. the caller owned the project); false otherwise.
   */
  async deleteForUser(projectId: string, userId: string): Promise<boolean> {
    const db = await getDatabase();
    const lookup = db.getProjectForUser(projectId, userId);
    if (!lookup.success || !lookup.data) {
      return false;
    }
    const archivePath = storagePath(lookup.data.storage_key);
    const del = db.deleteProjectForUser(projectId, userId);
    if (!del.success || !del.data) {
      return false;
    }
    // File deletion failures don't roll the DB back — an orphan archive is
    // cheaper than re-creating a phantom row. A GC job in Phase 9 will
    // reconcile orphans.
    await safeUnlink(archivePath);
    return true;
  },
};

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore — file may already be gone
  }
}
