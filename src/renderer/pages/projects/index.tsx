import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Empty, Message, Modal, Spin, Table, Upload } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { Delete, Download, FolderUpload } from '@icon-park/react';
import { withCsrfToken } from '@process/webserver/middleware/csrfClient';

/** Server-side DTO returned by /api/projects. */
type ProjectDto = {
  id: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIdx]}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

const ProjectListPage: React.FC = () => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/projects', { credentials: 'include' });
      if (!response.ok) {
        Message.error(t('projects.upload.errors.serverError'));
        return;
      }
      const data = (await response.json()) as { success: boolean; projects?: ProjectDto[] };
      setProjects(data.projects ?? []);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
      Message.error(t('projects.upload.errors.networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const uploadProject = useCallback(
    async (file: File) => {
      // Cheap client-side guard before round-trip; server still validates.
      if (!/\.zip$/i.test(file.name)) {
        Message.error(t('projects.upload.errors.notZip'));
        return false;
      }
      setUploading(true);
      Message.info(t('projects.upload.uploading', { name: file.name }));
      try {
        const form = new FormData();
        form.append('file', file);
        // tiny-csrf excludes /api/projects from its protected list because
        // multipart can't easily carry a CSRF body field, but we still pass
        // the token where possible so a future re-include doesn't break.
        const csrf = withCsrfToken({}) as Record<string, string>;
        if (csrf._csrf) form.append('_csrf', csrf._csrf);
        const response = await fetch('/api/projects', {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        const data = (await response.json()) as { success: boolean; message?: string; code?: string };
        if (!response.ok || !data.success) {
          const key = (() => {
            if (response.status === 413) return 'projects.upload.errors.oversize';
            if (response.status === 429) return 'projects.upload.errors.tooManyAttempts';
            if (response.status >= 500) return 'projects.upload.errors.serverError';
            if (data.code === 'invalidMagic') return 'projects.upload.errors.notZip';
            return 'projects.upload.errors.unknown';
          })();
          Message.error(t(key));
          return false;
        }
        Message.success(t('projects.upload.success', { name: file.name }));
        await fetchProjects();
        return true;
      } catch (error) {
        console.error('Upload failed:', error);
        Message.error(t('projects.upload.errors.networkError'));
        return false;
      } finally {
        setUploading(false);
      }
    },
    [fetchProjects, t]
  );

  const deleteProject = useCallback(
    (project: ProjectDto) => {
      Modal.confirm({
        title: t('projects.delete.confirmTitle'),
        content: t('projects.delete.confirmBody'),
        onOk: async () => {
          try {
            const response = await fetch(`/api/projects/${project.id}`, {
              method: 'DELETE',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(withCsrfToken({})),
            });
            if (!response.ok) {
              Message.error(t('projects.delete.error'));
              return;
            }
            Message.success(t('projects.delete.success'));
            await fetchProjects();
          } catch (error) {
            console.error('Delete failed:', error);
            Message.error(t('projects.delete.error'));
          }
        },
      });
    },
    [fetchProjects, t]
  );

  const columns: ColumnProps<ProjectDto>[] = [
    {
      title: t('projects.table.name'),
      dataIndex: 'name',
      render: (value: string) => <span style={{ fontWeight: 500 }}>{value}</span>,
    },
    {
      title: t('projects.table.size'),
      dataIndex: 'sizeBytes',
      width: 120,
      render: (value: number) => formatBytes(value),
    },
    {
      title: t('projects.table.created'),
      dataIndex: 'createdAt',
      width: 200,
      render: (value: number) => formatDate(value),
    },
    {
      title: t('projects.table.actions'),
      key: 'actions',
      width: 200,
      render: (_value, project) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size='small'
            icon={<Download theme='outline' size='14' />}
            href={`/api/projects/${project.id}/export`}
            target='_blank'
          >
            {t('projects.table.export')}
          </Button>
          <Button
            size='small'
            status='danger'
            icon={<Delete theme='outline' size='14' />}
            onClick={() => deleteProject(project)}
          >
            {t('projects.table.delete')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Card
        title={
          <div>
            <h2 style={{ margin: 0 }}>{t('projects.pageTitle')}</h2>
            <p style={{ margin: '4px 0 0', color: '#666', fontSize: 13 }}>{t('projects.subtitle')}</p>
          </div>
        }
      >
        <Upload
          drag
          accept='.zip,application/zip'
          autoUpload={false}
          showUploadList={false}
          multiple={false}
          disabled={uploading}
          onChange={(_fileList, file) => {
            if (file?.originFile) {
              void uploadProject(file.originFile);
            }
          }}
          tip={t('projects.upload.dragHint')}
        >
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#666' }}>
            <FolderUpload theme='outline' size='28' />
            <div style={{ marginTop: 8 }}>{t('projects.upload.dragHint')}</div>
          </div>
        </Upload>

        <div style={{ marginTop: 24 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <Spin />
            </div>
          ) : projects && projects.length === 0 ? (
            <Empty description={t('projects.empty')} />
          ) : (
            <Table
              rowKey='id'
              columns={columns}
              data={projects ?? []}
              pagination={{ pageSize: 20, showTotal: true }}
              noDataElement={<Empty description={t('projects.empty')} />}
            />
          )}
        </div>
      </Card>
    </div>
  );
};

export default ProjectListPage;
