/**
 * POST /api/auth/login -- ログイン
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { generateSessionToken, verifyPassword } from '../../lib/crypto.js';

/** セッション有効期限: 30日 */
const SESSION_EXPIRY_DAYS = 30;

export async function onRequestPost(context) {
  const { request, env } = context;

  // D1バインドの存在確認
  if (!env.NURIEL_DB) {
    console.error('NURIEL_DB バインドが設定されていません。Cloudflare Pages の Settings > Functions > D1 database bindings で NURIEL_DB を追加してください。');
    return errorResponse('データベース接続エラー: NURIEL_DB バインドが未設定です', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('リクエストボディが不正です', 400);
  }

  const { email, password } = body;

  if (!email || !password) {
    return errorResponse('メールアドレスとパスワードは必須です', 400);
  }

  try {
    // ユーザー検索
    const user = await env.NURIEL_DB
      .prepare('SELECT id, email, password_hash, display_name, plan FROM users WHERE email = ?')
      .bind(email.toLowerCase().trim())
      .first();

    if (!user) {
      return errorResponse('メールアドレスまたはパスワードが正しくありません', 401);
    }

    // パスワード検証
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return errorResponse('メールアドレスまたはパスワードが正しくありません', 401);
    }

    // セッション発行
    const sessionId = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    await env.NURIEL_DB
      .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(sessionId, user.id, expiresAt, now)
      .run();

    return jsonResponse({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        plan: user.plan,
      },
      token: sessionId,
    });
  } catch (err) {
    console.error('ログインエラー:', err.message, err.stack);
    return errorResponse('ログイン処理中にエラーが発生しました', 500);
  }
}
