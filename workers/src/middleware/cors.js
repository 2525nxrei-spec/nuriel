/**
 * CORSミドルウェア
 * フロントエンド（Cloudflare Pages）からのクロスオリジンリクエストを許可
 */

/**
 * 許可するCORSヘッダーを生成
 * @param {Object} env - 環境変数（FRONTEND_URLを含む）
 * @returns {Object} CORSヘッダー
 */
function getCorsHeaders(env) {
  const allowedOrigin = env.FRONTEND_URL || '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400', // プリフライト結果を24時間キャッシュ
  };
}

/**
 * OPTIONSプリフライトリクエストへの応答
 * @param {Request} request
 * @param {Object} env
 * @returns {Response}
 */
export function handleCors(request, env) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(env),
  });
}

/**
 * 既存レスポンスにCORSヘッダーを付与
 * @param {Response} response
 * @param {Object} env
 * @returns {Response}
 */
export function addCorsHeaders(response, env) {
  const newResponse = new Response(response.body, response);
  const corsHeaders = getCorsHeaders(env);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
