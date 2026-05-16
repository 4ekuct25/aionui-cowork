/**
 * Regression test for the 2026-05-17 audit finding: a low-privilege WS
 * user (`qa_check_2026`) was able to delete an admin-owned conversation
 * by triggering the sidebar's right-click → Delete action, because
 * `ipcBridge.conversation.remove.provider` ran straight into
 * `DockerSessionManager.release()` + `conversationService.deleteConversation()`
 * without any owner check. These tests pin down the new ACL guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

type ProviderHandler = (...args: unknown[]) => unknown;
const handlers: Record<string, ProviderHandler> = {};
function makeChannel(name: string) {
  return {
    provider: vi.fn((fn: ProviderHandler) => {
      handlers[name] = fn;
    }),
    emit: vi.fn(),
    invoke: vi.fn(),
  };
}

vi.mock('../../../src/common', () => ({
  ipcBridge: {
    conversation: {
      create: makeChannel('create'),
      createWithConversation: makeChannel('createWithConversation'),
      get: makeChannel('get'),
      getAssociateConversation: makeChannel('getAssociateConversation'),
      remove: makeChannel('remove'),
      update: makeChannel('update'),
      reset: makeChannel('reset'),
      stop: makeChannel('stop'),
      setConfig: makeChannel('setConfig'),
      sendMessage: makeChannel('sendMessage'),
      getSlashCommands: makeChannel('getSlashCommands'),
      askSideQuestion: makeChannel('askSideQuestion'),
      reloadContext: makeChannel('reloadContext'),
      getWorkspace: makeChannel('getWorkspace'),
      responseSearchWorkSpace: makeChannel('responseSearchWorkSpace'),
      warmup: makeChannel('warmup'),
      confirmation: {
        confirm: makeChannel('confirmation.confirm'),
        list: makeChannel('confirmation.list'),
      },
      approval: {
        check: makeChannel('approval.check'),
      },
      listChanged: { emit: vi.fn() },
      listByCronJob: makeChannel('listByCronJob'),
    },
    openclawConversation: {
      getRuntime: makeChannel('openclawConversation.getRuntime'),
    },
  },
}));

vi.mock('../../../src/process/utils/initStorage', () => ({
  ProcessChat: { get: vi.fn(async () => []) },
  getSkillsDir: vi.fn(() => '/skills'),
  getBuiltinSkillsCopyDir: vi.fn(() => '/skills-builtin'),
  getSystemDir: vi.fn(() => ({ cacheDir: '/tmp/cache' })),
  ProcessConfig: { get: vi.fn(async () => []) },
}));

vi.mock('../../../src/process/bridge/migrationUtils', () => ({
  migrateConversationToDatabase: vi.fn(async () => {}),
}));

vi.mock('../../../src/process/utils', () => ({
  copyFilesToDirectory: vi.fn(async () => []),
  readDirectoryRecursive: vi.fn(async () => null),
}));

vi.mock('../../../src/process/utils/openclawUtils', () => ({
  computeOpenClawIdentityHash: vi.fn(async () => 'hash'),
}));

vi.mock('../../../src/process/task/agentUtils', () => ({
  prepareFirstMessage: vi.fn(async (msg: string) => msg),
}));

vi.mock('../../../src/process/utils/tray', () => ({
  refreshTrayMenu: vi.fn(async () => {}),
}));

vi.mock('../../../src/process/utils/message', () => ({
  removeFromMessageCache: vi.fn(),
}));

// Stub the database lookup so `ownConversation` can resolve the row.
// Tests set `conversationOwner` per-case to control the user_id returned.
let conversationOwner: string | undefined = 'admin';
vi.mock('@process/services/database/export', () => ({
  getDatabase: vi.fn(async () => ({
    getDriver: () => ({
      prepare: (_sql: string) => ({
        get: (_id: string) =>
          conversationOwner === undefined ? undefined : { user_id: conversationOwner, project_id: null },
      }),
    }),
  })),
}));

// DockerSessionManager.release is invoked inside the `remove` provider.
// We stub the dynamic import so we can assert it's *not* called when the
// caller fails the ownership check.
const dockerRelease = vi.fn(async () => {});
vi.mock('@process/services/DockerSessionManager', () => ({
  DockerSessionManager: {
    release: dockerRelease,
  },
}));

import { runWithCaller } from '../../../src/process/webserver/callerContext';
import { initConversationBridge } from '../../../src/process/bridge/conversationBridge';
import type { IConversationService } from '../../../src/process/services/IConversationService';
import type { IWorkerTaskManager } from '../../../src/process/task/IWorkerTaskManager';
import type { TChatConversation } from '../../../src/common/config/storage';

function makeService(): IConversationService {
  return {
    createConversation: vi.fn(),
    deleteConversation: vi.fn(async () => {}),
    updateConversation: vi.fn(async () => {}),
    getConversation: vi.fn(
      async (id: string) => ({ id, type: 'gemini', name: 't', source: 'aionui' }) as unknown as TChatConversation
    ),
    createWithMigration: vi.fn(),
    listAllConversations: vi.fn(async () => []),
  };
}

function makeTaskManager(): IWorkerTaskManager {
  return {
    getTask: vi.fn(() => undefined),
    getOrBuildTask: vi.fn(async () => undefined as never),
    addTask: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    listTasks: vi.fn(() => []),
  };
}

describe('conversationBridge — ownership enforcement', () => {
  let service: IConversationService;
  let taskManager: IWorkerTaskManager;

  beforeEach(() => {
    vi.clearAllMocks();
    dockerRelease.mockClear();
    conversationOwner = 'admin';
    service = makeService();
    taskManager = makeTaskManager();
    initConversationBridge(service, taskManager);
  });

  describe('remove', () => {
    it('refuses to delete when caller does not own the conversation', async () => {
      const handler = handlers['remove'];

      // Simulate the WS request shape: `qa_check_2026` (role=user) targeting
      // admin's conversation. The pre-fix bug let this through.
      const result = await runWithCaller({ userId: 'qa_check_2026' }, () => handler({ id: '233a3802' }));

      expect(result).toBe(false);
      expect(taskManager.kill).not.toHaveBeenCalled();
      expect(dockerRelease).not.toHaveBeenCalled();
      expect(service.deleteConversation).not.toHaveBeenCalled();
    });

    it('proceeds with deletion when the caller owns the conversation', async () => {
      conversationOwner = 'admin';
      const handler = handlers['remove'];

      const result = await runWithCaller({ userId: 'admin' }, () => handler({ id: '233a3802' }));

      expect(result).toBe(true);
      expect(taskManager.kill).toHaveBeenCalledWith('233a3802');
      expect(service.deleteConversation).toHaveBeenCalledWith('233a3802');
    });

    it('proceeds with deletion when there is no WS caller (Electron IPC path)', async () => {
      // No runWithCaller wrapper — Electron single-user mode. ACL should
      // be skipped so existing single-user installs keep working.
      const handler = handlers['remove'];
      const result = await handler({ id: '233a3802' });

      expect(result).toBe(true);
      expect(service.deleteConversation).toHaveBeenCalledWith('233a3802');
    });
  });

  describe('update', () => {
    it('refuses to update another tenants conversation', async () => {
      const handler = handlers['update'];

      const result = await runWithCaller({ userId: 'qa_check_2026' }, () =>
        handler({ id: '233a3802', updates: { name: 'pwned' } as Partial<TChatConversation> })
      );

      expect(result).toBe(false);
      expect(service.updateConversation).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('refuses to inject messages into another tenants conversation', async () => {
      const handler = handlers['sendMessage'];

      const result = (await runWithCaller({ userId: 'qa_check_2026' }, () =>
        handler({ conversation_id: '233a3802', input: 'leak my secrets' })
      )) as { success: boolean };

      expect(result.success).toBe(false);
      // The handler must short-circuit before reaching the task manager.
      expect(taskManager.getOrBuildTask).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns undefined for non-owners (no existence leak)', async () => {
      const handler = handlers['get'];

      const result = await runWithCaller({ userId: 'qa_check_2026' }, () => handler({ id: '233a3802' }));

      expect(result).toBeUndefined();
      expect(service.getConversation).not.toHaveBeenCalled();
    });
  });
});
