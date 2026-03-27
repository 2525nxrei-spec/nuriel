/**
 * functions/lib/auth.js のテスト
 */
import { describe, it, expect } from 'vitest';
import { authenticate } from '../../functions/lib/auth.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

describe('authenticate', () => {
  it('Authorizationヘッダーがない場合はnullを返す', async () => {
    const request = createMockRequest('https://example.com/api/test');
    const env = { NURIEL_DB: createMockDB() };

    const result = await authenticate(request, env);
    expect(result).toBeNull();
  });

  it('Bearer以外の形式の場合はnullを返す', async () => {
    const request = createMockRequest('https://example.com/api/test', {
      headers: { Authorization: 'Basic abc123' },
    });
    const env = { NURIEL_DB: createMockDB() };

    const result = await authenticate(request, env);
    expect(result).toBeNull();
  });

  it('空トークンの場合はnullを返す', async () => {
    const request = createMockRequest('https://example.com/api/test', {
      headers: { Authorization: 'Bearer ' },
    });
    const env = { NURIEL_DB: createMockDB() };

    const result = await authenticate(request, env);
    expect(result).toBeNull();
  });

  it('存在しないセッショントークンの場合はnullを返す', async () => {
    const request = createMockRequest('https://example.com/api/test', {
      token: 'invalid-token',
    });
    const env = { NURIEL_DB: createMockDB() };

    const result = await authenticate(request, env);
    expect(result).toBeNull();
  });

  it('有効なトークンでユーザーオブジェクトを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);

    const db = createMockDB({
      sessions: [session],
      users: [user],
    });

    const request = createMockRequest('https://example.com/api/test', {
      token: session.id,
    });

    const result = await authenticate(request, { NURIEL_DB: db });
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
    expect(result.email).toBe(user.email);
    expect(result.sessionId).toBe(session.id);
  });

  it('期限切れセッションの場合はnullを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id, {
      expires_at: '2020-01-01T00:00:00.000Z', // 過去日付
    });

    const db = createMockDB({
      sessions: [session],
      users: [user],
    });

    const request = createMockRequest('https://example.com/api/test', {
      token: session.id,
    });

    const result = await authenticate(request, { NURIEL_DB: db });
    expect(result).toBeNull();
  });
});
