/**
 * POST /api/auth/logout のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../functions/api/auth/logout.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function createContext(request, env) {
  return { request, env };
}

describe('POST /api/auth/logout', () => {
  it('認証なしで401を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/logout', {
      method: 'POST',
    });
    const env = { NURIEL_DB: createMockDB() };

    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(401);
  });

  it('有効なトークンでログアウト成功する', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);

    const db = createMockDB({
      users: [user],
      sessions: [session],
    });

    const request = createMockRequest('https://example.com/api/auth/logout', {
      method: 'POST',
      token: session.id,
    });

    const res = await onRequestPost(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('ログアウト');
  });
});
