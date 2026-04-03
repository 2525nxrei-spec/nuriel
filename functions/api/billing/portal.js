/**
 * POST /api/billing/portal -- Customer Portalセッション作成（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { stripeRequest, StripeApiError, isMockMode } from '../../lib/stripe.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  try {
    const frontendUrl = env.FRONTEND_URL || 'https://photo-nurie.com';

    // --- モックモード ---
    if (isMockMode(env)) {
      const mockPortalUrl = `${frontendUrl}/app.html?mock_portal=true#plan`;
      console.log(`[モック] Customer Portalセッション作成: user=${user.id}`);
      return jsonResponse({ portal_url: mockPortalUrl });
    }

    // --- Stripe顧客IDの確認 ---
    if (!user.stripe_customer_id) {
      return errorResponse('Stripe顧客情報が見つかりません。まずプランに登録してください。', 400);
    }

    // --- Customer Portalセッション作成 ---
    const session = await stripeRequest('billing_portal/sessions', 'POST', {
      customer: user.stripe_customer_id,
      return_url: `${frontendUrl}/app.html?from=portal`,
    }, env.STRIPE_SECRET_KEY);

    console.log(`Customer Portal作成: user=${user.id}, customer=${user.stripe_customer_id}`);
    return jsonResponse({ portal_url: session.url });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error('Stripe Portalエラー:', err.message);
      return errorResponse('カスタマーポータルの作成に失敗しました', 502);
    }
    console.error('Portalエラー:', err.message, err.stack);
    return errorResponse('カスタマーポータルの処理中にエラーが発生しました', 500);
  }
}
