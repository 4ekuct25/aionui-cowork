/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import { getDatabase } from '@process/services/database/export';
import { isOidcEnabled } from '@process/webserver/auth/oidc/OidcConfig';

/**
 * Liveness/readiness endpoint consumed by docker-compose healthcheck (and
 * any external monitor). Returns 200 with a small status JSON when the
 * essential services answer, 503 otherwise.
 *
 * Intentionally public — health probes must not need credentials. The
 * payload only exposes information that helps an operator diagnose ("db
 * unreachable", "OIDC misconfigured"), nothing tenant-specific.
 */
export function registerHealthRoutes(app: Express): void {
  app.get('/api/health', async (_req: Request, res: Response) => {
    const checks: { db: 'ok' | 'error'; oidcEnabled: boolean; dockerMode: boolean; signupEnabled: boolean } = {
      db: 'error',
      oidcEnabled: isOidcEnabled(),
      dockerMode: (process.env.AIONUI_PLATFORM ?? '').trim().toLowerCase() === 'docker',
      signupEnabled: (process.env.ENABLE_LOCAL_SIGNUP ?? '').trim().toLowerCase() === 'true',
    };

    try {
      const db = await getDatabase();
      // Cheapest possible round-trip — a single integer literal from sqlite.
      db.getDriver().prepare('SELECT 1').get();
      checks.db = 'ok';
    } catch (error) {
      console.warn('[Health] database probe failed:', error);
    }

    const ok = checks.db === 'ok';
    res.status(ok ? 200 : 503).json({ success: ok, ...checks });
  });
}
