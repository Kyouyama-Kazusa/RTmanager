/* 放疗患者管理 · Service Worker
   策略：
   - HTML 导航请求 → 网络优先（在线时总能拿到最新版），失败回退缓存（离线可用）
   - 静态资源（图标/清单）→ 缓存优先（快），后台顺带更新
   - 全部兜底都会返回真正的 Response，绝不 resolve 成 undefined（否则离线时页面报错）
   - 检测到旧缓存被替换（即发生过版本升级）→ 向页面广播消息，由页面提示「有新版本」
   注意：每次发布新版本，请同步递增下面的 CACHE 版本号。 */
const CACHE = 'radiotherapy-v19';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './apple-touch-icon.png'
];

/* 离线兜底页（应用本体尚未缓存时兜住导航请求） */
const OFFLINE_HTML = '<!doctype html><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>暂时离线</title>' +
  '<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f2f4f7;color:#1f2937">' +
  '<div style="max-width:420px;margin:18vh auto;padding:24px;text-align:center">' +
  '<h2 style="margin:0 0 8px;color:#0f766e">暂时离线</h2>' +
  '<p style="margin:0;line-height:1.7;color:#475569">应用缓存尚未就绪。<br>请联网后重新打开一次，之后即可离线使用。</p>' +
  '</div></body>';

function offlinePage() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
function offlineAsset() {
  /* 让 fetch 拿到一个合法的失败响应，而不是 undefined */
  return new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => { }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => {
        const old = keys.filter((k) => k !== CACHE);
        return Promise.all(old.map((k) => caches.delete(k))).then(() => old.length);
      })
      .then((removed) => self.clients.claim().then(() => {
        /* 首次安装也会走 activate（此时没有旧缓存）→ 不提示；
           只有确实替换了旧版本才广播，避免第一次打开就弹「有新版本」 */
        if (!removed) return;
        return self.clients.matchAll({ type: 'window' }).then((cs) => {
          cs.forEach((c) => c.postMessage({ type: 'RT_SW_UPDATED', version: CACHE }));
        });
      }))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req)
          .then((r) => r || caches.match('./index.html'))
          .then((r) => r || offlinePage()))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        /* 缓存命中：立即返回，同时在后台刷新副本 */
        fetch(req).then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
        }).catch(() => { });
        return cached;
      }
      return fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => offlineAsset());
    })
  );
});
