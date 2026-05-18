/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { registerWebSocketBroadcaster, getBridgeEmitter } from '@/common/adapter/registry';
import { WebSocketManager } from './websocket/WebSocketManager';
import { getDatabase } from '@process/services/database/export';
import { runWithCaller } from './callerContext';
import { StreamReplayBuffer } from '@process/services/StreamReplayBuffer';

// 存储取消注册函数，用于服务器停止时清理
// Store unregister function for cleanup when server stops
let unregisterBroadcaster: (() => void) | null = null;
// Module-level reference so cleanupWebAdapter can destroy the heartbeat timer
let wsManagerInstance: WebSocketManager | null = null;

/**
 * Resolve the running container for a conversation.
 */
async function resolveContainerId(conversationId: string): Promise<string | null> {
  try {
    const db = await getDatabase();
    const session = db
      .getDriver()
      .prepare(`SELECT container_id FROM docker_sessions WHERE conversation_id = ? AND status = 'running'`)
      .get(conversationId) as { container_id: string } | undefined;
    return session?.container_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 初始化 Web 适配器 - 建立 WebSocket 与 bridge 的通信桥梁
 * Initialize Web Adapter - Bridge communication between WebSocket and platform bridge
 *
 * 注意：不再调用 bridge.adapter()，而是注册到主适配器
 * Note: No longer calling bridge.adapter(), instead registering with main adapter
 * 这样可以避免覆盖 Electron IPC 适配器
 * This avoids overwriting the Electron IPC adapter
 */
export function initWebAdapter(wss: WebSocketServer): void {
  const wsManager = new WebSocketManager(wss);
  wsManagerInstance = wsManager;
  wsManager.initialize();

  // Stamp every conversation-scoped broadcast with a monotonic `_seq` and
  // record it in the per-conversation replay buffer. The renderer tracks
  // the last `_seq` it saw and asks the server to replay missed events on
  // WS reconnect (see `conversation.streamResync`). We do this at the WS
  // edge (vs each emit site) because many agent managers emit directly
  // without going through `IpcAgentEventEmitter`.
  unregisterBroadcaster = registerWebSocketBroadcaster((name, data) => {
    const conversationId =
      data && typeof data === 'object' ? (data as { conversation_id?: string }).conversation_id : undefined;
    if (conversationId) {
      const seq = StreamReplayBuffer.record(conversationId, name, data);
      if (seq !== null) {
        wsManager.broadcast(name, { ...(data as object), _seq: seq });
        return;
      }
    }
    wsManager.broadcast(name, data);
  });

  // 设置 WebSocket 消息处理器，将消息转发到 bridge emitter
  // Setup WebSocket message handler to forward messages to bridge emitter
  wsManager.setupConnectionHandler(
    (name, data, _ws, userId) => {
      const emitter = getBridgeEmitter();
      console.log('[adapter] WS message received:', name, JSON.stringify(data).substring(0, 120));
      if (emitter) {
        // Tag the in-flight bridge dispatch with the authenticated caller so
        // providers (e.g. conversation.remove) can enforce ownership without
        // trusting client-supplied identifiers.
        runWithCaller({ userId }, () => {
          emitter.emit(name, data);
        });
      } else {
        console.warn('[adapter] Bridge emitter not set, message dropped:', name);
      }
    },
    async (ws: import('ws').WebSocket, conversationId: string, _req: IncomingMessage) => {
      const containerId = await resolveContainerId(conversationId);
      if (!containerId) {
        ws.close(1008, 'No running container for this conversation');
        return;
      }
      const { attachShellToContainer } = await import('./routes/shellRoute');
      await attachShellToContainer(ws, containerId);
    }
  );
}

/**
 * 清理 Web 适配器（服务器停止时调用）
 * Cleanup Web Adapter (called when server stops)
 */
export function cleanupWebAdapter(): void {
  if (unregisterBroadcaster) {
    unregisterBroadcaster();
    unregisterBroadcaster = null;
  }
  // Destroy the WebSocket manager to clear the heartbeat setInterval,
  // which would otherwise keep the event loop alive after shutdown.
  if (wsManagerInstance) {
    wsManagerInstance.destroy();
    wsManagerInstance = null;
  }
}
