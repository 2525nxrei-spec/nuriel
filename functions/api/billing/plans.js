/**
 * GET /api/billing/plans -- プラン一覧取得（認証不要）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const { results } = await env.NURIEL_DB
      .prepare('SELECT id, name, price_monthly, price_yearly, monthly_limit, styles_allowed, gallery_limit FROM plans ORDER BY price_monthly ASC')
      .all();

    // styles_allowedをJSON配列にパース
    const plans = results.map(plan => ({
      id: plan.id,
      name: plan.name,
      price_monthly: plan.price_monthly,
      price_yearly: plan.price_yearly,
      monthly_limit: plan.monthly_limit,
      styles_allowed: JSON.parse(plan.styles_allowed || '[]'),
      gallery_limit: plan.gallery_limit,
    }));

    return jsonResponse({ plans });
  } catch (err) {
    console.error('プラン一覧取得エラー:', err.message);
    return errorResponse('プラン情報の取得に失敗しました', 500);
  }
}
