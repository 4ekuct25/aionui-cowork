/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallerContext {
  userId: string;
}

const storage = new AsyncLocalStorage<CallerContext>();

export function runWithCaller<T>(ctx: CallerContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Caller userId of the in-flight WS bridge request, or undefined when the
 * request did not originate from an authenticated WebSocket (e.g. Electron
 * single-user IPC). Providers that need to enforce ownership should fall
 * back to permissive behavior when undefined — Electron callers are not
 * cross-tenant.
 */
export function getCallerUserId(): string | undefined {
  return storage.getStore()?.userId;
}
