/**
 * functions/lib/response.js のテスト
 */
import { describe, it, expect } from 'vitest';
import { jsonResponse, errorResponse } from '../../functions/lib/response.js';

describe('jsonResponse', () => {
  it('デフォルトで200ステータスを返す', async () => {
    const res = jsonResponse({ message: 'テスト' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe('テスト');
  });

  it('カスタムステータスコードを使用できる', async () => {
    const res = jsonResponse({ id: '123' }, 201);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe('123');
  });

  it('Content-Typeがapplication/jsonである', () => {
    const res = jsonResponse({});
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });
});

describe('errorResponse', () => {
  it('デフォルトで400ステータスを返す', async () => {
    const res = errorResponse('エラーメッセージ');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('エラーメッセージ');
  });

  it('カスタムステータスコードを使用できる', async () => {
    const res = errorResponse('認証エラー', 401);
    expect(res.status).toBe(401);
  });

  it('詳細情報を含められる', async () => {
    const res = errorResponse('バリデーションエラー', 400, { field: 'email' });
    const body = await res.json();
    expect(body.details).toEqual({ field: 'email' });
  });

  it('詳細がnullの場合はdetailsキーを含まない', async () => {
    const res = errorResponse('エラー', 400);
    const body = await res.json();
    expect(body).not.toHaveProperty('details');
  });
});
