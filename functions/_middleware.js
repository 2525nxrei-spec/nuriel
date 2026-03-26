/**
 * Pages Functions グローバルミドルウェア
 * CORS + セキュリティヘッダー + レート制限
 */

/** 許可するオリジン */
const ALLOWED_ORIGINS = [
  'https://photo-nurie.com',
  'http://localhost:8788',
  'http://localhost:3000',
];

/**
 * CORSヘッダーを生成
 */
function getCorsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  // 本番ドメインとlocalhostのみ許可（.pages.devは自サイトのプレビューのみ）
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.nuriel[a-z0-9-]*\.pages\.dev$/.test(origin);
  const allowedOrigin = isAllowed ? origin : 'https://photo-nurie.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

/** セキュリティヘッダー */
function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** インメモリレート制限（IP+パスベース） */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX_AUTH = 10;
const RATE_LIMIT_MAX_GENERAL = 120;

function isRateLimited(ip, pathname) {
  const now = Date.now();
  const isAuthEndpoint = pathname.includes('/api/auth/login') || pathname.includes('/api/auth/register');
  const limit = isAuthEndpoint ? RATE_LIMIT_MAX_AUTH : RATE_LIMIT_MAX_GENERAL;
  const key = isAuthEndpoint ? `auth:${ip}` : `gen:${ip}`;

  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

function cleanupRateLimit() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(key);
    }
  }
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // OPTIONSプリフライトへの応答
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...getCorsHeaders(request), ...getSecurityHeaders() },
    });
  }

  // レート制限チェック（Webhookは除外）
  if (!url.pathname.includes('/api/billing/webhook')) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(clientIP, url.pathname)) {
      const errorBody = JSON.stringify({ ok: false, error: 'リクエストが多すぎます。しばらく待ってからお試しください。' });
      return new Response(errorBody, {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...getCorsHeaders(request), ...getSecurityHeaders() },
      });
    }
  }

  // 定期クリーンアップ
  if (Math.random() < 0.01) cleanupRateLimit();

  try {
    // 次のハンドラを実行
    const response = await context.next();

    // レスポンスにCORS+セキュリティヘッダーを付与
    const newResponse = new Response(response.body, response);
    const corsHeaders = getCorsHeaders(request);
    const secHeaders = getSecurityHeaders();
    for (const [key, value] of Object.entries({ ...corsHeaders, ...secHeaders })) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  } catch (err) {
    console.error('未処理エラー:', err.message);
    const errorBody = JSON.stringify({ ok: false, error: 'サーバー内部エラーが発生しました' });
    return new Response(errorBody, {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...getCorsHeaders(request), ...getSecurityHeaders() },
    });
  }
}
