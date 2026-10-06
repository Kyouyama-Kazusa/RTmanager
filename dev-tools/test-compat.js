/* RTmanager 兼容性门禁（Compatibility Gate）
   用法：node test-compat.js
   目的：每次发布前拦截「会让老用户丢数据 / PWA 装不上 / 离线失效」的改动。
   与其余 test-*.js 的区别：那些验证功能是否正确，本套件验证的是
   **跨版本的不变式（契约）** —— 一旦破坏，线上用户的数据会静默损坏。

   设计原则：断言一律写成「正确行为」，全绿才可发布。 */
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

/* 可用 RT_APP_DIR 指定被测目录（故障注入演练 / 多副本对比时使用） */
const ROOT = process.env.RT_APP_DIR
  ? path.resolve(process.env.RT_APP_DIR)
  : appRoot();
const APP = path.join(ROOT, 'index.html');
const html = fs.readFileSync(APP, 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/m, '');

/* ---------- DOM 打桩（沿用既有测试的方式） ---------- */
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
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll() { return []; }, querySelector() { return null; },
  createElement() { return makeEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener() { }, documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = () => { }; global.confirm = () => true;
global.navigator = {};
global.URL.createObjectURL = () => 'blob:x';
global.URL.revokeObjectURL = () => { };
global.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; };
global.FileReader = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
global.setInterval = () => 0; global.clearInterval = () => { };

eval(js);

let pass = 0, fail = 0; const lines = [];
function ok(cond, msg, extra) {
  if (cond) pass++;
  else { fail++; lines.push('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(n) { lines.push(''); lines.push('--- ' + n + ' ---'); }

/* =====================================================================
   契约 1：localStorage 键名不得变更
   改任何一个键名 = 老用户打开新版后数据「凭空消失」（读的是空的新键）
   ===================================================================== */
group('契约 1 · 数据键名（改了老用户就读不到数据）');
{
  const required = [
    ['radiotherapy.v1', '患者主数据'],
    ['radiotherapy.snap.', '每日快照'],
    ['radiotherapy.backup.', '更新前备份'],
    ['radiotherapy.holidays', '自定义节假日'],
    ['radiotherapy.makeups', '自定义调休'],
    ['radiotherapy.makeupWorkday', '调休上班日开关'],
    ['radiotherapy.treatDays', '全局治疗日'],
    ['radiotherapy.tpls', '自定义随访模板'],
    ['radiotherapy.ai', 'AI 配置'],
    ['radiotherapy.sync', '云同步配置']
  ];
  required.forEach(function (pair) {
    ok(html.indexOf("'" + pair[0] + "'") >= 0, '键名保留：' + pair[0] + '（' + pair[1] + '）');
  });
  ok(typeof LS_KEY === 'string' && LS_KEY === 'radiotherapy.v1', 'LS_KEY 常量未被改写', LS_KEY);
}

/* =====================================================================
   契约 2：数据格式版本与迁移保护
   ===================================================================== */
group('契约 2 · 版本与迁移保护');
{
  ok(typeof SCHEMA_VERSION === 'number' && SCHEMA_VERSION >= 2, 'SCHEMA_VERSION 不低于 2', SCHEMA_VERSION);
  ok(/var LEGACY_STATUS_MAP[\s\S]{0,120}'暂停'[\s\S]{0,60}'在治'/.test(html),
    '旧状态「暂停」仍映射为「在治」');
  ok(/var LEGACY_STATUS_MAP[\s\S]{0,120}'随访中'[\s\S]{0,60}'治疗完成'/.test(html),
    '旧状态「随访中」仍映射为「治疗完成」');
  ok(/if \(fromV < SCHEMA_VERSION\)[\s\S]{0,400}BACKUP_PREFIX/.test(js),
    '★ 低版本数据进入时会自动备份原始档（迁移可回退）');
  ok(/function keepExtra/.test(js), 'keepExtra 存在（新字段自动保留的基础）');
}

/* =====================================================================
   契约 3：normalize 必须「只补齐、不丢弃」
   这是历次事故的根因（BUG-03 的 tplBase、BUG-02 的 boostFractions/stopDate）
   ===================================================================== */
group('契约 3 · normalize 只补齐不丢弃');
{
  const nm = js.match(/function normalize\(d\)\s*\{[\s\S]*?\n\}/);
  ok(!!nm, '能取到 normalize 函数体');
  if (nm) {
    const body = nm[0];
    ok(/keepExtra\(p,/.test(body), '★ 患者级字段走 keepExtra（新增字段不会丢）');
    ok(/keepExtra\(x,/.test(body), '中断/加照条目走 keepExtra');
    ok(/keepExtra\(r,/.test(body), '副反应条目走 keepExtra');
    const fCount = (body.match(/keepExtra\(f,/g) || []).length;
    ok(fCount >= 1, '随访条目走 keepExtra', fCount);
    ok(!/ patients: d\.patients \}/.test(body), '未直接透传未归一化的 patients');
  }
}

/* =====================================================================
   契约 4：★ 未来字段保留（最关键的一条）
   模拟「下个版本新增了字段、而用户数据里已经带着它」——
   normalize 必须原样保留，否则用户升级一次就丢一次数据。
   ===================================================================== */
group('契约 4 · 未知的未来字段必须原样保留');
{
  const fut = {
    version: SCHEMA_VERSION, updatedAt: '',
    patients: [{
      id: 'pf1', name: '未来字段', status: '在治', startDate: '2026-03-02', fractions: '30',
      treatDays: [1, 2, 3, 4, 5],
      someFieldFromV1_0: '下版本才有的新标量',
      someObjectFromV1_0: { nested: { deep: 42 } }
    }]
  };
  const out = normalize(JSON.parse(JSON.stringify(fut)));
  const p = out.patients[0];
  ok(p.someFieldFromV1_0 === '下版本才有的新标量', '★ 未知标量字段保留', p.someFieldFromV1_0);
  ok(p.someObjectFromV1_0 && p.someObjectFromV1_0.nested.deep === 42, '★ 未知对象字段保留');
  ok(p.name === '未来字段' && p.fractions === '30', '已知字段不受影响');

  /* 已知字段的完整性：v0.9 的全部业务字段都要在 */
  const must = ['id', 'mrn', 'name', 'sex', 'age', 'physician', 'diagnosis', 'purpose', 'technique',
    'simDate', 'position', 'planStatus', 'totalDose', 'fractions', 'dosePerFraction', 'startDate',
    'treatDays', 'pauses', 'extras', 'boostFractions', 'boostNote', 'stopDate', 'doneDates',
    'reactions', 'followupPlans', 'status', 'completedAt', 'notes'];
  const missing = must.filter(function (k) { return !(k in p); });
  ok(missing.length === 0, '★ 业务字段无缺失（新增字段后 normalize 必须同步声明）', missing);
}

/* =====================================================================
   契约 5：v0.1 老数据迁移无损（真实历史结构）
   ===================================================================== */
group('契约 5 · v0.1 老数据迁移无损');
{
  const legacy = {
    version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    patients: [{
      id: 'old1', name: '王建国', mrn: '123456', sex: '男', age: '58',
      diagnosis: '宫颈癌', status: '暂停', herbs: '中药调理',
      plannedStartDate: '2026-03-02', fractions: '33', totalDose: '70',
      sessions: [{ date: '2026-03-02' }, { date: '2026-03-03' }],
      reactions: [{ id: 'r1', site: '骨髓抑制', grade: '2级', status: '未处理', foundAt: '2026-03-10' }]
    }, {
      id: 'old2', name: '李秀兰', status: '随访中', plannedStartDate: '2026-02-01', fractions: '25'
    }]
  };
  const o = normalize(JSON.parse(JSON.stringify(legacy)));
  const a = o.patients[0], b = o.patients[1];
  ok(a.startDate === '2026-03-02', 'plannedStartDate → startDate', a.startDate);
  ok(a.doneDates.length === 2, 'sessions 并入 doneDates', a.doneDates);
  ok(a.herbs === '中药调理', '旧字段 herbs 未被丢弃', a.herbs);
  ok(a.status === '在治', '★ 旧状态「暂停」→「在治」（未静默改写）', a.status);
  ok(b.status === '治疗完成', '★ 旧状态「随访中」→「治疗完成」', b.status);
  ok(a.reactions[0].grade === '2级', '副反应字段保留', a.reactions[0].grade);
}

/* =====================================================================
   契约 6：读取失败时的写保护（loadError → save 必须拒绝）
   否则用户一添加患者就会把「空数据」写回，冲掉全部历史记录
   ===================================================================== */
group('契约 6 · 数据读取失败时的写保护');
{
  store[LS_KEY] = '{坏掉的 JSON';
  load();
  ok(loadError === true, '损坏数据被识别为 loadError');
  ok(!!rawSnapshot, '保留原始文本供抢救导出');
  const before = store[LS_KEY];
  save();
  ok(store[LS_KEY] === before, '★ loadError 时 save() 被拒绝，未覆盖原始数据');
  delete store[LS_KEY];
  load();
  ok(loadError === false, 'load() 会重置标记（不粘连上一次结果）');
}

/* =====================================================================
   契约 7：PWA 资源完整（装不上 / 离线白屏 都源于此）
   ===================================================================== */
group('契约 7 · PWA 资源完整');
{
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const m = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  ok(!!m, 'sw.js 中能取到 ASSETS 清单');
  if (m) {
    const assets = (m[1].match(/'\.\/[^']*'/g) || []).map(function (s) { return s.slice(1, -1); });
    ok(assets.indexOf('./index.html') >= 0, 'ASSETS 含 index.html');
    ok(assets.indexOf('./manifest.webmanifest') >= 0, 'ASSETS 含 manifest');
    ok(assets.indexOf('./apple-touch-icon.png') >= 0, 'ASSETS 含 iOS 桌面图标');
    assets.forEach(function (u) {
      if (u === './') return;
      const f = path.join(ROOT, u.replace(/^\.\//, ''));
      ok(fs.existsSync(f), '离线缓存的资源在磁盘存在：' + u);
    });
  }
  /* manifest 引用的图标必须真实存在（否则 Android 安装后图标空白） */
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  mf.icons.forEach(function (ic) {
    ok(fs.existsSync(path.join(ROOT, ic.src)), 'manifest 图标存在：' + ic.src);
  });
  ok(!!mf.start_url && !!mf.display, 'manifest 含 start_url 与 display（可安装的前提）');
  ok(fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll 存在（GitHub Pages 跳过 Jekyll）');
  ok(/rel="apple-touch-icon"/.test(html), 'index.html 声明了 apple-touch-icon（iOS 不认 SVG）');
  ok(/rel="manifest"/.test(html), 'index.html 声明了 manifest');
}

/* =====================================================================
   契约 8：版本与缓存号（决定用户能否拿到新版本）
   ===================================================================== */
group('契约 8 · 应用版本与 SW 缓存号');
{
  ok(/var APP_VERSION = '\d+\.\d+\.\d+'/.test(html), 'APP_VERSION 格式正确');
  const cur = swCacheOf();
  function swCacheOf() {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const m = sw.match(/CACHE = 'radiotherapy-v(\d+)'/);
    return m ? parseInt(m[1], 10) : null;
  }
  ok(typeof cur === 'number' && cur >= 13, 'SW 缓存号可解析且不低于 13（只增不减）', cur);
  ok(/self\.skipWaiting\(\)/.test(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')),
    'SW 保留 skipWaiting（新版本立即生效，不必等用户关页面）');
}

console.log(lines.join('\n'));
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
