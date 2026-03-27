/**
 * functions/lib/stripe.js のテスト
 */
import { describe, it, expect } from 'vitest';
import {
  buildFormBody,
  StripeApiError,
  isMockMode,
  VALID_PLAN_IDS,
  VALID_BILLING_PERIODS,
  STRIPE_PRICE_IDS,
} from '../../functions/lib/stripe.js';

describe('buildFormBody', () => {
  it('フラットなオブジェクトをURLエンコードする', () => {
    const result = buildFormBody({ email: 'test@example.com', name: 'テスト' });
    const params = new URLSearchParams(result);
    expect(params.get('email')).toBe('test@example.com');
    expect(params.get('name')).toBe('テスト');
  });

  it('ネストされたオブジェクトをStripe形式に変換する', () => {
    const result = buildFormBody({ metadata: { user_id: 'u1', plan_id: 'tappuri' } });
    const params = new URLSearchParams(result);
    expect(params.get('metadata[user_id]')).toBe('u1');
    expect(params.get('metadata[plan_id]')).toBe('tappuri');
  });

  it('配列をStripe形式に変換する', () => {
    const result = buildFormBody({
      items: [{ price: 'price_123', quantity: 1 }],
    });
    const params = new URLSearchParams(result);
    expect(params.get('items[0][price]')).toBe('price_123');
    expect(params.get('items[0][quantity]')).toBe('1');
  });

  it('nullとundefinedの値を除外する', () => {
    const result = buildFormBody({ a: 'hello', b: null, c: undefined });
    const params = new URLSearchParams(result);
    expect(params.get('a')).toBe('hello');
    expect(params.has('b')).toBe(false);
    expect(params.has('c')).toBe(false);
  });
});

describe('StripeApiError', () => {
  it('正しいプロパティを持つ', () => {
    const err = new StripeApiError('テストエラー', 'card_error', 'card_declined', 402);
    expect(err.message).toBe('テストエラー');
    expect(err.name).toBe('StripeApiError');
    expect(err.type).toBe('card_error');
    expect(err.code).toBe('card_declined');
    expect(err.httpStatus).toBe(402);
    expect(err instanceof Error).toBe(true);
  });
});

describe('isMockMode', () => {
  it('STRIPE_SECRET_KEYが空文字の場合はtrue', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: '' })).toBe(true);
  });

  it('STRIPE_SECRET_KEYが未定義の場合はtrue', () => {
    expect(isMockMode({})).toBe(true);
  });

  it('STRIPE_SECRET_KEYが設定されている場合はfalse', () => {
    expect(isMockMode({ STRIPE_SECRET_KEY: 'sk_test_xxx' })).toBe(false);
  });
});

describe('定数', () => {
  it('有効なプランIDが定義されている', () => {
    expect(VALID_PLAN_IDS).toContain('otameshi');
    expect(VALID_PLAN_IDS).toContain('tappuri');
    expect(VALID_PLAN_IDS).not.toContain('free');
  });

  it('有効な請求期間が定義されている', () => {
    expect(VALID_BILLING_PERIODS).toContain('monthly');
    expect(VALID_BILLING_PERIODS).toContain('yearly');
  });

  it('Stripe Price IDマッピングが全プラン・期間に対応している', () => {
    for (const planId of VALID_PLAN_IDS) {
      expect(STRIPE_PRICE_IDS[planId]).toBeDefined();
      expect(STRIPE_PRICE_IDS[planId].monthly).toBeTruthy();
    }
  });
});
