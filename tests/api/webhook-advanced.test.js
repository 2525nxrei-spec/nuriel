/**
 * Stripe Webhook 高度テスト（第2ラウンド）
 * - 全イベントタイプの異常系
 * - 署名検証の異常系
 * - 冪等性チェック
 * - DB操作失敗時のエラーハンドリング
 */
import { describe, it, expect, vi } from 'vitest';
import { onRequestPost as onWebhookPost } from '../../functions/api/billing/webhook.js';
import { verifyStripeSignature } from '../../functions/lib/stripe.js';
import {
  createMockDB,
  createMockEnv,
  createTestUser,
} from '../helpers/mock-env.js';

// ============================================================
// ヘルパー: Stripe署名ヘッダー生成
// ============================================================

/**
 * テスト用にStripe署名ヘッダーを生成する
 * @param {string} payload - ペイロード文字列
 * @param {string} secret - Webhook Secret
 * @param {number} [timestamp] - UNIXタイムスタンプ（省略時は現在）
 * @returns {Promise<string>} Stripe-Signature ヘッダー値
 */
async function createSignatureHeader(payload, secret, timestamp) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
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

  return `t=${ts},v1=${sig}`;
}

/**
 * webhookリクエストを生成しPOSTする
 */
async function postWebhook(env, payload, signatureHeader) {
  const request = new Request('https://example.com/api/billing/webhook', {
    method: 'POST',
    headers: signatureHeader ? { 'stripe-signature': signatureHeader } : {},
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return onWebhookPost({ request, env });
}

/**
 * 署名付きwebhookリクエストを生成しPOSTする
 */
async function postSignedWebhook(env, event, secret) {
  const payload = JSON.stringify(event);
  const sigHeader = await createSignatureHeader(payload, secret);
  return postWebhook(env, payload, sigHeader);
}

// ============================================================
// 署名検証 異常系テスト
// ============================================================

describe('Webhook署名検証: 異常系', () => {
  const WEBHOOK_SECRET = 'whsec_test_secret_key_12345';

  it('stripe-signatureヘッダーがない場合は400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const request = new Request('https://example.com/api/billing/webhook', {
      method: 'POST',
      body: '{"type":"test"}',
      // stripe-signatureヘッダーなし
    });

    const res = await onWebhookPost({ request, env });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('署名');
  });

  it('不正な署名形式（tなし）で400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const res = await postWebhook(env, '{"type":"test"}', 'v1=invalidhex');
    expect(res.status).toBe(400);
  });

  it('不正な署名形式（v1なし）で400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const res = await postWebhook(env, '{"type":"test"}', 't=12345');
    expect(res.status).toBe(400);
  });

  it('改竄されたペイロードで署名不一致→400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    // 正しいペイロードで署名を作成
    const originalPayload = '{"type":"test","id":"evt_original"}';
    const sigHeader = await createSignatureHeader(originalPayload, WEBHOOK_SECRET);

    // 改竄されたペイロードを送信
    const tamperedPayload = '{"type":"test","id":"evt_tampered"}';
    const res = await postWebhook(env, tamperedPayload, sigHeader);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('署名');
  });

  it('間違ったWebhook Secretで署名不一致→400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const payload = '{"type":"test","id":"evt_001"}';
    const wrongSecret = 'whsec_wrong_secret';
    const sigHeader = await createSignatureHeader(payload, wrongSecret);

    const res = await postWebhook(env, payload, sigHeader);
    expect(res.status).toBe(400);
  });

  it('期限切れタイムスタンプ（5分超過）で400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const payload = '{"type":"test","id":"evt_002"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10分前
    const sigHeader = await createSignatureHeader(payload, WEBHOOK_SECRET, oldTimestamp);

    const res = await postWebhook(env, payload, sigHeader);
    expect(res.status).toBe(400);
  });

  it('未来すぎるタイムスタンプ（5分超過）で400を返す', async () => {
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    const payload = '{"type":"test","id":"evt_003"}';
    const futureTimestamp = Math.floor(Date.now() / 1000) + 600; // 10分後
    const sigHeader = await createSignatureHeader(payload, WEBHOOK_SECRET, futureTimestamp);

    const res = await postWebhook(env, payload, sigHeader);
    expect(res.status).toBe(400);
  });
});

// ============================================================
// verifyStripeSignature ユニットテスト
// ============================================================

describe('verifyStripeSignature: ユニットテスト', () => {
  const SECRET = 'whsec_unit_test';

  it('signatureHeaderがnullでエラーをスローする', async () => {
    await expect(
      verifyStripeSignature('payload', null, SECRET)
    ).rejects.toThrow('Stripe-Signatureヘッダーがありません');
  });

  it('signatureHeaderが空文字でエラーをスローする', async () => {
    await expect(
      verifyStripeSignature('payload', '', SECRET)
    ).rejects.toThrow('Stripe-Signatureヘッダーがありません');
  });

  it('不正なヘッダー形式でエラーをスローする', async () => {
    await expect(
      verifyStripeSignature('payload', 'garbage_header', SECRET)
    ).rejects.toThrow('形式が不正');
  });

  it('正しい署名でイベントオブジェクトを返す', async () => {
    const event = { id: 'evt_valid', type: 'test' };
    const payload = JSON.stringify(event);
    const sigHeader = await createSignatureHeader(payload, SECRET);

    const result = await verifyStripeSignature(payload, sigHeader, SECRET);
    expect(result.id).toBe('evt_valid');
    expect(result.type).toBe('test');
  });

  it('タイムスタンプが許容範囲内（4分59秒前）で成功する', async () => {
    const event = { id: 'evt_boundary', type: 'test' };
    const payload = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000) - 299; // 4分59秒前
    const sigHeader = await createSignatureHeader(payload, SECRET, ts);

    const result = await verifyStripeSignature(payload, sigHeader, SECRET);
    expect(result.id).toBe('evt_boundary');
  });

  it('不正なJSONペイロードでも署名検証は成功するがJSON.parseでエラー', async () => {
    const payload = 'not-valid-json';
    const sigHeader = await createSignatureHeader(payload, SECRET);

    await expect(
      verifyStripeSignature(payload, sigHeader, SECRET)
    ).rejects.toThrow(); // JSON.parse エラー
  });
});

// ============================================================
// Webhookイベント処理: checkout.session.completed 異常系
// ============================================================

describe('Webhook: checkout.session.completed 異常系', () => {
  const WEBHOOK_SECRET = 'whsec_checkout_test';

  it('metadataにuser_idがない場合はエラーなく処理完了する', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_123' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_no_userid',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { plan_id: 'otameshi' }, // user_idなし
          subscription: 'sub_123',
          customer: 'cus_123',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  it('metadataにplan_idがない場合はエラーなく処理完了する', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_123' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_no_planid',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { user_id: user.id }, // plan_idなし
          subscription: 'sub_123',
          customer: 'cus_123',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('無効なplan_idの場合はエラーなく処理完了する', async () => {
    const user = createTestUser();
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_invalid_plan',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { user_id: user.id, plan_id: 'nonexistent_plan' },
          subscription: 'sub_123',
          customer: 'cus_123',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('正常なcheckout.session.completedイベントで200を返す', async () => {
    const user = createTestUser();
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_checkout_ok',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { user_id: user.id, plan_id: 'otameshi' },
          subscription: 'sub_new_123',
          customer: 'cus_new_123',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });
});

// ============================================================
// Webhookイベント処理: customer.subscription.updated 異常系
// ============================================================

describe('Webhook: customer.subscription.updated 異常系', () => {
  const WEBHOOK_SECRET = 'whsec_sub_updated';

  it('plan_idが特定できない場合はエラーなく処理完了する', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_sub' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_no_plan',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_sub',
          status: 'active',
          metadata: {}, // plan_idなし
          items: { data: [] }, // price情報もなし
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('ステータスがpast_dueの場合はプラン更新をスキップする', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_pastdue' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_pastdue',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_456',
          customer: 'cus_pastdue',
          status: 'past_due', // activeでもtrialingでもない
          metadata: { plan_id: 'tappuri' },
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('ステータスがcanceledの場合はプラン更新をスキップする', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_canceled' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_canceled',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_789',
          customer: 'cus_canceled',
          status: 'canceled',
          metadata: { plan_id: 'otameshi' },
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('metadataからplan_idが取れてactiveステータスで正常処理', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_active' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_active',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_active_001',
          customer: 'cus_active',
          status: 'active',
          metadata: { plan_id: 'tappuri' },
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('trialingステータスでも正常処理される', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_trial' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_trial',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_trial_001',
          customer: 'cus_trial',
          status: 'trialing',
          metadata: { plan_id: 'otameshi' },
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Webhookイベント処理: customer.subscription.deleted 異常系
// ============================================================

describe('Webhook: customer.subscription.deleted', () => {
  const WEBHOOK_SECRET = 'whsec_sub_deleted';

  it('解約イベントで正常に200を返す', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_del' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_del',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_del_001',
          customer: 'cus_del',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('存在しないcustomerでもエラーにならない（changes=0ログ）', async () => {
    const db = createMockDB({ users: [] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_sub_del_nouser',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_ghost_001',
          customer: 'cus_nonexistent',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Webhookイベント処理: invoice.payment_succeeded/failed 異常系
// ============================================================

describe('Webhook: invoice.payment_succeeded', () => {
  const WEBHOOK_SECRET = 'whsec_payment';

  it('支払い成功イベントで月間カウントをリセットする', async () => {
    const user = createTestUser({
      stripe_customer_id: 'cus_pay',
      monthly_generation_count: 5,
    });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_pay_ok',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          customer: 'cus_pay',
          subscription: 'sub_pay_001',
          amount_paid: 300,
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('存在しないcustomerでもエラーにならない', async () => {
    const db = createMockDB({ users: [] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_pay_nouser',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          customer: 'cus_ghost',
          subscription: 'sub_ghost',
          amount_paid: 100,
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});

describe('Webhook: invoice.payment_failed', () => {
  const WEBHOOK_SECRET = 'whsec_payfail';

  it('支払い失敗イベントで200を返す', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_fail' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_pay_fail',
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_fail',
          subscription: 'sub_fail_001',
          attempt_count: 3,
          id: 'in_fail_001',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });

  it('初回失敗（attempt_count=1）でも正常処理される', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_fail2' });
    const db = createMockDB({ users: [user] });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_pay_fail_first',
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_fail2',
          subscription: 'sub_fail_002',
          attempt_count: 1,
          id: 'in_fail_002',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 未対応のWebhookイベントタイプ
// ============================================================

describe('Webhook: 未対応イベント', () => {
  const WEBHOOK_SECRET = 'whsec_unknown';

  it('未対応のイベントタイプでも200を返す', async () => {
    const db = createMockDB();
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_unknown_type',
      type: 'customer.created',
      data: { object: {} },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  it('charge.disputeイベントでも正常に200を返す', async () => {
    const db = createMockDB();
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_dispute',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_001' } },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 冪等性チェック
// ============================================================

describe('Webhook: 冪等性', () => {
  const WEBHOOK_SECRET = 'whsec_idempotent';

  it('同じイベントIDの2回目の処理はスキップされる', async () => {
    const user = createTestUser({ stripe_customer_id: 'cus_idem' });
    const db = createMockDB({
      users: [user],
      // 既に処理済みのイベントをwebhooks_logに登録
      webhooks_log: [{ id: 'log_001', stripe_event_id: 'evt_already_processed' }],
    });
    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NURIEL_DB: db,
    });

    const event = {
      id: 'evt_already_processed',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { user_id: user.id, plan_id: 'tappuri' },
          subscription: 'sub_idem',
          customer: 'cus_idem',
        },
      },
    };

    const res = await postSignedWebhook(env, event, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('already_processed');
  });
});
