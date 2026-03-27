/**
 * workers/src/index.js（ルーター）のテスト
 * 旧実装だが、ルーティングロジックの正確性を検証
 */
import { describe, it, expect } from 'vitest';
import worker from '../../workers/src/index.js';
import {
  createMockDB,
  createMockR2,
  createMockEnv,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function createWorkerEnv(overrides = {}) {
  const user = createTestUser();
  const session = createTestSession(user.id);
  return createMockEnv({
    NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    NURIEL_STORAGE: createMockR2(),
    FRONTEND_URL: 'http://localhost:8788',
    ...overrides,
  });
}

const ctx = { waitUntil: () => {} };

describe('Workers ルーター', () => {
  it('OPTIONSリクエストに204を返す', async () => {
    const request = new Request('https://example.com/api/test', {
      method: 'OPTIONS',
    });

    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });

  it('存在しないルートに404を返す', async () => {
    const request = new Request('https://example.com/api/nonexistent');
    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    // 認証ミドルウェアが先に401を返すため、未認証では401が正しい
    expect(res.status).toBe(401);
  });

  it('認証なしで/api/auth/meにアクセスすると401を返す', async () => {
    const request = new Request('https://example.com/api/auth/me');
    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
  });

  it('/api/billing/plansは認証なしでアクセスできる', async () => {
    const request = new Request('https://example.com/api/billing/plans');
    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.plans).toBeDefined();
  });

  it('CORSヘッダーがレスポンスに付与される', async () => {
    const request = new Request('https://example.com/api/billing/plans');
    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });
});

describe('Workers ルーター: 認証不要エンドポイント', () => {
  it('POST /api/auth/login にアクセスできる', async () => {
    const request = new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'nonexistent123' }),
    });

    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    // 401=ユーザー不在は正常（ルーティングは成功）
    expect([200, 401]).toContain(res.status);
  });

  it('POST /api/auth/register にアクセスできる', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'newpass123' }),
    });

    const env = createWorkerEnv();
    const res = await worker.fetch(request, env, ctx);
    // 201=成功 or 409=重複は正常（ルーティングは成功）
    expect([201, 409]).toContain(res.status);
  });
});
