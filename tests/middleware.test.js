/**
 * functions/_middleware.js のテスト
 * CORS、セキュリティヘッダー、レート制限
 */
import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/_middleware.js';

/**
 * ミドルウェアのcontextを生成
 */
function createMiddlewareContext(request, nextResponse) {
  return {
    request,
    next: async () => nextResponse || new Response('OK', { status: 200 }),
  };
}

describe('ミドルウェア: OPTIONSプリフライト', () => {
  it('OPTIONSリクエストに204を返す', async () => {
    const request = new Request('https://example.com/api/test', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://photo-nurie.com' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.status).toBe(204);
  });

  it('OPTIONSレスポンスにCORSヘッダーが含まれる', async () => {
    const request = new Request('https://example.com/api/test', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://photo-nurie.com' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://photo-nurie.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});

describe('ミドルウェア: CORS', () => {
  it('許可されたオリジンでAccess-Control-Allow-Originが設定される', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'https://photo-nurie.com' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://photo-nurie.com');
  });

  it('localhostが許可される', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'http://localhost:8788' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8788');
  });

  it('pages.devプレビューURLが許可される', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'https://preview-123.nuriel.pages.dev' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://preview-123.nuriel.pages.dev');
  });

  it('未許可のオリジンでデフォルトオリジンが設定される', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'https://evil-site.com' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://photo-nurie.com');
  });
});

describe('ミドルウェア: セキュリティヘッダー', () => {
  it('セキュリティヘッダーが設定される', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'https://photo-nurie.com' },
    });

    const res = await onRequest(createMiddlewareContext(request));
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-XSS-Protection')).toBe('1; mode=block');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });
});

describe('ミドルウェア: エラーハンドリング', () => {
  it('ハンドラがエラーを投げた場合に500を返す', async () => {
    const request = new Request('https://example.com/api/test', {
      headers: { 'Origin': 'https://photo-nurie.com' },
    });

    const context = {
      request,
      next: async () => { throw new Error('テストエラー'); },
    };

    const res = await onRequest(context);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('サーバー内部エラー');
  });
});
