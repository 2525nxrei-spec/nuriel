/**
 * ヌリエル Service Worker
 * - 静的アセット: Cache First
 * - API呼び出し: Network First
 * - オフライン時: フォールバック表示
 */

const CACHE_NAME = 'nuriel-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.html',
  '/css/style.css',
  '/css/app.css',
  '/js/app.js',
  '/manifest.json'
];

// API のベースパスパターン
const API_PATTERN = /\/api\//;

/**
 * インストール: 静的アセットをキャッシュ
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // 即座にアクティブ化
  self.skipWaiting();
});

/**
 * アクティベート: 古いキャッシュを削除
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  // 全クライアントを即座に制御下に置く
  self.clients.claim();
});

/**
 * フェッチ: リクエスト種別に応じた戦略
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // POST等はキャッシュ対象外
  if (request.method !== 'GET') return;

  // API リクエスト → Network First
  if (API_PATTERN.test(request.url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 静的アセット → Cache First
  event.respondWith(cacheFirst(request));
});

/**
 * Cache First 戦略
 * キャッシュにあればそれを返す。なければネットワーク取得してキャッシュ保存
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

/**
 * Network First 戦略
 * ネットワーク優先。失敗したらキャッシュから返す
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback();
  }
}

/**
 * オフライン時のフォールバックレスポンス
 */
function offlineFallback() {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>オフライン - ヌリエル</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #FFFAF6;
      color: #D2735C;
      padding: 2rem;
      text-align: center;
    }
    .offline-icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #B85A3D; opacity: 0.7; }
    button {
      margin-top: 1.5rem;
      padding: 0.75rem 2rem;
      background: #D2735C;
      color: #fff;
      border: none;
      border-radius: 9999px;
      font-size: 1rem;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div>
    <div class="offline-icon">📡</div>
    <h1>オフラインです</h1>
    <p>インターネット接続を確認してください</p>
    <button onclick="location.reload()">再接続を試す</button>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' }
  });
}
