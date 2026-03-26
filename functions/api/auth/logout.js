/**
 * POST /api/auth/logout -- ログアウト（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // 現在のセッションを削除
  await env.NURIEL_DB
    .prepare('DELETE FROM sessions WHERE id = ?')
    .bind(user.sessionId)
    .run();

  return jsonResponse({ message: 'ログアウトしました' });
}
