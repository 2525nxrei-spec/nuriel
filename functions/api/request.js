/**
 * POST /api/request -- ユーザーリクエスト受付（認証不要）
 * D1のrequestsテーブルに保存
 */

import { jsonResponse, errorResponse } from '../lib/response.js';

/* 許可するカテゴリ一覧 */
const VALID_CATEGORIES = ['機能リクエスト', 'バグ報告', 'その他'];

/* 内容の最大文字数 */
const MAX_CONTENT_LENGTH = 5000;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { name, email, category, content } = body;

    // --- バリデーション ---
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return errorResponse('カテゴリを正しく選択してください。', 400);
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return errorResponse('内容を入力してください。', 400);
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return errorResponse(`内容は${MAX_CONTENT_LENGTH}文字以内で入力してください。`, 400);
    }

    // メールアドレスの簡易バリデーション（入力がある場合のみ）
    if (email && typeof email === 'string' && email.trim().length > 0) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email.trim())) {
        return errorResponse('メールアドレスの形式が正しくありません。', 400);
      }
    }

    // --- D1に保存 ---
    const id = crypto.randomUUID();
    await env.NURIEL_DB
      .prepare('INSERT INTO requests (id, name, email, category, content) VALUES (?, ?, ?, ?, ?)')
      .bind(
        id,
        name ? name.trim().slice(0, 100) : null,
        email ? email.trim().slice(0, 254) : null,
        category,
        content.trim().slice(0, MAX_CONTENT_LENGTH)
      )
      .run();

    console.log(`リクエスト受信: id=${id}, category=${category}`);
    return jsonResponse({ message: 'リクエストを受け付けました' }, 201);
  } catch (err) {
    console.error('リクエスト保存エラー:', err.message, err.stack);
    return errorResponse('リクエストの保存中にエラーが発生しました。', 500);
  }
}
