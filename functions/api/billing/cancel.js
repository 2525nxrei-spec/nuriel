/**
 * POST /api/billing/cancel -- サブスクリプション解約（認証必須）
 * 即時解約ではなく、現在の請求期間終了時に解約（cancel_at_period_end）
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
    // --- モックモード ---
    if (isMockMode(env)) {
      console.log(`[モック] サブスクリプション解約: user=${user.id}`);
      return jsonResponse({
        canceled: true,
        mock: true,
        message: 'モックモード: 解約処理が完了しました',
      });
    }

    // --- Stripe顧客IDの確認 ---
    if (!user.stripe_customer_id) {
      return errorResponse('Stripe顧客情報が見つかりません。まずプランに登録してください。', 400);
    }

    // --- サブスクリプションIDの取得 ---
    let subscriptionId = user.stripe_subscription_id;

    // DBにない場合はStripe APIから取得
    if (!subscriptionId) {
      const subsData = await stripeRequest(
        `subscriptions?customer=${user.stripe_customer_id}&status=active&limit=1`,
        'GET',
        null,
        env.STRIPE_SECRET_KEY
      );

      if (!subsData.data || subsData.data.length === 0) {
        return errorResponse('アクティブなサブスクリプションが見つかりません', 404);
      }

      subscriptionId = subsData.data[0].id;
    }

    // --- サブスクリプションを期間終了時に解約 ---
    const subscription = await stripeRequest(
      `subscriptions/${subscriptionId}`,
      'POST',
      { cancel_at_period_end: 'true' },
      env.STRIPE_SECRET_KEY
    );

    // --- DBのフラグを更新 ---
    await env.NURIEL_DB
      .prepare('UPDATE users SET cancel_at_period_end = 1, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(user.id)
      .run();

    console.log(`サブスクリプション解約: user=${user.id}, subscription=${subscriptionId}`);

    return jsonResponse({
      canceled: true,
      cancel_at_period_end: true,
      current_period_end: subscription.current_period_end,
      message: '解約が完了しました。現在の請求期間の終了までサービスをご利用いただけます。',
    });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error('Stripe解約エラー:', err.message, err.type, err.code);
      return errorResponse('サブスクリプションの解約に失敗しました', 502);
    }
    console.error('解約エラー:', err.message, err.stack);
    return errorResponse('解約処理中にエラーが発生しました', 500);
  }
}
