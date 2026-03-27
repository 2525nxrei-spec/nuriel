/**
 * POST /api/auth/register のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../functions/api/auth/register.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
} from '../helpers/mock-env.js';

function createContext(request, env) {
  return { request, env };
}

describe('POST /api/auth/register', () => {
  it('NURIEL_DBが未設定の場合は500を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'new@example.com', password: 'password123' },
    });

    const res = await onRequestPost(createContext(request, {}));
    expect(res.status).toBe(500);
  });

  it('メールアドレスが空の場合は400を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: '', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);
  });

  it('無効なメールアドレスの場合は400を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'invalid-email', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('メールアドレス');
  });

  it('パスワードが8文字未満の場合は400を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'new@example.com', password: 'short' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('8文字以上');
  });

  it('既存ユーザーのメールアドレスで409を返す', async () => {
    const existingUser = createTestUser({ email: 'existing@example.com' });

    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'existing@example.com', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB({ users: [existingUser] }) };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('既に登録');
  });

  it('正常な登録で201を返しトークンを生成する', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'newuser@example.com', password: 'StrongPass1', displayName: '新ユーザー' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe('newuser@example.com');
    expect(body.user.displayName).toBe('新ユーザー');
    expect(body.user.plan).toBe('free');
    expect(body.token).toBeTruthy();
  });

  it('displayNameなしでも登録できる', async () => {
    const request = createMockRequest('https://example.com/api/auth/register', {
      method: 'POST',
      body: { email: 'nname@example.com', password: 'password123' },
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.user.displayName).toBeNull();
  });
});
