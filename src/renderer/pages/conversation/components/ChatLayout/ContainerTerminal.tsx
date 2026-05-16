/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useCallback } from 'react';
import * as XTerm from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';

/**
 * WebSocket terminal component connected to docker exec bash in the session
 * container. Uses binary protocol for resize (0x01 + rows/cols) and raw
 * data for stdin/stdout.
 */
export default function ContainerTerminal({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm.Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const sendResize = useCallback((t: XTerm.Terminal) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) {
      const buf = new Uint8Array(5);
      buf[0] = 0x01;
      buf[1] = t.rows & 0xff;
      buf[2] = (t.rows >> 8) & 0xff;
      buf[3] = t.cols & 0xff;
      buf[4] = (t.cols >> 8) & 0xff;
      ws.send(buf);
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "Menlo", "Courier New", monospace',
      allowProposedApi: true,
      convertEol: true,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b7066',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host;

    const ws = new WebSocket(
      `${protocol}//${host}/api/sessions/${conversationId}/shell`,
    );
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      sendResize(term);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else {
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[connection closed]\x1b[0m\r\n');
      setTimeout(onClose, 1500);
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[shell error] Failed to connect to container.\x1b[0m\r\n');
    };

    const encoder = new TextEncoder();
    term.onData((data: string) => {
      if (ws.readyState === 1) {
        ws.send(encoder.encode(data));
      }
    });

    term.onResize(() => {
      sendResize(term);
    });

    const onVisibilityChange = () => {
      if (!document.hidden && term && ws.readyState === 1) {
        fitAddon.fit();
        sendResize(term);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [conversationId, onClose, sendResize]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '400px',
        background: '#1e1e2e',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    />
  );
}
