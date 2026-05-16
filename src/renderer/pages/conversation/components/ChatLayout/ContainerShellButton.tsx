/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useState } from 'react';
import { Modal, Button } from '@arco-design/web-react';
import ContainerTerminal from './ContainerTerminal';

/**
 * Button that opens a terminal modal connected to the session container
 * via WebSocket (docker exec -it bash).
 */
export function ContainerShellButton({ conversationId }: { conversationId?: string }) {
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => {
    if (conversationId) setOpen(true);
  }, [conversationId]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  if (!conversationId) return null;

  return (
    <>
      <Button
        size='mini'
        type='secondary'
        shape='round'
        onClick={handleOpen}
        style={{ fontSize: '12px' }}
      >
        ⬢ Shell
      </Button>

      <Modal
        title='Container Shell'
        visible={open}
        onCancel={handleClose}
        footer={null}
        style={{ top: 20, maxWidth: '800px' }}
        closable
      >
        <ContainerTerminal conversationId={conversationId} onClose={handleClose} />
      </Modal>
    </>
  );
}
