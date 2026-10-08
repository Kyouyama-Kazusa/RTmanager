/* 云同步（加密 Gist）测试
   用模拟的 GitHub 服务端验证完整链路：加密 → 上传 → 拉取 → 解密 → 合并导入。
   重点覆盖：禁用缓存、错误处理、并发冲突检测、密码错误提示。
   只读取 index.html，不修改源码。 */
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
    appendChild() { }, removeChild() { }, click() { }, remove() { }, focus() { },
    querySelector() { return null; }
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
/* 捕获 toast / alert / confirm，便于断言用户可见的提示 */
const toastMsgs = [], alertMsgs = [], confirmQueue = [];
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll(sel) { return sel === '#sheetBody [name]' ? sheetInputs : []; },
  querySelector() { return null; },
  createElement() { return makeEl(); },
  body: {
    appendChild(el) { if (el && typeof el.textContent === 'string' && el.textContent) toastMsgs.push(el.textContent); },
    removeChild() { }
  },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; }, documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'https:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = (m) => { alertMsgs.push(String(m)); };
global.confirm = (m) => { alertMsgs.push('[confirm] ' + m); return confirmQueue.length ? confirmQueue.shift() : true; };
global.navigator = { userAgent: 'Mozilla/5.0 (Macintosh)' };
global.crypto = webcrypto;                       /* Node 自带 WebCrypto */
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.setInterval = () => 0; global.clearInterval = () => { };

/* ---------- 模拟 GitHub API ---------- */
let gists = {};              /* id -> { id, updated_at, files, public, description } */
let gistSeq = 0;
let netCalls = [];           /* 记录每次请求，用于断言缓存与鉴权 */
let nextStatus = null;       /* 强制下一次请求返回指定状态（测错误分支） */
let clock = 0;

function bumpTime() { clock += 1000; return new Date(1700000000000 + clock).toISOString().replace(/\.\d+Z$/, 'Z'); }

global.fetch = function (url, opts) {
  opts = opts || {};
  netCalls.push({ url: url, method: opts.method || 'GET', headers: opts.headers || {}, cache: opts.cache, body: opts.body });

  const body = () => (opts.body ? JSON.parse(opts.body) : null);
  const resp = (status, obj) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
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
      g.updated_at = bumpTime();
      g.history.push({});
      return resp(200, g);
    }
    if (opts.method === 'DELETE') { delete gists[gm[1]]; return Promise.resolve({ ok: true, status: 204, headers: { get: () => null }, text: () => Promise.resolve(''), json: () => Promise.resolve(null) }); }
    return resp(200, g);
  }
  return resp(404, { message: 'Not Found' });
};

eval(js);
bind();

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
function lastCall(method) {
  const list = netCalls.filter(c => !method || c.method === method);
  return list[list.length - 1];
}
function resetNet() { netCalls = []; }
function inState(patients) {
  state = normalize({ version: 2, updatedAt: '', patients: patients });
  return state.patients[0];
}
/* 等待所有微任务/异步链走完（仅用于「不涉及网络请求」的纯微任务场景） */
function tick(n) { return new Promise(r => setTimeout(r, n || 30)); }

/* ★ 轮询等待：等一个**可观测的异步结果**成立，而不是赌一个固定时长。
   背景（2026-10-08）：本套件原先用 `await tick(60)` 等加密 + fetch 链路走完。
   tick 是 setTimeout 固定时长，而加密（PBKDF2 25 万次）与 fetch 的耗时随机器负载波动：
   空闲时 60ms 够，负载下不够 → 请求还没发出就断言 → 报一堆"未发起请求"的假红，
   且重跑又变绿 —— 最难查的那类测试缺陷。
   waitUntil 改为轮询条件，默认最长 8 秒，正常路径通常几十毫秒即返回。 */
async function waitUntil(cond, desc, maxMs) {
  const limit = maxMs || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await tick(10);
  }
  /* 超时不在这里判失败：交给紧随其后的真实断言报错，能给出更具体的上下文。
     但仍提示一句，避免"超时"被误读成"断言本身写错"。 */
  console.log('  ⏱ waitUntil 超时（' + (desc || '') + '），交由后续断言判定');
  return false;
}
/* 常用条件：网络已记录到指定方法 / 指定次数的请求 */
function netHas(method, n) {
  const c = netCalls.filter(x => !method || x.method === method).length;
  return c >= (n || 1);
}

(async function () {
  console.log('========== 云同步（加密 Gist） ==========');

  group('1. parseGistId：接受网页链接、裸 id、带空格的输入');
  ok(parseGistId('https://gist.github.com/Kyouyama-Kazusa/abc123def456abc123def456abc12345') === 'abc123def456abc123def456abc12345', '从完整网页链接提取 id');
  ok(parseGistId('  abc123def456abc123def456abc12345  ') === 'abc123def456abc123def456abc12345', '从裸 id 提取（含首尾空格）');
  ok(parseGistId('https://gist.github.com/abc123def456abc123def456abc12345') === 'abc123def456abc123def456abc12345', '不带用户名也支持');
  ok(parseGistId('') === '', '空字符串返回空');
  ok(parseGistId('随便一段文字') === '', '无法识别时返回空（由调用处提示）');

  group('2. 加密原语');
  const plain = JSON.stringify({ version: 2, patients: [{ name: '张三', mrn: 'RT001', diagnosis: '鼻咽癌' }] });
  const blob = await syncEncrypt('密码12345678', plain);
  ok(await syncDecrypt('密码12345678', blob) === plain, '★ 加解密往返一致');
  const parsed = JSON.parse(blob);
  ok(parsed.app === 'RTmanager' && parsed.alg === 'PBKDF2-SHA256/AES-GCM-256', '密文带应用标识与算法', parsed.alg);
  ok(parsed.iter === 250000, 'PBKDF2 迭代 25 万次', parsed.iter);
  ok(!blob.includes('张三') && !blob.includes('鼻咽癌'), '★ 密文中不含任何明文患者信息');
  const blob2 = await syncEncrypt('密码12345678', plain);
  ok(JSON.parse(blob2).salt !== parsed.salt, '★ 每次加密 salt 随机（相同明文密文不同）');
  let wrongOk = false;
  try { await syncDecrypt('错误密码', blob); } catch (e) { wrongOk = /密码不对/.test(e.message); }
  ok(wrongOk, '★ 密码错误给出可读提示（不是 OperationError）');
  let badOk = false;
  try { await syncDecrypt('密码12345678', '{"app":"Other","salt":"x","iv":"y","data":"z"}'); } catch (e) { badOk = /不是本应用/.test(e.message); }
  ok(badOk, '非本应用的密文被拒绝');
  let junkOk = false;
  try { await syncDecrypt('密码12345678', 'not json'); } catch (e) { junkOk = /不是有效的加密数据/.test(e.message); }
  ok(junkOk, 	'非 JSON 内容被拒绝');

  group('3. 配置与状态文案');
  lsSet(SYNC_KEY, {});
  ok(syncHasToken() === false && syncHasGist() === false, '初始未配置');
  ok(syncSupported() === true, '★ 当前环境支持加密（crypto.subtle 可用）');
  ok(syncSubText().indexOf('未配置') >= 0, '未配置时给出提示', syncSubText());
  setSyncCfg({ token: 'ghp_x', gistId: '' });
  ok(syncSubText().indexOf('尚未上传') >= 0, '配了 Token 但没上传时的文案', syncSubText());
  setSyncCfg({ token: 'ghp_x', gistId: 'a'.repeat(32), lastSyncAt: '2026-10-05T22:30:00Z' });
  ok(syncSubText().indexOf('已连接') >= 0 && syncSubText().indexOf('22:30') >= 0, '已连接时显示上次同步时间', syncSubText());

  group('4. 未配置时的保护');
  resetNet();
  lsSet(SYNC_KEY, {});
  state = emptyState();
  toastMsgs.length = 0;
  syncPush();
  await tick();
  ok(netCalls.length === 0, '★ 未配置 Token 时不发任何网络请求');  ok(toastMsgs.some(t => /请先完成云同步设置/.test(t)), '并提示先去设置', toastMsgs);

  group('5. 首次上传：自动创建 secret gist');
  resetNet(); confirmQueue.length = 0; toastMsgs.length = 0;
  lsSet(SYNC_KEY, {});
  setSyncCfg({ token: 'ghp_test', password: '放疗科-密码-2026' });
  state = normalize({ version: 2, patients: [
    { id: 'p1', name: '张三', mrn: 'RT001', diagnosis: '鼻咽癌', status: '在治', fractions: '33', startDate: '2026-09-01', treatDays: [1, 2, 3, 4, 5], boostFractions: '3', boostNote: '瘤床加量' },
    { id: 'p2', name: '李四', mrn: 'RT002', diagnosis: '乳腺癌', status: '治疗完成', fractions: '25', startDate: '2026-08-01', treatDays: [1, 2, 3, 4, 5], pauses: [{ id: 'x', from: '2026-08-10', to: '2026-08-12', reason: '机器检修' }] }
  ] });
  view.page = 'settings';
  syncPush();
  await waitUntil(() => netHas('POST'), '创建 gist 请求已发出');
  const createCall = lastCall('POST');
  ok(!!createCall, '★ 发起了创建 gist 的请求', netCalls.map(c => c.method + ' ' + c.url));
  ok(createCall && createCall.url === 'https://api.github.com/gists', '打的是 /gists 接口', createCall && createCall.url);
  ok(createCall && createCall.cache === 'no-store', '★ 请求带 cache:no-store（绕过 max-age=60）', createCall && createCall.cache);
  ok(createCall && /^Bearer ghp_test$/.test(createCall.headers['Authorization']), '带 Bearer 鉴权头');
  const sent = createCall && JSON.parse(createCall.body);
  ok(sent && sent.public === false, '★ 创建的是 secret gist（public:false）');
  ok(sent && sent.files && sent.files[SYNC_FILE], '文件名为 ' + SYNC_FILE, sent && Object.keys(sent.files));
  ok(sent && sent.files[SYNC_FILE].content.indexOf('张三') < 0, '★ 上传内容不含明文患者姓名');
  ok(syncHasGist(), '★ gistId 已写回本机配置', syncCfg().gistId);
  ok(!!syncCfg().lastSyncAt, '记录了上次同步时间');

  group('6. 再次上传：更新既有 gist（PATCH）');
  resetNet();
  state.patients[0].boostFractions = '5';
  state.patients[0].boostNote = '加量追加到 5 次';
  syncPush();
  await waitUntil(() => netHas('PATCH'), '更新 gist 请求已发出');
  const patchCall = lastCall('PATCH');
  ok(!!patchCall, '★ 第二次上传走 PATCH 更新', netCalls.map(c => c.method));
  ok(patchCall && patchCall.cache === 'no-store', 'PATCH 也禁用缓存');
  const gid = syncCfg().gistId;
  const remoteBlob = gists[gid].files[SYNC_FILE].content;
  const decoded = JSON.parse(await syncDecrypt('放疗科-密码-2026', remoteBlob));
  ok(decoded.state.patients.length === 2, '云端存了 2 位患者', decoded.state.patients.length);
  ok(decoded.state.patients[0].boostFractions === '5', '★ 云端数据已更新为新值', decoded.state.patients[0].boostFractions);
  ok(decoded.state.patients[0].id === 'p1', '患者 id 保持不变（合并导入靠它去重）');

  group('7. 并发冲突检测');
  /* 模拟另一台设备先改了云端 */
  resetNet();
  gists[gid].updated_at = '2030-01-01T00:00:00Z';
  confirmQueue.length = 0;
  confirmQueue.push(false);                        /* 用户在冲突提示上选「取消」 */
  syncPush();
  await tick(30);                                  /* 冲突分支会在本地弹确认框，稍等确认队列被消费 */
  ok(lastCall('PATCH') === undefined, '★ 检测到云端被别的设备改过，取消后不覆盖上传');
  confirmQueue.length = 0;
  syncPush();
  await waitUntil(() => netHas('PATCH'), '用户确认后的覆盖上传已发出');
  ok(!!lastCall('PATCH'), '★ 用户确认后仍可强制覆盖上传');

  group('8. 拉取：解密 + 进入合并导入');
  resetNet();
  /* 清空本机，模拟「新设备第一次拉取」 */
  state = normalize({ version: 2, patients: [] });
  pendingImport = null;
  syncPull();
  await waitUntil(() => pendingImport !== null || netHas('GET'), '拉取请求已发出');
  await waitUntil(() => pendingImport !== null, '拉取结果已解密进入暂存');
  ok(pendingImport !== null, '★ 拉取后进入导入方式选择', pendingImport === null ? 'pendingImport 仍为空' : '已就绪');
  ok(pendingImport && pendingImport.patients.length === 2, '解出 2 位患者', pendingImport && pendingImport.patients.length);
  ok(pendingImport && pendingImport.patients[0].name === '张三', '患者姓名正确解密', pendingImport && pendingImport.patients[0].name);
  ok(pendingImport && (pendingImport.patients[0].pauses || []).length === 0, '第一位无中断记录（与云端一致）',
    pendingImport && pendingImport.patients[0].pauses);
  ok(pendingImport && pendingImport.patients[1].pauses[0].reason === '机器检修', '★ 中断原因中文完整还原');
  ok(getEl('sheetTitle').textContent === '选择导入方式', '弹层标题正确', getEl('sheetTitle').textContent);
  ok(getEl('sheetBody').innerHTML.indexOf('云端数据') >= 0, '★ 弹层标明来源为「云端数据」');
  const pullCall = lastCall('GET');
  ok(pullCall && pullCall.cache === 'no-store', '★ 拉取同样禁用缓存（避免读到旧数据）');

  group('9. 合并导入：两台设备各改各的都不丢');
  /* 本机（设备 B）自己录的患者保留，云端（设备 A）的补进来 */
  state = normalize({ version: 2, patients: [
    { id: 'pb', name: '王五', mrn: 'RT900', status: '在治', treatDays: [1, 2, 3, 4, 5], reactions: [{ id: 'r1', site: '皮肤反应', status: '未处理', content: '红斑' }] },
    { id: 'p1', name: '张三', mrn: 'RT001', status: '在治', fractions: '33', treatDays: [1, 2, 3, 4, 5], reactions: [{ id: 'r2', site: '口腔黏膜炎', status: '未处理', content: '充血' }] }
  ] });
  fire('import-merge');
  const merged = state.patients;
  ok(merged.length === 3, '★ 合并后共 3 位患者（本机 2 + 云端独有 1，不重复）', merged.map(p => p.name));
  const zs = merged.filter(p => p.name === '张三')[0];
  ok(zs.boostFractions === '5', '★ 从云端补齐了加量设置', zs.boostFractions);
  ok((zs.reactions || []).length === 1 && zs.reactions[0].content === '充血', '★ 本机自己的副反应记录未被覆盖', zs.reactions);
  ok(merged.some(p => p.name === '王五'), '本机独有患者保留');
  ok(merged.some(p => p.name === '李四'), '云端独有患者并入');
  ok(pendingImport === null, '导入后清空暂存');

  group('10. 密码错误时不污染本机数据');
  resetNet();
  lsSet(SYNC_KEY, {});
  setSyncCfg({ token: 'ghp_test', password: '这是错的密码', gistId: gid });
  state = normalize({ version: 2, patients: [{ id: 'keep', name: '本机患者', status: '在治' }] });
  const before = JSON.stringify(state);
  pendingImport = null;
  syncPull();
  await waitUntil(() => /密码不对/.test(getEl('syncStatus').innerHTML), '密码错误提示已渲染');
  ok(pendingImport === null, '★ 解密失败时不会产生导入数据');
  ok(JSON.stringify(state) === before, '★ 本机数据完全未被改动');
  ok(getEl('syncStatus').innerHTML.indexOf('密码不对') >= 0, '★ 界面提示「密码不对」', getEl('syncStatus').innerHTML.slice(0, 120));

  group('11. 云端异常分支');
  /* 404 */
  resetNet();
  setSyncCfg({ token: 'ghp_test', password: 'pw12345678', gistId: 'f'.repeat(32) });
  syncPull();
  await waitUntil(() => /找不到云端数据/.test(getEl('syncStatus').innerHTML), '404 提示已渲染');
  ok(getEl('syncStatus').innerHTML.indexOf('找不到云端数据') >= 0, '★ 404 给出「找不到云端数据」', getEl('syncStatus').innerHTML.slice(0, 120));
  /* 文件不匹配 */
  resetNet();
  gists[gid].files = { 'other.txt': { content: 'x' } };
  setSyncCfg({ token: 'ghp_test', password: '放疗科-密码-2026', gistId: gid });
  syncPull();
  await waitUntil(() => /找不到/.test(getEl('syncStatus').innerHTML), '文件不匹配提示已渲染');
  ok(getEl('syncStatus').innerHTML.indexOf('找不到') >= 0, '★ 云端文件不匹配时明确报错', getEl('syncStatus').innerHTML.slice(0, 140));
  /* Token 失效 */
  resetNet();
  nextStatus = { status: 401, body: { message: 'Bad credentials' } };
  syncPush();
  await waitUntil(() => /401/.test(getEl('syncStatus').innerHTML), '401 提示已渲染');
  ok(getEl('syncStatus').innerHTML.indexOf('401') >= 0, '★ Token 失效时提示 401', getEl('syncStatus').innerHTML.slice(0, 120));

  group('12. 清除同步设置');
  resetNet(); confirmQueue.length = 0;
  setSyncCfg({ token: 'ghp_x', password: 'p', gistId: 'g'.repeat(32) });
  syncForget();
  ok(!syncHasToken(), '★ Token 已从本机清除');
  ok(!syncHasGist(), '★ gistId 已清除');
  ok(state.patients.length > 0, '★ 患者数据不受影响', state.patients.length);

  group('13. 设置页入口与界面');
  lsSet(SYNC_KEY, {});
  setSyncCfg({ token: 'ghp_t', password: 'pw12345678' });
  view.page = 'settings'; render();
  const page = getEl('view').innerHTML;
  ok(page.indexOf('云同步') >= 0, '★ 设置页有云同步入口');
  ok(page.indexOf('data-act="sync-panel"') >= 0, '入口可点击');
  ok(page.indexOf('尚未上传') >= 0, '入口副标题反映当前状态');
  fire('sync-panel');
  const sheetBody = getEl('sheetBody').innerHTML;
  ok(sheetBody.indexOf('加密后的乱码') >= 0, '面板说明云端只有密文');
  const foot = getEl('sheetFootInner').innerHTML;
  ok(foot.indexOf('sync-push') >= 0 && foot.indexOf('sync-pull') >= 0, '★ 有上传与拉取按钮');
  ok(foot.indexOf('sync-setup') >= 0, '有同步设置按钮');
  ok(foot.indexOf('sync-forget') >= 0, '已配置时有清除按钮');

  group('14. 设置表单校验');
  sheetSyncSetup();
  const body2 = getEl('sheetBody').innerHTML;
  ok(body2.indexOf('name="token"') >= 0 && body2.indexOf('name="password"') >= 0 && body2.indexOf('name="gistId"') >= 0, '表单含 Token / 密码 / 云端地址');
  ok(body2.indexOf('data-act="sync-test"') >= 0, '含「测试连接」按钮');
  ok(body2.indexOf('只保存在本机') >= 0, '说明凭据只存本机');
  /* 保存校验 */
  let r = sheetCtx.onSave({ token: '', password: 'pw12345678', gistId: '' });
  ok(r === false, '★ Token 为空时拒绝保存');
  r = sheetCtx.onSave({ token: 'ghp_a', password: '123', gistId: '' });
  ok(r === false, '★ 密码过短时拒绝保存');
  r = sheetCtx.onSave({ token: 'ghp_a', password: 'pw12345678', gistId: '这不是地址' });
  ok(r === false, '★ 云端地址无法识别时拒绝保存');
  r = sheetCtx.onSave({ token: 'ghp_a', password: 'pw12345678', gistId: 'https://gist.github.com/u/' + 'c'.repeat(32) });
  ok(r === false, '保存成功时返回 false（用于跳回面板）');
  ok(syncCfg().token === 'ghp_a' && syncCfg().gistId === 'c'.repeat(32), '★ 配置已保存', { t: syncCfg().token, g: syncCfg().gistId });
  ok(syncCfg().password === 'pw12345678', '记住密码时写入本机');
  /* 不记住密码 */
  sheetSyncSetup();
  sheetCtx.onSave({ token: 'ghp_b', password: 'pw87654321', gistId: '', remember: false });
  ok(syncCfg().password === '', '★ 取消勾选时不保存密码', syncCfg().password);
  ok(syncCfg().remember === false, '记住标记已更新');

  group('15. 未保存密码时弹窗索要');
  resetNet();
  lsSet(SYNC_KEY, {});
  setSyncCfg({ token: 'ghp_t', password: '', gistId: '' });
  syncPush();
  await tick();
  ok(getEl('sheetTitle').textContent === '输入同步密码', '★ 未存密码时先弹出输入框', getEl('sheetTitle').textContent);
  ok(netCalls.length === 0, '★ 此时还没发起上传（等到输入密码才继续）');
  /* 输入密码后应继续走完上传 */
  sheetCtx.onSave({ password: '临时密码12345' });
  await waitUntil(() => netHas('POST'), '输入密码后上传请求已发出');
  ok(netCalls.some(c => c.url.indexOf('/gists') >= 0), '★ 输入密码后继续完成上传', netCalls.map(c => c.method));
  ok(String(syncCfg().password || '') === '', '临时输入的密码不落库', syncCfg().password);

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('测试脚本异常：' + (e && e.stack || e)); process.exit(1); });
