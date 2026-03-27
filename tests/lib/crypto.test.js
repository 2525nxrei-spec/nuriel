/**
 * functions/lib/crypto.js のテスト
 */
import { describe, it, expect } from 'vitest';
import { generateId, generateSessionToken, hashPassword, verifyPassword } from '../../functions/lib/crypto.js';

describe('generateId', () => {
  it('UUIDv4形式の文字列を返す', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('呼び出すたびに異なるIDを返す', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });
});

describe('generateSessionToken', () => {
  it('64文字の16進文字列を返す', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('呼び出すたびに異なるトークンを返す', () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    expect(t1).not.toBe(t2);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('パスワードをハッシュ化してsalt:hash形式で返す', async () => {
    const hash = await hashPassword('TestPassword123');
    expect(hash).toContain(':');

    const [salt, hashPart] = hash.split(':');
    expect(salt).toHaveLength(32); // 16バイト = 32文字hex
    expect(hashPart).toHaveLength(64); // 32バイト = 64文字hex
  });

  it('同じパスワードでも異なるハッシュを生成する（ソルトが異なるため）', async () => {
    const hash1 = await hashPassword('TestPassword123');
    const hash2 = await hashPassword('TestPassword123');
    expect(hash1).not.toBe(hash2);
  });

  it('正しいパスワードで検証が成功する', async () => {
    const hash = await hashPassword('MySecretPass99');
    const result = await verifyPassword('MySecretPass99', hash);
    expect(result).toBe(true);
  });

  it('間違ったパスワードで検証が失敗する', async () => {
    const hash = await hashPassword('CorrectPassword1');
    const result = await verifyPassword('WrongPassword2', hash);
    expect(result).toBe(false);
  });
});
