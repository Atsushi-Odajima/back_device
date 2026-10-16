// 返却デスク（仮称）Service Worker
// アプリシェル（HTML・ビルド済みJS/CSS・アイコン）だけをキャッシュする。
// 業務API・写真・署名URL・CSV出力・同梱サンプルCSVはキャッシュしない。
// 完全オフライン動作は提供しない（業務保存・写真送信はオンライン必須）。
const CACHE = 'return-desk-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase 等の外部通信は扱わない

  // 画面遷移：ネットワーク優先、失敗時のみキャッシュ済みシェル
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // ハッシュ付きのビルド成果物（/assets/*.js|css）とアイコンのみキャッシュ優先
  const isShellAsset = /^\/assets\/[^/]+\.(js|css)$/.test(url.pathname) || url.pathname.startsWith('/icons/');
  if (!isShellAsset) return;
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        }),
    ),
  );
});
