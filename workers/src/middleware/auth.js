/**
 * 認証ミドルウェア
 * Authorizationヘッダーからセッショントークンを検証し、ユーザー情報を返す
 */

/**
 * リクエストからユーザーを認証する
 * 認証成功時はユーザーオブジェクト、失敗時はnullを返す
 *
 * @param {Request} request
 * @param {Object} env - 環境変数（NURIEL_DBを含む）
 * @returns {Promise<Object|null>} ユーザーオブジェクト or null
 */
export async function authenticate(request, env) {
  try {
    // Authorizationヘッダーからトークン取得
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.slice(7); // "Bearer " の後ろ
    if (!token) {
      return null;
    }

    // セッションテーブルからトークンを検索
    const session = await env.NURIEL_DB
      .prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?')
      .bind(token)
      .first();

    if (!session) {
      return null;
    }

    // 有効期限チェック
    const now = new Date().toISOString();
    if (session.expires_at < now) {
      // 期限切れセッションを削除
      await env.NURIEL_DB
        .prepare('DELETE FROM sessions WHERE id = ?')
        .bind(token)
        .run();
      return null;
    }

    // ユーザー情報を取得
    const user = await env.NURIEL_DB
      .prepare(`
        SELECT id, email, display_name, plan,
               stripe_customer_id, stripe_subscription_id,
               monthly_generation_count, monthly_reset_date,
               gallery_count, created_at
        FROM users WHERE id = ?
      `)
      .bind(session.user_id)
      .first();

    if (!user) {
      return null;
    }

    // セッションIDもユーザーオブジェクトに付与（ログアウト時に使用）
    user.sessionId = session.id;

    return user;
  } catch (err) {
    console.error('認証エラー:', err.message);
    return null;
  }
}
