/**
 * レスポンスユーティリティ
 * 統一されたJSON応答形式を提供
 */

/**
 * 成功レスポンスを生成
 * @param {Object} data - レスポンスデータ
 * @param {number} [status=200] - HTTPステータスコード
 * @returns {Response}
 */
export function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify({
      ok: true,
      ...data,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }
  );
}

/**
 * エラーレスポンスを生成
 * @param {string} message - エラーメッセージ
 * @param {number} [status=400] - HTTPステータスコード
 * @param {Object} [details=null] - 追加エラー詳細（バリデーションエラー等）
 * @returns {Response}
 */
export function errorResponse(message, status = 400, details = null) {
  const body = {
    ok: false,
    error: message,
  };
  if (details) {
    body.details = details;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
