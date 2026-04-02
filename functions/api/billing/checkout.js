/**
 * POST /api/billing/checkout -- Checkoutセッション作成（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import {
  stripeRequest,
  StripeApiError,
  VALID_PLAN_IDS,
  VALID_BILLING_PERIODS,
  STRIPE_PRICE_IDS,
  isMockMode,
} from '../../lib/stripe.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  try {
    // --- リクエストバリデーション ---
    const body = await request.json();
    const { plan_id, billing_period } = body;

    if (!plan_id || !VALID_PLAN_IDS.includes(plan_id)) {
      return errorResponse('無効なプランIDです。otameshi または tappuri を指定してください。', 400);
    }

    if (!billing_period || !VALID_BILLING_PERIODS.includes(billing_period)) {
      return errorResponse('無効な請求期間です。monthly または yearly を指定してください。', 400);
    }

    // --- D1からプラン情報取得 ---
    const plan = await env.NURIEL_DB
      .prepare('SELECT * FROM plans WHERE id = ?')
      .bind(plan_id)
      .first();

    if (!plan) {
      return errorResponse('指定されたプランが見つかりません', 404);
    }

    // 対応するStripe Price IDを決定
    const periodKey = billing_period === 'monthly' ? 'monthly' : 'yearly';
    const priceId = (billing_period === 'monthly' ? plan.stripe_price_id_monthly : plan.stripe_price_id_yearly)
      || STRIPE_PRICE_IDS[plan_id]?.[periodKey]
      || null;

    if (!priceId) {
      return errorResponse('このプランの価格設定が見つかりません', 500);
    }

    // --- モックモード ---
    if (isMockMode(env)) {
      console.log(`[モック] Checkoutセッション作成: plan=${plan_id}, period=${billing_period}, user=${user.id}`);
      return jsonResponse({ clientSecret: 'mock_client_secret', mock: true });
    }

    // --- Stripe顧客の確認/作成 ---
    let stripeCustomerId = user.stripe_customer_id;

    if (!stripeCustomerId) {
      const customer = await stripeRequest('customers', 'POST', {
        email: user.email,
        name: user.display_name || user.email,
        metadata: {
          nuriel_user_id: user.id,
        },
      }, env.STRIPE_SECRET_KEY);

      stripeCustomerId = customer.id;

      await env.NURIEL_DB
        .prepare('UPDATE users SET stripe_customer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(stripeCustomerId, user.id)
        .run();
    }

    // --- Stripe Embedded Checkout Session作成 ---
    const frontendUrl = env.FRONTEND_URL || 'https://photo-nurie.com';

    // Embedded Checkout: ページ内埋め込み決済（リダイレクトなし）
    const session = await stripeRequest('checkout/sessions', 'POST', {
      mode: 'subscription',
      ui_mode: 'embedded',
      customer: stripeCustomerId,
      locale: 'ja',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      return_url: `${frontendUrl}/app.html?session_id={CHECKOUT_SESSION_ID}#plan`,
      metadata: {
        user_id: user.id,
        plan_id: plan_id,
      },
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan_id: plan_id,
        },
      },
    }, env.STRIPE_SECRET_KEY);

    console.log(`Checkoutセッション作成: session=${session.id}, plan=${plan_id}, user=${user.id}`);
    return jsonResponse({ clientSecret: session.client_secret });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error('Stripe Checkoutエラー:', err.message, err.type, err.code);
      return errorResponse('決済セッションの作成に失敗しました。しばらくしてからお試しください。', 502);
    }
    console.error('Checkoutエラー:', err.message, err.stack);
    return errorResponse('決済処理中にエラーが発生しました', 500);
  }
}
