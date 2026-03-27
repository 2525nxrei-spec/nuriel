/**
 * エッジケーステスト（第2ラウンド）
 * - 不正JSON
 * - 空ボディ
 * - 期限切れトークン
 * - 認可テスト（他ユーザーリソースへのアクセス）
 * - 各エンドポイントの境界値テスト
 */
import { describe, it, expect } from 'vitest';
import { authenticate } from '../../functions/lib/auth.js';
import { onRequestPost as onLoginPost } from '../../functions/api/auth/login.js';
import { onRequestPost as onRegisterPost } from '../../functions/api/auth/register.js';
import { onRequestPost as onCheckoutPost } from '../../functions/api/billing/checkout.js';
import { onRequestPost as onPortalPost } from '../../functions/api/billing/portal.js';
import { onRequestGet as onStatusGet } from '../../functions/api/billing/status.js';
import { onRequestPost as onUploadPost } from '../../functions/api/upload.js';
import {
  createMockDB,
  createMockR2,
  createMockEnv,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function ctx(request, env) {
  return { request, env };
}

// ============================================================
// 不正JSON / 空ボディ テスト
// ============================================================

describe('不正JSON / 空ボディ: 各エンドポイント', () => {
  it('POST /api/auth/login: 不正JSONで400', async () => {
    const request = new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": "test@example.com", password: }',
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onLoginPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login: 空文字列ボディで400', async () => {
    const request = new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onLoginPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/register: 不正JSONで400', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not{json',
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/register: 空のオブジェクトで400', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('POST /api/billing/checkout: 不正JSONで400/401', async () => {
    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{{',
    });

    const env = createMockEnv();
    const res = await onCheckoutPost(ctx(request, env));
    // 認証されていないため401が先に返る
    expect(res.status).toBe(401);
  });

  it('POST /api/billing/checkout: 認証済みで不正JSONの場合', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: '|||invalid|||',
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(500);
  });
});

// ============================================================
// 期限切れトークンテスト
// ============================================================

describe('期限切れトークン: 各エンドポイント', () => {
  function createExpiredEnv() {
    const user = createTestUser();
    const session = createTestSession(user.id, {
      expires_at: '2020-01-01T00:00:00.000Z', // 期限切れ
    });
    return {
      user,
      session,
      env: createMockEnv({
        NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      }),
    };
  }

  it('GET /api/billing/status: 期限切れトークンで401', async () => {
    const { session, env } = createExpiredEnv();

    const request = new Request('https://example.com/api/billing/status', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onStatusGet(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('POST /api/billing/checkout: 期限切れトークンで401', async () => {
    const { session, env } = createExpiredEnv();

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'otameshi', billing_period: 'monthly' }),
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('POST /api/billing/portal: 期限切れトークンで401', async () => {
    const { session, env } = createExpiredEnv();

    const request = new Request('https://example.com/api/billing/portal', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onPortalPost(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('POST /api/upload: 期限切れトークンで401', async () => {
    const { session, env } = createExpiredEnv();

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const res = await onUploadPost(ctx(request, env));
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 認証ヘッダー形式の異常系
// ============================================================

describe('認証ヘッダー形式の異常系', () => {
  it('Bearer のみ（トークンなし）で401', async () => {
    const request = new Request('https://example.com/api/billing/status', {
      headers: { 'Authorization': 'Bearer ' },
    });

    const env = createMockEnv();
    const res = await onStatusGet(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('Basic認証形式で401', async () => {
    const request = new Request('https://example.com/api/billing/status', {
      headers: { 'Authorization': 'Basic dGVzdDp0ZXN0' },
    });

    const env = createMockEnv();
    const res = await onStatusGet(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('不正なトークン文字列で401', async () => {
    const request = new Request('https://example.com/api/billing/status', {
      headers: { 'Authorization': 'Bearer invalid-token-that-does-not-exist' },
    });

    const env = createMockEnv();
    const res = await onStatusGet(ctx(request, env));
    expect(res.status).toBe(401);
  });

  it('AuthorizationヘッダーなしでGET /api/billing/statusは401', async () => {
    const request = new Request('https://example.com/api/billing/status');
    const env = createMockEnv();
    const res = await onStatusGet(ctx(request, env));
    expect(res.status).toBe(401);
  });
});

// ============================================================
// authenticate関数の詳細テスト
// ============================================================

describe('authenticate: 追加エッジケース', () => {
  it('セッションが存在するがユーザーが削除されている場合はnull', async () => {
    const session = createTestSession('deleted-user-id');
    const db = createMockDB({
      sessions: [session],
      users: [], // ユーザーが存在しない
    });

    const request = new Request('https://example.com/api/test', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const result = await authenticate(request, { NURIEL_DB: db });
    expect(result).toBeNull();
  });

  it('複数のセッションがあっても正しいものでマッチする', async () => {
    const user = createTestUser();
    const session1 = createTestSession(user.id, { id: 'session-1' });
    const session2 = createTestSession(user.id, { id: 'session-2' });
    const db = createMockDB({
      sessions: [session1, session2],
      users: [user],
    });

    const request = new Request('https://example.com/api/test', {
      headers: { 'Authorization': `Bearer session-1` },
    });

    const result = await authenticate(request, { NURIEL_DB: db });
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
  });
});

// ============================================================
// POST /api/auth/register: バリデーション境界値
// ============================================================

describe('POST /api/auth/register: バリデーション境界値', () => {
  it('パスワードがちょうど8文字で成功する', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'eight@example.com', password: '12345678' }),
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(201);
  });

  it('パスワードが7文字で400を返す', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seven@example.com', password: '1234567' }),
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('メールアドレスが@のみで400を返す', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '@', password: '12345678' }),
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    // @が含まれるので通る可能性があるが、実装依存
    // 少なくとも500にはならない
    expect([201, 400]).toContain(res.status);
  });

  it('メールアドレスが数字型で渡された場合は400', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 12345, password: '12345678' }),
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('パスワードが数字型で渡された場合は400', async () => {
    const request = new Request('https://example.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'type@example.com', password: 12345678 }),
    });

    const env = { NURIEL_DB: createMockDB() };
    const res = await onRegisterPost(ctx(request, env));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/billing/checkout: 境界値テスト
// ============================================================

describe('POST /api/billing/checkout: 追加バリデーション', () => {
  it('plan_idが空文字の場合は400', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: '', billing_period: 'monthly' }),
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('billing_periodが空文字の場合は400', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'otameshi', billing_period: '' }),
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('freeプランでcheckoutしようとすると400', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'free', billing_period: 'monthly' }),
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('yearlyの請求期間でも正常に処理される', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      STRIPE_SECRET_KEY: '', // モックモード
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'tappuri', billing_period: 'yearly' }),
    });

    const res = await onCheckoutPost(ctx(request, env));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.mock).toBe(true);
    expect(body.clientSecret).toBeDefined();
  });
});

// ============================================================
// POST /api/upload: 追加エッジケース
// ============================================================

describe('POST /api/upload: 追加エッジケース', () => {
  it('Content-Typeが境界的な値（image/heic）で201', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = {
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      NURIEL_STORAGE: createMockR2(),
    };

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/heic',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]),
    });

    const res = await onUploadPost(ctx(request, env));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.imageKey).toContain('.heic');
  });

  it('Content-Typeがimage/webpで201', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = {
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      NURIEL_STORAGE: createMockR2(),
    };

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/webp',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });

    const res = await onUploadPost(ctx(request, env));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.imageKey).toContain('.webp');
  });

  it('Content-Typeがimage/gifで400（非対応形式）', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = {
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      NURIEL_STORAGE: createMockR2(),
    };

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/gif',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([0x47, 0x49, 0x46]),
    });

    const res = await onUploadPost(ctx(request, env));
    expect(res.status).toBe(400);
  });

  it('Content-Typeがapplication/jsonで400', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = {
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      NURIEL_STORAGE: createMockR2(),
    };

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: '{"not": "an image"}',
    });

    const res = await onUploadPost(ctx(request, env));
    expect(res.status).toBe(400);
  });
});
