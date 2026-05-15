/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { getDatabase } from '@process/services/database/export';
import type { IAuditLogRow } from '@process/services/database/types';

/**
 * Stable action vocabulary used by every audit call site. Keeping the set of
 * strings centralised means admin views can filter on enum values rather
 * than free-form text. New actions land here first, then in the call sites.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.register'
  | 'auth.oidc.link'
  | 'auth.oidc.login'
  | 'project.upload'
  | 'project.delete'
  | 'project.export'
  | 'session.acquire'
  | 'session.release'
  | 'session.destroy'
  | 'secret.store'
  | 'secret.delete';

export type AppendInput = {
  /** Caller user ID; `null` when the event is anonymous (e.g. failed login). */
  userId: string | null;
  /** One of the AuditAction strings — keep the list above in sync. */
  action: AuditAction;
  /** Entity the action operates on (project id, conversation id, …). Optional. */
  target?: string | null;
  /** Free-form JSON-serialisable details (HTTP IP, archive size, error code). */
  meta?: Record<string, unknown>;
};

/**
 * Append-only audit trail. Every call is best-effort — if the insert fails,
 * we log a warning and **do not** throw, because dropping an audit row must
 * never break the user-visible operation that triggered it (the audit
 * trail's purpose is to record what already happened, not to gate it).
 *
 * The unique-id is a 16-byte random hex prefixed with `aud_` so admin UIs
 * can copy/paste an id from a log row without worrying about ambiguity.
 */
export const AuditLogService = {
  async append(input: AppendInput): Promise<void> {
    try {
      const db = await getDatabase();
      const id = `aud_${crypto.randomBytes(8).toString('hex')}`;
      const meta = JSON.stringify(input.meta ?? {});
      const result = db.appendAuditLog({
        id,
        userId: input.userId,
        action: input.action,
        target: input.target ?? null,
        meta,
        createdAt: Date.now(),
      });
      if (!result.success) {
        console.warn('[Audit] append failed:', result.error);
      }
    } catch (error) {
      // Even getDatabase() throwing must not propagate — caller might be in
      // the middle of an HTTP response.
      console.warn('[Audit] append threw, swallowing:', error);
    }
  },

  /**
   * List events. `userId=null` means "all users" (admin view). Caller is
   * expected to enforce admin role before invoking; this service does no
   * authorisation of its own.
   */
  async list(options: {
    userId?: string | null;
    action?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<IAuditLogRow[]> {
    const db = await getDatabase();
    const result = db.listAuditLog({
      userId: options.userId === undefined ? null : options.userId,
      action: options.action ?? null,
      limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
      offset: Math.max(options.offset ?? 0, 0),
    });
    if (!result.success) {
      throw new Error(result.error || 'Failed to read audit log');
    }
    return result.data ?? [];
  },
};
