/**
 * ギャラリーハンドラ
 * 生成済み線画の一覧表示と削除
 */

import { jsonResponse, errorResponse } from '../utils/response.js';

/**
 * GET /api/gallery — ギャラリー一覧
 * クエリパラメータ: page(デフォルト1), limit(デフォルト20, 最大50)
 */
export async function handleGalleryList(request, env, user) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = (page - 1) * limit;

  // 完了済み生成のみをギャラリーとして返す
  const items = await env.NURIEL_DB
    .prepare(`
      SELECT id, original_image_key, line_art_image_key, pdf_key, style, created_at
      FROM generations
      WHERE user_id = ? AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(user.id, limit, offset)
    .all();

  // 総件数を取得（ページネーション用）
  const countResult = await env.NURIEL_DB
    .prepare("SELECT COUNT(*) as total FROM generations WHERE user_id = ? AND status = 'completed'")
    .bind(user.id)
    .first();

  const total = countResult?.total || 0;

  return jsonResponse({
    items: items.results.map(item => ({
      id: item.id,
      style: item.style,
      hasLineArt: !!item.line_art_image_key,
      hasPdf: !!item.pdf_key,
      lineArtUrl: item.line_art_image_key ? `/api/convert/${item.id}/result` : null,
      pdfUrl: item.pdf_key ? `/api/pdf/${item.id}` : null,
      createdAt: item.created_at,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

/**
 * DELETE /api/gallery/:id — ギャラリーアイテム削除
 * R2上の画像・PDFも同時に削除
 */
export async function handleGalleryDelete(request, env, user, generationId) {
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
