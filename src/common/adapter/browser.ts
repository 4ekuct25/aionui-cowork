/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge, logger } from '@office-ai/platform';
import { WEBUI_DEFAULT_PORT } from '@/common/config/constants';
import type { ElectronBridgeAPI } from '@/common/types/electron';

interface CustomWindow extends Window {
  electronAPI?: ElectronBridgeAPI;
  __bridgeEmitter?: { emit: (name: string, data: unknown) => void };
  __emitBridgeCallback?: (name: string, data: unknown) => void;
  __websocketReconnect?: () => void;
}

const win = window as CustomWindow;

/**
 * 适配electron的API到浏览器中,建立renderer和main的通信桥梁, 与preload.ts中的注入对应
 * */
if (win.electronAPI) {
  // Electron 环境 - 使用 IPC 通信
  bridge.adapter({
    emit(name, data) {
      return win.electronAPI.emit(name, data);
    },
    on(emitter) {
      win.electronAPI?.on((event) => {
        try {
          const { value } = event;
          const { name, data } = JSON.parse(value);
          emitter.emit(name, data);
        } catch (e) {
          console.warn('JSON parsing error:', e);
        }
      });
    },
  });
} else {
  // Web 环境 - 使用 WebSocket 通信，并在登录后自动补上已获取 Cookie 的连接
  // Web runtime bridge: ensure the socket reconnects after login so session cookie can be sent
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const defaultHost = `${window.location.hostname}:${WEBUI_DEFAULT_PORT}`;
  const socketUrl = `${protocol}//${window.location.host || defaultHost}`;

  type QueuedMessage = { name: string; data: unknown };

  let socket: WebSocket | null = null;
  let emitterRef: { emit: (name: string, data: unknown) => void } | null = null;
  let reconnectTimer: number | null = null;
  let reconnectDelay = 500;
  let shouldReconnect = true; // Flag to control reconnection
  // Tracks whether the next open is a re-establishment (vs the first ever
  // connection). Set on every close, cleared once resync fires. Without
  // this, a clean drop-and-immediate-reconnect skips resync because the
  // exponential backoff never had time to grow past 500ms.
  let hasConnectedBefore = false;

  const messageQueue: QueuedMessage[] = [];

  // Phase 9.4: per-conversation high-water mark of stream events the
  // renderer has applied. Used to ask the server for a delta after a WS
  // reconnect (`conversation.stream-resync`).
  const lastSeenSeq = new Map<string, number>();

  /**
   * After a reconnect, ask the server to replay anything we missed for
   * each conversation we've been streaming. Fires fire-and-forget RPCs
   * by issuing a synthetic invoke through the same emit channel the
   * provider helper uses (`subscribe-<name>` + id correlation).
   */
  const requestStreamResync = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const [conversationId, sinceSeq] of lastSeenSeq.entries()) {
      const id = `stream-resync-${conversationId}-${Date.now()}`;
      // Bridge subscribe envelope: { name, data: { id, data: payload } }.
      // The server's bridge handler destructures `n.data` to get the
      // payload, so we must wrap once even though it feels redundant.
      socket.send(
        JSON.stringify({
          name: 'subscribe-conversation.stream-resync',
          data: { id, data: { conversationId, sinceSeq } },
        })
      );
    }
  };

  // 1.发送队列中积压的消息，确保在重新建立连接后不会丢事件
  const flushQueue = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (messageQueue.length > 0) {
      const queued = messageQueue.shift();
      if (queued) {
        socket.send(JSON.stringify(queued));
      }
    }
  };

  // 2.简单的指数退避重连，等待服务端在登录成功后接受新连接
  const scheduleReconnect = () => {
    if (reconnectTimer !== null || !shouldReconnect) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
      connect();
    }, reconnectDelay);
  };

  // 3.建立 WebSocket 连接（或复用已有的 OPEN/CONNECTING 状态）
  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      socket = new WebSocket(socketUrl);
    } catch (error) {
      scheduleReconnect();
      return;
    }

    // Capture the socket created in this call so the close handler only
    // nulls the outer reference when it still points at THIS socket.
    // Without this guard, a late-firing close event from the OLD socket
    // could wipe the reference to a NEWLY created replacement socket.
    const currentSocket = socket;

    currentSocket.addEventListener('open', () => {
      const isReconnect = hasConnectedBefore;
      hasConnectedBefore = true;
      reconnectDelay = 500;
      flushQueue();
      if (isReconnect) {
        // Phase 9.4: after a reconnect, ask the server to replay any
        // events we missed for each conversation we have a seq for. The
        // server's StreamReplayBuffer holds the last ~1000 events per
        // conversation; on gap (buffer doesn't cover sinceSeq) it
        // returns `{gap:true}` and the renderer is expected to re-fetch
        // from the DB.
        requestStreamResync();
      }
    });

    currentSocket.addEventListener('message', (event: MessageEvent) => {
      if (!emitterRef) {
        return;
      }

      try {
        const payload = JSON.parse(event.data as string) as {
          name: string;
          data: unknown;
        };

        // Track the highest `_seq` we've applied per conversation so we
        // can ask for a delta on reconnect. Server stamps these on every
        // stream event that's worth replaying (see IpcAgentEventEmitter).
        const data = payload.data as { conversation_id?: string; _seq?: number } | undefined;
        if (data && typeof data === 'object' && typeof data._seq === 'number' && data.conversation_id) {
          const prev = lastSeenSeq.get(data.conversation_id) ?? 0;
          if (data._seq > prev) {
            lastSeenSeq.set(data.conversation_id, data._seq);
          }
        }

        // 处理服务端心跳 ping，立即回复 pong 以保持连接
        // Handle server heartbeat ping - respond with pong immediately to keep connection alive
        if (payload.name === 'ping') {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ name: 'pong', data: { timestamp: Date.now() } }));
          }
          return;
        }

        // 处理认证过期 - 停止重连并跳转到登录页
        // Handle auth expiration - stop reconnecting and redirect to login
        if (payload.name === 'auth-expired') {
          console.warn('[WebSocket] Authentication expired, stopping reconnection');
          shouldReconnect = false;

          // 清除所有待执行的重连定时器
          // Clear any pending reconnection timer
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }

          // 关闭 socket 并跳转到登录页
          // Close the socket and redirect to login page
          socket?.close();

          // 已在登录页则不再重定向，防止无限刷新循环
          // Skip redirect if already on login page to prevent infinite reload loop
          if (window.location.pathname === '/login' || window.location.hash.includes('/login')) {
            return;
          }

          // 短暂延迟后跳转到登录页，以便显示 UI 反馈
          // Redirect to login page after a short delay to show any UI feedback
          // Use hash navigation to stay within the SPA (HashRouter), avoiding a full
          // page reload that would land on an empty hash and cause a blank screen.
          setTimeout(() => {
            window.location.hash = '/login';
          }, 1000);

          return;
        }

        // Intercept the resync response: server returns the buffered
        // events as an array; re-emit each one through the local emitter
        // so the renderer's existing stream handlers process them as if
        // they had arrived live during the disconnect window.
        if (payload.name.startsWith('subscribe.callback-conversation.stream-resync')) {
          const resyncData = payload.data as
            | { gap?: boolean; events?: Array<{ seq: number; name: string; data: { conversation_id?: string; _seq?: number } }> }
            | undefined;
          if (resyncData?.events?.length) {
            for (const ev of resyncData.events) {
              // Stamp _seq onto the replayed payload (defensive — server
              // already stamps the live broadcast, but the buffer keeps
              // raw payloads so we make sure the renderer sees the seq).
              const replayPayload = { ...ev.data, _seq: ev.seq };
              if (replayPayload.conversation_id) {
                const prev = lastSeenSeq.get(replayPayload.conversation_id) ?? 0;
                if (ev.seq > prev) lastSeenSeq.set(replayPayload.conversation_id, ev.seq);
              }
              emitterRef.emit(ev.name, replayPayload);
            }
          }
          return;
        }

        emitterRef.emit(payload.name, payload.data);
      } catch (error) {
        // 忽略формат-ошибки / Ignore malformed payloads
      }
    });

    currentSocket.addEventListener('close', (event: CloseEvent) => {
      // Only null the outer reference if it still points at this socket.
      if (socket === currentSocket) {
        socket = null;
      }

      // Detect auth failure from close code (server sends 1008 for token issues).
      // This acts as a fallback in case the auth-expired message was not received
      // (e.g., socket not yet ready for sending during initial handshake).
      if (event.code === 1008 && !shouldReconnect) {
        return; // Already handled by auth-expired message handler
      }
      if (event.code === 1008) {
        console.warn('[WebSocket] Connection rejected by server (policy violation), redirecting to login');
        shouldReconnect = false;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        // 已在登录页则不再重定向，防止无限刷新循环
        // Skip redirect if already on login page to prevent infinite reload loop
        if (window.location.pathname === '/login' || window.location.hash.includes('/login')) {
          return;
        }
        // Use hash navigation to stay within the SPA (HashRouter)
        setTimeout(() => {
          window.location.hash = '/login';
        }, 500);
        return;
      }

      scheduleReconnect();
    });

    currentSocket.addEventListener('error', () => {
      currentSocket.close();
    });
  };

  // 4.确保在发送/订阅前已经发起连接
  const ensureSocket = () => {
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      connect();
    }
  };

  bridge.adapter({
    emit(name, data) {
      const message: QueuedMessage = { name, data };

      ensureSocket();

      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(message));
          return;
        } catch (error) {
          scheduleReconnect();
        }
      }

      messageQueue.push(message);
    },
    on(emitter) {
      emitterRef = emitter;
      win.__bridgeEmitter = emitter;

      // Expose callback emitter for bridge provider pattern
      // Used by components to send responses back through WebSocket
      win.__emitBridgeCallback = (name: string, data: unknown) => {
        emitter.emit(name, data);
      };

      ensureSocket();
    },
  });

  connect();

  // Expose reconnection control for login flow
  win.__websocketReconnect = () => {
    shouldReconnect = true;
    reconnectDelay = 500;
    connect();
  };
}

logger.provider({
  log(log) {
    console.log('process.log', log.type, ...log.logs);
  },
  path() {
    return Promise.resolve('');
  },
});
