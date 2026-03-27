/**
 * POST /api/auth/login のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../functions/api/auth/login.js';
import { hashPassword } from '../../functions/lib/crypto.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
} from '../helpers/mock-env.js';

/**
 * Pages Functionsのcontextオブジェクトを生成
 */
function createContext(request, env) {
  return { request, env };
}

describe('POST /api/auth/login', () => {
  it('NURIEL_DBが未設定の場合は500を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: 'test@example.com', password: 'password123' },
    });

    const res = await onRequestPost(createContext(request, {}));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('リクエストボディが不正な場合は400を返す', async () => {
    const request = new Request('https://example.com/api/auth/login', {
      method: 'POST',
      body: 'invalid json',
      headers: { 'Content-Type': 'application/json' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);
  });

  it('メールアドレスが空の場合は400を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: '', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('必須');
  });

  it('パスワードが空の場合は400を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: 'test@example.com', password: '' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);
  });

  it('存在しないユーザーの場合は401を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: 'nonexistent@example.com', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toContain('正しくありません');
  });

  it('正しい認証情報でログイン成功する', async () => {
    const passwordHash = await hashPassword('ValidPass123');
    const user = createTestUser({ password_hash: passwordHash });

    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'ValidPass123' },
    });

    const env = { NURIEL_DB: createMockDB({ users: [user] }) };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(user.email);
    expect(body.token).toBeTruthy();
    expect(body.token.length).toBe(64);
  });

  it('間違ったパスワードで401を返す', async () => {
    const passwordHash = await hashPassword('CorrectPass1');
    const user = createTestUser({ password_hash: passwordHash });

    const request = createMockRequest('https://example.com/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'WrongPass999' },
    });

    const env = { NURIEL_DB: createMockDB({ users: [user] }) };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(401);
  });
});
