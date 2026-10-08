/* 定时自动同步测试
   覆盖：配置与开关、间隔判定、数据变更判定、三条件与门、静默行为、
   失败与安全边界（空数据/云端冲突/loadError/并发）、生命周期挂钩、界面、兼容性。
   只读取 index.html，不修改源码。 */
const fs = require('fs');
const path = require('path');
/* 应用目录探测：dev-tools 既可能在仓库内，也可能与仓库平级（旧结构）。两种都能跑。 */
function appRoot() {
  var cands = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'radiotherapy-ward')];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'index.html'))) return cands[i];
  }
  return cands[0];
}
const { webcrypto } = require('crypto');

const APP = appRoot() + '/index.html';
let html = fs.readFileSync(APP, 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/, '');

/* ---------- DOM 打桩 ---------- */
const elById = {};
function makeEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() { }, contains(c) { return !!this._s[c]; } },
    addEventListener() { }, onclick: null, dataset: {}, parentElement: null,
    appendChild() { }, removeChild() { }, click() { }, remove() { }, focus() { }, querySelector() { return null; }
  };
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
let clickHandler = null, sheetInputs = [];
const toastMsgs = [], alertMsgs = [], confirmQueue = [];
/* 事件注册记录：断言 visibilitychange / online / pagehide 确实被注册 */
const listeners = {};
/* 定时器打桩：记录 setTimeout，便于手动触发去抖与断言"没有用 setInterval" */
let timers = [], timerSeq = 0, intervalCalls = 0;

global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll(sel) { return sel === '#sheetBody [name]' ? sheetInputs : []; },
  querySelector() { return null; },
  createElement() { return makeEl(); },
  body: {
    appendChild(el) { if (el && typeof el.textContent === 'string' && el.textContent) toastMsgs.push(el.textContent); },
    removeChild() { }
  },
  addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); if (ev === 'click') clickHandler = fn; },
  documentElement: makeEl(), visibilityState: 'visible'
};
global.window = global;
/* window.addEventListener：应用里用的是 window.addEventListener('online'…)。
   桩环境把 window 指向 global，故需在 global 上补一个（记录到 listeners）。 */
global.addEventListener = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
global.location = { search: '', protocol: 'https:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = (m) => { alertMsgs.push(String(m)); };
global.confirm = (m) => { alertMsgs.push('[confirm] ' + m); return confirmQueue.length ? confirmQueue.shift() : true; };
global.navigator = { userAgent: 'Mozilla/5.0 (Macintosh)' };
global.crypto = webcrypto;
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.setInterval = () => { intervalCalls++; return 0; };
global.clearInterval = () => { };
/* 定时器打桩的坑：应用用 setTimeout 做去抖，而 tick() 也用 setTimeout 制造"下一个事件循环"。
   若把 setTimeout 整个换掉，await tick() 永远不会 resolve，测试会静默截断。
   所以：只拦截「去抖时长(AUTO_SYNC_DEBOUNCE_MS)」以及明显是应用发起的长延时，
   其余（短延时）照常交给真实的 setTimeout 执行。 */
const realSetTimeout = global.setTimeout.bind(global);
const realClearTimeout = global.clearTimeout.bind(global);
const DEBOUNCE_MS = 20000;
/* 去抖定时器用一个「已取消」标记来实现 clearTimeout 语义：
   应用每次 autoSyncSchedule 都会先 clearTimeout 旧的，故最终只应剩一个活的。 */
global.setTimeout = (fn, ms) => {
  if (ms === DEBOUNCE_MS) {
    const t = { fn: fn, ms: ms, id: ++timerSeq, cancelled: false };
    timers.push(t);
    return t.id;
  }
  return realSetTimeout(fn, ms);
};
global.clearTimeout = (id) => {
  timers = timers.filter(function (t) { return t.id !== id; });
  realClearTimeout(id);
};
/* 手动跑掉所有挂起的定时器（模拟去抖到期） */
function runTimers() {
  const list = timers.slice(); timers = [];
  list.forEach(function (t) { try { t.fn(); } catch (e) { } });
}

/* ---------- 模拟 GitHub API ---------- */
let gists = {};
let gistSeq = 0;
let netCalls = [];
let nextStatus = null;
let clock = 0;
function bumpTime() { clock += 1000; return new Date(1700000000000 + clock).toISOString().replace(/\.\d+Z$/, 'Z'); }

global.fetch = function (url, opts) {
  opts = opts || {};
  netCalls.push({ url: url, method: opts.method || 'GET', headers: opts.headers || {}, cache: opts.cache, body: opts.body, keepalive: !!opts.keepalive });
  const body = () => (opts.body ? JSON.parse(opts.body) : null);
  const resp = (status, obj) => Promise.resolve({
    ok: status >= 200 && status < 300, status: status,
    headers: { get: (h) => (h && h.toLowerCase() === 'etag' ? 'W/"e' + clock + '"' : null) },
    text: () => Promise.resolve(obj === undefined ? '' : JSON.stringify(obj)),
    json: () => Promise.resolve(obj)
  });
  if (nextStatus) { const s = nextStatus; nextStatus = null; return resp(s.status, s.body || { message: 'err' }); }
  const m = url.replace('https://api.github.com', '');
  if (m === '/user') return resp(200, { login: 'Kyouyama-Kazusa', id: 1 });
  if (m.indexOf('/gists?') === 0) return resp(200, []);
  if (m === '/gists' && (opts.method || 'GET') === 'POST') {
    gistSeq++;
    const id = ('a'.repeat(31) + gistSeq);
    gists[id] = { id: id, updated_at: bumpTime(), files: body().files, public: !!body().public, description: body().description, history: [{}] };
    return resp(201, gists[id]);
  }
  const gm = m.match(/^\/gists\/([0-9a-f]+)$/);
  if (gm) {
    const g = gists[gm[1]];
    if (!g) return resp(404, { message: 'Not Found' });
    if ((opts.method || 'GET') === 'PATCH') {
      const b = body();
      Object.keys(b.files || {}).forEach(k => { g.files[k] = b.files[k]; });
      g.updated_at = bumpTime(); g.history.push({});
      return resp(200, g);
    }
    return resp(200, g);
  }
  return resp(404, { message: 'Not Found' });
};

eval(js);
bind();
/* init() 已在 eval 时执行过（会自动注册生命周期监听）。
   为便于断言，再显式调用一次 bindAutoSync（内部为 addEventListener，重复注册无害）。 */

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }
function fire(act, data) {
  const el = makeEl(); el.dataset.act = act; Object.assign(el.dataset, data || {});
  clickHandler({ target: el });
}
function resetNet() { netCalls = []; }
function pushes() { return netCalls.filter(c => c.method === 'PATCH' || (c.method === 'POST' && c.url.indexOf('/gists') >= 0)); }
function inState(patients) {
  state = normalize({ version: 2, updatedAt: '', patients: patients });
  return state.patients[0];
}
function tick(n) { return new Promise(r => setTimeout(r, n || 30)); }
/* 配一个"可自动同步"的完整环境 */
function cfgReady(extra) {
  const o = Object.assign({
    token: 'ghp_testtoken123456', password: '密码12345678', remember: true,
    gistId: '', autoSync: true, autoSyncMin: 60
  }, extra || {});
  lsSet(SYNC_KEY, o);
  autoSyncBusy = false;          /* 用例间隔离：清掉上一组可能残留的并发标志，
                                    否则后续用例会因去重而"什么都没做"却断言通过 */
  return o;
}
/* 造一位患者，并让 state.updatedAt 有值（模拟已保存过） */
function seedPatient() {
  const p = inState([{ id: 'p1', name: '张三', status: '在治', startDate: '2026-03-02', fractions: '30', treatDays: [1, 2, 3, 4, 5] }]);
  state.updatedAt = '2026-03-02T10:00:00.000Z';
  return p;
}
/* 用例间隔离：把上一次可能仍在"飞行中"的自动同步收敛掉。
   否则 autoSyncBusy 会残留为 true，导致后续用例其实什么都没做却"断言通过"——
   这正是故障注入时暴露的问题（去掉空数据保护后，本该失败的断言却没红）。 */
async function settle() {
  for (let i = 0; i < 20 && autoSyncBusy; i++) await tick(30);
  autoSyncBusy = false;
  timers = [];
}
/* 等待"当前这次上传真正结束"。
   不能只写 await tick(60)：syncEncrypt 走 PBKDF2 25 万次迭代，真机上要几百毫秒，
   于是 tick(60) 常常在加密还没算完时就返回。此时：
     - 断言"没有请求"会假绿（其实是还没发）；
     - 上一次上传的收尾 .then() 会漂移到下一组，把 lastAutoSyncAt 改掉，
       导致下一组"本该到期"的用例莫名不到期 —— 表现为随机失败（抖动）。
   所以：凡是"触发了真实上传"的地方，都必须 drain 到 busy 落下再继续。
   同时给一个额外的短抖动窗口，让收尾回调（setSyncCfg）有机会执行完。 */
async function drain(maxMs) {
  const limit = maxMs || 8000;
  const t0 = Date.now();
  while (autoSyncBusy && Date.now() - t0 < limit) await tick(10);
  await tick(60);                 /* 让最后一个 .then 收尾落地 */
  for (let i = 0; i < 5 && autoSyncBusy; i++) await tick(20);
  return autoSyncBusy === false;
}

(async function () {
  console.log('========== 定时自动同步 ==========');

  /* ================================================================ */
  group('A. 配置与开关');
  {
    lsSet(SYNC_KEY, {});
    ok(autoSyncOn() === false, '★ 默认关闭（不擅自替用户开启联网上传）');
    ok(autoSyncMin() === 60, '★ 默认间隔 60 分钟', autoSyncMin());
    ok(AUTO_SYNC_DEFAULT_MIN === 60, '默认间隔常量存在且为 60');
    ok(AUTO_SYNC_OPTIONS.indexOf(60) >= 0 && AUTO_SYNC_OPTIONS.indexOf(30) >= 0, '可选间隔含 60 与 30 分钟', AUTO_SYNC_OPTIONS);

    setAutoSyncOn(true);
    ok(autoSyncOn() === true, '开启后开关为真');
    ok(syncCfg().autoSync === true, '开关落到 localStorage 配置里');
    setAutoSyncOn(false);
    ok(autoSyncOn() === false, '可关闭');

    setAutoSyncMin(120);
    ok(autoSyncMin() === 120, '间隔可设 120 分钟');
    setAutoSyncMin(999);
    ok(autoSyncMin() === 60, '★ 非法间隔回落默认 60（不被写坏）', autoSyncMin());
    setAutoSyncMin('abc');
    ok(autoSyncMin() === 60, '非数字间隔回落默认 60', autoSyncMin());
    setAutoSyncMin('720');
    ok(autoSyncMin() === 720, '字符串数字可正确解析', autoSyncMin());

    ok(autoSyncMinText(30) === '30 分钟', '30 → “30 分钟”', autoSyncMinText(30));
    ok(autoSyncMinText(60) === '1 小时', '60 → “1 小时”', autoSyncMinText(60));
    ok(autoSyncMinText(1440) === '24 小时', '1440 → “24 小时”', autoSyncMinText(1440));
    ok(autoSyncMinText(90) === '1.5 小时', '90 → “1.5 小时”', autoSyncMinText(90));
  }

  /* ================================================================ */
  group('B. 间隔判定 autoSyncDue');
  {
    seedPatient();
    cfgReady({ lastAutoSyncAt: '' });
    ok(autoSyncDue() === true, '★ 从未同步过 → 立即到期', syncCfg().lastAutoSyncAt);

    const now = Date.now();
    cfgReady({ lastAutoSyncAt: new Date(now - 10 * 60000).toISOString(), autoSyncMin: 60 });
    ok(autoSyncDue() === false, '10 分钟前同步过、间隔 60 分钟 → 未到期');

    cfgReady({ lastAutoSyncAt: new Date(now - 61 * 60000).toISOString(), autoSyncMin: 60 });
    ok(autoSyncDue() === true, '61 分钟前同步过、间隔 60 分钟 → 到期');

    cfgReady({ lastAutoSyncAt: new Date(now - 60000).toISOString(), autoSyncMin: 30, lastAutoSyncAt2: '' });
    ok(autoSyncDue() === false, '间隔改小到 30 分钟，1 分钟前同步过 → 仍未到期');

    cfgReady({ lastAutoSyncAt: new Date(now - 31 * 60000).toISOString(), autoSyncMin: 30 });
    ok(autoSyncDue() === true, '★ 间隔改小立即生效（31 分钟 > 30 分钟）');

    cfgReady({ lastAutoSyncAt: new Date(now - 12 * 3600000).toISOString(), autoSyncMin: 1440 });
    ok(autoSyncDue() === false, '12 小时前同步过、间隔 24 小时 → 未到期');

    cfgReady({ lastAutoSyncAt: new Date(now - 25 * 3600000).toISOString(), autoSyncMin: 1440 });
    ok(autoSyncDue() === true, '★ 25 小时前同步过、间隔 24 小时 → 到期（跨天长间隔）');

    cfgReady({ lastAutoSyncAt: '坏掉的时间戳', autoSyncMin: 60 });
    ok(autoSyncDue() === true, '★ 时间戳损坏 → 视为到期（不会永久卡死）');
  }

  /* ================================================================ */
  group('C. 数据变更判定 autoSyncDataChanged');
  {
    const p = seedPatient();
    cfgReady({ lastAutoSyncState: state.updatedAt });
    ok(autoSyncDataChanged() === false, '★ 与上次同步的版本一致 → 判定为未变更');

    state.updatedAt = '2026-03-02T11:00:00.000Z';
    ok(autoSyncDataChanged() === true, '★ updatedAt 变了 → 判定为已变更');

    cfgReady({ lastAutoSyncState: '' });
    ok(autoSyncDataChanged() === true, '从未记录过同步版本 → 视为已变更');
  }

  /* ================================================================ */
  group('D. 三条件与门 autoSyncShouldRun');
  {
    seedPatient();
    const fresh = () => { cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' }); };

    fresh();
    ok(autoSyncShouldRun() === true, '★ 全部满足 → 应执行');

    fresh(); setAutoSyncOn(false);
    ok(autoSyncShouldRun() === false, '开关关闭 → 不执行');

    fresh();
    const c1 = syncCfg(); c1.token = ''; setSyncCfg(c1);
    ok(autoSyncShouldRun() === false, '★ 无 Token → 不执行');
    ok(/Token/.test(autoSyncBlockReason()), '原因文案指出缺 Token', autoSyncBlockReason());

    fresh();
    const c2 = syncCfg(); c2.password = ''; setSyncCfg(c2);
    ok(autoSyncShouldRun() === false, '★ 未保存密码 → 不执行（不弹窗打断）');
    ok(/记住密码|密码/.test(autoSyncBlockReason()), '原因文案指出需保存密码', autoSyncBlockReason());

    fresh();
    const c3 = syncCfg(); c3.lastAutoSyncAt = new Date().toISOString(); c3.autoSyncMin = 60; setSyncCfg(c3);
    ok(autoSyncShouldRun() === false, '未到间隔 → 不执行');

    fresh();
    const c4 = syncCfg(); c4.lastAutoSyncState = state.updatedAt; setSyncCfg(c4);
    ok(autoSyncShouldRun() === false, '数据未变更 → 不执行');

    /* 环境不支持加密时也应拦住。
       注意：Node 里 global.crypto 是只读 getter，直接赋值会静默失效，
       必须用 defineProperty 才能真正替换（踩过这个坑）。 */
    fresh();
    const realCrypto = global.crypto;
    Object.defineProperty(global, 'crypto', { value: {}, configurable: true, writable: true });
    ok(typeof crypto.subtle === 'undefined', '桩已生效：crypto.subtle 不可用');
    ok(autoSyncShouldRun() === false, '★ 环境不支持 crypto.subtle → 不执行');
    ok(/环境/.test(autoSyncBlockReason()), '原因文案指出环境不支持', autoSyncBlockReason());
    Object.defineProperty(global, 'crypto', { value: realCrypto, configurable: true, writable: true });
  }

  /* ================================================================ */
  group('E. 静默上传：成功路径与"不打扰用户"');
  {
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet(); toastMsgs.length = 0; alertMsgs.length = 0;

    const ran = autoSyncTick('test');
    ok(ran === true, 'autoSyncTick 在条件满足时返回 true');
    await drain();

    ok(pushes().length === 1, '★ 发生了一次上传（首次为创建 gist）', pushes().length);
    const c = syncCfg();
    ok(!!c.gistId, '★ 首次自动同步会自动创建云端数据', c.gistId);
    ok(!!c.lastAutoSyncAt, '★ 成功后写入 lastAutoSyncAt');
    ok(c.lastAutoSyncState === state.updatedAt, '★ 成功后记下已同步的数据版本');
    ok(c.lastAutoSyncErr === '', '成功后清空失败原因');
    ok(!!c.lastSyncAt, '同时更新 lastSyncAt（与手动同步口径一致）');

    ok(toastMsgs.length === 0, '★ 静默：不弹 toast', toastMsgs);
    ok(alertMsgs.length === 0, '★ 静默：不弹 alert/confirm', alertMsgs);

    /* 立刻再 tick：因为 lastAutoSyncAt 刚写、数据未变 → 不该再传 */
    resetNet();
    const again = autoSyncTick('test2');
    await tick(40);
    ok(again === false, '★ 刚同步过且数据未变 → 不再重复上传');
    ok(pushes().length === 0, '★ 确认没有产生新的上传请求', pushes().length);

    /* 数据变了，但间隔未到 → 仍不传 */
    resetNet();
    state.updatedAt = '2026-03-02T12:00:00.000Z';
    autoSyncTick('test3');
    await tick(40);
    ok(pushes().length === 0, '★ 间隔未到时，即使数据变了也不传');

    /* 把间隔基准推到很久以前 → 应传 */
    resetNet();
    const c2 = syncCfg(); c2.lastAutoSyncAt = new Date(Date.now() - 2 * 3600000).toISOString(); setSyncCfg(c2);
    autoSyncTick('test4');
    await drain();
    ok(pushes().length === 1, '★ 间隔已到且数据变了 → 上传', pushes().length);
    ok(syncCfg().lastAutoSyncState === state.updatedAt, '上传后版本基准更新');
  }

  /* ================================================================ */
  group('F. 安全边界与失败处理');
  {
    /* F1 空数据不上传（防覆盖云端）
       注意断言的取法：不能只断言"没有 PATCH 请求"。syncEncrypt 用 PBKDF2 25 万次迭代，
       耗时远超本用例的等待窗口，因此"没请求"可能只是"还没算完"，属于假绿。
       真正该断言的是「同步返回的决定」：守卫必须同步命中并立刻返回 false，
       既不能进入上传流程（autoSyncBusy 不被置起），也要留下可读的跳过原因。 */
    await settle();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    state = emptyState(); state.updatedAt = '2026-03-02T10:00:00.000Z';
    resetNet(); toastMsgs.length = 0;
    const rEmpty = autoSyncSilentPush('empty');
    ok(autoSyncBusy === false, '★ 空数据时同步调用立即返回，未进入上传流程（不留并发标志）', autoSyncBusy);
    await drain();
    ok(pushes().length === 0, '★ 本机无患者数据 → 绝不上传（不覆盖云端）', pushes().length);
    ok(netCalls.length === 0, '★ 空数据时连一次网络请求都不发起', netCalls.map(function (x) { return x.method; }));
    ok(rEmpty && typeof rEmpty.then === 'function', '返回 Promise（调用方可统一 await）');
    ok(/暂无患者/.test(syncCfg().lastAutoSyncErr), '并记录跳过原因', syncCfg().lastAutoSyncErr);
    ok(toastMsgs.length === 0, '静默跳过，不打扰用户');
    /* 结论值：Promise 必须 resolve 为 false（表示"没有上传"） */
    const vEmpty = await rEmpty;
    ok(vEmpty === false, '★ 返回 false，明确表达"未上传"', vEmpty);

    /* F1b 空数据 + 已到期 + 已开启 → 走 autoSyncTick 同样不上传 */
    await settle();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    state = emptyState(); state.updatedAt = '2026-03-02T10:00:00.000Z';
    resetNet();
    ok(autoSyncShouldRun() === true, '前置：三条件全部满足（否则本用例无意义）', {
      enabled: autoSyncEnabled(), due: autoSyncDue(), changed: autoSyncDataChanged()
    });
    autoSyncTick('empty-tick');
    await drain();
    ok(autoSyncBusy === false && netCalls.length === 0, '★ 经 autoSyncTick 入口同样零请求、零并发标志', netCalls.length);

    /* F2 云端被别的设备改过 → 跳过、不覆盖、不弹窗 */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet(); alertMsgs.length = 0;
    /* ⚠ 这里必须用 drain() 而不是固定的 tick(N)。
       本步要等的是"上传流程真正把云端记录建出来"这一异步副作用，用时不受控；
       早期写成 `tick(60)`，机器空闲时够用，但在负载下（如并发跑回归）60ms 窗口
       不足 → gists[gid] 仍为 undefined → 下一行取 .updated_at 直接抛 TypeError，
       表现为"发布门禁随机变红"。drain() 会轮询 autoSyncBusy 落下、最多 8 秒。 */
    autoSyncTick('c1'); await drain();                  /* 先建立云端数据 */
    const gid = syncCfg().gistId;
    /* 前置校验：拿不到云端记录就没必要继续。
       注意：这里**不能写 return** —— 本组是裸块（group('F. ...'); { ... }），
       return 会连带跳过套件末的汇总与 process.exit，导致失败被吞、退出码为 0，
       发布门禁失效（比崩溃更危险）。改为记录失败后用 if 跳过依赖它的后续步骤。 */
    const cloudReady = !!(gid && gists[gid]);
    ok(cloudReady, '前置：云端记录已建立（否则本用例无意义）', { gid, has: !!gists[gid] });

    if (cloudReady) {
    const c = syncCfg(); c.lastRemoteUpdatedAt = 'OLD_TIMESTAMP'; setSyncCfg(c);   /* 假装本机记的是旧版本 */
    gists[gid].updated_at = 'REMOTE_CHANGED_BY_OTHER_DEVICE';
    resetNet(); alertMsgs.length = 0;
    autoSyncSilentPush('conflict');
    await drain();
    ok(pushes().length === 0, '★ 云端被其他设备更新过 → 不上传（不覆盖）', pushes().length);
    ok(/其他设备/.test(syncCfg().lastAutoSyncErr), '★ 记录"被其他设备更新"的原因', syncCfg().lastAutoSyncErr);
    ok(alertMsgs.length === 0, '★ 不弹窗打扰（与手动同步的覆盖确认区分开）', alertMsgs);
    ok(gists[gid].files[SYNC_FILE].content !== undefined, '云端数据未被改动');
    }   /* end if(cloudReady) —— F2 的依赖前置步骤 */

    /* F3 网络失败 → 记录原因，且不更新 lastAutoSyncAt（下轮会重试） */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    const before = syncCfg().lastAutoSyncAt;
    nextStatus = { status: 500, body: { message: 'server error' } };
    resetNet(); alertMsgs.length = 0;
    autoSyncSilentPush('neterr');
    await drain();
    ok(!!syncCfg().lastAutoSyncErr, '★ 失败被记录', syncCfg().lastAutoSyncErr);
    ok(syncCfg().lastAutoSyncAt === before, '★ 失败不更新 lastAutoSyncAt（否则会静默跳过一个周期）', syncCfg().lastAutoSyncAt);
    ok(alertMsgs.length === 0, '★ 网络失败不弹窗（静默待下次）', alertMsgs);

    /* F4 401 鉴权失败 */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    nextStatus = { status: 401, body: { message: 'Bad credentials' } };
    resetNet();
    autoSyncSilentPush('auth');
    await drain();
    ok(/Token|鉴权|凭据|401/.test(syncCfg().lastAutoSyncErr), '★ 鉴权失败给出可读原因', syncCfg().lastAutoSyncErr);

    /* F5 loadError 时完全不动作 */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    resetNet();
    loadError = true;
    const r = autoSyncTick('loaderr');
    await tick(40);
    ok(r === false, '★ loadError 时 autoSyncTick 直接返回 false');
    ok(pushes().length === 0, '★ loadError 时不产生任何请求', pushes().length);
    loadError = false;

    /* F6 并发去重 */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet();
    autoSyncSilentPush('a');
    autoSyncSilentPush('b');
    autoSyncSilentPush('c');
    await drain();
    ok(pushes().length === 1, '★ 并发触发只上传一次（autoSyncBusy 去重）', pushes().length);

    /* F7 去抖：连续变更只触发一次 */
    await settle();
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet(); timers = [];
    autoSyncSchedule(); autoSyncSchedule(); autoSyncSchedule();
    ok(timers.length === 1, '★ 连续变更被去抖为一次定时', timers.length);
    ok(timers[0].ms === AUTO_SYNC_DEBOUNCE_MS, '去抖延时为 20 秒', timers[0].ms);
    runTimers();
    await drain();
    ok(pushes().length === 1, '去抖到期后执行一次上传', pushes().length);

    await settle();
    /* F8 开关关闭时不安排去抖 */
    lsSet(SYNC_KEY, { token: 'ghp_x', password: 'pw12345678', autoSync: false });
    timers = [];
    autoSyncSchedule();
    ok(timers.length === 0, '★ 未开启自动同步时不安排定时器');
  }

  /* ================================================================ */
  group('G. 生命周期挂钩');
  {
    bindAutoSync();
    ok((listeners['visibilitychange'] || []).length > 0, '★ 已注册 visibilitychange');
    ok((listeners['online'] || []).length > 0, '★ 已注册 online');
    ok((listeners['pagehide'] || []).length > 0, '★ 已注册 pagehide');

    /* visibilitychange 回调在可见时应触发检查 */
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet();
    const savedState = document.visibilityState;
    document.visibilityState = 'visible';
    (listeners['visibilitychange'] || []).forEach(f => f({}));
    await drain();
    ok(pushes().length === 1, '★ 回到前台（visible）会触发一次同步', pushes().length);
    document.visibilityState = savedState;

    /* pagehide 用 keepalive 兜底 */
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet();
    autoSyncSilentPush('setup'); await drain();       /* 先建好 gist，才有 id 可用 */
    const c = syncCfg(); c.lastAutoSyncAt = ''; c.lastAutoSyncState = ''; setSyncCfg(c);
    state.updatedAt = '2026-03-02T23:00:00.000Z';
    resetNet();
    (listeners['pagehide'] || []).forEach(f => f({}));
    /* pagehide 的兜底请求走的是「fire-and-forget」——它不设 autoSyncBusy，
       所以 drain() 等不到它。必须显式轮询，直到请求出现（或超时）。
       否则偶发地在加密还没算完时就断言，会变成随机失败。 */
    let kaWait = 0;
    while (kaWait < 8000 && netCalls.filter(x => x.keepalive === true).length === 0) {
      await tick(20); kaWait += 20;
    }
    await tick(40);
    const ka = netCalls.filter(x => x.keepalive === true);
    ok(ka.length >= 1, '★ pagehide 兜底请求带 keepalive（页面销毁后仍能送达）', netCalls.length);
    ok(ka.length === 0 || ka[0].cache === 'no-store', '★ pagehide 请求同样禁用缓存');

    /* 不使用 setInterval */
    intervalCalls = 0;
    const src = js;
    ok(!/autoSync[\s\S]{0,400}setInterval/.test(src), '★ 自动同步不使用 setInterval（移动端后台会被冻结）');
    ok(/onDoc\('visibilitychange'|addEventListener\('visibilitychange'/.test(src), '源码中确有 visibilitychange 注册');
    ok(/onWin\('online'|addEventListener\('online'/.test(src), '源码中确有 online 注册');
    ok(/onWin\('pagehide'|addEventListener\('pagehide'/.test(src), '源码中确有 pagehide 注册');
  }

  /* ================================================================ */
  group('H. 界面与动作');
  {
    /* 设置页入口 */
    seedPatient();
    cfgReady({ autoSync: true, autoSyncMin: 60, gistId: 'a'.repeat(31) + '1' });
    view.page = 'settings'; view.pid = null;
    render();
    const sh = getEl('view').innerHTML;
    ok(sh.indexOf('autosync-panel') >= 0, '★ 设置页出现「定时自动同步」入口');
    ok(sh.indexOf('定时自动同步') >= 0, '入口标题正确');
    ok(sh.indexOf('sync-panel') >= 0, '云同步入口仍在');

    /* 未配置 Token 时不显示自动同步入口 */
    lsSet(SYNC_KEY, {});
    render();
    ok(getEl('view').innerHTML.indexOf('autosync-panel') < 0, '★ 未配置云同步时隐藏自动同步入口（避免误导）');

    /* 面板渲染 */
    cfgReady({ autoSync: true, autoSyncMin: 120, gistId: 'a'.repeat(31) + '1' });
    sheetAutoSync();
    const body = getEl('sheetBody').innerHTML;
    const foot = getEl('sheetFootInner').innerHTML;
    ok(body.indexOf('只上传、不拉取') >= 0, '★ 面板说明「只上传不拉取」');
    ok(body.indexOf('不会上传') >= 0, '面板说明空数据不上传');
    ok(body.indexOf('不覆盖') >= 0, '面板说明云端冲突时不覆盖');
    ok(foot.indexOf('autosync-toggle') >= 0, '面板有开关按钮');
    ok(foot.indexOf('autosync-interval') >= 0, '面板有间隔按钮');
    ok(foot.indexOf('autosync-now') >= 0, '面板有「立即同步一次」');
    ok(foot.indexOf('2 小时') >= 0, '间隔按钮显示当前间隔文案', '2 小时');

    /* 间隔选择弹层 */
    sheetAutoSyncInterval();
    const ib = getEl('sheetBody').innerHTML;
    ok(ib.indexOf('autosync-set') >= 0, '间隔弹层渲染出可选项');
    AUTO_SYNC_OPTIONS.forEach(function (n) {
      ok(ib.indexOf('data-min="' + n + '"') >= 0, '间隔选项存在：' + autoSyncMinText(n));
    });
    ok(ib.indexOf('✅') >= 0, '当前间隔有勾选标记');

    /* 动作：切换开关 */
    fire('autosync-toggle');
    ok(autoSyncOn() === false, '★ 点开关可关闭', autoSyncOn());
    fire('autosync-toggle');
    ok(autoSyncOn() === true, '★ 点开关可开启');

    /* 动作：设置间隔 */
    fire('autosync-set', { min: '360' });
    ok(autoSyncMin() === 360, '★ 动作可设置间隔为 360 分钟', autoSyncMin());

    /* 动作：设置非法间隔被拒 */
    fire('autosync-set', { min: '7' });
    ok(autoSyncMin() === 60, '★ 非法间隔回落默认值', autoSyncMin());

    /* 动作已注册 */
    const acts = ['autosync-panel', 'autosync-toggle', 'autosync-interval', 'autosync-set', 'autosync-now'];
    acts.forEach(function (a) { ok(js.indexOf("'" + a + "':") >= 0, '动作已注册：' + a); });

    /* 无密码时开启被拒绝并提示 */
    lsSet(SYNC_KEY, { token: 'ghp_test12345678', password: '', autoSync: false });
    toastMsgs.length = 0;
    fire('autosync-toggle');
    ok(autoSyncOn() === false, '★ 未保存密码时无法开启', autoSyncOn());
    ok(toastMsgs.length > 0, '并给出提示', toastMsgs[0]);
  }

  /* ================================================================ */
  group('I. 兼容性与隔离');
  {
    /* 老配置对象（完全不含新字段）应可正常读写，且不报错 */
    lsSet(SYNC_KEY, { token: 'ghp_oldtoken123', password: 'oldpass12345', remember: true, gistId: 'a'.repeat(31) + '9' });
    ok(autoSyncOn() === false, '★ 老配置（无 autoSync 字段）默认关闭，不会自动联网上传');
    ok(autoSyncMin() === 60, '★ 老配置读取间隔回落默认 60');
    ok(autoSyncBlockReason() === '', '老配置只要密码在就能通过前置条件');
    ok(autoSyncSubText().length > 0, '老配置下副标题可正常生成', autoSyncSubText());

    /* 自动同步不新增 localStorage 键。
       注意：radiotherapy.snap.* 是 render() 触发的每日快照（既有机制，与自动同步无关），
       故这里只断言「自动同步没有引入新的配置类键」。 */
    const cfgKeysBefore = Object.keys(store).filter(function (k) { return k.indexOf('radiotherapy.sync') === 0; }).join(',');
    seedPatient();
    cfgReady({ lastAutoSyncAt: '', lastAutoSyncState: '' });
    gists = {}; resetNet();
    autoSyncTick('k');
    /* 必须等静默上传真正收尾：PBKDF2 加密（25 万次迭代）耗时不定，
       只 tick(60) 会在慢机器/并发跑时抢跑，导致下面读 gists 为空而崩。
       用 drain() 显式等 autoSyncBusy 归零。 */
    await drain();
    await tick(60);
    const cfgKeysAfter = Object.keys(store).filter(function (k) { return k.indexOf('radiotherapy.sync') === 0; }).join(',');
    ok(cfgKeysAfter === 'radiotherapy.sync', '★ 自动同步的配置只写在 radiotherapy.sync 这一个键里', cfgKeysAfter);
    ok(cfgKeysBefore === cfgKeysAfter, '同步前后配置键名集合不变（未新增键）');
    ok(store['radiotherapy.sync'] !== undefined, 'radiotherapy.sync 仍在');
    /* 确认没有引入 autoSync 专属的新键 */
    const strayKeys = Object.keys(store).filter(function (k) { return /autosync/i.test(k); });
    ok(strayKeys.length === 0, '★ 没有引入任何 autoSync 专属的新存储键', strayKeys);

    /* 新字段不污染患者数据。
       注意：必须真的走一次 save() 才会写入 radiotherapy.v1；
       前面 seedPatient() 只改了内存里的 state，没落盘。 */
    save();
    const raw = store['radiotherapy.v1'];
    ok(raw !== undefined, '患者数据键已写入（走 save）');
    ok(raw !== undefined && raw.indexOf('autoSync') < 0, '★ 自动同步配置不写进患者数据');
    ok(raw !== undefined && raw.indexOf('lastAutoSyncState') < 0, '患者数据里没有自动同步字段');

    /* 同步配置与患者数据分离 */
    const c = syncCfg();
    ok(c.token !== undefined && c.autoSync !== undefined, '同步配置里同时持有 token 与 autoSync');
    ok(state.patients[0].token === undefined, '患者对象里没有同步相关字段');

    /* 静默上传后，加密内容仍不含明文 */
    const gid = syncCfg().gistId;
    const gEntry = gists[gid] || (gists[gid] = { files: {} });
    const gFile = gEntry.files[SYNC_FILE] || (gEntry.files[SYNC_FILE] = { content: '' });
    const content = gFile.content;
    if (!content) await drain();                 /* 再给一次机会，避免抢跑 */
    const content2 = (gists[gid] && gists[gid].files[SYNC_FILE] && gists[gid].files[SYNC_FILE].content) || '';
    ok(!!content2, '★ 静默上传确实写入了云端 gist');
    ok(content2.indexOf('张三') < 0, '★ 自动上传的仍是密文（不含明文姓名）');
    ok(content2 && JSON.parse(content2).app === 'RTmanager', '密文带应用标识');
  }

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
