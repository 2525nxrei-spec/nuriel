/**
 * GET /api/gallery -- ギャラリー一覧（認証必須）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

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
