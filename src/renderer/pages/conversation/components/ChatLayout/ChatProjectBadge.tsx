/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Dropdown, Menu, Message, Tag } from '@arco-design/web-react';
import { FolderClose } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useProjectSelection } from '@renderer/hooks/context/ProjectSelectionContext';
import { withCsrfToken } from '@process/webserver/middleware/csrfClient';

type SessionDto = { projectId?: string | null };

/**
 * Badge shown in the chat header listing the project attached to the
 * current conversation. Click → dropdown with "Switch project" entries
 * (re-POST /api/sessions) and "Detach" (DELETE the session).
 *
 * Silent no-op when /api/sessions/:id returns 404 (chat predates Phase 4C
 * or the user runs in non-docker mode).
 */
export function ChatProjectBadge({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation();
  const { available, refresh } = useProjectSelection();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${conversationId}`, { credentials: 'same-origin' });
        if (!res.ok) {
          if (!cancelled) setProjectId(null);
          return;
        }
        const data = (await res.json()) as { session?: SessionDto };
        if (!cancelled) setProjectId(data.session?.projectId ?? null);
      } catch {
        if (!cancelled) setProjectId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, reloadTick]);

  const project = projectId && available ? available.find((p) => p.id === projectId) : undefined;

  const handleSwitch = useCallback(
    async (newProjectId: string) => {
      if (!conversationId) return;
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withCsrfToken({ conversationId, projectId: newProjectId })),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          Message.error(data?.message ?? t('projects.badge.switchFailed'));
          return;
        }
        Message.success(t('projects.badge.switched'));
        setReloadTick((n) => n + 1);
      } catch (err) {
        Message.error((err as Error).message);
      }
    },
    [conversationId, t]
  );

  const handleDetach = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/sessions/${conversationId}?destroy=1`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        Message.error(data?.message ?? t('projects.badge.detachFailed'));
        return;
      }
      Message.success(t('projects.badge.detached'));
      setReloadTick((n) => n + 1);
    } catch (err) {
      Message.error((err as Error).message);
    }
  }, [conversationId, t]);

  if (!conversationId || projectId === null) return null;

  const label = project?.name ?? t('projects.badge.unknown');
  const others = (available ?? []).filter((p) => p.id !== projectId);

  const menu = (
    <Menu>
      {others.length > 0 && (
        <Menu.SubMenu key='switch' title={t('projects.badge.switch')}>
          {others.map((p) => (
            <Menu.Item key={`switch-${p.id}`} onClick={() => void handleSwitch(p.id)}>
              {p.name}
            </Menu.Item>
          ))}
        </Menu.SubMenu>
      )}
      <Menu.Item key='refresh' onClick={() => refresh()}>
        {t('projects.badge.refreshList')}
      </Menu.Item>
      <Menu.Item key='detach' onClick={() => void handleDetach()} style={{ color: 'var(--color-danger)' }}>
        {t('projects.badge.detach')}
      </Menu.Item>
    </Menu>
  );

  return (
    <Dropdown droplist={menu} trigger='click' position='br'>
      <Tag
        color='arcoblue'
        bordered
        icon={<FolderClose theme='outline' size='12' />}
        style={{
          borderRadius: '10px',
          padding: '2px 10px',
          fontSize: '12px',
          lineHeight: '20px',
          cursor: 'pointer',
        }}
      >
        {label}
      </Tag>
    </Dropdown>
  );
}

export default ChatProjectBadge;
