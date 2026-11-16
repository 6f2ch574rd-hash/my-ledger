/* 我的記帳本 — 離線快取＋推播通知（v19：黑白圖示、推播提醒） */
const CACHE = 'my-ledger-v21';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-dark-180.png',
  './icons/icon-gray-180.png'
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
   伺服器送來的是空推播；收到後向伺服器問「這次為什麼推」（/why），再依煩人程度和幾天沒記帳決定文字。
   問不到的時候，就照手機上存的狀態發一則記帳提醒。iPhone 規定每一則推播都要顯示通知。 */
const NAG_TXT = {
  gentle: {      // 溫和：像朋友提醒，不會變兇，永遠只留一則
    0: ['今天花了什麼？趁還記得記一下 ☕', '記帳時間到囉，10 秒就好。', '今天的帳還空著，順手記一筆吧。'],
    1: ['昨天好像沒記到，今天一起補上吧。', '兩天的帳一起記，現在還想得起來。'],
    2: ['好幾天沒見了，回來記一筆吧。', '{d} 天沒記了，從今天開始也可以。']
  },
  nag: {         // 囉嗦：碎念的室友，會數今天第幾次
    first: ['記帳時間到了。先說好，等等我還會再來。', '今天的帳呢？我會每隔一陣子問一次喔。'],
    0: ['第 {n} 次了。你不累我都累了。', '我又來了（第 {n} 次）。記一筆我就走。', '第 {n} 次提醒。錢不會自己告訴你它去了哪裡。'],
    1: ['昨天沒記，今天也還沒。要我一直問下去嗎？', '今天不記，明天就要補三天份。'],
    2: ['{d} 天了。我每天準時來，你呢？', '我等你 {d} 天了，一筆也好。', '你說好要記帳的，{d} 天前。']
  },
  hell: {        // 地獄：討債的，兩天沒記就一則一則疊在鎖定畫面
    first: ['倒數開始。不記帳，我每 15 分鐘出現一次。'],
    0: ['第 {n} 次。我數到三。', '第 {n} 次。你的帳本在哭。', '第 {n} 次了，我還有很多次。', '第 {n} 次。我開始寫你的傳記：某天他忘了記帳……'],
    1: ['昨天放你一馬，今天不會。', '昨天的帳也還欠著，連本帶利。'],
    2: ['{d} 天沒記。我是不是哪裡做錯了？', '{d} 天了。你答應過我的。', '你不記，我就一則一則疊給你看。', '{d} 天，你的錢去哪了，你自己知道嗎？']
  }
};
const pick = (list, salt) => list[(Math.floor(Date.now() / 60000) + (salt || 0)) % list.length];
const fmt = n => 'NT$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const md = s => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
function localDate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); }
async function readState() {
  try { const r = await caches.open('ledger-nag').then(c => c.match('./__nagstate')); if (r) return await r.json(); } catch (e) {}
  return {};
}
async function fetchWhy(st) {
  if (!st.api || !st.id || !st.token) return null;
  try {
    const r = await fetch(st.api + '/why', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: st.id, token: st.token }) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.msgs) ? j.msgs : null;
  } catch (e) { return null; }
}
function nagNote(st, m) {
  const level = NAG_TXT[(m && m.level) || st.level] ? ((m && m.level) || st.level) : 'nag';
  const today = localDate(new Date());
  let last = st.last || (m && m.logged) || today;
  if (m && m.logged && m.logged > last) last = m.logged;
  const gap = Math.max(0, daysBetween(last, today)), missed = Math.max(0, gap - 1), n = (m && m.n) || 1;
  const T = NAG_TXT[level], tier = missed >= 2 ? 2 : missed;
  const list = tier === 0 && n === 1 && T.first ? T.first : T[tier];
  const title = pick(list, n).replace(/\{d\}/g, gap).replace(/\{n\}/g, n);
  let body;
  if (missed >= 2) body = level === 'gentle'
    ? `上次記帳是 ${md(last)}。拖久了容易忘記小額花費，金額也容易記錯。`
    : `上次記帳是 ${md(last)}。拖越久越容易忘：${gap} 天前的午餐、零錢、轉帳，很容易少記或記錯金額。`;
  else body = level === 'gentle' ? '點一下打開記帳本。' : '點一下打開記帳本，記一筆今天就不吵你。';
  // 囉嗦、地獄：兩天以上沒記，就不蓋掉舊的，一則一則疊在鎖定畫面
  const stack = level !== 'gentle' && missed >= 2;
  return { title, body, tag: stack ? 'ledger-nag-' + Date.now() + '-' + n : 'ledger-nag', badge: Math.max(1, gap) };
}
function cardNote(m) {
  const title = m.days === 0 ? `今天是「${m.n}」的繳款截止日` : `「${m.n}」${m.days} 天後要繳卡費`;
  const body = `${m.a ? `應繳 ${fmt(m.a)}，` : ''}${md(m.d)} 截止。繳完記得在記帳本記錄繳款。`;
  return { title, body, tag: 'ledger-card-' + m.n };
}
function budNote(m) {
  if (m.th >= 100) return { title: '這個月預算超支了', body: `已經超出 ${fmt(m.left)}。接下來每一筆都在花下個月的錢。`, tag: 'ledger-bud' };
  return { title: `這個月預算用了 ${m.p}%`, body: `還剩 ${fmt(m.left)}${m.day ? `，平均每天可用 ${fmt(m.day)}` : ''}。`, tag: 'ledger-bud' };
}
async function buildNotes(e) {
  const st = await readState();
  let data = {};
  try { data = e && e.data ? e.data.json() : {}; } catch (err) {}
  if (data && data.title) return [{ title: data.title, body: data.body || '', tag: 'ledger-nag' }];
  const msgs = await fetchWhy(st), out = [];
  (msgs || []).forEach(m => {
    if (m.kind === 'nag') out.push(nagNote(st, m));
    else if (m.kind === 'card') out.push(cardNote(m));
    else if (m.kind === 'bud') out.push(budNote(m));
    else if (m.kind === 'test') out.push({ title: '測試通知', body: '推播運作正常 ✅ 之後的提醒會從這裡跳出來。', tag: 'ledger-test' });
  });
  if (!out.length) out.push(nagNote(st, null));
  return out;
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const notes = await buildNotes(e);
    for (const t of notes) {
      await self.registration.showNotification(t.title, {
        body: t.body, tag: t.tag, renotify: true,
        icon: './icons/icon-192.png',
        data: { url: './index.html?from=push' }
      });
    }
    const nag = notes.find(t => t.badge);
    try { if (nag && self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(nag.badge); } catch (err) {}
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
