/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Tooltip } from '@arco-design/web-react';
import { FolderClose } from '@icon-park/react';
import { useProjectSelection } from '@renderer/hooks/context/ProjectSelectionContext';

/**
 * Drop-in picker rendered alongside the other action-row buttons in the
 * Guid (new chat) page. Lets the user pick an uploaded project to attach
 * the chat to; "No sandbox" keeps the legacy host-spawn path.
 */
const ProjectPickerButton: React.FC = () => {
  const { t } = useTranslation();
  const { available, selectedProjectId, setSelectedProjectId } = useProjectSelection();

  // While the project list is still loading we show the picker disabled so
  // the row layout doesn't jump once it appears.
  const loading = available === null;
  const options = (available ?? []).map((p) => ({ label: p.name, value: p.id }));

  return (
    <Tooltip content={t('projects.picker.tooltip')}>
      <Select
        size='small'
        placeholder={t('projects.picker.placeholder')}
        prefix={<FolderClose theme='outline' size='14' />}
        value={selectedProjectId ?? undefined}
        onChange={(value) => setSelectedProjectId(value || null)}
        allowClear
        loading={loading}
        disabled={loading}
        style={{ minWidth: 180, maxWidth: 280 }}
        options={[{ label: t('projects.picker.noSandbox'), value: '' }, ...options]}
      />
    </Tooltip>
  );
};

export default ProjectPickerButton;
