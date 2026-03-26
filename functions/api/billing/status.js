/**
 * GET /api/billing/status -- 課金ステータス取得（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { stripeRequest, isMockMode } from '../../lib/stripe.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  try {
    // --- D1からプラン情報取得 ---
    const plan = await env.NURIEL_DB
      .prepare('SELECT * FROM plans WHERE id = ?')
      .bind(user.plan || 'free')
      .first();

    if (!plan) {
      return errorResponse('プラン情報の取得に失敗しました', 500);
    }

    // --- 基本レスポンス ---
    const status = {
      plan: {
        id: plan.id,
        name: plan.name,
        price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly,
        monthly_limit: plan.monthly_limit,
        styles_allowed: JSON.parse(plan.styles_allowed || '[]'),
        gallery_limit: plan.gallery_limit,
      },
      usage: {
        monthly_generation_count: user.monthly_generation_count || 0,
        monthly_limit: plan.monthly_limit,
        remaining: Math.max(0, plan.monthly_limit - (user.monthly_generation_count || 0)),
        gallery_count: user.gallery_count || 0,
        gallery_limit: plan.gallery_limit,
      },
      subscription: null,
    };

    // --- Stripeからサブスク情報を取得 ---
    if (!isMockMode(env) && user.stripe_subscription_id) {
      try {
        const subscription = await stripeRequest(
          `subscriptions/${user.stripe_subscription_id}`,
          'GET',
          null,
          env.STRIPE_SECRET_KEY
        );

        status.subscription = {
          id: subscription.id,
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: subscription.cancel_at_period_end,
          canceled_at: subscription.canceled_at,
          next_billing_date: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          billing_period: subscription.items?.data?.[0]?.price?.recurring?.interval || null,
        };
      } catch (stripeErr) {
        console.error('Stripeサブスク情報取得エラー:', stripeErr.message);
        status.subscription = { error: 'サブスクリプション情報の取得に失敗しました' };
      }
    }

    return jsonResponse(status);
  } catch (err) {
    console.error('課金ステータス取得エラー:', err.message, err.stack);
    return errorResponse('課金ステータスの取得に失敗しました', 500);
  }
}
