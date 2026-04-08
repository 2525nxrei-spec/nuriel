/**
 * GET /api/auth/me -- 現在のユーザー情報（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { getNextMonthlyResetDate } from '../../lib/crypto.js';

/**
 * 月次生成カウントのリセットが必要か確認し、必要ならリセットする
 * @param {Object} env
 * @param {Object} user
 */
async function checkAndResetMonthlyCount(env, user) {
  if (!user.monthly_reset_date) return;

  const now = new Date();
  const resetDate = new Date(user.monthly_reset_date);

  if (now >= resetDate) {
    const nextReset = getNextMonthlyResetDate();
    await env.NURIEL_DB
      .prepare('UPDATE users SET monthly_generation_count = 0, monthly_reset_date = ?, updated_at = ? WHERE id = ?')
      .bind(nextReset, now.toISOString(), user.id)
      .run();
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // 月次カウントのリセット判定
  await checkAndResetMonthlyCount(env, user);

  // 最新情報を再取得
  const freshUser = await env.NURIEL_DB
    .prepare(`
      SELECT id, email, display_name, plan,
             monthly_generation_count, monthly_reset_date,
             gallery_count, created_at
      FROM users WHERE id = ?
    `)
    .bind(user.id)
    .first();

  // プラン情報も付与
  const plan = await env.NURIEL_DB
    .prepare('SELECT monthly_limit, styles_allowed, gallery_limit FROM plans WHERE id = ?')
    .bind(freshUser.plan)
    .first();

  return jsonResponse({
    user: {
      id: freshUser.id,
      email: freshUser.email,
      displayName: freshUser.display_name,
      plan: freshUser.plan,
      monthlyGenerationCount: freshUser.monthly_generation_count,
      monthlyLimit: plan ? plan.monthly_limit : 1,
      stylesAllowed: plan ? JSON.parse(plan.styles_allowed) : ['simple'],
      galleryCount: freshUser.gallery_count,
      galleryLimit: plan ? plan.gallery_limit : 3,
      createdAt: freshUser.created_at,
    },
  });
}
