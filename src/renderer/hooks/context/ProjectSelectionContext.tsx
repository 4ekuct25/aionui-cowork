/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { withCsrfToken } from '@process/webserver/middleware/csrfClient';

/**
 * Lightweight chat-creation-time selection of an uploaded project. When set,
 * `useGuidSend` will additionally POST /api/sessions after the conversation
 * is created so the chat is attached to a project volume (Phase 4C).
 *
 * Lives in its own context (not in AuthContext) so it can be wrapped only
 * around the GuidPage that needs it — keeping ordinary auth consumers
 * un-disturbed.
 */
export type ProjectSummary = {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
};

type ProjectSelectionContextValue = {
  /** All projects owned by the current user (newest first). null while loading. */
  available: ProjectSummary[] | null;
  /** Currently selected project id; null means "no sandbox" (legacy path). */
  selectedProjectId: string | null;
  /** Update the selection. Persists in sessionStorage so a refresh keeps it. */
  setSelectedProjectId: (id: string | null) => void;
  /** Manual refetch — useful after the user uploads a new project on /projects. */
  refresh: () => void;
};

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | undefined>(undefined);

const STORAGE_KEY = 'aionui:selectedProjectId';

export const ProjectSelectionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [available, setAvailable] = useState<ProjectSummary[] | null>(null);
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(STORAGE_KEY);
  });

  const refresh = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/projects', { credentials: 'include' });
        if (!response.ok) return;
        const data = (await response.json()) as { projects?: ProjectSummary[] };
        if (!cancelled) setAvailable(data.projects ?? []);
      } catch (err) {
        // Silently ignore — the projects API is optional for chat creation
        // (legacy single-tenant path keeps working without it). The Guid
        // picker just won't render its dropdown.
        if (!cancelled) {
          console.warn('[ProjectSelection] fetch failed:', err);
          setAvailable([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return refresh();
  }, [refresh]);

  const setSelectedProjectId = useCallback((id: string | null) => {
    setSelectedProjectIdState(id);
    if (typeof window !== 'undefined') {
      if (id) {
        window.sessionStorage.setItem(STORAGE_KEY, id);
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  const value = useMemo<ProjectSelectionContextValue>(
    () => ({ available, selectedProjectId, setSelectedProjectId, refresh }),
    [available, refresh, selectedProjectId, setSelectedProjectId]
  );

  return <ProjectSelectionContext.Provider value={value}>{children}</ProjectSelectionContext.Provider>;
};

/**
 * Hook for components that read or set the current project selection.
 * Returns a no-op shape when used outside the provider so legacy chat
 * pages that don't render the picker keep compiling.
 */
export function useProjectSelection(): ProjectSelectionContextValue {
  const ctx = useContext(ProjectSelectionContext);
  if (!ctx) {
    return {
      available: null,
      selectedProjectId: null,
      setSelectedProjectId: () => {},
      refresh: () => {},
    };
  }
  return ctx;
}

/**
 * Attach a freshly-created conversation to a project. Best-effort — failure
 * here doesn't break the chat itself (it just runs without a sandbox).
 *
 * Called by useGuidSend after each `ipcBridge.conversation.create.invoke`.
 */
export async function attachConversationToProject(
  conversationId: string,
  projectId: string,
): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    const body = withCsrfToken({ conversationId, projectId });
    const response = await fetch('/api/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      return { ok: false, status: response.status, message: data?.message };
    }
    return { ok: true };
  } catch (error) {
    console.warn('[ProjectSelection] attach failed:', error);
    return { ok: false, message: (error as Error).message };
  }
}
