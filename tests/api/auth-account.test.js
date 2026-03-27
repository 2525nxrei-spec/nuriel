/**
 * DELETE /api/auth/account のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestDelete } from '../../functions/api/auth/account.js';
import { hashPassword } from '../../functions/lib/crypto.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function createContext(request, env) {
  return { request, env };
}

describe('DELETE /api/auth/account', () => {
  it('認証なしで401を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/account', {
      method: 'DELETE',
      body: { password: 'test123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestDelete(createContext(request, env));
    expect(res.status).toBe(401);
  });

  it('パスワードが空の場合は400を返す', async () => {
    const passwordHash = await hashPassword('MyPass123');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/account', {
      method: 'DELETE',
      body: { password: '' },
      token: session.id,
    });

    const res = await onRequestDelete(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(400);
  });

  it('正しいパスワードでアカウント削除成功', async () => {
    const passwordHash = await hashPassword('DeleteMe1');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/account', {
      method: 'DELETE',
      body: { password: 'DeleteMe1' },
      token: session.id,
    });

    const res = await onRequestDelete(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('削除');
  });

  it('間違ったパスワードで401を返す', async () => {
    const passwordHash = await hashPassword('RealPass1');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/account', {
      method: 'DELETE',
      body: { password: 'WrongPass1' },
      token: session.id,
    });

    const res = await onRequestDelete(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(401);
  });
});
