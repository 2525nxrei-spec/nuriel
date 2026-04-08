/**
 * ヌリエル Service Worker
 * - 全リクエスト: Network First（常に最新を取得、オフライン時のみキャッシュ）
 * - オフライン時: フォールバック表示
 */

const CACHE_NAME = 'nuriel-v7';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/app.css',
  '/js/app.js',
  '/manifest.json'
];

/**
 * インストール: 静的アセットをキャッシュ（オフライン用）
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

/**
 * アクティベート: 古いキャッシュを全削除
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
  self.clients.claim();
});

/**
 * フェッチ: 全リクエストNetwork First
 * ネットワーク優先で常に最新を返す。オフライン時のみキャッシュから返す。
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // APIリクエストとapp.htmlはキャッシュしない（常にネットワーク直接）
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/app.html') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return offlineFallback();
      })
  );
});

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
      font-family: "Zen Maru Gothic", system-ui, "Hiragino Kaku Gothic ProN", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #FFFAF6;
      color: #3D3330;
      padding: 2rem;
      text-align: center;
    }
    .offline-icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #7A6B66; opacity: 0.7; }
    button {
      margin-top: 1.5rem;
      padding: 0.75rem 2rem;
      background: #D2735C;
      color: #fff;
      border: none;
      border-radius: 12px;
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
