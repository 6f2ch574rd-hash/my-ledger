/* 我的記帳本 — 離線快取 */
const CACHE = 'my-ledger-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // App 殼：快取優先，更新時背景更新
  if (req.mode === 'navigate' || req.url.endsWith('.html') || req.url.endsWith('/')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match('./index.html');
        const network = fetch(req).then(res => { if (res && res.status === 200) cache.put('./index.html', res.clone()); return res; }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // 其他同源靜態檔：快取優先，退回網路
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.status === 200 && new URL(req.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
