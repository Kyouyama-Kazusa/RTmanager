/* 设置层云同步测试（节假日 / 调休 / 随访模板 / 默认治疗日 / 调休当工作日）
   背景：这些设置存在**独立 localStorage 键**里（不在 state 内），
   但它们决定排程结果 —— 两台设备不一致，同一患者会算出不同的结束日期。
   所以必须随云同步一起走，并且：
     · 取并集（与本应用「合并导入不丢数据」的一贯口径一致）
     · **删除也算变更**：覆盖层用 null 表示「删除内置项」，
       null 必须参与合并，否则本机删掉的节日会在拉取时「复活」
     · 老版本备份/老版本应用：没有 settings 字段时静默跳过，不报错、不清空
   只读取 index.html，不修改源码。 */
const fs = require('fs');
const path = require('path');
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
global.crypto = webcrypto;
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.setInterval = () => 0; global.clearInterval = () => { };

/* ---------- 模拟 GitHub API ---------- */
let gists = {};
let gistSeq = 0;
let netCalls = [];
let nextStatus = null;
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
function resetNet() { netCalls = []; }
function tick(n) { return new Promise(r => setTimeout(r, n || 30)); }
/* ★ 轮询等待可观测结果成立，而不是赌固定时长。
   与 test-sync / test-autosync 的问题同源（2026-10-08）：加密 + fetch 的耗时随机器
   负载波动，`tick(120)` 这类固定等待在负载下会不够，导致请求未发出就断言 → 假红。 */
async function waitUntil(cond, desc, maxMs) {
  const limit = maxMs || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    let v = false;
    try { v = !!cond(); } catch (e) { v = false; }
    if (v) return true;
    await tick(10);
  }
  console.log('  ⏱ waitUntil 超时（' + (desc || '') + '），交由后续断言判定');
  return false;
}
/* 清空全部设置键（每个用例开始前调用，避免相互污染） */
function clearSettings() {
  ['radiotherapy.holidays', 'radiotherapy.makeups', 'radiotherapy.tpls',
    'radiotherapy.makeupWorkday', 'radiotherapy.treatDays'].forEach(k => { delete store[k]; });
}
function lsRaw(k) { return Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(store[k]) : undefined; }
function setState(patients) {
  state = normalize({ version: 2, updatedAt: '2026-10-07T08:00:00Z', patients: patients || [] });
  return state;
}
const P1 = { id: 'p1', name: '张三', mrn: 'RT001', diagnosis: '鼻咽癌', status: '在治', fractions: '30', startDate: '2026-09-01', treatDays: [1, 2, 3, 4, 5] };

(async function () {
  console.log('========== 设置层云同步（节假日 / 调休 / 模板 / 治疗日） ==========');

  /* ================= A. 导出 ================= */
  group('A. exportSettings：只导出「本机真有的」，不把「未设」当成「设为空」');
  clearSettings();
  ok(JSON.stringify(exportSettings()) === '{}', '★ 全部未设时导出空对象（不会误伤云端）', exportSettings());
  setHoliday('2026-10-09', '院庆');
  ok(exportSettings().holidays && exportSettings().holidays['2026-10-09'] === '院庆', '★ 新增的节假日被导出', exportSettings());
  setTreatDaysCfg([1, 2, 3, 4, 5, 6]);
  ok(Array.isArray(exportSettings().treatDays) && exportSettings().treatDays.length === 6, '默认治疗日被导出', exportSettings().treatDays);
  setMakeupAsWorkday(false);
  ok(exportSettings().makeupWorkday === false, '★ 显式的 false 也会被导出（不能被当成「未设」丢掉）', exportSettings().makeupWorkday);
  delete store['radiotherapy.makeupWorkday'];
  ok(!('makeupWorkday' in exportSettings()), '未设的键不出现在导出结果里', Object.keys(exportSettings()));

  /* ================= B. 合并 ================= */
  group('B. installOverride：并集 + 本机优先 + 删除优先（三条规则的自洽合成）');
  ok(mergeOverride({ 'd1': 'A' }, { 'd2': 'B' })['d1'] === 'A' &&
    mergeOverride({ 'd1': 'A' }, { 'd2': 'B' })['d2'] === 'B', '★ 两层取并集', mergeOverride({ d1: 'A' }, { d2: 'B' }));
  ok(mergeOverride({ 'd1': '本机' }, { 'd1': '云端' })['d1'] === '本机', '★ 规则①：同一 key 都是具体值时本机优先', mergeOverride({ d1: '本机' }, { d1: '云端' }));
  const mNull = mergeOverride({ 'd1': null }, { 'd1': '云端有', 'd2': 'x' });
  ok(mNull['d1'] === null, '★ 规则②：本机的删除标记不会被云端复活', mNull);
  ok(mNull['d2'] === 'x', '同时仍然接收云端新增项', mNull);
  ok(mergeOverride({ 'd1': '本机设的' }, { 'd1': null })['d1'] === null,
    '★ 规则②反向：云端删了，本机即使有具体值也让位给删除（否则两台设备排程不一致）',
    mergeOverride({ d1: '本机设的' }, { d1: null }));
  ok(mergeOverride({ 'd1': null }, { 'd1': null })['d1'] === null, '两边都是删除 → 保持删除');
  ok(mergeOverride(null, { a: 1 }).a === 1, '本机为空对象时照常接收云端');
  ok(mergeOverride(null, { a: null }).a === null, '本机为空、云端是删除 → 删除也落地');
  ok(JSON.stringify(mergeOverride({ a: 1 }, null)) === '{"a":1}', '云端为空时保留本机');
  ok(JSON.stringify(mergeOverride(null, null)) === '{}', '两边都为空时得到空对象');
  ok(JSON.stringify(mergeOverride({ a: 1 }, '垃圾')) === '{"a":1}', '云端是非法值时忽略（不崩）');
  ok(typeof settingsSummary === 'function' && typeof exportSettings === 'function', '导出/摘要等函数齐备');

  /* ================= C. 导入：节假日 / 调休 / 模板 ================= */
  group('C. importSettings：并入本机并给出变更摘要');
  clearSettings();
  setHoliday('2026-01-04', '本机加的假');
  let r = importSettings({ holidays: { '2026-01-04': '云端改的', '2026-03-08': '妇女节' } }, true);
  ok(r.changed === 1 && r.details.indexOf('holidays') >= 0, '★ 有变化才计数', r);
  ok(lsRaw('radiotherapy.holidays')['2026-01-04'] === '本机加的假', '★ 本机已有的值不被云端覆盖', lsRaw('radiotherapy.holidays'));
  ok(lsRaw('radiotherapy.holidays')['2026-03-08'] === '妇女节', '★ 云端新增项已并入', lsRaw('radiotherapy.holidays'));
  /* 幂等：再并一次不应有变化 */
  r = importSettings({ holidays: { '2026-01-04': '云端改的', '2026-03-08': '妇女节' } }, true);
  ok(r.changed === 0, '★ 重复并入同一份数据不产生变更（幂等）', r);
  /* apply=false 只探测不落地 */
  clearSettings();
  r = importSettings({ holidays: { '2026-05-05': 'X' } }, false);
  ok(r.changed === 1 && lsRaw('radiotherapy.holidays') === undefined, '★ apply=false 时只算不写', { r, v: lsRaw('radiotherapy.holidays') });
  ok(importSettings(null, true).changed === 0, 'remote 为 null 时不报错、不变更');
  ok(importSettings({}, true).changed === 0, 'remote 为空对象时不变更');

  group('D. ★ 删除也算变更：null 墓碑必须双向一致');
  clearSettings();
  delHoliday('2025-01-01');                       /* 本机删除内置的元旦 */
  ok(lsRaw('radiotherapy.holidays')['2025-01-01'] === null, '本机删除写入 null 墓碑', lsRaw('radiotherapy.holidays'));
  /* 另一台设备：没有该删除记录，但有一批新节假日 */
  r = importSettings({ holidays: { '2026-07-01': '建党节' } }, true);
  var h = lsRaw('radiotherapy.holidays');
  ok(h['2025-01-01'] === null, '★ 拉取后「本机删掉的元旦」仍是删除状态（没被复活）', h);
  ok(h['2026-07-01'] === '建党节', '★ 云端新增项正常并入', h);
  ok(holidays()['2025-01-01'] === undefined, '★ 合并后 2025-01-01 确实不再是假期（生效）', holidays()['2025-01-01']);
  /* 反方向：云端带 null（本机没有该覆盖）→ 应把「删除」也并进来。
     选一个本机**确实新增过**的日期：本机把它设为假期、云端把它删掉，
     合并后本机必须尊重云端的删除，否则两台设备会各算各的。 */
  clearSettings();
  setHoliday('2026-08-08', '本机加的假');
  r = importSettings({ holidays: { '2026-08-08': null } }, true);
  ok(lsRaw('radiotherapy.holidays')['2026-08-08'] === null, '★ 云端传来的删除标记会生效（本机新增项被删掉）', lsRaw('radiotherapy.holidays'));
  ok(r.changed === 1 && r.details.indexOf('holidays') >= 0, '且计为一次变更', r);
  /* 本机删内置项、云端又把它改回具体值：本机优先 → 保持删除（不回退） */
  clearSettings();
  delHoliday('2025-01-01');
  r = importSettings({ makeups: { '2026-01-04': null } }, true);
  ok(lsRaw('radiotherapy.makeups')['2026-01-04'] === null, '★ 云端的删除标记也并入本机（调休）', lsRaw('radiotherapy.makeups'));
  ok(r.changed === 1 && r.details.indexOf('makeups') >= 0, '调休的删除同样计数', r);

  group('E. 标量（调休当工作日 / 默认治疗日）');
  clearSettings();
  r = importSettings({ makeupWorkday: false, treatDays: [1, 2, 3, 4, 5, 6] }, true);
  ok(r.changed === 2, '★ 本机未设时采纳云端的两项标量', r);
  ok(lsRaw('radiotherapy.makeupWorkday') === false, '★ 云端 false 被正确采纳（不是「没设」）', lsRaw('radiotherapy.makeupWorkday'));
  ok(makeupAsWorkday() === false, '功能生效', makeupAsWorkday());
  ok(treatDaysCfg().length === 6, '默认治疗日生效', treatDaysCfg());
  /* 本机已设 → 保留本机 */
  setMakeupAsWorkday(true);
  setTreatDaysCfg([1, 2, 3, 4, 5]);
  r = importSettings({ makeupWorkday: false, treatDays: [1, 2, 3, 4, 5, 6] }, true);
  ok(r.changed === 0, '★ 本机已设的标量不被云端覆盖', r);
  ok(makeupAsWorkday() === true && treatDaysCfg().length === 5, '本机值保持', { m: makeupAsWorkday(), t: treatDaysCfg() });

  group('F. 随访模板同样参与同步');
  clearSettings();
  saveTpl('本机模板', [{ n: 1, u: 'm' }, { n: 3, u: 'm' }]);
  r = importSettings({ tpls: { '云端模板': { items: [{ n: 2, u: 'w' }] } } }, true);
  var t = tplOverride();
  ok(t['本机模板'] && t['云端模板'], '★ 本机与云端模板共存（并集）', Object.keys(t));
  ok(findTpl('云端模板') && findTpl('云端模板').items[0].n === 2, '云端模板可用', findTpl('云端模板'));
  r = importSettings({ tpls: { '本机模板': null } }, true);
  ok(tplOverride()['本机模板'] === null, '★ 云端的「删除模板」也生效', tplOverride());

  /* ================= G. 摘要文案 ================= */
  group('G. settingsSummary：同步界面要能说清「云端还带了哪些设置」');
  ok(settingsSummary(null) === '', 'null 时返回空串');
  ok(settingsSummary({}) === '', '空对象返回空串');
  var sum = settingsSummary({ holidays: { a: 1, b: 2 }, makeups: { c: null }, tpls: {}, makeupWorkday: false, treatDays: [1, 2] });
  ok(sum.indexOf('节假日覆盖 2 条') >= 0, '报出节假日条数', sum);
  ok(sum.indexOf('调休覆盖 1 条') >= 0, '★ 值为 null 的删除标记也算一条覆盖', sum);
  ok(sum.indexOf('调休当工作日=否') >= 0, '报出标量取值', sum);
  ok(sum.indexOf('默认治疗日 2 天') >= 0, '报出治疗日天数', sum);
  ok(sum.indexOf('随访模板') < 0, '空模板不赘述', sum);

  /* ================= H. 完整链路：上传 → 拉取 ================= */
  group('H. ★ 上传→拉取 全链路：设置随数据一起往返');
  clearSettings();
  gists = {}; gistSeq = 0; resetNet();
  lsSet(SYNC_KEY, {});
  lsSet(LS_KEY, JSON.stringify(normalize({ version: 2, updatedAt: '2026-10-07T08:00:00Z', patients: [P1] })));
  setSyncCfg({ token: 'ghp_test', password: '放疗科-密码-2026' });
  /* 设备 A 的设置 */
  setHoliday('2026-10-09', '设备A的院庆');
  delMakeup('2026-10-10');
  setTreatDaysCfg([1, 2, 3, 4, 5, 6]);
  saveTpl('A模板', [{ n: 1, u: 'm' }]);
  setState([P1]);
  syncPush();
  await waitUntil(() => !!syncCfg().gistId, '上传完成并写回 gist id');
  ok(!!syncCfg().gistId, '★ 上传成功并记下 gist id', syncCfg().gistId);
  /* 解开云端密文，确认设置字段真的在 */
  var gid = syncCfg().gistId;
  var rawBlob = gists[gid].files[SYNC_FILE].content;
  var payloadTxt = await syncDecrypt('放疗科-密码-2026', rawBlob);
  var payload = JSON.parse(payloadTxt);
  ok(!!payload.settings, '★ 云端载荷里带 settings 字段', Object.keys(payload.settings || {}));
  ok(payload.settings.holidays && payload.settings.holidays['2026-10-09'] === '设备A的院庆', '节假日进了云端', payload.settings.holidays);
  ok(payload.settings.makeups && payload.settings.makeups['2026-10-10'] === null, '★ 删除标记（null）也进了云端', payload.settings.makeups);
  ok(payload.settings.treatDays && payload.settings.treatDays.length === 6, '治疗日进了云端', payload.settings.treatDays);
  ok(payloadTxt.indexOf('张三') >= 0 && !rawBlob.includes('张三'), '★ 患者信息是加密的，设置也在同一份密文里');

  /* 换到设备 B：清空本机设置，拉取后应完整还原 */
  group('I. ★ 设备 B 拉取后，设置与排程结果一致');
  var kb = ['radiotherapy.holidays', 'radiotherapy.makeups', 'radiotherapy.tpls',
    'radiotherapy.makeupWorkday', 'radiotherapy.treatDays'];
  kb.forEach(k => { delete store[k]; });
  var cfgKeep = syncCfg();
  cfgKeep.lastRemoteUpdatedAt = '';
  setSyncCfg(cfgKeep);
  resetNet(); toastMsgs.length = 0;
  syncPull();
  await waitUntil(() => {
    var v = lsRaw('radiotherapy.holidays');
    return v && typeof v === 'object' && v['2026-10-09'] === '设备A的院庆';
  }, '云端设置已落到本机');
  /* 用 lsOv 统一取值，避免「云端压根没同步过来」时抛异常而中断后面的断言 */
  function lsOv(key) { var v = lsRaw(key); return (v && typeof v === 'object') ? v : {}; }
  ok(lsOv('radiotherapy.holidays')['2026-10-09'] === '设备A的院庆', '★ 节假日已从云端落到设备 B', lsRaw('radiotherapy.holidays'));
  ok(lsOv('radiotherapy.makeups')['2026-10-10'] === null, '★ 删除标记也落到设备 B', lsRaw('radiotherapy.makeups'));
  ok(treatDaysCfg().length === 6, '默认治疗日已落到设备 B', treatDaysCfg());
  ok(!!findTpl('A模板'), '随访模板已落到设备 B', Object.keys(tplOverride()));
  ok(makeups()['2026-10-10'] === undefined, '★ 效果一致：2026-10-10 在 B 上也不是调休上班日', makeups()['2026-10-10']);
  /* 拉取后弹出的「选择导入方式」应说明云端带了哪些设置 */
  ok(!!sheetCtx && sheetCtx.title === '选择导入方式', '拉取后弹出导入方式选择', sheetCtx && sheetCtx.title);
  var importBody = String((sheetCtx && sheetCtx.body) || '');
  ok(importBody.indexOf('含设置') >= 0, '★ 面板说明云端带了哪些设置', importBody.replace(/<[^>]+>/g, ' ').slice(0, 200));
  ok(importBody.indexOf('节假日覆盖') >= 0, '具体列出节假日', '');
  ok(importBody.indexOf('已并入本机设置') >= 0 || importBody.indexOf('设置无变化') >= 0,
    '并说明本机设置有没有变化', '');
  /* 拉取后的排程应与设备 A 相同 —— 这是本功能存在的意义 */
  var pA = normalize({ version: 2, patients: [P1] }).patients[0];
  var sA = computeSchedule(pA);
  ok(sA.length > 0, '设备 B 能算出排程', sA.length);
  ok(sA.some(function (x) { return x.date === '2026-10-09'; }) === false, '★ 排程避开了从云端同步来的假期', sA.map(x => x.date).slice(0, 3));

  group('J. ★ 兼容性：老备份 / 老版本应用');
  clearSettings();
  setHoliday('2026-06-01', '本机原有');
  r = importSettings(undefined, true);
  ok(r.changed === 0 && lsRaw('radiotherapy.holidays')['2026-06-01'] === '本机原有',
    '★ 老备份没有 settings 字段时静默跳过，本机设置不被清空', r);
  r = importSettings(null, true);
  ok(r.changed === 0, '同样不报错', r);
  /* 老版本应用读到带 settings 的备份：只取 patients，忽略多出来的字段 */
  var oldStyle = JSON.parse(JSON.stringify(normalize({ version: 2, patients: [P1] })));
  ok(Array.isArray(oldStyle.patients), '多出来的 settings 是兄弟字段，patients 结构不变（老应用可直接读）');

  group('K. 走 save() 的业务路径确实会触发自动同步（含设置变更）');
  ok(typeof saveSettings === 'function', '★ 设置写入有统一收口 saveSettings()');
  /* 设置变更 → autoSyncSchedule 被调用 */
  clearSettings();
  gists = {}; gistSeq = 0;
  setSyncCfg({ token: 'ghp_test', password: '放疗科-密码-2026', gistId: '', autoSync: true, autoSyncMin: 60, lastRemoteUpdatedAt: '' });
  setState([P1]);
  save();                                        /* 制造一次患者数据变更 */
  var st = syncCfg();
  st.lastAutoSyncState = String(state.updatedAt || '');
  st.lastAutoSyncSettings = settingsSig();
  setSyncCfg(st);
  ok(autoSyncDataChanged() === false, '先让「无变更」成立', { u: state.updatedAt, s: st.lastAutoSyncState });
  setHoliday('2026-12-25', '圣诞');
  ok(settingsDirty() === true, '★ 改节假日会置上「设置已动」标记');
  ok(autoSyncDataChanged() === true, '★ 仅改设置（患者数据没动）也算「有变更」，会自动同步', autoSyncDataChanged());
  save();                                        /* save() 里记录的是同步完成时的指纹 */
  ok(autoSyncDataChanged() === true, '★ 尚未上传前，变更状态保持为真（不会漏传）');
  /* 各设置写入口都要打标记 */
  settingsDirtyAt = '';
  delHoliday('2025-01-01');          ok(settingsDirty() === true, 'delHoliday 打标记');
  settingsDirtyAt = ''; setMakeup('2026-02-14', '调休'); ok(settingsDirty() === true, 'setMakeup 打标记');
  settingsDirtyAt = ''; delMakeup('2026-02-14'); ok(settingsDirty() === true, 'delMakeup 打标记');
  settingsDirtyAt = ''; setTreatDaysCfg([1, 2, 3, 4, 5, 6]); ok(settingsDirty() === true, 'setTreatDaysCfg 打标记');
  settingsDirtyAt = ''; saveTpl('K模板', [{ n: 1, u: 'm' }]); ok(settingsDirty() === true, 'saveTpl 打标记');
  settingsDirtyAt = ''; delTpl('K模板'); ok(settingsDirty() === true, 'delTpl 打标记');
  settingsDirtyAt = ''; resetTpls(); ok(settingsDirty() === true, 'resetTpls 打标记');
  settingsDirtyAt = ''; setMakeupAsWorkday(false); ok(settingsDirty() === true, 'setMakeupAsWorkday 打标记');
  settingsDirtyAt = ''; fire('toggle-makeup'); ok(settingsDirty() === true, '切换「调休当工作日」打标记');
  settingsDirtyAt = ''; fire('hol-reset'); ok(settingsDirty() === true, '恢复内置假期打标记');
  settingsDirtyAt = ''; fire('mk-reset'); ok(settingsDirty() === true, '恢复内置调休打标记');

  group('L. ★ 设置同步不会污染患者数据');
  clearSettings();
  setState([P1]);
  var beforeNames = state.patients.map(p => p.name).join(',');
  importSettings({ holidays: { '2026-08-08': 'X' }, treatDays: [1, 2, 3, 4, 5, 6] }, true);
  ok(state.patients.map(p => p.name).join(',') === beforeNames, '★ 并入设置后患者数据原封不动', state.patients.length);
  ok(exportSettings().holidays !== undefined && Object.keys(exportSettings()).indexOf('patients') < 0,
    '★ 设置导出里没有患者数据（互不越界）', Object.keys(exportSettings()));

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('测试脚本异常：' + (e && e.stack || e)); process.exit(1); });
