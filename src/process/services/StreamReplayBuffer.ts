/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-conversation ring buffer of recent stream events for WebSocket
 * reconnect-replay. Without this, a renderer that drops its WS mid-stream
 * (transient network blip, mobile sleep, laptop lid close) loses every
 * event broadcast during the gap — the chat panel would freeze
 * mid-token. With this, the client tracks the last `_seq` it saw, sends
 * `conversation.streamResync({conversationId, sinceSeq})` on reconnect,
 * and the server replays the missed events.
 *
 * Design constraints:
 * - In-memory only. Events older than the cap (default 1000 per
 *   conversation) are dropped — clients that miss more than that window
 *   need to re-fetch the conversation from `database.getConversationMessages`
 *   instead (renderer already does this on cold mount).
 * - LRU eviction across conversations (default cap: 50 conversations
 *   simultaneously buffered). On hit-limit the least-recently-recorded
 *   conversation is evicted.
 * - Seq is a monotonic per-conversation counter. Resets when the buffer
 *   for a conversation is evicted and re-created — the client always
 *   compares its `sinceSeq` against `nextSeq - bufferSize` and re-fetches
 *   from DB when the gap exceeds the buffer.
 */

export type RecordedEvent = {
  seq: number;
  name: string;
  data: unknown;
  ts: number;
};

const DEFAULT_PER_CONV_CAP = 1000;
const DEFAULT_MAX_CONVERSATIONS = 50;

class StreamReplayBufferImpl {
  private readonly perConvCap: number;
  private readonly maxConversations: number;
  private buffers = new Map<string, RecordedEvent[]>();
  private seqCounters = new Map<string, number>();
  private accessOrder: string[] = [];

  constructor(perConvCap = DEFAULT_PER_CONV_CAP, maxConversations = DEFAULT_MAX_CONVERSATIONS) {
    this.perConvCap = perConvCap;
    this.maxConversations = maxConversations;
  }

  /**
   * Append an event to the conversation's ring buffer and return the assigned
   * monotonic seq number. The caller is expected to stamp the same seq onto
   * the broadcast payload (typically as `_seq`) so the client can track its
   * high-water mark.
   *
   * Pass-through return when `conversationId` is empty/undefined — global
   * non-conversation events (auth-expired, ping, etc.) aren't replay-worthy.
   */
  record(conversationId: string | undefined, name: string, data: unknown): number | null {
    if (!conversationId) return null;
    this.touch(conversationId);
    const buf = this.buffers.get(conversationId) ?? [];
    const seq = (this.seqCounters.get(conversationId) ?? 0) + 1;
    buf.push({ seq, name, data, ts: Date.now() });
    if (buf.length > this.perConvCap) {
      buf.splice(0, buf.length - this.perConvCap);
    }
    this.buffers.set(conversationId, buf);
    this.seqCounters.set(conversationId, seq);
    return seq;
  }

  /**
   * Return events whose seq is strictly greater than `sinceSeq`. When the
   * gap exceeds the available buffer (oldest retained seq > sinceSeq + 1),
   * returns `{ gap: true }` instead — client should re-fetch from DB.
   */
  getSince(conversationId: string, sinceSeq: number): { gap: false; events: RecordedEvent[] } | { gap: true; oldestSeq: number; newestSeq: number } {
    const buf = this.buffers.get(conversationId);
    if (!buf || buf.length === 0) {
      return { gap: false, events: [] };
    }
    this.touch(conversationId);
    const oldest = buf[0].seq;
    const newest = buf[buf.length - 1].seq;
    // sinceSeq=0 is a valid "give me everything you have" sentinel.
    if (sinceSeq > 0 && sinceSeq < oldest - 1) {
      return { gap: true, oldestSeq: oldest, newestSeq: newest };
    }
    const missed = buf.filter((e) => e.seq > sinceSeq);
    return { gap: false, events: missed };
  }

  /** Drop a conversation's buffer. Called when the conversation is deleted. */
  drop(conversationId: string): void {
    this.buffers.delete(conversationId);
    this.seqCounters.delete(conversationId);
    const idx = this.accessOrder.indexOf(conversationId);
    if (idx >= 0) this.accessOrder.splice(idx, 1);
  }

  /** Test/inspection helper. */
  size(conversationId: string): number {
    return this.buffers.get(conversationId)?.length ?? 0;
  }

  /** Test/inspection helper. */
  activeConversations(): number {
    return this.buffers.size;
  }

  /** Reset (tests). */
  __resetForTests(): void {
    this.buffers.clear();
    this.seqCounters.clear();
    this.accessOrder = [];
  }

  private touch(conversationId: string): void {
    const idx = this.accessOrder.indexOf(conversationId);
    if (idx >= 0) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(conversationId);
    while (this.accessOrder.length > this.maxConversations) {
      const evict = this.accessOrder.shift();
      if (evict) {
        this.buffers.delete(evict);
        this.seqCounters.delete(evict);
      }
    }
  }
}

export const StreamReplayBuffer = new StreamReplayBufferImpl();

/** Exposed for tests that need their own buffer instance. */
export function __createStreamReplayBufferForTests(perConvCap?: number, maxConversations?: number): StreamReplayBufferImpl {
  return new StreamReplayBufferImpl(perConvCap, maxConversations);
}
