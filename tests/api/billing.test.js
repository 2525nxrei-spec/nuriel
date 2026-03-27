/**
 * Billing API のテスト
 * /api/billing/plans, /api/billing/status, /api/billing/checkout,
 * /api/billing/portal, /api/billing/webhook, /api/billing/stripe-key
 */
import { describe, it, expect } from 'vitest';
import { onRequestGet as onPlansGet } from '../../functions/api/billing/plans.js';
import { onRequestGet as onStatusGet } from '../../functions/api/billing/status.js';
import { onRequestPost as onCheckoutPost } from '../../functions/api/billing/checkout.js';
import { onRequestPost as onPortalPost } from '../../functions/api/billing/portal.js';
import { onRequestPost as onWebhookPost } from '../../functions/api/billing/webhook.js';
import { onRequestGet as onStripeKeyGet } from '../../functions/api/billing/stripe-key.js';
import {
  createMockDB,
  createMockEnv,
  createMockRequest,
  createTestUser,
  createTestSession,
} from '../helpers/mock-env.js';

describe('GET /api/billing/plans', () => {
  it('プラン一覧を返す', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/api/billing/plans');

    const res = await onPlansGet({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.plans)).toBe(true);
    expect(body.plans.length).toBeGreaterThanOrEqual(3);

    // 各プランの構造を検証
    for (const plan of body.plans) {
      expect(plan.id).toBeTruthy();
      expect(plan.name).toBeTruthy();
      expect(typeof plan.price_monthly).toBe('number');
      expect(Array.isArray(plan.styles_allowed)).toBe(true);
    }
  });
});

describe('GET /api/billing/status', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/billing/status');
    const env = createMockEnv();

    const res = await onStatusGet({ request, env });
    expect(res.status).toBe(401);
  });

  it('認証ありで課金ステータスを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/status', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onStatusGet({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.plan).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.usage.monthly_limit).toBeDefined();
    expect(body.usage.remaining).toBeDefined();
  });
});

describe('POST /api/billing/checkout', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'otameshi', billing_period: 'monthly' }),
    });

    const env = createMockEnv();
    const res = await onCheckoutPost({ request, env });
    expect(res.status).toBe(401);
  });

  it('無効なプランIDで400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'invalid', billing_period: 'monthly' }),
    });

    const res = await onCheckoutPost({ request, env });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('プランID');
  });

  it('無効な請求期間で400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'otameshi', billing_period: 'weekly' }),
    });

    const res = await onCheckoutPost({ request, env });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('請求期間');
  });

  it('モックモードでclientSecretを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      STRIPE_SECRET_KEY: '',  // モックモード
    });

    const request = new Request('https://example.com/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.id}`,
      },
      body: JSON.stringify({ plan_id: 'otameshi', billing_period: 'monthly' }),
    });

    const res = await onCheckoutPost({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.clientSecret).toBeDefined();
    expect(body.mock).toBe(true);
  });
});

describe('POST /api/billing/portal', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/billing/portal', {
      method: 'POST',
    });

    const env = createMockEnv();
    const res = await onPortalPost({ request, env });
    expect(res.status).toBe(401);
  });

  it('モックモードでportal_urlを返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const env = createMockEnv({
      NURIEL_DB: createMockDB({ users: [user], sessions: [session] }),
      STRIPE_SECRET_KEY: '',
    });

    const request = new Request('https://example.com/api/billing/portal', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onPortalPost({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.portal_url).toContain('mock_portal');
  });
});

describe('POST /api/billing/webhook', () => {
  it('モックモードでreceivedを返す', async () => {
    const request = new Request('https://example.com/api/billing/webhook', {
      method: 'POST',
      body: '{}',
    });

    const env = createMockEnv({ STRIPE_SECRET_KEY: '' });
    const res = await onWebhookPost({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.received).toBe(true);
  });

  it('STRIPE_WEBHOOK_SECRETが未設定で500を返す（非モック時）', async () => {
    const request = new Request('https://example.com/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=abc' },
      body: '{"type":"test"}',
    });

    const env = createMockEnv({
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: '',
    });

    const res = await onWebhookPost({ request, env });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/billing/stripe-key', () => {
  it('公開鍵が未設定の場合は500を返す', async () => {
    const request = new Request('https://example.com/api/billing/stripe-key');
    const env = { STRIPE_PUBLISHABLE_KEY: '' };

    const res = await onStripeKeyGet({ request, env });
    expect(res.status).toBe(500);
  });

  it('公開鍵が設定されている場合は返す', async () => {
    const request = new Request('https://example.com/api/billing/stripe-key');
    const env = { STRIPE_PUBLISHABLE_KEY: 'pk_test_12345' };

    const res = await onStripeKeyGet({ request, env });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.publishableKey).toBe('pk_test_12345');
  });
});
