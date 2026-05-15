/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import { AuthMiddleware } from '@process/webserver/auth/middleware/AuthMiddleware';
import { authenticatedActionLimiter, apiRateLimiter } from '../middleware/security';
import { SecretsService, SecretsConfigError, SecretDecryptError } from '@process/services/SecretsService';
import { AuditLogService } from '@process/services/AuditLogService';

/**
 * Per-user encrypted secrets vault. Plaintext never leaves the server via
 * any of these endpoints — `GET` returns only key names + timestamps so
 * the UI can render a list without exfiltrating live credentials. To
 * actually use a secret, the agent layer calls SecretsService.read(...)
 * server-side.
 *
 *   GET    /api/secrets               — list owned key names
 *   PUT    /api/secrets/:keyName      — store / replace (body: {value})
 *   DELETE /api/secrets/:keyName      — remove
 */
export function registerSecretsRoutes(app: Express): void {
  app.get(
    '/api/secrets',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const secrets = await SecretsService.list(req.user!.id);
        res.json({ success: true, secrets });
      } catch (error) {
        console.error('List secrets failed:', error);
        res.status(500).json({ success: false, message: 'Failed to list secrets' });
      }
    }
  );

  app.put(
    '/api/secrets/:keyName',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const keyName = String(req.params.keyName);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyName)) {
          res.status(400).json({ success: false, message: 'keyName must match [A-Za-z0-9._-]{1,64}' });
          return;
        }
        const value = typeof req.body?.value === 'string' ? req.body.value : '';
        if (!value) {
          res.status(400).json({ success: false, message: 'value (string, non-empty) is required' });
          return;
        }

        const meta = await SecretsService.store(req.user!.id, keyName, value);
        void AuditLogService.append({
          userId: req.user!.id,
          action: 'secret.store',
          target: keyName,
        });
        res.json({ success: true, secret: meta });
      } catch (error) {
        if (error instanceof SecretsConfigError) {
          // 500 because it's an operator misconfiguration, not a user error.
          console.error('SecretsService misconfigured:', error.message);
          res.status(500).json({ success: false, message: error.message });
          return;
        }
        console.error('Store secret failed:', error);
        res.status(500).json({ success: false, message: 'Failed to store secret' });
      }
    }
  );

  app.delete(
    '/api/secrets/:keyName',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const keyName = String(req.params.keyName);
        const removed = await SecretsService.delete(req.user!.id, keyName);
        if (!removed) {
          res.status(404).json({ success: false, message: 'Secret not found' });
          return;
        }
        void AuditLogService.append({
          userId: req.user!.id,
          action: 'secret.delete',
          target: keyName,
        });
        res.json({ success: true });
      } catch (error) {
        console.error('Delete secret failed:', error);
        res.status(500).json({ success: false, message: 'Failed to delete secret' });
      }
    }
  );

  // Helper kept exposed for future routes that surface decryption failures
  // (e.g. an agent endpoint that returns 503 when KMS_KEY is wrong).
  void SecretDecryptError;
}
