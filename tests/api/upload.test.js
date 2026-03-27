/**
 * POST /api/upload のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../../functions/api/upload.js';
import {
  createMockDB,
  createMockR2,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

function createContext(request, env) {
  return { request, env };
}

function createAuthEnv(user, session) {
  return {
    NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    NURIEL_STORAGE: createMockR2(),
  };
}

describe('POST /api/upload', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const env = {
      NURIEL_DB: createMockDB(),
      NURIEL_STORAGE: createMockR2(),
    };

    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(401);
  });

  it('非対応のContent-Typeで400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createAuthEnv(user, session);

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': `Bearer ${session.id}`,
      },
      body: 'not an image',
    });

    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('画像形式');
  });

  it('有効なバイナリ画像アップロードで201を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createAuthEnv(user, session);

    // 最小限のPNGデータ
    const pngData = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${session.id}`,
      },
      body: pngData,
    });

    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.imageKey).toContain('originals/');
    expect(body.imageKey).toContain('.png');
    expect(body.mimeType).toBe('image/png');
    expect(body.fileId).toBeTruthy();
  });

  it('10MBを超えるファイルで400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createAuthEnv(user, session);

    // 11MB相当のArrayBuffer（テスト用に空データ）
    const largeData = new ArrayBuffer(11 * 1024 * 1024);

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'Authorization': `Bearer ${session.id}`,
      },
      body: largeData,
    });

    const res = await onRequestPost(createContext(request, env));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('10MB');
  });
});
