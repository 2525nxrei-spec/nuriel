/**
 * DELETE /api/gallery/:id -- ギャラリーアイテム削除（認証必須）
 * R2上の画像・PDFも同時に削除
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const generationId = params.id;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // 対象レコードを取得（所有者チェック含む）
  const gen = await env.NURIEL_DB
    .prepare(`
      SELECT id, original_image_key, line_art_image_key, pdf_key
      FROM generations WHERE id = ? AND user_id = ?
    `)
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('指定されたアイテムが見つかりません', 404);
  }

  // R2から関連ファイルを削除
  const deletePromises = [];
  if (gen.original_image_key) {
    deletePromises.push(env.NURIEL_STORAGE.delete(gen.original_image_key));
  }
  if (gen.line_art_image_key) {
    deletePromises.push(env.NURIEL_STORAGE.delete(gen.line_art_image_key));
  }
  if (gen.pdf_key) {
    deletePromises.push(env.NURIEL_STORAGE.delete(gen.pdf_key));
  }
  await Promise.all(deletePromises);

  // DBレコードを削除
  await env.NURIEL_DB
    .prepare('DELETE FROM generations WHERE id = ?')
    .bind(generationId)
    .run();

  // ユーザーのギャラリーカウントを更新
  await env.NURIEL_DB
    .prepare('UPDATE users SET gallery_count = MAX(0, gallery_count - 1), updated_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), user.id)
    .run();

  return jsonResponse({ message: '削除しました' });
}
