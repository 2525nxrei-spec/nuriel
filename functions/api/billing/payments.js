/**
 * GET /api/billing/payments — 支払い履歴取得（認証必須）
 * StripeのInvoice APIから支払い済みインボイスを取得して返す
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { stripeRequest, isMockMode, STRIPE_PRICE_IDS } from '../../lib/stripe.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  try {
    // モックモード（STRIPE_SECRET_KEY未設定時）
    if (isMockMode(env)) {
      return jsonResponse({ payments: [], mock: true });
    }

    // DBからstripe_customer_idを取得
    const dbUser = await env.NURIEL_DB
      .prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
      .bind(user.id)
      .first();

    if (!dbUser?.stripe_customer_id) {
      return jsonResponse({ payments: [] });
    }

    // Stripe APIから支払い履歴を取得（最新20件）
    const invoicesData = await stripeRequest(
      `invoices?customer=${dbUser.stripe_customer_id}&limit=20&status=paid`,
      'GET',
      null,
      env.STRIPE_SECRET_KEY
    );

    const invoices = invoicesData.data || [];

    // プラン名の日本語マッピング
    const planNameMap = {
      otameshi: 'おためしプラン',
      tappuri: 'たっぷりプラン',
    };

    // フロントエンドが期待する形式に変換
    const payments = invoices.map((invoice) => {
      const lineItem = invoice.lines?.data?.[0];
      const priceId = lineItem?.price?.id || '';

      // Price IDからプラン名を判定（定数のPrice IDとマッチング）
      let planKey = '';
      for (const [plan, prices] of Object.entries(STRIPE_PRICE_IDS)) {
        if (priceId === prices.monthly || priceId === prices.yearly) {
          planKey = plan;
          break;
        }
      }

      return {
        date: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
        planName: planNameMap[planKey] || planKey,
        amount: invoice.amount_paid || 0,
        status: invoice.status === 'paid' ? 'succeeded' : invoice.status,
        invoiceId: invoice.id,
        invoicePdf: invoice.invoice_pdf || null,
      };
    });

    return jsonResponse({ payments });
  } catch (err) {
    console.error('支払い履歴取得エラー:', err.message, err.stack);
    return errorResponse('支払い履歴の取得に失敗しました', 500);
  }
}
