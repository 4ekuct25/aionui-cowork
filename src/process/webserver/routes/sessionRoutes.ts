/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import { AuthMiddleware } from '@process/webserver/auth/middleware/AuthMiddleware';
import { authenticatedActionLimiter, apiRateLimiter } from '../middleware/security';
import { getDatabase } from '@process/services/database/export';
import { DockerSessionManager, SessionProjectNotFoundError } from '@process/services/DockerSessionManager';
import { AuditLogService } from '@process/services/AuditLogService';
import type { IDockerSession } from '@process/services/database/types';

/**
 * Hide the host-side container_id from API responses — clients shouldn't
 * need to know it, and exposing it makes pivoting easier for an attacker.
 */
function toDto(session: IDockerSession) {
  return {
    conversationId: session.conversation_id,
    projectId: session.project_id,
    status: session.status,
    startedAt: session.started_at,
    lastSeenAt: session.last_seen_at,
  };
}

/**
 * Verify that the requesting user owns the given conversation. Returns the
 * row when they do; null when the conversation doesn't exist OR is owned by
 * someone else (deliberately collapsed so we don't leak existence).
 */
async function ownConversation(conversationId: string, userId: string): Promise<{ projectId: string | null } | null> {
  const db = await getDatabase();
  const row = db
    .getDriver()
    .prepare('SELECT user_id, project_id FROM conversations WHERE id = ?')
    .get(conversationId) as { user_id: string; project_id: string | null } | undefined;
  if (!row || row.user_id !== userId) {
    return null;
  }
  return { projectId: row.project_id };
}

/**
 * Register session lifecycle routes:
 *   POST   /api/sessions               — acquire (idempotent)
 *   GET    /api/sessions/:conversation — status
 *   DELETE /api/sessions/:conversation — release (?destroy=1 removes volume)
 *
 * `acquire` also links the conversation to the project (sets
 * conversations.project_id) so the chat row remembers its workspace even
 * after the container is stopped.
 */
export function registerSessionRoutes(app: Express): void {
  app.post(
    '/api/sessions',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
        const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
        if (!conversationId || !projectId) {
          res.status(400).json({ success: false, message: 'conversationId and projectId are required' });
          return;
        }

        const owned = await ownConversation(conversationId, req.user!.id);
        if (!owned) {
          res.status(404).json({ success: false, message: 'Conversation not found' });
          return;
        }

        const { session, created } = await DockerSessionManager.acquire({
          conversationId,
          userId: req.user!.id,
          projectId,
        });

        // Remember the project link on the conversation row so the chat
        // resumes against the same workspace next time.
        const db = await getDatabase();
        db.setConversationProject(conversationId, req.user!.id, projectId);

        // Only log on cold start — warm re-acquires would fill the log with
        // noise, and the session row's `last_seen_at` already records them.
        if (created) {
          void AuditLogService.append({
            userId: req.user!.id,
            action: 'session.acquire',
            target: conversationId,
            meta: { projectId },
          });
        }

        res.status(created ? 201 : 200).json({ success: true, session: toDto(session) });
      } catch (error) {
        if (error instanceof SessionProjectNotFoundError) {
          res.status(404).json({ success: false, message: 'Project not found' });
          return;
        }
        console.error('Acquire session failed:', error);
        res.status(500).json({ success: false, message: 'Failed to acquire session' });
      }
    }
  );

  app.get(
    '/api/sessions/:conversation',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const conversationId = String(req.params.conversation);
        const owned = await ownConversation(conversationId, req.user!.id);
        if (!owned) {
          res.status(404).json({ success: false, message: 'Conversation not found' });
          return;
        }
        const db = await getDatabase();
        const result = db.getDockerSessionForUser(conversationId, req.user!.id);
        if (!result.success || !result.data) {
          res.status(404).json({ success: false, message: 'No session for this conversation' });
          return;
        }
        res.json({ success: true, session: toDto(result.data) });
      } catch (error) {
        console.error('Get session failed:', error);
        res.status(500).json({ success: false, message: 'Failed to get session' });
      }
    }
  );

  app.delete(
    '/api/sessions/:conversation',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const conversationId = String(req.params.conversation);
        const owned = await ownConversation(conversationId, req.user!.id);
        if (!owned) {
          res.status(404).json({ success: false, message: 'Conversation not found' });
          return;
        }
        // `?destroy=1` (or true) tears down volume + row; otherwise we just
        // stop+remove the container so the volume can be reused on next
        // acquire.
        const destroy = req.query?.destroy === '1' || req.query?.destroy === 'true';
        if (destroy) {
          await DockerSessionManager.destroy(conversationId, req.user!.id);
        } else {
          await DockerSessionManager.release(conversationId, req.user!.id);
        }
        void AuditLogService.append({
          userId: req.user!.id,
          action: destroy ? 'session.destroy' : 'session.release',
          target: conversationId,
        });
        res.json({ success: true });
      } catch (error) {
        console.error('Release session failed:', error);
        res.status(500).json({ success: false, message: 'Failed to release session' });
      }
    }
  );
}
