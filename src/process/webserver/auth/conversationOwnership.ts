/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database/export';

/**
 * Verify that the requesting user owns the given conversation. Returns the
 * row when they do; null when the conversation doesn't exist OR is owned by
 * someone else (deliberately collapsed so we don't leak existence).
 */
export async function ownConversation(
  conversationId: string,
  userId: string
): Promise<{ projectId: string | null } | null> {
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
