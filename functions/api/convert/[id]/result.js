/**
 * GET /api/convert/:id/result -- 変換結果取得（認証必須）
 */

import { jsonResponse, errorResponse } from '../../../lib/response.js';
import { authenticate } from '../../../lib/auth.js';
import { arrayBufferToBase64 } from '../../../lib/crypto.js';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const generationId = params.id;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  const gen = await env.NURIEL_DB
    .prepare(`
      SELECT id, status, original_image_key, line_art_image_key, pdf_key, style, created_at
      FROM generations WHERE id = ? AND user_id = ?
    `)
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('変換記録が見つかりません', 404);
  }

  if (gen.status !== 'completed') {
    return errorResponse(
      `変換がまだ完了していません（現在のステータス: ${gen.status}）`,
      400
    );
  }

  // 線画画像をR2から取得してBase64で返す
  let lineArtBase64 = null;
  if (gen.line_art_image_key) {
    const obj = await env.NURIEL_STORAGE.get(gen.line_art_image_key);
    if (obj) {
      const buffer = await obj.arrayBuffer();
      lineArtBase64 = arrayBufferToBase64(buffer);
    }
  }

  return jsonResponse({
    generationId: gen.id,
    status: gen.status,
    style: gen.style,
    lineArtImageKey: gen.line_art_image_key,
    lineArtBase64: lineArtBase64 ? `data:image/png;base64,${lineArtBase64}` : null,
    pdfKey: gen.pdf_key,
    pdfUrl: gen.pdf_key ? `/api/pdf/${gen.id}` : null,
    createdAt: gen.created_at,
  });
}
