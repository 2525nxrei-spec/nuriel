/**
 * ヌリエル 認証・課金・プランアクセス制御テスト
 *
 * テスト対象:
 * - 登録バリデーション
 * - ログインバリデーション
 * - プランベースのスタイル制御
 * - imageKey所有者検証
 * - ギャラリー上限チェック
 * - セッション管理
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===================================================================
// テスト用モック
// ===================================================================

// D1モック
function createMockDB(data = {}) {
  const prepared = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(data.first || null),
    all: vi.fn().mockResolvedValue(data.all || { results: [] }),
    run: vi.fn().mockResolvedValue(data.run || { meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn().mockReturnValue(prepared),
    batch: vi.fn().mockResolvedValue([]),
    _prepared: prepared,
  };
}

// R2モック
function createMockStorage() {
  return {
    head: vi.fn().mockResolvedValue({ httpMetadata: { contentType: 'image/png' } }),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

// Requestモック
function createMockRequest(body = {}, headers = {}) {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: {
      get: vi.fn((key) => headers[key] || null),
    },
    url: 'https://photo-nurie.com/api/test',
    method: 'POST',
  };
}

// ===================================================================
// 1. 登録バリデーション
// ===================================================================
describe('登録バリデーション', () => {
  it('メールアドレスなしで登録しようとしたら400エラー', { timeout: 15000 }, async () => {
    const { onRequestPost } = await import('../functions/api/auth/register.js');
    const request = createMockRequest({ password: 'test1234' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('メールアドレス');
  });

  it('パスワード7文字以下で登録しようとしたら400エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/register.js');
    const request = createMockRequest({ email: 'test@test.com', password: '1234abc' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('8文字以上');
  });

  it('英字のみのパスワードで登録しようとしたら400エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/register.js');
    const request = createMockRequest({ email: 'test@test.com', password: 'abcdefgh' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('英字と数字');
  });

  it('数字のみのパスワードで登録しようとしたら400エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/register.js');
    const request = createMockRequest({ email: 'test@test.com', password: '12345678' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('英字と数字');
  });

  it('@なしメールアドレスで登録しようとしたら400エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/register.js');
    const request = createMockRequest({ email: 'testtest.com', password: 'test1234' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('メールアドレス');
  });
});

// ===================================================================
// 2. ログインバリデーション
// ===================================================================
describe('ログインバリデーション', () => {
  it('メールアドレスなしでログインしようとしたら400エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/login.js');
    const request = createMockRequest({ password: 'test1234' });
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(400);
    expect(json.error).toContain('メールアドレス');
  });

  it('存在しないユーザーでログインしようとしたら401エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/login.js');
    const request = createMockRequest({ email: 'notexist@test.com', password: 'test1234' });
    const db = createMockDB({ first: null });
    const env = { NURIEL_DB: db };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
    expect(json.error).toContain('正しくありません');
  });
});

// ===================================================================
// 3. プランベースのスタイル制御（API側）
// ===================================================================
describe('プランベースのスタイル制御', () => {
  it('フリープランでstandardスタイルを使おうとしたら403エラー', async () => {
    const { onRequestPost } = await import('../functions/api/convert/index.js');

    const userId = 'user-123';
    const request = createMockRequest(
      { imageKey: `originals/${userId}/2026/01/01/img.png`, style: 'standard' },
      { 'Authorization': 'Bearer valid-token' }
    );

    const db = createMockDB();
    // authenticateが呼ぶSELECT sessions
    let callCount = 0;
    db.prepare = vi.fn().mockImplementation((sql) => {
      callCount++;
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(() => {
          if (sql.includes('sessions')) {
            return Promise.resolve({ id: 'valid-token', user_id: userId, expires_at: new Date(Date.now() + 86400000).toISOString() });
          }
          if (sql.includes('FROM users')) {
            return Promise.resolve({
              id: userId, email: 'test@test.com', plan: 'free',
              monthly_generation_count: 0, monthly_reset_date: new Date().toISOString(),
              gallery_count: 0,
            });
          }
          if (sql.includes('FROM plans')) {
            return Promise.resolve({
              monthly_limit: 1,
              styles_allowed: '["gentle"]',
              gallery_limit: 3,
            });
          }
          return Promise.resolve(null);
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
    });

    const storage = createMockStorage();
    const env = { NURIEL_DB: db, NURIEL_STORAGE: storage };

    const result = await onRequestPost({ request, env, waitUntil: vi.fn() });
    const json = await result.json();
    expect(result.status).toBe(403);
    expect(json.error).toContain('利用できません');
  });
});

// ===================================================================
// 4. imageKey所有者検証
// ===================================================================
describe('imageKey所有者検証', () => {
  it('他ユーザーのimageKeyを指定したら403エラー', async () => {
    const { onRequestPost } = await import('../functions/api/convert/index.js');

    const userId = 'user-123';
    const otherUserId = 'user-456';
    const request = createMockRequest(
      { imageKey: `originals/${otherUserId}/2026/01/01/img.png`, style: 'gentle' },
      { 'Authorization': 'Bearer valid-token' }
    );

    const db = createMockDB();
    db.prepare = vi.fn().mockImplementation((sql) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(() => {
        if (sql.includes('sessions')) {
          return Promise.resolve({ id: 'valid-token', user_id: userId, expires_at: new Date(Date.now() + 86400000).toISOString() });
        }
        if (sql.includes('FROM users')) {
          return Promise.resolve({
            id: userId, email: 'test@test.com', plan: 'free',
            monthly_generation_count: 0,
          });
        }
        return Promise.resolve(null);
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    }));

    const storage = createMockStorage();
    const env = { NURIEL_DB: db, NURIEL_STORAGE: storage };

    const result = await onRequestPost({ request, env, waitUntil: vi.fn() });
    const json = await result.json();
    expect(result.status).toBe(403);
    expect(json.error).toContain('アクセス権がありません');
  });
});

// ===================================================================
// 5. 認証必須エンドポイント
// ===================================================================
describe('認証必須エンドポイント', () => {
  it('トークンなしでログアウトしようとしたら401エラー', async () => {
    const { onRequestPost } = await import('../functions/api/auth/logout.js');
    const request = createMockRequest({}, {});
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしでユーザー情報を取得しようとしたら401エラー', async () => {
    const { onRequestGet } = await import('../functions/api/auth/me.js');
    const request = {
      headers: { get: vi.fn().mockReturnValue(null) },
      url: 'https://photo-nurie.com/api/auth/me',
    };
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestGet({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしで画像アップロードしようとしたら401エラー', async () => {
    const { onRequestPost } = await import('../functions/api/upload.js');
    const request = {
      headers: { get: vi.fn().mockReturnValue(null) },
      url: 'https://photo-nurie.com/api/upload',
    };
    const env = { NURIEL_DB: createMockDB(), NURIEL_STORAGE: createMockStorage() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしでギャラリーにアクセスしようとしたら401エラー', async () => {
    const { onRequestGet } = await import('../functions/api/gallery/index.js');
    const request = {
      headers: { get: vi.fn().mockReturnValue(null) },
      url: 'https://photo-nurie.com/api/gallery',
    };
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestGet({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしで課金ステータスにアクセスしようとしたら401エラー', { timeout: 15000 }, async () => {
    const { onRequestGet } = await import('../functions/api/billing/status.js');
    const request = {
      headers: { get: vi.fn().mockReturnValue(null) },
      url: 'https://photo-nurie.com/api/billing/status',
    };
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestGet({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしでPDFにアクセスしようとしたら401エラー', async () => {
    const { onRequestGet } = await import('../functions/api/pdf/[id].js');
    const request = {
      headers: { get: vi.fn().mockReturnValue(null) },
      url: 'https://photo-nurie.com/api/pdf/some-id',
    };
    const env = { NURIEL_DB: createMockDB(), NURIEL_STORAGE: createMockStorage() };
    const result = await onRequestGet({ request, env, params: { id: 'some-id' } });
    const json = await result.json();
    expect(result.status).toBe(401);
  });

  it('トークンなしでCheckoutしようとしたら401エラー', async () => {
    const { onRequestPost } = await import('../functions/api/billing/checkout.js');
    const request = createMockRequest({ plan_id: 'otameshi', billing_period: 'monthly' }, {});
    const env = { NURIEL_DB: createMockDB() };
    const result = await onRequestPost({ request, env });
    const json = await result.json();
    expect(result.status).toBe(401);
  });
});

// ===================================================================
// 6. Stripeライブラリのユーティリティ
// ===================================================================
describe('Stripeユーティリティ', () => {
  it('buildFormBodyがネストされたオブジェクトを正しくエンコードする', async () => {
    const { buildFormBody } = await import('../functions/lib/stripe.js');
    const result = buildFormBody({ key: 'value', nested: { inner: 'data' } });
    expect(result).toContain('key=value');
    expect(result).toContain('nested%5Binner%5D=data');
  });

  it('isMockModeがSTRIPE_SECRET_KEY未設定時にtrueを返す', async () => {
    const { isMockMode } = await import('../functions/lib/stripe.js');
    expect(isMockMode({})).toBe(true);
    expect(isMockMode({ STRIPE_SECRET_KEY: 'sk_test_xxx' })).toBe(false);
  });
});

// ===================================================================
// 7. レスポンスユーティリティ
// ===================================================================
describe('レスポンスユーティリティ', () => {
  it('jsonResponseが正しい形式のレスポンスを返す', async () => {
    const { jsonResponse } = await import('../functions/lib/response.js');
    const res = jsonResponse({ data: 'test' }, 201);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toBe('test');
  });

  it('errorResponseが正しい形式のエラーレスポンスを返す', async () => {
    const { errorResponse } = await import('../functions/lib/response.js');
    const res = errorResponse('テストエラー', 403);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('テストエラー');
  });
});

// ===================================================================
// 8. 暗号化ユーティリティ
// ===================================================================
describe('暗号化ユーティリティ', () => {
  it('generateIdがUUID形式を返す', async () => {
    const { generateId } = await import('../functions/lib/crypto.js');
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generateSessionTokenが64文字の16進文字列を返す', async () => {
    const { generateSessionToken } = await import('../functions/lib/crypto.js');
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashPasswordとverifyPasswordが正しく動作する', async () => {
    const { hashPassword, verifyPassword } = await import('../functions/lib/crypto.js');
    const hash = await hashPassword('test1234');
    expect(hash).toContain(':');
    expect(await verifyPassword('test1234', hash)).toBe(true);
    expect(await verifyPassword('wrong1234', hash)).toBe(false);
  });

  it('getNextMonthlyResetDateが翌月1日を返す', async () => {
    const { getNextMonthlyResetDate } = await import('../functions/lib/crypto.js');
    const date = getNextMonthlyResetDate();
    const parsed = new Date(date);
    expect(parsed.getUTCDate()).toBe(1);
    expect(parsed.getUTCHours()).toBe(0);
  });
});

// ===================================================================
// 9. プラン一覧API（認証不要）
// ===================================================================
describe('プラン一覧API', () => {
  it('認証なしでプラン一覧を取得できる', async () => {
    const { onRequestGet } = await import('../functions/api/billing/plans.js');
    const db = createMockDB({
      all: {
        results: [
          { id: 'free', name: '無料体験', price_monthly: 0, price_yearly: 0, monthly_limit: 1, styles_allowed: '["gentle"]', gallery_limit: 3 },
          { id: 'otameshi', name: 'おためし', price_monthly: 100, price_yearly: 1000, monthly_limit: 3, styles_allowed: '["gentle","standard"]', gallery_limit: 10 },
        ],
      },
    });
    const env = { NURIEL_DB: db };
    const result = await onRequestGet({ env });
    const json = await result.json();
    expect(result.status).toBe(200);
    expect(json.plans).toHaveLength(2);
    expect(json.plans[0].styles_allowed).toContain('gentle');
  });
});

// ===================================================================
// 10. ギャラリー削除の所有者チェック
// ===================================================================
describe('ギャラリー削除の所有者チェック', () => {
  it('他人のアイテムを削除しようとしたら404エラー', async () => {
    const { onRequestDelete } = await import('../functions/api/gallery/[id].js');

    const userId = 'user-123';
    const request = {
      headers: { get: vi.fn((key) => key === 'Authorization' ? 'Bearer valid-token' : null) },
    };

    const db = createMockDB();
    db.prepare = vi.fn().mockImplementation((sql) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(() => {
        if (sql.includes('sessions')) {
          return Promise.resolve({ id: 'valid-token', user_id: userId, expires_at: new Date(Date.now() + 86400000).toISOString() });
        }
        if (sql.includes('FROM users')) {
          return Promise.resolve({ id: userId, email: 'test@test.com', plan: 'free' });
        }
        // generations WHERE id = ? AND user_id = ? → nullで所有者チェック失敗
        if (sql.includes('FROM generations')) {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    }));

    const env = { NURIEL_DB: db, NURIEL_STORAGE: createMockStorage() };
    const result = await onRequestDelete({ request, env, params: { id: 'other-gen-id' } });
    const json = await result.json();
    expect(result.status).toBe(404);
    expect(json.error).toContain('見つかりません');
  });
});
