/**
 * GET /api/convert/:id/status -- 変換ステータス確認（認証必須）
 */

import { jsonResponse, errorResponse } from '../../../lib/response.js';
import { authenticate } from '../../../lib/auth.js';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const generationId = params.id;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  const gen = await env.NURIEL_DB
    .prepare('SELECT id, status, style, created_at FROM generations WHERE id = ? AND user_id = ?')
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('変換記録が見つかりません', 404);
  }

  return jsonResponse({
    generationId: gen.id,
    status: gen.status,
    style: gen.style,
    createdAt: gen.created_at,
  });
}
