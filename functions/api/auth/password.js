/**
 * PUT /api/auth/password — パスワード変更
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { verifyPassword, hashPassword } from '../../lib/crypto.js';

export async function onRequestPut(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) return errorResponse('認証が必要です', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('リクエストボディが不正です', 400);
  }

  const { current_password, new_password } = body;
  if (!current_password || !new_password) {
    return errorResponse('現在のパスワードと新しいパスワードは必須です', 400);
  }

  if (new_password.length < 8) {
    return errorResponse('新しいパスワードは8文字以上で設定してください', 400);
  }

  if (!/[a-zA-Z]/.test(new_password) || !/[0-9]/.test(new_password)) {
    return errorResponse('パスワードは英字と数字の両方を含めてください', 400);
  }

  // 現在のパスワードを検証
  const dbUser = await env.NURIEL_DB
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first();

  if (!dbUser) return errorResponse('ユーザーが見つかりません', 404);

  const isValid = await verifyPassword(current_password, dbUser.password_hash);
  if (!isValid) {
    return errorResponse('現在のパスワードが正しくありません', 401);
  }

  // 新しいパスワードでハッシュ生成
  const newHash = await hashPassword(new_password);

  await env.NURIEL_DB
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newHash, user.id)
    .run();

  return jsonResponse({ message: 'パスワードを変更しました' });
}
