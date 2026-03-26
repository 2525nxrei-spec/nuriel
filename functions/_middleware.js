/**
 * Pages Functions グローバルミドルウェア
 * 全APIリクエストにCORSヘッダーを付与し、OPTIONSプリフライトに応答
 */

/**
 * 許可するCORSヘッダーを生成
 * @param {Object} env - 環境変数（FRONTEND_URLを含む）
 * @returns {Object} CORSヘッダー
 */
function getCorsHeaders(env) {
  // Pages Functionsでは同一オリジンのため通常CORSは不要だが、
  // 開発環境や外部からのアクセスに備えて設定
  const allowedOrigin = env.FRONTEND_URL || '*';
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
      headers: getCorsHeaders(env),
    });
  }

  try {
    // 次のハンドラを実行
    const response = await context.next();

    // レスポンスにCORSヘッダーを付与
    const newResponse = new Response(response.body, response);
    const corsHeaders = getCorsHeaders(env);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  } catch (err) {
    console.error('未処理エラー:', err.message, err.stack);
    const errorBody = JSON.stringify({ ok: false, error: 'サーバー内部エラーが発生しました' });
    const errorResponse = new Response(errorBody, {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const corsHeaders = getCorsHeaders(env);
    for (const [key, value] of Object.entries(corsHeaders)) {
      errorResponse.headers.set(key, value);
    }
    return errorResponse;
  }
}
