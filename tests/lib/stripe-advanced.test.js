/**
 * Stripe ライブラリ追加テスト（第2ラウンド）
 * - buildFormBody の追加エッジケース
 * - StripeApiError の詳細テスト
 * - verifyStripeSignature の署名検証ロジック
 * - stripeRequest のリクエスト構築（モック）
 */
import { describe, it, expect } from 'vitest';
import {
  buildFormBody,
  StripeApiError,
  isMockMode,
  VALID_PLAN_IDS,
  VALID_BILLING_PERIODS,
  STRIPE_PRICE_IDS,
  STRIPE_API_BASE,
  verifyStripeSignature,
} from '../../functions/lib/stripe.js';

// ============================================================
// buildFormBody: 追加エッジケース
// ============================================================

describe('buildFormBody: 追加エッジケース', () => {
  it('空オブジェクトで空文字列を返す', () => {
    const result = buildFormBody({});
    expect(result).toBe('');
  });

  it('数値の値を文字列に変換する', () => {
    const result = buildFormBody({ amount: 1000, quantity: 1 });
    const params = new URLSearchParams(result);
    expect(params.get('amount')).toBe('1000');
    expect(params.get('quantity')).toBe('1');
  });

  it('booleanの値を文字列に変換する', () => {
    const result = buildFormBody({ active: true, canceled: false });
    const params = new URLSearchParams(result);
    expect(params.get('active')).toBe('true');
    expect(params.get('canceled')).toBe('false');
  });

  it('深くネストされたオブジェクトを正しく変換する', () => {
    const result = buildFormBody({
      subscription_data: {
        metadata: {
          user_id: 'u1',
          plan_id: 'tappuri',
        },
      },
    });
    const params = new URLSearchParams(result);
    expect(params.get('subscription_data[metadata][user_id]')).toBe('u1');
    expect(params.get('subscription_data[metadata][plan_id]')).toBe('tappuri');
  });

  it('配列内のプリミティブ値を変換する', () => {
    const result = buildFormBody({
      expand: ['customer', 'subscription'],
    });
    const params = new URLSearchParams(result);
    expect(params.get('expand[0]')).toBe('customer');
    expect(params.get('expand[1]')).toBe('subscription');
  });

  it('複数アイテムの配列を変換する', () => {
    const result = buildFormBody({
      items: [
        { price: 'price_123', quantity: 1 },
        { price: 'price_456', quantity: 2 },
      ],
    });
    const params = new URLSearchParams(result);
    expect(params.get('items[0][price]')).toBe('price_123');
    expect(params.get('items[0][quantity]')).toBe('1');
    expect(params.get('items[1][price]')).toBe('price_456');
    expect(params.get('items[1][quantity]')).toBe('2');
  });

  it('日本語の値を正しくエンコードする', () => {
    const result = buildFormBody({ description: 'ヌリエルサブスク' });
    const params = new URLSearchParams(result);
    expect(params.get('description')).toBe('ヌリエルサブスク');
  });

  it('空文字列の値は含まれる（nullやundefinedとは異なる）', () => {
    const result = buildFormBody({ email: '', name: 'test' });
    const params = new URLSearchParams(result);
    expect(params.get('email')).toBe('');
    expect(params.get('name')).toBe('test');
  });

  it('混合型のオブジェクトを処理する', () => {
    const result = buildFormBody({
      customer: 'cus_123',
      metadata: { user_id: 'u1' },
      items: [{ price: 'price_abc' }],
      active: true,
      extra: null,
    });
    const params = new URLSearchParams(result);
    expect(params.get('customer')).toBe('cus_123');
    expect(params.get('metadata[user_id]')).toBe('u1');
    expect(params.get('items[0][price]')).toBe('price_abc');
    expect(params.get('active')).toBe('true');
    expect(params.has('extra')).toBe(false);
  });
});

// ============================================================
// StripeApiError: 追加テスト
// ============================================================

describe('StripeApiError: 追加テスト', () => {
  it('デフォルト値でインスタンス化できる', () => {
    const err = new StripeApiError('テスト');
    expect(err.message).toBe('テスト');
    expect(err.name).toBe('StripeApiError');
    expect(err.type).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.httpStatus).toBeUndefined();
  });

  it('api_errorタイプを正しく保持する', () => {
    const err = new StripeApiError('APIエラー', 'api_error', null, 500);
    expect(err.type).toBe('api_error');
    expect(err.httpStatus).toBe(500);
  });

  it('invalid_request_errorタイプを正しく保持する', () => {
    const err = new StripeApiError('不正なリクエスト', 'invalid_request_error', 'resource_missing', 404);
    expect(err.type).toBe('invalid_request_error');
    expect(err.code).toBe('resource_missing');
    expect(err.httpStatus).toBe(404);
  });

  it('authentication_errorタイプを正しく保持する', () => {
    const err = new StripeApiError('認証失敗', 'authentication_error', 'api_key_expired', 401);
    expect(err.type).toBe('authentication_error');
    expect(err.httpStatus).toBe(401);
  });

  it('Error.prototype チェーンが正しい', () => {
    const err = new StripeApiError('テスト', 'card_error', 'card_declined', 402);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof StripeApiError).toBe(true);
    expect(err.stack).toBeDefined();
  });

  it('try/catchでキャッチできる', () => {
    let caught = false;
    try {
      throw new StripeApiError('テスト', 'card_error', 'card_declined', 402);
    } catch (e) {
      caught = true;
      expect(e.message).toBe('テスト');
      expect(e.type).toBe('card_error');
    }
    expect(caught).toBe(true);
  });
});

// ============================================================
// isMockMode: 追加テスト
// ============================================================

describe('isMockMode: 追加エッジケース', () => {
  it('STRIPE_SECRET_KEYがnullの場合はtrue', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: null })).toBe(true);
  });

  it('STRIPE_SECRET_KEYが0の場合はtrue', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: 0 })).toBe(true);
  });

  it('STRIPE_SECRET_KEYがfalseの場合はtrue', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: false })).toBe(true);
  });

  it('STRIPE_SECRET_KEYがsk_liveの場合はfalse', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: 'sk_live_xxx' })).toBe(false);
  });
});

// ============================================================
// 定数テスト: 追加
// ============================================================

describe('定数: 追加テスト', () => {
  it('STRIPE_API_BASEが正しいURLである', () => {
    expect(STRIPE_API_BASE).toBe('https://api.stripe.com/v1');
  });

  it('全プランのyearlyの価格IDが定義されている', () => {
    for (const planId of VALID_PLAN_IDS) {
      expect(STRIPE_PRICE_IDS[planId].yearly).toBeTruthy();
    }
  });

  it('otameshiプランの価格IDがprice_で始まる', () => {
    expect(STRIPE_PRICE_IDS.otameshi.monthly).toMatch(/^price_/);
    expect(STRIPE_PRICE_IDS.otameshi.yearly).toMatch(/^price_/);
  });

  it('tappuriプランの価格IDがprice_で始まる', () => {
    expect(STRIPE_PRICE_IDS.tappuri.monthly).toMatch(/^price_/);
    expect(STRIPE_PRICE_IDS.tappuri.yearly).toMatch(/^price_/);
  });

  it('VALID_PLAN_IDSにfreeが含まれない（有料プランのみ）', () => {
    expect(VALID_PLAN_IDS).not.toContain('free');
  });

  it('VALID_BILLING_PERIODSにdailyやweeklyが含まれない', () => {
    expect(VALID_BILLING_PERIODS).not.toContain('daily');
    expect(VALID_BILLING_PERIODS).not.toContain('weekly');
  });
});

// ============================================================
// verifyStripeSignature: 追加テスト（crypto.subtleが使える環境のみ）
// ============================================================

describe('verifyStripeSignature: タイミングセーフ比較', () => {
  const SECRET = 'whsec_timing_test';

  async function createSig(payload, secret, ts) {
    const signedPayload = `${ts}.${payload}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(signedPayload);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    return Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  it('複数のv1署名がある場合、1つでも一致すれば成功する', async () => {
    const payload = '{"id":"evt_multi"}';
    const ts = Math.floor(Date.now() / 1000);
    const validSig = await createSig(payload, SECRET, ts);

    // 2つのv1署名（1つ目は無効、2つ目が有効）
    const header = `t=${ts},v1=invalidhexsignature1234567890abcdef1234567890abcdef1234567890abcdef12,v1=${validSig}`;

    const result = await verifyStripeSignature(payload, header, SECRET);
    expect(result.id).toBe('evt_multi');
  });

  it('すべてのv1署名が無効な場合はエラー', async () => {
    const payload = '{"id":"evt_invalid"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=aaaa,v1=bbbb`;

    await expect(
      verifyStripeSignature(payload, header, SECRET)
    ).rejects.toThrow('署名');
  });

  it('v0署名は無視される', async () => {
    const payload = '{"id":"evt_v0"}';
    const ts = Math.floor(Date.now() / 1000);
    const validSig = await createSig(payload, SECRET, ts);

    // v0は無視、v1のみ検証される
    const header = `t=${ts},v0=oldsig,v1=${validSig}`;

    const result = await verifyStripeSignature(payload, header, SECRET);
    expect(result.id).toBe('evt_v0');
  });
});
