/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response, NextFunction } from 'express';
import os from 'os';
import multer from 'multer';
import fs from 'fs';
import { AuthMiddleware } from '@process/webserver/auth/middleware/AuthMiddleware';
import { authenticatedActionLimiter, apiRateLimiter } from '../middleware/security';
import { ProjectIngestService, ProjectIngestError } from '@process/services/ProjectIngestService';
import { AuditLogService } from '@process/services/AuditLogService';
import type { IProject } from '@process/services/database/types';

/** Hard cap multer enforces before we even touch the file. Mirrors ProjectIngestService. */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

const PROJECT_UPLOAD = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
});

/**
 * Strip the storage_key (server filesystem detail) from responses so clients
 * can't probe for upload paths.
 */
function toDto(project: IProject) {
  return {
    id: project.id,
    name: project.name,
    sizeBytes: project.size_bytes,
    sha256: project.sha256,
    createdAt: project.created_at,
  };
}

/**
 * Register project routes:
 *   POST   /api/projects            — multipart upload, field `file`
 *   GET    /api/projects            — list owned projects, newest first
 *   GET    /api/projects/:id        — single project metadata
 *   DELETE /api/projects/:id        — drop row and archive
 *   GET    /api/projects/:id/export — download the original archive
 *
 * All endpoints require an authenticated session and are scoped to the
 * caller's `req.user.id` — there is no admin override here.
 */
export function registerProjectRoutes(app: Express): void {
  app.post(
    '/api/projects',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    // multer v2 surfaces file-size errors via next(); intercept manually so
    // the client gets a 413 instead of falling through to the 500 handler.
    (req: Request, res: Response, next: NextFunction) => {
      PROJECT_UPLOAD.single('file')(req, res, (err: unknown) => {
        if (err) {
          if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ success: false, message: 'Archive exceeds size limit' });
            return;
          }
          next(err);
          return;
        }
        void handleUpload(req, res);
      });
    }
  );

  app.get(
    '/api/projects',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const projects = await ProjectIngestService.listForUser(req.user!.id);
        res.json({ success: true, projects: projects.map(toDto) });
      } catch (error) {
        console.error('List projects failed:', error);
        res.status(500).json({ success: false, message: 'Failed to list projects' });
      }
    }
  );

  app.get(
    '/api/projects/:id',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const found = await ProjectIngestService.findForUser(String(req.params.id), req.user!.id);
        if (!found) {
          res.status(404).json({ success: false, message: 'Project not found' });
          return;
        }
        res.json({ success: true, project: toDto(found.project) });
      } catch (error) {
        console.error('Get project failed:', error);
        res.status(500).json({ success: false, message: 'Failed to get project' });
      }
    }
  );

  app.delete(
    '/api/projects/:id',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const projectId = String(req.params.id);
        const ok = await ProjectIngestService.deleteForUser(projectId, req.user!.id);
        if (!ok) {
          res.status(404).json({ success: false, message: 'Project not found' });
          return;
        }
        void AuditLogService.append({
          userId: req.user!.id,
          action: 'project.delete',
          target: projectId,
        });
        res.json({ success: true });
      } catch (error) {
        console.error('Delete project failed:', error);
        res.status(500).json({ success: false, message: 'Failed to delete project' });
      }
    }
  );

  app.get(
    '/api/projects/:id/export',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const found = await ProjectIngestService.findForUser(String(req.params.id), req.user!.id);
        if (!found) {
          res.status(404).json({ success: false, message: 'Project not found' });
          return;
        }
        // Once session containers come online (Phase 3+) this endpoint will
        // stream a fresh tar of the live volume; for now it returns the
        // original upload so the round-trip is exercised end-to-end.
        const safeName = found.project.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'project';
        void AuditLogService.append({
          userId: req.user!.id,
          action: 'project.export',
          target: found.project.id,
        });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
        res.setHeader('Content-Length', String(found.project.size_bytes));
        const stream = fs.createReadStream(found.archivePath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to stream archive' });
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
      } catch (error) {
        console.error('Export project failed:', error);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Failed to export project' });
        }
      }
    }
  );
}

async function handleUpload(req: Request, res: Response): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, message: 'Missing file field' });
      return;
    }

    // Trim + bound the user-visible name. Falling back to the upload's
    // original filename keeps the UX sensible when the form omits it.
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const fallbackName = file.originalname.replace(/\.[^.]+$/, '') || `project-${Date.now()}`;
    const name = (rawName || fallbackName).slice(0, 200);

    const project = await ProjectIngestService.ingest({
      tempPath: file.path,
      userId: req.user!.id,
      name,
      declaredSize: file.size,
    });
    void AuditLogService.append({
      userId: req.user!.id,
      action: 'project.upload',
      target: project.id,
      meta: { sizeBytes: project.size_bytes, sha256: project.sha256 },
    });
    res.status(201).json({ success: true, project: toDto(project) });
  } catch (error) {
    if (error instanceof ProjectIngestError) {
      const status = error.code === 'oversize' ? 413 : error.code === 'invalidMagic' ? 400 : 500;
      res.status(status).json({ success: false, code: error.code, message: error.message });
      return;
    }
    console.error('Project upload failed:', error);
    res.status(500).json({ success: false, message: 'Failed to upload project' });
  }
}
