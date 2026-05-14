/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthUser } from '@process/webserver/auth/repository/UserRepository';

declare global {
  namespace Express {
    interface Request {
      // `role` is included so route guards can enforce admin-only access
      // without re-querying the database on every request.
      user?: Pick<AuthUser, 'id' | 'username' | 'role'>;
      cookies?: Record<string, string>;
      csrfToken?: () => string;
    }
  }
}
