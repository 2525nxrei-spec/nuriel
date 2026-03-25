/**
 * 認証ハンドラ
 * ユーザー登録・ログイン・ログアウト・ユーザー情報取得
 */

import { jsonResponse, errorResponse } from '../utils/response.js';
import { generateId, generateSessionToken, hashPassword, verifyPassword } from '../utils/crypto.js';

/** セッション有効期限: 30日 */
const SESSION_EXPIRY_DAYS = 30;

/**
 * POST /api/auth/register — ユーザー新規登録
 */
export async function handleRegister(request, env) {
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
  const session = await createSession(env, userId);

  return jsonResponse({
    user: {
      id: userId,
      email: email.toLowerCase().trim(),
      displayName: displayName || null,
      plan: 'free',
    },
    token: session.id,
  }, 201);
}

/**
 * POST /api/auth/login — ログイン
 */
export async function handleLogin(request, env) {
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
  const session = await createSession(env, user.id);

  return jsonResponse({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      plan: user.plan,
    },
    token: session.id,
  });
}

/**
 * POST /api/auth/logout — ログアウト
 */
export async function handleLogout(request, env, user) {
  // 現在のセッションを削除
  await env.NURIEL_DB
    .prepare('DELETE FROM sessions WHERE id = ?')
    .bind(user.sessionId)
    .run();

  return jsonResponse({ message: 'ログアウトしました' });
}

/**
 * GET /api/auth/me — 現在のユーザー情報
 */
export async function handleMe(request, env, user) {
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

// --- 内部ヘルパー ---

/**
 * セッションを作成してDBに保存
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<{id: string, expiresAt: string}>}
 */
async function createSession(env, userId) {
  const sessionId = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  await env.NURIEL_DB
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(sessionId, userId, expiresAt, now)
    .run();

  return { id: sessionId, expiresAt };
}

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

/**
 * 次回の月次リセット日を計算（翌月1日 00:00 JST）
 * @returns {string} ISO8601形式
 */
function getNextMonthlyResetDate() {
  const now = new Date();
  // 翌月1日 00:00 UTC（日本時間ベースの場合は+9h調整が必要だが、UTCで統一）
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return next.toISOString();
}
