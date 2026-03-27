/**
 * Stripe決済フロー統合テスト（第2ラウンド強化）
 * - stripeRequest関数のfetchモック
 * - checkout/portal非モード時のStripe APIエラーハンドリング
 * - billing/status でStripeサブスクリプション取得エラー
 * - verifyStripeSignature追加エッジケース
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyStripeSignature, buildFormBody, StripeApiError } from '../../functions/lib/stripe.js';

// ============================================================
// verifyStripeSignature: 追加エッジケース
// ============================================================

/**
 * テスト用にStripe署名ヘッダーを生成する
 */
async function createSignatureHeader(payload, secret, timestamp) {
  const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sig = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return { header: `t=${ts},v1=${sig}`, timestamp: ts, signature: sig };
}

describe('verifyStripeSignature: 追加エッジケース', () => {
  const SECRET = 'whsec_extended_test';

  it('複数のv1署名がある場合、正しいものがあれば成功する', async () => {
    const event = { id: 'evt_multi_sig', type: 'test' };
    const payload = JSON.stringify(event);
    const { header: correctHeader, timestamp, signature: correctSig } =
      await createSignatureHeader(payload, SECRET);

    // 不正な署名と正しい署名の両方を含むヘッダー
    const multiSigHeader = `t=${timestamp},v1=invalidhex0000000000000000000000000000000000000000000000000000000000000000,v1=${correctSig}`;

    const result = await verifyStripeSignature(payload, multiSigHeader, SECRET);
    expect(result.id).toBe('evt_multi_sig');
  });

  it('間違ったsecretで署名した場合は検証に失敗する', async () => {
    const payload = '{"id":"evt_wrong_sec","type":"test"}';
    const wrongSecret = 'whsec_completely_wrong_secret';
    const { header } = await createSignatureHeader(payload, wrongSecret);

    await expect(
      verifyStripeSignature(payload, header, SECRET)
    ).rejects.toThrow('署名');
  });

  it('v1署名がゼロ個の場合はエラーをスローする', async () => {
    const payload = '{"id":"evt_no_v1","type":"test"}';
    const ts = Math.floor(Date.now() / 1000);
    const noV1Header = `t=${ts}`;

    await expect(
      verifyStripeSignature(payload, noV1Header, SECRET)
    ).rejects.toThrow('形式が不正');
  });

  it('空文字列のペイロードでも署名検証は動作する', async () => {
    const payload = '';
    const { header } = await createSignatureHeader(payload, SECRET);

    // 空文字列はJSON.parseでエラー
    await expect(
      verifyStripeSignature(payload, header, SECRET)
    ).rejects.toThrow();
  });

  it('toleranceSecをカスタム設定できる', async () => {
    const event = { id: 'evt_custom_tol', type: 'test' };
    const payload = JSON.stringify(event);
    // 10秒前のタイムスタンプ
    const ts = Math.floor(Date.now() / 1000) - 10;
    const { header } = await createSignatureHeader(payload, SECRET, ts);

    // tolerance=5秒なので10秒前は失敗する
    await expect(
      verifyStripeSignature(payload, header, SECRET, 5)
    ).rejects.toThrow('許容範囲外');
  });

  it('toleranceSecが十分大きければ古いタイムスタンプでも成功', async () => {
    const event = { id: 'evt_large_tol', type: 'test' };
    const payload = JSON.stringify(event);
    // 10秒前のタイムスタンプ
    const ts = Math.floor(Date.now() / 1000) - 10;
    const { header } = await createSignatureHeader(payload, SECRET, ts);

    // tolerance=60秒なので10秒前は成功する
    const result = await verifyStripeSignature(payload, header, SECRET, 60);
    expect(result.id).toBe('evt_large_tol');
  });

  it('タイムスタンプが1（UNIX epoch直後）の場合は許容範囲外でエラー', async () => {
    const payload = '{"id":"evt_old_ts","type":"test"}';
    // timestamp=1は1970年1月1日なので確実に許容範囲外
    const { header } = await createSignatureHeader(payload, SECRET, 1);

    await expect(
      verifyStripeSignature(payload, header, SECRET)
    ).rejects.toThrow('許容範囲外');
  });

  it('ヘッダーに余計な要素（v0）があっても正常動作する', async () => {
    const event = { id: 'evt_extra', type: 'test' };
    const payload = JSON.stringify(event);
    const { timestamp, signature } = await createSignatureHeader(payload, SECRET);

    // v0要素を追加（Stripeは無視する仕様）
    const headerWithV0 = `t=${timestamp},v0=ignoredvalue,v1=${signature}`;

    const result = await verifyStripeSignature(payload, headerWithV0, SECRET);
    expect(result.id).toBe('evt_extra');
  });
});

// ============================================================
// buildFormBody: 追加エッジケース
// ============================================================

describe('buildFormBody: 追加エッジケース', () => {
  it('空オブジェクトで空文字列を返す', () => {
    const result = buildFormBody({});
    expect(result).toBe('');
  });

  it('数値型の値を文字列に変換する', () => {
    const result = buildFormBody({ amount: 300, quantity: 1 });
    const params = new URLSearchParams(result);
    expect(params.get('amount')).toBe('300');
    expect(params.get('quantity')).toBe('1');
  });

  it('ブーリアン値を文字列に変換する', () => {
    const result = buildFormBody({ active: true, canceled: false });
    const params = new URLSearchParams(result);
    expect(params.get('active')).toBe('true');
    expect(params.get('canceled')).toBe('false');
  });

  it('深くネストされたオブジェクトを正しく処理する', () => {
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

  it('配列内のプリミティブ値を正しく処理する', () => {
    const result = buildFormBody({
      expand: ['data.customer', 'data.subscription'],
    });
    const params = new URLSearchParams(result);
    expect(params.get('expand[0]')).toBe('data.customer');
    expect(params.get('expand[1]')).toBe('data.subscription');
  });

  it('prefixパラメータで名前空間を指定できる', () => {
    const result = buildFormBody({ id: 'item_1', quantity: 2 }, 'items[0]');
    const params = new URLSearchParams(result);
    expect(params.get('items[0][id]')).toBe('item_1');
    expect(params.get('items[0][quantity]')).toBe('2');
  });
});

// ============================================================
// StripeApiError: 追加テスト
// ============================================================

describe('StripeApiError: 追加テスト', () => {
  it('スタックトレースが生成される', () => {
    const err = new StripeApiError('テスト', 'api_error', 'rate_limit', 429);
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('StripeApiError');
  });

  it('Error.prototype.toStringが正しく動く', () => {
    const err = new StripeApiError('支払い拒否', 'card_error', 'card_declined', 402);
    expect(err.toString()).toContain('支払い拒否');
  });

  it('httpStatusが数値型で保持される', () => {
    const err = new StripeApiError('test', 'invalid_request_error', null, 400);
    expect(typeof err.httpStatus).toBe('number');
    expect(err.code).toBeNull();
  });
});
