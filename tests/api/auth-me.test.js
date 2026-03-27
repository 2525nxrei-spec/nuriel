/**
 * GET /api/auth/me のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../functions/api/auth/me.js';
import {
  createMockDB,
  createMockRequest,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function createContext(request, env) {
  return { request, env };
}

describe('GET /api/auth/me', () => {
  it('認証なしで401を返す', async () => {
    const request = createMockRequest('https://example.com/api/auth/me');
    const env = { NURIEL_DB: createMockDB() };

    const res = await onRequestGet(createContext(request, env));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('認証');
  });

  it('有効なトークンでユーザー情報を返す', async () => {
    const user = createTestUser({ plan: 'free' });
    const session = createTestSession(user.id);

    const db = createMockDB({
      users: [user],
      sessions: [session],
    });

    const request = createMockRequest('https://example.com/api/auth/me', {
      token: session.id,
    });

    const res = await onRequestGet(createContext(request, { NURIEL_DB: db }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe(user.email);
    expect(body.user.plan).toBe('free');
    expect(body.user.monthlyLimit).toBeDefined();
    expect(body.user.stylesAllowed).toBeDefined();
  });
});
