/**
 * Pages Functions グローバルミドルウェア
 * 全APIリクエストにCORSヘッダーを付与し、OPTIONSプリフライトに応答
 */

/**
 * 許可するCORSヘッダーを生成
 * @param {Object} env - 環境変数（FRONTEND_URLを含む）
 * @returns {Object} CORSヘッダー
 */
function getCorsHeaders(env, request) {
  // リクエストのOriginを取得
  const origin = request?.headers?.get('Origin') || '';
  // 本番ドメインとPages プレビュードメインを許可
  const allowedOrigins = [
    'https://photo-nurie.com',
    'http://localhost:8788',
    'http://localhost:3000',
  ];
  // Pages プレビューURL（*.nuriel-xxx.pages.dev）も許可
  const isAllowed = allowedOrigins.includes(origin) || origin.endsWith('.pages.dev');
  const allowedOrigin = isAllowed ? origin : 'https://photo-nurie.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  // OPTIONSプリフライトへの応答
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(env, request),
    });
  }

  try {
    // 次のハンドラを実行
    const response = await context.next();

    // レスポンスにCORSヘッダーを付与
    const newResponse = new Response(response.body, response);
    const corsHeaders = getCorsHeaders(env, request);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  } catch (err) {
    console.error('未処理エラー:', err.message, err.stack);
    const errorBody = JSON.stringify({ ok: false, error: 'サーバー内部エラーが発生しました' });
    const errResp = new Response(errorBody, {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const corsHeaders = getCorsHeaders(env, request);
    for (const [key, value] of Object.entries(corsHeaders)) {
      errResp.headers.set(key, value);
    }
    return errResp;
  }
}
