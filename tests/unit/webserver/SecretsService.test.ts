import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

type SecretRow = {
  user_id: string;
  key_name: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  created_at: number;
  updated_at: number;
};

const { mockUpsert, mockGet, mockList, mockDelete, store } = vi.hoisted(() => {
  const memory = new Map<string, SecretRow>();
  return {
    store: memory,
    mockUpsert: vi.fn((row: SecretRow) => {
      memory.set(`${row.user_id}::${row.key_name}`, row);
      return { success: true, data: true };
    }),
    mockGet: vi.fn((userId: string, keyName: string) => {
      return { success: true, data: memory.get(`${userId}::${keyName}`) ?? null };
    }),
    mockList: vi.fn((userId: string) => {
      // Mirror the real SQL `ORDER BY key_name` so list() ordering assertions
      // hold against the mock as well as the live DB.
      const rows = [...memory.values()]
        .filter((r) => r.user_id === userId)
        .map((r) => ({ key_name: r.key_name, created_at: r.created_at, updated_at: r.updated_at }))
        .toSorted((a, b) => a.key_name.localeCompare(b.key_name));
      return { success: true, data: rows };
    }),
    mockDelete: vi.fn((userId: string, keyName: string) => {
      const k = `${userId}::${keyName}`;
      const had = memory.has(k);
      memory.delete(k);
      return { success: true, data: had };
    }),
  };
});

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    upsertUserSecret: mockUpsert,
    getUserSecret: mockGet,
    listUserSecretNames: mockList,
    deleteUserSecret: mockDelete,
  }),
}));

// 64-hex-char KMS key (= 32 bytes) generated once for the suite.
const KMS_KEY = crypto.randomBytes(32).toString('hex');

describe('SecretsService', () => {
  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
    process.env.KMS_KEY = KMS_KEY;
    const mod = await import('@process/services/SecretsService');
    mod.__resetKmsKeyCacheForTests();
  });

  afterEach(async () => {
    delete process.env.KMS_KEY;
    const mod = await import('@process/services/SecretsService');
    mod.__resetKmsKeyCacheForTests();
  });

  it('round-trips a secret: store → read returns the original plaintext', async () => {
    const { SecretsService } = await import('@process/services/SecretsService');

    await SecretsService.store('u1', 'OPENAI_API_KEY', 'sk-test-12345');
    const back = await SecretsService.read('u1', 'OPENAI_API_KEY');

    expect(back).toBe('sk-test-12345');
    // Stored buffer is not the plaintext.
    const row = store.get('u1::OPENAI_API_KEY')!;
    expect(row.ciphertext.toString('utf8')).not.toBe('sk-test-12345');
    expect(row.iv).toHaveLength(12);
    expect(row.auth_tag).toHaveLength(16);
  });

  it('refuses to start when KMS_KEY is missing', async () => {
    delete process.env.KMS_KEY;
    const { SecretsService, SecretsConfigError, __resetKmsKeyCacheForTests } =
      await import('@process/services/SecretsService');
    __resetKmsKeyCacheForTests();

    await expect(SecretsService.store('u1', 'X', 'val')).rejects.toBeInstanceOf(SecretsConfigError);
  });

  it('refuses to start when KMS_KEY is the wrong length', async () => {
    process.env.KMS_KEY = 'abc123'; // 3 bytes, not 32
    const { SecretsService, SecretsConfigError, __resetKmsKeyCacheForTests } =
      await import('@process/services/SecretsService');
    __resetKmsKeyCacheForTests();

    await expect(SecretsService.store('u1', 'X', 'val')).rejects.toBeInstanceOf(SecretsConfigError);
  });

  it('rejects a row whose auth tag was tampered with', async () => {
    const { SecretsService, SecretDecryptError } = await import('@process/services/SecretsService');

    await SecretsService.store('u1', 'TAMPER', 'plain');
    // Mutate the stored tag — simulating a row swap.
    const row = store.get('u1::TAMPER')!;
    row.auth_tag = Buffer.from(row.auth_tag);
    row.auth_tag[0] ^= 0xff;

    await expect(SecretsService.read('u1', 'TAMPER')).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it('uses (userId, keyName) as AAD — swapping rows between users fails decrypt', async () => {
    const { SecretsService, SecretDecryptError } = await import('@process/services/SecretsService');

    await SecretsService.store('alice', 'TOKEN', 'alice-secret');
    // Copy alice's row under bob's user_id (simulating a tenant-cross attack).
    const aliceRow = store.get('alice::TOKEN')!;
    store.set('bob::TOKEN', { ...aliceRow, user_id: 'bob' });

    await expect(SecretsService.read('bob', 'TOKEN')).rejects.toBeInstanceOf(SecretDecryptError);
  });

  it('returns null when a secret is missing rather than throwing', async () => {
    const { SecretsService } = await import('@process/services/SecretsService');
    expect(await SecretsService.read('ghost', 'NO_SUCH_KEY')).toBeNull();
  });

  it('list() returns names only, in alphabetical order, without exposing ciphertext', async () => {
    const { SecretsService } = await import('@process/services/SecretsService');
    await SecretsService.store('u1', 'B_KEY', 'b');
    await SecretsService.store('u1', 'A_KEY', 'a');

    const result = await SecretsService.list('u1');
    expect(result.map((r) => r.keyName)).toEqual(['A_KEY', 'B_KEY']);
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|iv|auth_tag/);
  });

  it('delete() reports whether a row actually existed', async () => {
    const { SecretsService } = await import('@process/services/SecretsService');
    await SecretsService.store('u1', 'X', 'v');
    expect(await SecretsService.delete('u1', 'X')).toBe(true);
    expect(await SecretsService.delete('u1', 'X')).toBe(false);
  });
});
