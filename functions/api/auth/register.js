/**
 * POST /api/auth/register -- ユーザー新規登録
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { generateId, generateSessionToken, hashPassword } from '../../lib/crypto.js';

/** セッション有効期限: 30日 */
const SESSION_EXPIRY_DAYS = 30;

/**
 * 次回の月次リセット日を計算（翌月1日 00:00 UTC）
 * @returns {string} ISO8601形式
 */
function getNextMonthlyResetDate() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return next.toISOString();
}

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

  const { email, password, displayName } = body;

  // バリデーション
  if (!email || !password) {
    return errorResponse('メールアドレスとパスワードは必須です', 400);
  }
  if (typeof email !== 'string' || !email.includes('@')) {
    return errorResponse('有効なメールアドレスを入力してください', 400);
  }
  if (typeof password !== 'string' || password.length < 8) {
    return errorResponse('パスワードは8文字以上で設定してください', 400);
  }

  try {
    // メールアドレス重複チェック
    const existing = await env.NURIEL_DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email.toLowerCase().trim())
      .first();

    if (existing) {
      return errorResponse('このメールアドレスは既に登録されています', 409);
    }

    // ユーザー作成
    const userId = generateId();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    const resetDate = getNextMonthlyResetDate();

    await env.NURIEL_DB
      .prepare(`
        INSERT INTO users (id, email, password_hash, display_name, plan, monthly_generation_count, monthly_reset_date, gallery_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'free', 0, ?, 0, ?, ?)
      `)
      .bind(userId, email.toLowerCase().trim(), passwordHash, displayName || null, resetDate, now, now)
      .run();

    // セッション発行
    const sessionId = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await env.NURIEL_DB
      .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(sessionId, userId, expiresAt, now)
      .run();

    return jsonResponse({
      user: {
        id: userId,
        email: email.toLowerCase().trim(),
        displayName: displayName || null,
        plan: 'free',
      },
      token: sessionId,
    }, 201);
  } catch (err) {
    console.error('ユーザー登録エラー:', err.message, err.stack);
    return errorResponse(`登録処理でエラーが発生しました: ${err.message}`, 500);
  }
}
