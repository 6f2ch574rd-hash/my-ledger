/* 我的記帳本 — 離線快取＋推播通知（v19：黑白圖示、推播提醒） */
const CACHE = 'my-ledger-v19';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-dark-180.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 'ledger-nag' 存的是推播要用的狀態，不能被清掉
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'ledger-nag').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 收到頁面「立即更新」指令時，讓新 SW 立刻接管
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;   // 推播伺服器等外部請求直接走網路
  // App 殼：網路優先（離線才用快取）→ 每次開啟都拿到最新版
  if (req.mode === 'navigate' || req.url.endsWith('.html') || req.url.endsWith('/')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match('./index.html');
        return fetch(req)
          .then(res => {
            const path = new URL(req.url).pathname;
            const isMain = path.endsWith('/') || path.endsWith('/index.html');
            if (res && res.status === 200 && isMain) cache.put('./index.html', res.clone());
            return res;
          })
          .catch(() => cached);
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

/* ---------------- 推播通知 ----------------
   伺服器送來的是空推播；通知文字在這裡依「幾天沒記帳」和煩人程度決定。
   iPhone 規定每一則推播都要顯示通知，所以一定會跳一則。 */
const MSG = [
  ['今天的帳還沒記，花 10 秒就好。', '今天花了什麼？趁還記得快記下來。', '記帳時間到了，來吧。'],
  ['還沒記？錢不會自己告訴你它去了哪裡。', '我又來了。今天的帳呢？', '再拖下去，就想不起來午餐花了多少了。'],
  ['昨天沒記，今天也還沒。要我一直問下去嗎？', '已經兩天沒記帳了，你的錢包很想念你。', '今天不記，明天就要補三天份。'],
  ['{d} 天沒記帳了。我會越來越煩，你知道的。', '{d} 天了，你的帳本開始長灰塵了。', '連續 {d} 天沒記。記一筆，我就閉嘴。'],
  ['{d} 天沒記帳。我不會放棄的。', '{d} 天了，我還在這裡，而且會一直在。', '記一筆，我就消失。不記，我就天天來。']
];
function localDate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); }
async function nagText(push) {
  let st = {};
  try { const r = await caches.open('ledger-nag').then(c => c.match('./__nagstate')); if (r) st = await r.json(); } catch (e) {}
  let data = {};
  try { data = push && push.data ? push.data.json() : {}; } catch (e) {}
  if (data && data.title) return { title: data.title, body: data.body || '' };
  const today = localDate(new Date()), last = st.last || today;
  const gap = Math.max(0, daysBetween(last, today));            // 上次記帳到今天隔幾天
  const missed = Math.max(0, gap - 1);                           // 整天沒記的天數
  const h = new Date().getHours();
  const tier = missed >= 4 ? 4 : missed >= 2 ? 3 : missed === 1 ? 2 : h >= 22 ? 1 : 0;
  const list = MSG[tier], line = list[Math.floor(Date.now() / 60000) % list.length].replace('{d}', gap);
  const body = gap >= 2 ? `上次記帳是 ${+last.slice(5, 7)}/${+last.slice(8, 10)}。點一下打開記帳本。` : '點一下打開記帳本，記一筆就不會再吵你。';
  return { title: line, body, gap };
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const t = await nagText(e);
    await self.registration.showNotification(t.title, {
      body: t.body,
      tag: 'ledger-nag',          // 同一時間只留最新的一則
      renotify: true,
      icon: './icons/icon-192.png',
      data: { url: './index.html?from=push' }
    });
    try { if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(Math.max(1, t.gap || 1)); } catch (err) {}
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.focus(); return; } catch (err) {} } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
