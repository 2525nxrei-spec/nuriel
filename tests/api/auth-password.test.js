/**
 * PUT /api/auth/password のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPut } from '../../functions/api/auth/password.js';
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

describe('PUT /api/auth/password', () => {
  it('認証なしで401を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/password', {
      method: 'PUT',
      body: { current_password: 'old', new_password: 'newpass123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPut(createContext(request, env));
    expect(res.status).toBe(401);
  });

  it('現在のパスワードが空の場合は400を返す', async () => {
    const passwordHash = await hashPassword('OldPass123');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);

    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/password', {
      method: 'PUT',
      body: { current_password: '', new_password: 'NewPass123' },
      token: session.id,
    });

    const res = await onRequestPut(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(400);
  });

  it('新しいパスワードが8文字未満の場合は400を返す', async () => {
    const passwordHash = await hashPassword('OldPass123');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);

    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/password', {
      method: 'PUT',
      body: { current_password: 'OldPass123', new_password: 'short' },
      token: session.id,
    });

    const res = await onRequestPut(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('8文字以上');
  });

  it('英字のみのパスワードは400を返す', async () => {
    const passwordHash = await hashPassword('OldPass123');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);

    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/password', {
      method: 'PUT',
      body: { current_password: 'OldPass123', new_password: 'onlyletters' },
      token: session.id,
    });

    const res = await onRequestPut(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('英字と数字');
  });

  it('正しい現在のパスワードでパスワード変更成功', async () => {
    const passwordHash = await hashPassword('OldPass123');
    const user = createTestUser({ password_hash: passwordHash });
    const session = createTestSession(user.id);

    const db = createMockDB({ users: [user], sessions: [session] });

    const request = createMockRequest('https://example.com/api/auth/password', {
      method: 'PUT',
      body: { current_password: 'OldPass123', new_password: 'NewPass456' },
      token: session.id,
    });

    const res = await onRequestPut(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('パスワード');
  });
});
