/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Tag } from '@arco-design/web-react';
import { Spin } from '@arco-design/web-react';

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  starting: 'orange',
  stopped: 'red',
  error: 'red',
};

/**
 * Polls /api/sessions/:conversationId and displays a small status badge
 * when the conversation has an active Docker session container.
 */
export function ContainerStatusBadge({ conversationId }: { conversationId?: string }) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;

    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/sessions/${conversationId}`, { credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status ?? null);
        } else if (res.status === 404) {
          setStatus(null);
        }
      } catch {
        // ignore — not in docker mode
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [conversationId]);

  if (!status) return null;

  return (
    <Tag
      color={STATUS_COLORS[status] ?? 'gray'}
      style={{
        borderRadius: '10px',
        padding: '2px 10px',
        fontSize: '12px',
        lineHeight: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        border: 'none',
      }}
    >
      {status === 'starting' && <Spin size={12} />}
      <span className='capitalize'>
        {status === 'running' ? '⬢ Container' : status === 'starting' ? '⏳ Starting' : '⏹ Stopped'}
      </span>
    </Tag>
  );
}
