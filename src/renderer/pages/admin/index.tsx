import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Empty, Input, Message, Modal, Spin, Table, Tabs } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { Delete, Refresh } from '@icon-park/react';
import { withCsrfToken } from '@process/webserver/middleware/csrfClient';
import { useAuth } from '../../hooks/context/AuthContext';

type AdminUser = {
  id: string;
  username: string;
  email?: string;
  role: 'admin' | 'user';
  createdAt: number;
  updatedAt: number;
  lastLogin?: number | null;
  oidcLinked: boolean;
};

type AuditEvent = {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: number;
};

type SessionRow = {
  conversationId: string;
  userId: string;
  projectId: string;
  status: string;
  startedAt: number;
  lastSeenAt: number;
};

function formatDate(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

const AdminPage: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();

  if (user?.role !== 'admin') {
    return (
      <div style={{ padding: 32 }}>
        <Empty description={t('admin.forbidden')} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <Card>
        <h2 style={{ margin: '0 0 16px 0' }}>{t('admin.pageTitle')}</h2>
        <Tabs defaultActiveTab='users' destroyOnHide>
          <Tabs.TabPane key='users' title={t('admin.tabs.users')}>
            <UsersTab />
          </Tabs.TabPane>
          <Tabs.TabPane key='audit' title={t('admin.tabs.auditLog')}>
            <AuditTab />
          </Tabs.TabPane>
          <Tabs.TabPane key='sessions' title={t('admin.tabs.sessions')}>
            <SessionsTab />
          </Tabs.TabPane>
        </Tabs>
      </Card>
    </div>
  );
};

const UsersTab: React.FC = () => {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/users', { credentials: 'include' });
      if (!response.ok) {
        Message.error(t('admin.errors.loadFailed'));
        return;
      }
      const data = (await response.json()) as { users: AdminUser[] };
      setUsers(data.users ?? []);
    } catch (error) {
      console.error('Admin users fetch failed:', error);
      Message.error(t('admin.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const columns: ColumnProps<AdminUser>[] = [
    { title: t('admin.users.username'), dataIndex: 'username' },
    { title: t('admin.users.email'), dataIndex: 'email', render: (v: string) => v ?? '—' },
    { title: t('admin.users.role'), dataIndex: 'role', width: 100 },
    {
      title: t('admin.users.oidc'),
      dataIndex: 'oidcLinked',
      width: 100,
      render: (v: boolean) => (v ? t('admin.users.yes') : t('admin.users.no')),
    },
    {
      title: t('admin.users.lastLogin'),
      dataIndex: 'lastLogin',
      width: 180,
      render: (v: number | null) => (v ? formatDate(v) : t('admin.users.never')),
    },
    {
      title: t('admin.users.createdAt'),
      dataIndex: 'createdAt',
      width: 180,
      render: (v: number) => formatDate(v),
    },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }
  return <Table rowKey='id' columns={columns} data={users ?? []} pagination={{ pageSize: 50, showTotal: true }} />;
};

const AuditTab: React.FC = () => {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (userFilter.trim()) params.set('userId', userFilter.trim());
      if (actionFilter.trim()) params.set('action', actionFilter.trim());
      const response = await fetch(`/api/admin/audit-log?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        Message.error(t('admin.errors.loadFailed'));
        return;
      }
      const data = (await response.json()) as { events: AuditEvent[] };
      setEvents(data.events ?? []);
    } catch (error) {
      console.error('Admin audit fetch failed:', error);
      Message.error(t('admin.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, t, userFilter]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  const columns: ColumnProps<AuditEvent>[] = [
    {
      title: t('admin.audit.createdAt'),
      dataIndex: 'createdAt',
      width: 180,
      render: (v: number) => formatDate(v),
    },
    {
      title: t('admin.audit.userId'),
      dataIndex: 'userId',
      width: 180,
      render: (v: string | null) => v ?? t('admin.audit.anonymous'),
    },
    { title: t('admin.audit.action'), dataIndex: 'action', width: 180 },
    { title: t('admin.audit.target'), dataIndex: 'target', render: (v: string | null) => v ?? '—' },
    {
      title: t('admin.audit.meta'),
      dataIndex: 'meta',
      render: (v: unknown) => (v && Object.keys(v as Record<string, unknown>).length > 0 ? JSON.stringify(v) : '—'),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Input
          placeholder={t('admin.audit.filterUserId')}
          value={userFilter}
          onChange={setUserFilter}
          style={{ maxWidth: 280 }}
        />
        <Input
          placeholder={t('admin.audit.filterAction')}
          value={actionFilter}
          onChange={setActionFilter}
          style={{ maxWidth: 220 }}
        />
        <Button icon={<Refresh theme='outline' size='14' />} onClick={fetchEvents}>
          Refresh
        </Button>
      </div>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : (
        <Table rowKey='id' columns={columns} data={events ?? []} pagination={{ pageSize: 100, showTotal: true }} />
      )}
    </div>
  );
};

const SessionsTab: React.FC = () => {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/sessions', { credentials: 'include' });
      if (!response.ok) {
        Message.error(t('admin.errors.loadFailed'));
        return;
      }
      const data = (await response.json()) as { sessions: SessionRow[] };
      setSessions(data.sessions ?? []);
    } catch (error) {
      console.error('Admin sessions fetch failed:', error);
      Message.error(t('admin.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const killSession = useCallback(
    (row: SessionRow) => {
      Modal.confirm({
        title: t('admin.sessions.killConfirmTitle'),
        content: t('admin.sessions.killConfirmBody'),
        onOk: async () => {
          try {
            const response = await fetch(`/api/admin/sessions/${row.conversationId}`, {
              method: 'DELETE',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(withCsrfToken({})),
            });
            if (!response.ok) {
              Message.error(t('admin.sessions.killError'));
              return;
            }
            Message.success(t('admin.sessions.killSuccess'));
            await fetchSessions();
          } catch (error) {
            console.error('Admin kill session failed:', error);
            Message.error(t('admin.sessions.killError'));
          }
        },
      });
    },
    [fetchSessions, t]
  );

  const columns: ColumnProps<SessionRow>[] = [
    { title: t('admin.sessions.conversationId'), dataIndex: 'conversationId' },
    { title: t('admin.sessions.userId'), dataIndex: 'userId', width: 180 },
    { title: t('admin.sessions.projectId'), dataIndex: 'projectId', width: 180 },
    { title: t('admin.sessions.status'), dataIndex: 'status', width: 100 },
    {
      title: t('admin.sessions.startedAt'),
      dataIndex: 'startedAt',
      width: 180,
      render: (v: number) => formatDate(v),
    },
    {
      title: t('admin.sessions.lastSeenAt'),
      dataIndex: 'lastSeenAt',
      width: 180,
      render: (v: number) => formatDate(v),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_v, row) => (
        <Button
          size='small'
          status='danger'
          icon={<Delete theme='outline' size='14' />}
          onClick={() => killSession(row)}
        >
          {t('admin.sessions.killBtn')}
        </Button>
      ),
    },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
        <Spin />
      </div>
    );
  }
  return (
    <Table
      rowKey='conversationId'
      columns={columns}
      data={sessions ?? []}
      pagination={false}
      noDataElement={<Empty description='—' />}
    />
  );
};

export default AdminPage;
