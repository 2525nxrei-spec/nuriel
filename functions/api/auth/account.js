/**
 * DELETE /api/auth/account — アカウント削除（退会）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';
import { verifyPassword } from '../../lib/crypto.js';

export async function onRequestDelete(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) return errorResponse('認証が必要です', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('リクエストボディが不正です', 400);
  }

  const { password } = body;
  if (!password) return errorResponse('パスワードの入力が必要です', 400);

  // パスワード検証
  const dbUser = await env.NURIEL_DB
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first();

  if (!dbUser) return errorResponse('ユーザーが見つかりません', 404);

  const isValid = await verifyPassword(password, dbUser.password_hash);
  if (!isValid) {
    return errorResponse('パスワードが正しくありません', 401);
  }

  // R2からユーザーの全ファイルを削除
  try {
    const generations = await env.NURIEL_DB
      .prepare('SELECT original_image_key, line_art_image_key, pdf_key FROM generations WHERE user_id = ?')
      .bind(user.id)
      .all();

    if (generations.results && generations.results.length > 0) {
      const deletePromises = [];
      for (const gen of generations.results) {
        if (gen.original_image_key) deletePromises.push(env.NURIEL_STORAGE.delete(gen.original_image_key));
        if (gen.line_art_image_key) deletePromises.push(env.NURIEL_STORAGE.delete(gen.line_art_image_key));
        if (gen.pdf_key) deletePromises.push(env.NURIEL_STORAGE.delete(gen.pdf_key));
      }
      await Promise.all(deletePromises);
    }
  } catch (r2Err) {
    console.error('R2ファイル削除エラー（続行）:', r2Err.message);
  }

  // 関連データを削除
  try {
    await env.NURIEL_DB.batch([
      env.NURIEL_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.NURIEL_DB.prepare('DELETE FROM generations WHERE user_id = ?').bind(user.id),
      env.NURIEL_DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
  } catch {
    // テーブルがない場合はusersだけ削除
    await env.NURIEL_DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  }

  return jsonResponse({ message: 'アカウントを削除しました。ご利用ありがとうございました。' });
}
