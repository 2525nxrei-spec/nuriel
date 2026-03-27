/**
 * POST /api/convert, GET /api/convert/:id/status, GET /api/convert/:id/result のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../functions/api/convert/index.js';
import { onRequestGet as onStatusGet } from '../../functions/api/convert/[id]/status.js';
import { onRequestGet as onResultGet } from '../../functions/api/convert/[id]/result.js';
import {
  createMockDB,
  createMockR2,
  createTestUser,
  createTestSession,
  createTestGeneration,
} from '../helpers/mock-env.js';

function createConvertContext(request, env, overrides = {}) {
  return {
    request,
    env,
    waitUntil: () => {},  // バックグラウンド処理のモック
    ...overrides,
  };
}

describe('POST /api/convert', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageKey: 'test.png' }),
    });

    const env = {
      NURIEL_DB: createMockDB(),
      NURIEL_STORAGE: createMockR2(),
    };

    const res = await onRequestPost(createConvertContext(request, env));
    expect(res.status).toBe(401);
  });

  it('imageKeyが空の場合は400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();

    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ imageKey: '' }),
    });

    const res = await onRequestPost(createConvertContext(request, {
      NURIEL_DB: db,
      NURIEL_STORAGE: r2,
      REPLICATE_API_TOKEN: '',
    }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('imageKey');
  });

  it('存在しない画像キーで404を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();

    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ imageKey: 'nonexistent/image.png' }),
    });

    const res = await onRequestPost(createConvertContext(request, {
      NURIEL_DB: db,
      NURIEL_STORAGE: r2,
      REPLICATE_API_TOKEN: '',
    }));
    expect(res.status).toBe(404);
  });

  it('有効なリクエストで変換を開始する（202を返す）', async () => {
    const user = createTestUser({ plan: 'free' });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();

    // R2にテスト画像をアップロード
    await r2.put('originals/test.png', new Uint8Array([1, 2, 3]));

    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ imageKey: 'originals/test.png', style: 'gentle' }),
    });

    const res = await onRequestPost(createConvertContext(request, {
      NURIEL_DB: db,
      NURIEL_STORAGE: r2,
      REPLICATE_API_TOKEN: '',
    }));
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.generationId).toBeTruthy();
    expect(body.status).toBe('pending');
  });

  it('プランで許可されていないスタイルで403を返す', async () => {
    const user = createTestUser({ plan: 'free' });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();
    await r2.put('originals/test.png', new Uint8Array([1, 2, 3]));

    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ imageKey: 'originals/test.png', style: 'manga' }),
    });

    const res = await onRequestPost(createConvertContext(request, {
      NURIEL_DB: db,
      NURIEL_STORAGE: r2,
      REPLICATE_API_TOKEN: '',
    }));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('スタイル');
  });

  it('月間上限に達している場合は429を返す', async () => {
    const user = createTestUser({
      plan: 'free',
      monthly_generation_count: 1,  // freeプランの上限は1
    });
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();
    await r2.put('originals/test.png', new Uint8Array([1, 2, 3]));

    const request = new Request('https://example.com/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ imageKey: 'originals/test.png', style: 'gentle' }),
    });

    const res = await onRequestPost(createConvertContext(request, {
      NURIEL_DB: db,
      NURIEL_STORAGE: r2,
      REPLICATE_API_TOKEN: '',
    }));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toContain('上限');
  });
});

describe('GET /api/convert/:id/status', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/convert/gen-001/status');
    const env = { NURIEL_DB: createMockDB() };

    const res = await onStatusGet({
      request,
      env,
      params: { id: 'gen-001' },
    });
    expect(res.status).toBe(401);
  });

  it('存在しない生成IDで404を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = new Request('https://example.com/api/convert/nonexistent/status', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onStatusGet({
      request,
      env: { NURIEL_DB: db },
      params: { id: 'nonexistent' },
    });
    expect(res.status).toBe(404);
  });

  it('有効なIDでステータスを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, { status: 'processing' });
    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/convert/gen-001/status', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onStatusGet({
      request,
      env: { NURIEL_DB: db },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.generationId).toBe(gen.id);
    expect(body.status).toBe('processing');
  });
});

describe('GET /api/convert/:id/result', () => {
  it('未完了の場合は400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, { status: 'processing' });
    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/convert/gen-001/result', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onResultGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: createMockR2() },
      params: { id: gen.id },
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('完了していません');
  });

  it('完了済みの場合は結果を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, { status: 'completed' });
    const r2 = createMockR2();
    await r2.put('line_art/gen-001.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/convert/gen-001/result', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onResultGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.generationId).toBe(gen.id);
    expect(body.lineArtBase64).toContain('data:image/png;base64,');
  });
});
