/* 验证 Service Worker 的更新策略：
   1. 推送新版本后，用户再次打开能否拿到新版
   2. 离线时能否回退到缓存
   3. 旧缓存是否会被清理
   通过仿真 Cache Storage 与 fetch，精确验证 sw.js 的每个分支。 */
const fs = require('fs');
const path = require('path');
/* 应用目录探测：dev-tools 既可能在仓库内（radiotherapy-ward/dev-tools），
   也可能与仓库平级（旧结构）。两种都能跑。 */
function appRoot() {
  var cands = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'radiotherapy-ward')];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'index.html'))) return cands[i];
  }
  return cands[0];
}
const SW = fs.readFileSync(path.join(appRoot(), 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }

/* ---------- 仿真环境 ---------- */
/* 兼容两种写法：makeResponse(body) / new Response(body, {status, headers, statusText}) */
function makeResponse(body, init) {
  const st = (init && typeof init === 'object') ? (init.status || 200) : (init || 200);
  return {
    body, status: st,
    statusText: (init && typeof init === 'object' && init.statusText) || '',
    headers: (init && typeof init === 'object' && init.headers) || {},
    clone() { return makeResponse(this.body, this.status); }
  };
}
function keyOf(req) {
  if (typeof req === 'string') return req;
  return req.url;
}
/* SW 里的相对路径（'./index.html'）会被浏览器解析成绝对 URL，这里保持一致 */
function normalizeUrl(x) {
  let k = keyOf(x);
  if (k.indexOf('./') === 0) k = 'https://site.test/' + k.slice(2);
  return k;
}

/* 一个 Service Worker 实例的运行环境（各自独立的 Cache Storage） */
function makeEnv(storage, opts) {
  opts = opts || {};
  const handlers = {};
  const netCalls = [];
  let networkDown = !!opts.offline;

  const env = {
    self: {
      addEventListener(ev, fn) { handlers[ev] = fn; },
      skipWaiting() { env.skippedWaiting = true; return Promise.resolve(); },
      clients: {
        claim() { env.claimed = true; return Promise.resolve(); },
        /* 页面窗口句柄：postMessage 会被记录，用于验证「有新版本」广播 */
        matchAll() { return Promise.resolve(env.windowClients || []); }
      },
      location: { origin: 'https://site.test' },
      registration: {}
    },
    caches: {
      async open(name) {
        storage[name] = storage[name] || {};
        return {
          async add(u) { storage[name][normalizeUrl(u)] = makeResponse('CACHED-' + normalizeUrl(u)); },
          async put(req, resp) { storage[name][normalizeUrl(req)] = resp; },
          async match(req) { return storage[name][normalizeUrl(req)]; }
        };
      },
      async keys() { return Object.keys(storage); },
      async delete(name) { delete storage[name]; },
      /* 全局 match：依次在所有缓存里查找（对应浏览器行为） */
      async match(req) {
        const k = normalizeUrl(req);
        for (const name of Object.keys(storage)) {
          if (storage[name][k]) return storage[name][k];
        }
        return undefined;
      }
    },
    fetch: async (req) => {
      const url = keyOf(req);
      netCalls.push(url);
      if (networkDown) throw new TypeError('Failed to fetch');
      return makeResponse('NETWORK-' + url);
    },
    Response: makeResponse,
    URL: URL
  };
  env.netCalls = netCalls;
  env.setOffline = (v) => { networkDown = v; };
  /* 已打开的页面窗口（postMessage 收集站） */
  const posted = [];
  env.posted = posted;
  env.windowClients = (opts.clients || []).map(() => ({ postMessage: (m) => posted.push(m) }));

  /* 在隔离作用域里执行 sw.js */
  const fn = new Function('self', 'caches', 'fetch', 'Response', 'URL', SW);
  fn(env.self, env.caches, env.fetch, env.Response, env.URL);
  env.handlers = handlers;
  return env;
}

function htmlReq(url) {
  return { url: url, method: 'GET', mode: 'navigate', headers: { get: (h) => (h === 'accept' ? 'text/html' : '') } };
}
function assetReq(url) {
  return { url: url, method: 'GET', mode: 'no-cors', headers: { get: () => 'image/png' } };
}

async function run(env, evName, request) {
  const e = {
    waitUntil: (p) => { env._p = p; },
    respondWith: (p) => { env._resp = p; },
    request: request
  };
  const h = env.handlers[evName];
  if (!h) throw new Error('未注册事件: ' + evName);
  h(e);
  if (env._p) await env._p;
  return env._resp ? await env._resp : null;
}

(async function () {
  console.log('========== Service Worker 更新策略验证 ==========');

  const CACHE = (SW.match(/CACHE = '([^']+)'/) || [])[1];
  console.log('  当前缓存版本:', CACHE);
  console.log('  HTML 策略: 网络优先 | 静态资源: 缓存优先');

  group('1. 首次安装（用户第一次打开）');
  let storage = {};
  const env1 = makeEnv(storage);
  await run(env1, 'install');
  ok(env1.skippedWaiting === true, 'install 调用 skipWaiting（新版本立即生效，不等待关闭页面）');
  ok(Object.keys(storage[CACHE] || {}).length >= 6, '预缓存了静态资源', Object.keys(storage[CACHE] || {}).length);
  await run(env1, 'activate');
  ok(env1.claimed === true, 'activate 调用 clients.claim（立即接管已打开页面）');
  ok(env1.posted.length === 0, '★ 首次安装不广播「有新版本」（此时没有旧版本可替换）', env1.posted);

  group('2. 在线打开：应拿到最新版（关键：推送后能否自动体现）');
  /* 模拟：用户已缓存旧版，此时服务器已更新 */
  storage[CACHE]['https://site.test/'] = makeResponse('CACHED-OLD-VERSION');
  const env2 = makeEnv(storage);
  const r2 = await run(env2, 'fetch', htmlReq('https://site.test/'));
  const body2 = r2 && r2.body;
  console.log('  HTML 请求结果:', body2);
  ok(body2 === 'NETWORK-https://site.test/', '★ 在线时返回网络版本（不是缓存里的旧版）', body2);
  ok(env2.netCalls.indexOf('https://site.test/') >= 0, '确实发起了网络请求');
  ok(storage[CACHE]['https://site.test/'] && storage[CACHE]['https://site.test/'].body === 'NETWORK-https://site.test/',
    '缓存同步更新为最新版（下次离线也能用新版）');

  group('3. 离线打开：回退到缓存（断网仍可用）');
  const env3 = makeEnv(storage, { offline: true });
  const r3 = await run(env3, 'fetch', htmlReq('https://site.test/'));
  console.log('  离线时 HTML 请求结果:', r3 && r3.body);
  ok(r3 && r3.body === 'NETWORK-https://site.test/', '★ 离线时回退到缓存（用上次在线缓存的版本）', r3 && r3.body);
  ok(env3.netCalls.indexOf('https://site.test/') >= 0, '确实尝试过网络（失败后才回退）');

  group('4. 离线且从未访问过该地址：回退到 index.html');
  const env4 = makeEnv(storage, { offline: true });
  const r4 = await run(env4, 'fetch', htmlReq('https://site.test/some-page'));
  console.log('  未知路径离线请求结果:', r4 && r4.body);
  ok(r4 && r4.body && r4.body.indexOf('index.html') >= 0, '★ 回退到 index.html（SPA 式兜底）', r4 && r4.body);

  group('5. 静态资源（图标）：缓存优先，后台顺带更新');
  const env5 = makeEnv(storage);
  storage[CACHE]['https://site.test/icon-192.png'] = makeResponse('CACHED-ICON-v4');
  const r5b = await run(env5, 'fetch', assetReq('https://site.test/icon-192.png'));
  console.log('  图标请求结果:', r5b && r5b.body);
  ok(r5b && r5b.body === 'CACHED-ICON-v4', '静态资源直接返回缓存（加载快）', r5b && r5b.body);
  await new Promise((r) => setTimeout(r, 30));
  ok(storage[CACHE]['https://site.test/icon-192.png'].body === 'NETWORK-https://site.test/icon-192.png',
    '后台已把新图标写入缓存（下次生效）');

  group('6. 发布新版本：新旧 SW 交替与旧缓存清理');
  const oldCache = 'radiotherapy-vOLD';
  storage[oldCache] = { 'https://site.test/': makeResponse('OLD-STUFF') };
  ok(Object.keys(storage).length >= 2, '存在两个版本的缓存', Object.keys(storage));
  const env6 = makeEnv(storage, { clients: [{}, {}] });
  await run(env6, 'activate');
  console.log('  activate 后的缓存:', Object.keys(storage));
  ok(!storage[oldCache], '★ 旧版本缓存已被删除（不会无限堆积）');
  ok(!!storage[CACHE], '当前版本缓存保留');
  ok(env6.posted.length === 2, '★ 版本升级时向所有已打开页面广播消息', env6.posted.length);
  ok(env6.posted.every((m) => m && m.type === 'RT_SW_UPDATED' && m.version === CACHE),
    '★ 广播内容带版本号，供页面提示「有新版本，请刷新」', env6.posted[0]);

  group('7. 离线兜底：任何分支都返回真正的 Response（不会 resolve 成 undefined）');
  /* 完全空缓存（例如首次打开就断网）→ 连 index.html 都没有，只能给内置离线页 */
  const envEmpty = makeEnv({}, { offline: true });
  const rBlank = await run(envEmpty, 'fetch', htmlReq('https://site.test/'));
  console.log('  离线 + 完全空缓存：', rBlank && rBlank.status, rBlank && String(rBlank.body).slice(0, 40));
  ok(rBlank && typeof rBlank.body === 'string' && rBlank.body.indexOf('暂时离线') >= 0,
    '★ 空缓存离线时给出内置离线页（不是 undefined）', rBlank && String(rBlank.body).slice(0, 30));
  /* 有 index.html 但请求的是别的路径 → 兜到 index.html（SPA 式） */
  const env7a = makeEnv(storage, { offline: true });
  const rBlank2 = await run(env7a, 'fetch', htmlReq('https://site.test/never-cached-page'));
  ok(rBlank2 && String(rBlank2.body).indexOf('index.html') >= 0,
    '有缓存时优先兜到 index.html', rBlank2 && String(rBlank2.body).slice(0, 30));
  const env7b = makeEnv(storage, { offline: true });
  const rMiss = await run(env7b, 'fetch', assetReq('https://site.test/never-cached.png'));
  ok(rMiss && rMiss.status >= 400, '★ 离线且未缓存的状态资源返回失败响应（不是 undefined）', rMiss && rMiss.status);

  group('8. 非 GET 请求不干预');
  const env7 = makeEnv(storage);
  let threw = false;
  try { env7.handlers.fetch({ waitUntil: () => { }, respondWith: () => { throw new Error('不应干预'); }, request: { url: 'https://site.test/', method: 'POST', mode: 'cors', headers: { get: () => '' } } }); } catch (err) { threw = true; }
  ok(!threw, 'POST 请求不被 SW 拦截（交还浏览器处理）');

  group('9. 跨域请求不干预');
  const env8 = makeEnv(storage);
  let threw8 = false;
  try { env8.handlers.fetch({ waitUntil: () => { }, respondWith: () => { throw new Error('不应干预'); }, request: { url: 'https://other.com/api', method: 'GET', mode: 'cors', headers: { get: () => '' } } }); } catch (err) { threw8 = true; }
  ok(!threw8, '站外请求不被 SW 拦截');

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
