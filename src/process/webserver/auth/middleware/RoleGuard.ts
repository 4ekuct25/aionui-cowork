/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { UserRole } from '@process/services/database/types';

/**
 * Express middleware factory that allows the request through only when the
 * authenticated user has one of the accepted roles.
 *
 * MUST be chained AFTER `AuthMiddleware.authenticateToken` so that `req.user`
 * is already populated; otherwise the guard responds 401 (no session).
 *
 * @example
 *   app.get(
 *     '/admin/users',
 *     AuthMiddleware.authenticateToken,
 *     requireRole('admin'),
 *     handler,
 *   );
 */
export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  if (allowedRoles.length === 0) {
    throw new Error('requireRole(): at least one role must be provided');
  }
  const allowed = new Set<UserRole>(allowedRoles);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    if (!allowed.has(req.user.role)) {
      res.status(403).json({
        success: false,
        message: 'Forbidden: insufficient privileges',
      });
      return;
    }
    next();
  };
}
