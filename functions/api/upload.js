/**
 * POST /api/upload -- 写真アップロード（認証必須）
 * ペット写真をR2ストレージに保存
 */

import { jsonResponse, errorResponse } from '../lib/response.js';
import { generateId } from '../lib/crypto.js';
import { authenticate } from '../lib/auth.js';

/** 許可する画像MIMEタイプ */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/** アップロード上限: 10MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * MIMEタイプから拡張子を返す
 * @param {string} mime
 * @returns {string}
 */
function getExtension(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
  };
  return map[mime] || 'bin';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // Content-Typeチェック
  const contentType = request.headers.get('Content-Type') || '';

  let imageData;
  let mimeType;
  let fileName;

  if (contentType.includes('multipart/form-data')) {
    // multipart/form-data として処理
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file || !(file instanceof File)) {
      return errorResponse('画像ファイル（imageフィールド）が必要です', 400);
    }

    // MIMEタイプ検証
    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorResponse(
        `対応していない画像形式です。JPEG, PNG, WebP, HEICのみ対応しています。（受信: ${file.type}）`,
        400
      );
    }

    // ファイルサイズ検証
    if (file.size > MAX_FILE_SIZE) {
      return errorResponse('ファイルサイズは10MB以下にしてください', 400);
    }

    imageData = await file.arrayBuffer();
    mimeType = file.type;
    fileName = file.name || 'upload';
  } else {
    // バイナリボディとして処理（APIクライアント向け）
    mimeType = contentType.split(';')[0].trim();
    if (!ALLOWED_TYPES.includes(mimeType)) {
      return errorResponse(
        'Content-Typeが画像形式（image/jpeg, image/png, image/webp, image/heic）ではありません',
        400
      );
    }

    imageData = await request.arrayBuffer();
    if (imageData.byteLength > MAX_FILE_SIZE) {
      return errorResponse('ファイルサイズは10MB以下にしてください', 400);
    }
    fileName = 'upload';
  }

  // R2キーを生成（ユーザーID/日付/ユニークID.拡張子）
  const fileId = generateId();
  const ext = getExtension(mimeType);
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  const r2Key = `originals/${user.id}/${datePrefix}/${fileId}.${ext}`;

  // R2にアップロード
  await env.NURIEL_STORAGE.put(r2Key, imageData, {
    httpMetadata: {
      contentType: mimeType,
    },
    customMetadata: {
      userId: user.id,
      originalName: fileName,
      uploadedAt: new Date().toISOString(),
    },
  });

  return jsonResponse({
    imageKey: r2Key,
    fileId,
    size: imageData.byteLength,
    mimeType,
  }, 201);
}
