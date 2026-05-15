/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import { AuthMiddleware, requireRole } from '@process/webserver/auth';
import { UserRepository } from '@process/webserver/auth/repository/UserRepository';
import { authenticatedActionLimiter, apiRateLimiter } from '../middleware/security';
import { AuditLogService } from '@process/services/AuditLogService';
import { DockerSessionManager } from '@process/services/DockerSessionManager';
import type { AuthUser } from '@process/webserver/auth/repository/UserRepository';
import type { IDockerSession } from '@process/services/database/types';

/**
 * Admin-only diagnostic + operational endpoints. Each route requires both:
 *   1. AuthMiddleware.authenticateToken — must be logged in
 *   2. requireRole('admin')             — must hold the admin role
 *
 * Phase 10 ships the API surface; the renderer-side admin panel that
 * consumes it follows separately. Endpoints intentionally hide nothing
 * sensitive (audit_log + session DTOs); they're meant for incident
 * response and tenant management.
 */
function userDto(user: AuthUser) {
  // Drop the password hash + jwt secret. Email + role + last_login are
  // useful to an admin; everything else is implementation detail.
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLogin: user.last_login,
    oidcLinked: Boolean(user.oidc_sub),
  };
}

function sessionDto(session: IDockerSession) {
  return {
    conversationId: session.conversation_id,
    userId: session.user_id,
    projectId: session.project_id,
    status: session.status,
    startedAt: session.started_at,
    lastSeenAt: session.last_seen_at,
  };
}

export function registerAdminRoutes(app: Express): void {
  app.get(
    '/api/admin/users',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    requireRole('admin'),
    authenticatedActionLimiter,
    async (_req: Request, res: Response) => {
      try {
        const users = await UserRepository.listUsers();
        res.json({ success: true, users: users.map(userDto) });
      } catch (error) {
        console.error('Admin list users failed:', error);
        res.status(500).json({ success: false, message: 'Failed to list users' });
      }
    }
  );

  app.get(
    '/api/admin/audit-log',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    requireRole('admin'),
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
        const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
        // Filters are optional. `userId` (single user audit view) and
        // `action` (filter by AuditAction string) keep the simple
        // signatures from AuditLogService.list.
        const userIdRaw = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
        const actionRaw = typeof req.query.action === 'string' ? req.query.action.trim() : '';

        const rows = await AuditLogService.list({
          userId: userIdRaw ? userIdRaw : null,
          action: actionRaw ? actionRaw : null,
          limit,
          offset,
        });
        res.json({
          success: true,
          events: rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            action: row.action,
            target: row.target,
            // meta lives as a JSON string in the column — parse so the
            // admin UI gets structured objects rather than strings.
            meta: safeParseMeta(row.meta),
            createdAt: row.created_at,
          })),
        });
      } catch (error) {
        console.error('Admin audit log failed:', error);
        res.status(500).json({ success: false, message: 'Failed to read audit log' });
      }
    }
  );

  app.get(
    '/api/admin/sessions',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    requireRole('admin'),
    authenticatedActionLimiter,
    async (_req: Request, res: Response) => {
      try {
        const sessions = await DockerSessionManager.listActive();
        res.json({ success: true, sessions: sessions.map(sessionDto) });
      } catch (error) {
        console.error('Admin list sessions failed:', error);
        res.status(500).json({ success: false, message: 'Failed to list sessions' });
      }
    }
  );

  // DELETE /api/admin/sessions/:conversation
  // Force-kills a session container regardless of which user owns it.
  // Equivalent to DELETE /api/sessions/:id?destroy=1 but bypasses the
  // per-user scope check. Used to evict runaway sandboxes during
  // incident response.
  app.delete(
    '/api/admin/sessions/:conversation',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    requireRole('admin'),
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const conversationId = String(req.params.conversation);
        // We still need the owning user id to call destroy(); look it up
        // off the docker_sessions row so admins don't have to pass it.
        const sessions = await DockerSessionManager.listActive();
        const target = sessions.find((s) => s.conversation_id === conversationId);
        if (!target) {
          res.status(404).json({ success: false, message: 'Session not found' });
          return;
        }
        await DockerSessionManager.destroy(conversationId, target.user_id);
        res.json({ success: true });
      } catch (error) {
        console.error('Admin destroy session failed:', error);
        res.status(500).json({ success: false, message: 'Failed to destroy session' });
      }
    }
  );
}

function safeParseMeta(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
