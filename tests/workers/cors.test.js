/**
 * workers/src/middleware/cors.js のテスト
 */
import { describe, it, expect } from 'vitest';
import { handleCors, addCorsHeaders } from '../../workers/src/middleware/cors.js';

describe('handleCors', () => {
  it('204レスポンスを返す', () => {
    const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
    const env = { FRONTEND_URL: 'https://photo-nurie.com' };

    const res = handleCors(request, env);
    expect(res.status).toBe(204);
  });

  it('CORSヘッダーが設定される', () => {
    const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
    const env = { FRONTEND_URL: 'https://photo-nurie.com' };

    const res = handleCors(request, env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://photo-nurie.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('FRONTEND_URLが未設定の場合は*が使われる', () => {
    const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
    const env = {};

    const res = handleCors(request, env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('addCorsHeaders', () => {
  it('既存レスポンスにCORSヘッダーを追加する', () => {
    const original = new Response('test', { status: 200 });
    const env = { FRONTEND_URL: 'https://photo-nurie.com' };

    const res = addCorsHeaders(original, env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://photo-nurie.com');
    expect(res.status).toBe(200);
  });
});
