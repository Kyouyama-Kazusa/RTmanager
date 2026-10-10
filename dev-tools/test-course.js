/* 治疗疗程（手术 / 化疗 / 放疗）与全程治疗时间轴测试
   覆盖：
   A. normalize 三层（疗程/周期/给药）字段补齐与未知字段保留
   B. 幂等：load → save → load 不丢、不重复备份
   C. treatmentTimeline 聚合：三类事件、排序、status 推算、纯放疗自动合成、跨年
   D. 增删改：走**渲染层**（fireFromHtml）点击 —— 不用 fire() 绕过渲染层
   E. 隔离红线：courses 不污染放疗排程 / 完成度 / 剂量统计 / 无网络调用
   F. radioSegments：放疗按非放疗事件切段（纯函数）
   G. 折叠行为（渲染层）：放疗段头/化疗给药子行默认收起、点击后真正展开
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
const APP = appRoot() + '/index.html';
const html = fs.readFileSync(APP, 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/, '');

/* ---------- DOM 打桩 ---------- */
const elById = {};
let clickHandler = null;                     /* 捕获 bind() 注册的点击委托 */
function makeEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() { }, contains(c) { return !!this._s[c]; } },
    addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; },
    onclick: null, dataset: {}, parentElement: null,
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
  querySelectorAll(sel) {
    /* 表单收集：sheetValues() 需要 #sheetBody [name] */
    if (sel === '#sheetBody [name]' && global.__sheetFields) return global.__sheetFields;
    return [];
  },
  createElement() { return makeEl(); },
  body: { appendChild() { }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; },
  documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:', href: 'file:///x/index.html' };
global.requestAnimationFrame = (cb) => { cb && cb(); };
const alertMsgs = [];
global.alert = (m) => { alertMsgs.push(m); };
global.confirm = () => (global.__confirmAnswer !== false);
global.navigator = {};
global.URL = { createObjectURL() { return 'x'; }, revokeObjectURL() { } };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.setInterval = () => 0; global.clearInterval = () => { };
/* 网络调用探针 */
const netCalls = [];
global.fetch = function (url, opt) { netCalls.push({ url: String(url), opt: opt || {} }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); };

eval(js);
bind();

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }

const today = todayStr();
function addDays(ds, n) {
  var d = parseD(ds); d.setDate(d.getDate() + n);
  return dstr(d);
}
/* 造患者（默认在治、周一~五治疗） */
function mk(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  state.patients[0].status = '在治';
  return state.patients[0];
}
/* 真·点击模拟：从已渲染 HTML 里取按钮，只用它自带的 data-* 派发 */
function fireFromHtml(htmlStr, act, nth) {
  const re = new RegExp('<button[^>]*data-act="' + act + '"[^>]*>', 'g');
  const all = String(htmlStr).match(re) || [];
  const tag = all[nth || 0];
  if (!tag) { ok(false, 'fireFromHtml: 找不到 data-act="' + act + '"', String(htmlStr).slice(0, 200)); return false; }
  const el = makeEl();
  const attrs = tag.match(/data-([a-z-]+)="([^"]*)"/g) || [];
  attrs.forEach(function (a) {
    const m = a.match(/data-([a-z-]+)="([^"]*)"/);
    if (m) el.dataset[m[1].replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = m[2];
  });
  clickHandler({ target: el });
  return true;
}
/* 模拟弹层保存：直接给 sheetCtx.onSave 传表单值 */
function saveSheet(vals) { return sheetCtx && sheetCtx.onSave ? sheetCtx.onSave(vals) : null; }

/* 按 data-key 精确点击折叠按钮 —— 不依赖位置下标。
   时间轴上「放疗段头」与「化疗周期」都是 timeline-fold，谁在前取决于日期，
   用下标会随当天日期漂移（跨日期扫描已抓到过这个坑），故按 key 定位。 */
function fireFold(htmlStr, key) {
  const re = /<button[^>]*data-act="timeline-fold"[^>]*>/g;
  const all = String(htmlStr).match(re) || [];
  const tag = all.filter(function (t) { return t.indexOf('data-key="' + key + '"') >= 0; })[0];
  if (!tag) { ok(false, 'fireFold: 找不到 data-key="' + key + '" 的折叠按钮', all.join(' | ').slice(0, 300)); return false; }
  const el = makeEl();
  (tag.match(/data-([a-z-]+)="([^"]*)"/g) || []).forEach(function (a) {
    const m = a.match(/data-([a-z-]+)="([^"]*)"/);
    if (m) el.dataset[m[1].replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = m[2];
  });
  clickHandler({ target: el });
  return true;
}

/* ================================================================ */
group('A. normalize 三层字段与未知字段');

{
  const raw = {
    version: 2, updatedAt: '', patients: [{
      id: 'pA', name: '甲', status: '在治', startDate: '2026-03-02', fractions: '30', treatDays: [1, 2, 3, 4, 5],
      courses: [
        { id: 'c1', kind: 'surgery', title: '根治术', date: '2026-01-10', note: '本院', 未来字段S: 1 },
        { id: 'c2', kind: 'chemo', title: '第1程', regimen: 'TP', 未来字段C: 'x',
          cycles: [{ id: 'cy1', n: 1, startDate: '2026-02-01', endDate: '2026-02-03', 未来字段CY: true,
            doses: [{ id: 'd1', date: '2026-02-01', drug: '紫杉醇', dose: 175, unit: 'mg/m2', 未来字段D: 9 }] }] }
      ]
    }]
  };
  const p = normalize(raw).patients[0];
  ok(Array.isArray(p.courses) && p.courses.length === 2, 'courses 保留两条疗程', p.courses && p.courses.length);
  const su = p.courses[0], ch = p.courses[1];
  ok(su.kind === 'surgery' && su.title === '根治术' && su.date === '2026-01-10', '手术疗程字段齐全', su);
  ok(ch.kind === 'chemo' && ch.regimen === 'TP', '化疗疗程字段齐全', ch);
  ok(ch.cycles.length === 1 && ch.cycles[0].n === 1, '周期保留', ch.cycles && ch.cycles.length);
  ok(ch.cycles[0].doses.length === 1 && ch.cycles[0].doses[0].drug === '紫杉醇', '给药保留', ch.cycles[0].doses);
  ok(String(ch.cycles[0].doses[0].dose) === '175', '给药剂量转字符串', ch.cycles[0].doses[0].dose);
  ok(su.未来字段S === 1, '★ 疗程层未知字段保留');
  ok(ch.未来字段C === 'x', '★ 疗程层未知字段保留(2)');
  ok(ch.cycles[0].未来字段CY === true, '★ 周期层未知字段保留');
  ok(ch.cycles[0].doses[0].未来字段D === 9, '★ 给药层未知字段保留');

  /* 非法 kind 退回 chemo；缺 courses → [] */
  const p2 = normalize({ version: 2, updatedAt: '', patients: [{ id: 'p2', name: '乙', status: '在治', courses: [{ id: 'x', kind: '乱写' }] }] }).patients[0];
  ok(p2.courses[0].kind === 'chemo', '非法 kind 退回 chemo', p2.courses[0].kind);
  const p3 = normalize({ version: 2, updatedAt: '', patients: [{ id: 'p3', name: '丙', status: '在治' }] }).patients[0];
  ok(Array.isArray(p3.courses) && p3.courses.length === 0, '老患者（无 courses）补为空数组');
}

/* ================================================================ */
group('B. 幂等：load → save → load');

{
  Object.keys(store).forEach(k => delete store[k]);
  const data = {
    version: 2, updatedAt: '', patients: [{
      id: 'pB', name: '幂等', status: '在治', startDate: '2026-03-02', fractions: '30', treatDays: [1, 2, 3, 4, 5],
      courses: [{ id: 'cb', kind: 'chemo', title: 'C', cycles: [{ id: 'cyb', n: 1, startDate: '2026-02-01', doses: [{ id: 'db', date: '2026-02-01', drug: '药' }] }] }]
    }]
  };
  store['radiotherapy.v1'] = JSON.stringify(data);
  load();
  var before = JSON.stringify(state.patients[0].courses);
  save();
  load();
  var after = JSON.stringify(state.patients[0].courses);
  ok(before === after, '两次 load 后 courses 完全一致（幂等）', { before: before.slice(0, 80), after: after.slice(0, 80) });
  const bk = Object.keys(store).filter(k => k.indexOf('radiotherapy.backup.') === 0);
  ok(bk.length <= 1, '未重复生成迁移备份', bk);
  ok(state.patients[0].courses[0].cycles[0].doses[0].drug === '药', '嵌套数据无丢失');
}

/* ================================================================ */
group('C. treatmentTimeline 聚合');

{
  /* C1. 三类事件齐全 + 排序 + status */
  const past = addDays(today, -30), future = addDays(today, 30);
  const p = mk({
    startDate: addDays(today, 40), fractions: '5',   /* 放疗在未来，避免与化疗混期干扰 */
    courses: [
      { id: 'c1', kind: 'surgery', title: '根治术', date: past },
      { id: 'c2', kind: 'chemo', title: '第1程', regimen: 'TP', cycles: [
        { id: 'cy1', n: 1, startDate: addDays(today, -20), endDate: addDays(today, -18),
          doses: [{ id: 'd1', date: addDays(today, -20), drug: '紫杉醇', dose: '175', unit: 'mg/m2' }] }
      ] }
    ]
  });
  const tl = treatmentTimeline(p);
  ok(tl.length > 0, '时间轴非空', tl.length);
  const kinds = {};
  tl.forEach(x => { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
  ok(kinds.surgery === 1, '含 1 条手术事件', kinds);
  ok(kinds.chemo >= 2, '含化疗周期+给药事件', kinds);
  ok(kinds.radio === 5, '含放疗 5 次事件（来自 computeSchedule）', kinds);
  /* 升序 */
  let asc = true;
  for (let i = 1; i < tl.length; i++) if (tl[i].date < tl[i - 1].date) asc = false;
  ok(asc, '★ 事件按日期升序');
  /* status 推算：过去=done，未来=planned */
  const suEv = tl.filter(x => x.kind === 'surgery')[0];
  ok(suEv.status === 'done', '过去的手术 → done', suEv.status);
  const radioEv = tl.filter(x => x.kind === 'radio')[0];
  ok(radioEv.status === 'planned', '未来的放疗 → planned', radioEv.status);

  /* C2. 同日排序权重：手术 < 化疗 < 放疗。
     注意：同一天必须确实是「治疗日」才会排出放疗事件（周末/节假日不排），
     否则放疗事件缺席会让「同日排序」无从检验。
     所以找一个「排程第一项正好落在该日」的日期（不能只看长度—— 
     排在别的日子也算长度为 1，那样同日就没有放疗事件了）。 */
  let same = addDays(today, -15);
  for (let off = 0; off < 30; off++) {
    const cand = addDays(today, -15 + off);
    const probe = mk({ startDate: cand, fractions: '1' });
    const sc = computeSchedule(probe);
    if (sc.length === 1 && sc[0].date === cand) { same = cand; break; }
  }
  const p2 = mk({
    startDate: same, fractions: '1',
    courses: [
      { id: 's', kind: 'surgery', title: '手术', date: same },
      { id: 'c', kind: 'chemo', title: '化疗', cycles: [{ id: 'cy', n: 1, startDate: same, doses: [] }] },
      { id: 'r', kind: 'radio', title: '放疗', radioRef: true }
    ]
  });
  const tl2 = treatmentTimeline(p2).filter(x => x.date === same);
  const order = tl2.map(x => x.kind).join('>');
  ok(order.indexOf('surgery') < order.indexOf('chemo') && order.indexOf('chemo') <= order.indexOf('radio'),
    '★ 同日排序：手术 < 化疗 < 放疗', order);

  /* C3. 纯放疗老患者 courses 为空 → 自动合成放疗事件流 */
  const p3 = mk({ startDate: addDays(today, -14), fractions: '10' });
  ok((p3.courses || []).length === 0, '前置：courses 为空');
  const tl3 = treatmentTimeline(p3);
  ok(tl3.length === 10, '★ 无 courses 的纯放疗患者自动生成放疗事件', tl3.length);
  ok(tl3.every(x => x.kind === 'radio'), '全部为放疗事件');
  /* 与 computeSchedule 完全一致 */
  const sch = computeSchedule(p3);
  ok(JSON.stringify(tl3.map(x => x.date)) === JSON.stringify(sch.map(x => x.date)),
    '★ 放疗事件日期与 computeSchedule 逐项一致（唯一真相）');

  /* C4. 跨年升序 */
  const p4 = mk({
    startDate: '2026-12-01', fractions: '30',
    courses: [{ id: 'x', kind: 'surgery', title: '手术', date: '2025-06-01' }]
  });
  const tl4 = treatmentTimeline(p4);
  ok(tl4[0].date === '2025-06-01', '跨年：最早事件在最前', tl4[0].date);
  ok(tl4[tl4.length - 1].date >= '2026-12-01', '跨年：最晚事件在最后', tl4[tl4.length - 1].date);

  /* C5. 未填 startDate 且无 courses → 空时间轴 */
  const p5 = mk({ name: '空', startDate: '', fractions: '' });
  ok(treatmentTimeline(p5).length === 0, '空患者时间轴为空');

  /* C6. 新建的 radio 疗程 title 用作前缀 */
  const p6 = mk({
    startDate: addDays(today, -3), fractions: '3',
    courses: [{ id: 'rc', kind: 'radio', title: '原发灶放疗', radioRef: true }]
  });
  const tl6 = treatmentTimeline(p6);
  ok(tl6[0].title.indexOf('原发灶放疗') === 0, '★ 放疗疗程 title 作为事件前缀', tl6[0].title);
  ok(tl6[0].courseId === 'rc', '放疗事件关联到疗程 id', tl6[0].courseId);
}

/* ================================================================ */
group('D. 增删改（走渲染层点击）');

{
  const p = mk({ name: '录入', startDate: addDays(today, -5), fractions: '10' });
  view.page = 'patient'; view.pid = p.id;
  render();
  const pageHtml = getEl('view').innerHTML;
  ok(pageHtml.indexOf('data-act="course-add"') >= 0, '详情页渲染出「新增疗程」按钮');
  ok(pageHtml.indexOf('治疗时间轴') >= 0, '详情页渲染出时间轴卡片');

  /* D1. 新增手术疗程。
     注意：course-add 是**页面级**动作（在当前患者详情页里新增），
     不跨语境，因此依赖 view.pid 是合理的 —— 这里保持 view.pid 有效。 */
  fireFromHtml(pageHtml, 'course-add');
  ok(getEl('sheetTitle').textContent.indexOf('疗程') >= 0, '★ 点「新增疗程」打开弹层', getEl('sheetTitle').textContent);
  ok(sheetCtx && sheetCtx.onSave, '弹层有保存回调');
  saveSheet({ kind: 'surgery', title: '根治术', date: '2026-01-10', site: '', note: '本院' });
  ok((p.courses || []).length === 1, '★ 手术疗程写入患者', (p.courses || []).length);
  ok(p.courses[0].kind === 'surgery' && p.courses[0].title === '根治术', '字段正确', p.courses[0]);
  const cid = p.courses[0].id;

  /* D2. 新增化疗疗程 → 加周期 → 加给药 */
  view.page = 'patient'; view.pid = p.id; render();
  fireFromHtml(getEl('view').innerHTML, 'course-add');
  saveSheet({ kind: 'chemo', title: '第1程化疗', regimen: 'TP方案', site: '', date: '', note: '' });
  const chemo = p.courses.filter(c => c.kind === 'chemo')[0];
  ok(!!chemo, '★ 化疗疗程写入');
  ok((chemo.cycles || []).length === 0, '新化疗疗程无周期');

  view.page = 'patient'; view.pid = p.id; render();
  const htmlWithChemo = getEl('view').innerHTML;
  const cycleAddBtn = String(htmlWithChemo).match(/data-act="cycle-add"[^>]*/);
  ok(!!cycleAddBtn && cycleAddBtn[0].indexOf('data-id="' + chemo.id + '"') >= 0,
    '★ 管理区「＋周期」按钮自带 data-id', cycleAddBtn && cycleAddBtn[0]);
  /* ★ v0.14.0：操作按钮全部上移到「治疗管理与概况」区。
     D2 前置断言：时间轴**事件流部分**不得再出现任何增删改按钮（只读）。
     ★ 注意：timelineHtml() 返回的卡片**同时包含**管理区，
       所以必须先把管理区（courseSummaryHtml 那段）切掉再扫，
       否则会误报 —— 管理区本来就该有按钮。 */
  {
    const tlFull = String(timelineHtml(p));
    const mgr = String(courseSummaryHtml(p));
    const cut = tlFull.indexOf(mgr);
    ok(cut > 0, 'D2 前置：管理区确实是卡片的一部分', cut);
    const tlOnly = cut > 0 ? tlFull.slice(cut + mgr.length) : tlFull;
    const acts = ['cycle-add', 'cycle-edit', 'cycle-del', 'dose-add', 'dose-edit', 'dose-del', 'course-edit', 'course-del'];
    const leaked = acts.filter(function (a) { return tlOnly.indexOf('data-act="' + a + '"') >= 0; });
    /* course-add（右上角＋疗程）与 timeline-fold/timeline-dir 属浏览态，允许保留 */
    ok(leaked.length === 0, '★★ D2 时间轴事件流内无任何增删改按钮（全部上移到管理区）', leaked);
    ok(tlFull.indexOf('data-act="course-add"') >= 0, '★ D2 时间轴仍保留「＋ 疗程」与排序按钮');
    ok(tlOnly.indexOf('data-act="timeline-fold"') >= 0, '★ D2 时间轴仍保留折叠展开（浏览用）');
  }
  fireFromHtml(htmlWithChemo, 'cycle-add');
  ok(getEl('sheetTitle').textContent.indexOf('周期') >= 0, '★ 点「＋周期」打开周期弹层', getEl('sheetTitle').textContent);
  saveSheet({ n: '1', startDate: '2026-02-01', endDate: '2026-02-03', note: '' });
  ok(chemo.cycles.length === 1 && chemo.cycles[0].n === 1, '★ 周期写入', chemo.cycles);

  /* D2b. ★ 管理区的周期明细默认收起 —— 未展开时看不到周期级按钮。
     展开后逐周期列出，才拿到 ＋给药 / 编辑周期 / 删除。 */
  view.page = 'patient'; view.pid = p.id; view.tlOpen = {}; render();
  {
    const hClosed = getEl('view').innerHTML;
    ok(hClosed.indexOf('data-act="dose-add"') < 0, '★ D2b 周期明细未展开 → 无 ＋给药 按钮');
    ok(hClosed.indexOf('tls-cyc') < 0, '★ D2b 周期明细未展开 → 不渲染周期行');
    view.page = 'patient'; view.pid = p.id; render();
    fireFromHtml(getEl('view').innerHTML, 'mg-fold');
    const hOpen = getEl('view').innerHTML;
    ok(hOpen.indexOf('tls-cyc') >= 0, '★★ D2b 点「周期明细」后渲染出周期行');
    ok(hOpen.indexOf('第 1 化疗周期') >= 0, '★ D2b 周期行显示「第 1 化疗周期」标题',
      (hOpen.match(/tls-cyc-n">[^<]*/) || [])[0]);
  }

  view.page = 'patient'; view.pid = p.id; render();
  const htmlWithCycle = getEl('view').innerHTML;
  const doseAddBtn = String(htmlWithCycle).match(/data-act="dose-add"[^>]*/);
  ok(!!doseAddBtn && doseAddBtn[0].indexOf('data-id="' + chemo.id + '"') >= 0 && doseAddBtn[0].indexOf('data-n="1"') >= 0,
    '★ 管理区周期行「＋给药」按钮自带 data-id 与 data-n', doseAddBtn && doseAddBtn[0]);
  fireFromHtml(htmlWithCycle, 'dose-add');
  ok(getEl('sheetTitle').textContent.indexOf('给药') >= 0, '★ 点「＋给药」打开给药弹层', getEl('sheetTitle').textContent);
  saveSheet({ date: '2026-02-01', drug: '紫杉醇', dose: '175', unit: 'mg/m2', note: '' });
  ok(chemo.cycles[0].doses.length === 1 && chemo.cycles[0].doses[0].drug === '紫杉醇', '★ 给药写入', chemo.cycles[0].doses);

  /* D3. 编辑给药：走管理区的给药明细行（周期已展开）。
     ★ v0.14.0 起给药明细在管理区**始终列出**（不再依赖时间轴折叠），
       因此这里不需要再 fireFold 展开时间轴，直接抓 dose-edit 即可。 */
  view.page = 'patient'; view.pid = p.id; view.tlOpen = {}; render();
  const cyId = chemo.cycles[0].id;
  /* 管理区需要先展开（mg-fold），否则周期与给药明细都不渲染 */
  fireFromHtml(getEl('view').innerHTML, 'mg-fold');
  view.page = 'patient'; view.pid = p.id; render();
  const doseHtml = getEl('view').innerHTML;
  const doseEditBtn = String(doseHtml).match(/data-act="dose-edit"[^>]*/);
  ok(!!doseEditBtn && doseEditBtn[0].indexOf('data-dose="') >= 0, '★ 给药「编辑」按钮自带 data-dose', doseEditBtn && doseEditBtn[0]);
  ok(String(doseHtml).indexOf('tls-dose') >= 0, '★ D3 管理区列出给药明细行（tls-dose）');
  fireFromHtml(doseHtml, 'dose-edit');
  const did = chemo.cycles[0].doses[0].id;
  saveSheet({ date: '2026-02-01', drug: '紫杉醇', dose: '200', unit: 'mg/m2', note: '调量' });
  ok(String(chemo.cycles[0].doses[0].dose) === '200', '★ 编辑给药生效（不新增条目）', chemo.cycles[0].doses[0]);
  ok(chemo.cycles[0].doses.length === 1, '编辑不产生重复条目', chemo.cycles[0].doses.length);

  /* D4. 删除给药（管理区周期仍处于展开态） */
  global.__confirmAnswer = true;
  view.page = 'patient'; view.pid = p.id; render();
  const delHtml = getEl('view').innerHTML;
  const doseDelBtn = String(delHtml).match(/data-act="dose-del"[^>]*/);
  ok(!!doseDelBtn && doseDelBtn[0].indexOf('data-dose="') >= 0, '★ 给药「删除」按钮自带 data-dose', doseDelBtn && doseDelBtn[0]);
  fireFromHtml(delHtml, 'dose-del');
  ok(chemo.cycles[0].doses.length === 0, '★ 删除给药生效', chemo.cycles[0].doses.length);
  view.tlOpen = {};

  /* D5. 删除周期（先展开管理区拿到 cycle-del） */
  view.page = 'patient'; view.pid = p.id; view.tlOpen = {}; render();
  fireFromHtml(getEl('view').innerHTML, 'mg-fold');
  view.page = 'patient'; view.pid = p.id; render();
  fireFromHtml(getEl('view').innerHTML, 'cycle-del');
  ok(chemo.cycles.length === 0, '★ 删除周期生效', chemo.cycles.length);

  /* D6. 删除疗程（管理区第一行的 course-del） */
  view.page = 'patient'; view.pid = p.id; view.tlOpen = {}; render();
  const before = p.courses.length;
  const courseDelBtn = String(getEl('view').innerHTML).match(/data-act="course-del"[^>]*/);
  ok(!!courseDelBtn && courseDelBtn[0].indexOf('data-id="') >= 0, '★ 疗程「删除」按钮自带 data-id', courseDelBtn && courseDelBtn[0]);
  fireFromHtml(getEl('view').innerHTML, 'course-del');
  ok(p.courses.length === before - 1, '★ 删除疗程生效', { before: before, after: p.courses.length });

  /* D7. 正/倒序切换按钮 */
  view.page = 'patient'; view.pid = p.id; render();
  const dirBtn = String(getEl('view').innerHTML).match(/data-act="timeline-dir"[^>]*/);
  ok(!!dirBtn && dirBtn[0].indexOf('data-dir=') >= 0, '★ 正/倒序切换按钮自带 data-dir', dirBtn && dirBtn[0]);
  const d0 = view.tlDesc;
  fireFromHtml(getEl('view').innerHTML, 'timeline-dir');
  ok(view.tlDesc !== d0, '★ 点击切换排序方向', { before: d0, after: view.tlDesc });
  view.tlDesc = false;
}

/* ================================================================ */
group('E. 隔离红线');

{
  /* E1. 有化疗数据时，放疗排程与统计完全不受影响 */
  const base = { name: '隔离', status: '在治', startDate: '2026-03-02', fractions: '20', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5] };
  const noChe = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ id: 'x1' }, base)] }).patients[0];
  const withChe = normalize({
    version: 2, updatedAt: '', patients: [Object.assign({ id: 'x2' }, base, {
      courses: [{ id: 'c', kind: 'chemo', title: 'C', cycles: [{ id: 'cy', n: 1, startDate: '2025-01-01', doses: [{ id: 'd', date: '2025-01-01', drug: '药', dose: '999' }] }] }]
    })]
  }).patients[0];
  ok(JSON.stringify(computeSchedule(noChe)) === JSON.stringify(computeSchedule(withChe)),
    '★ 放疗排程不受化疗数据影响');
  ok(doneCount(noChe) === doneCount(withChe), '★ 完成次数不受影响');
  ok(accumulatedDose(noChe) === accumulatedDose(withChe), '★ 累计剂量不受影响');
  ok(scheduleEnd(noChe) === scheduleEnd(withChe), '★ 结束日期不受影响');

  /* E2. 教学：courses 不参与 verifyPending / followup 起算 */
  ok(typeof treatmentTimeline === 'function', 'treatmentTimeline 存在');
  ok(timelineEmpty(noChe) === false || noChe.startDate === '', 'timelineEmpty 判定可用');

  /* E3. 无网络调用（数据不出设备） */
  const netBefore = netCalls.length;
  const p = mk({ courses: [{ id: 'c', kind: 'surgery', title: 'S', date: '2026-01-01' }] });
  treatmentTimeline(p);
  upsertCourse(p.id, null, { kind: 'chemo', title: 'X' });
  delCourse(p.id, p.courses[p.courses.length - 1].id);
  ok(netCalls.length === netBefore, '★ 疗程操作全程无网络调用');
}

/* ================================================================ */
group('F. radioSegments：放疗按非放疗事件切段');

{
  /* 造事件的小工具：只关心 kind/date，其余字段不参与切段逻辑 */
  function rEv(date) { return { kind: 'radio', date: date, title: 'R' + date }; }
  function cEv(date) { return { kind: 'chemo', date: date, title: 'C' + date }; }
  function sEv(date) { return { kind: 'surgery', date: date, title: 'S' + date }; }

  /* F0. 空输入 */
  ok(JSON.stringify(radioSegments([])) === '[]', 'F0 空输入 → []');
  ok(JSON.stringify(radioSegments(null)) === '[]', 'F0 null → []');

  /* F1. 纯放疗、无掺杂 → 1 段，count 与首尾日期正确 */
  {
    const evs = [rEv('2026-03-02'), rEv('2026-03-03'), rEv('2026-03-04')];
    const segs = radioSegments(evs);
    ok(segs.length === 1, 'F1 无掺杂 → 1 段', segs.length);
    ok(segs[0].count === 3, 'F1 count = 3', segs[0] && segs[0].count);
    ok(segs[0].from === '2026-03-02' && segs[0].to === '2026-03-04', 'F1 首尾日期正确',
      segs[0] && [segs[0].from, segs[0].to]);
  }

  /* F2. 中间夹 1 次化疗 → 2 段，边界日期为「化疗前一日 / 化疗后一日」 */
  {
    const evs = [rEv('2026-03-02'), rEv('2026-03-03'), cEv('2026-03-04'), rEv('2026-03-05'), rEv('2026-03-06')];
    const segs = radioSegments(evs);
    ok(segs.length === 2, 'F2 夹 1 次化疗 → 2 段', segs.length);
    ok(segs[0].to === '2026-03-03', 'F2 第1段止于化疗前一日', segs[0] && segs[0].to);
    ok(segs[1].from === '2026-03-05', 'F2 第2段起于化疗后一日', segs[1] && segs[1].from);
    ok(segs[0].count === 2 && segs[1].count === 2, 'F2 两段计数各为 2',
      segs.map(function (s) { return s.count; }));
  }

  /* F3. 夹 2 次化疗 → 3 段 */
  {
    const evs = [
      rEv('2026-03-02'), cEv('2026-03-03'), rEv('2026-03-04'), cEv('2026-03-05'), rEv('2026-03-06')
    ];
    const segs = radioSegments(evs);
    ok(segs.length === 3, 'F3 夹 2 次化疗 → 3 段', segs.length);
  }

  /* F4. 首/尾为非放疗事件 → 段数不受影响，非放疗事件不进任何段 */
  {
    const evs = [sEv('2026-01-10'), rEv('2026-03-02'), rEv('2026-03-03'), cEv('2026-04-01')];
    const segs = radioSegments(evs);
    ok(segs.length === 1, 'F4 首尾非放疗 → 仍为 1 段', segs.length);
    ok(segs[0].from === '2026-03-02' && segs[0].to === '2026-03-03', 'F4 段范围仅含放疗事件',
      segs[0] && [segs[0].from, segs[0].to]);
  }

  /* F5. 段内事件全为 radio，且各段 count 之和 = 放疗事件总数（无丢失/无重复） */
  {
    const evs = [
      rEv('2026-01-01'), rEv('2026-01-02'), cEv('2026-01-03'),
      rEv('2026-01-04'), sEv('2026-01-05'), rEv('2026-01-06'), rEv('2026-01-07'), rEv('2026-01-08')
    ];
    const segs = radioSegments(evs);
    const totalRadioIn = evs.filter(function (x) { return x.kind === 'radio'; }).length;
    const sumCount = segs.reduce(function (a, s) { return a + s.count; }, 0);
    const allRadio = segs.every(function (s) { return s.events.every(function (e) { return e.kind === 'radio'; }); });
    ok(segs.length === 3, 'F5 混合序列 → 3 段', segs.length);
    ok(allRadio, 'F5 各段 events 全为 radio');
    ok(sumCount === totalRadioIn, 'F5 各段计数之和 = 放疗事件总数', { sumCount: sumCount, in: totalRadioIn });
    /* events 引用原对象：确保渲染时能拿到 title/status 等字段 */
    ok(segs[0].events[0] === evs[0], 'F5 events 保留原事件对象引用');
  }

  /* F6. 通过 treatmentTimeline 的真实数据验证切段（端到端） */
  {
    /* 放疗 2026-03-02 起、工作日治疗；化疗周期起始日落在放疗期间 */
    const p = mk({
      startDate: '2026-03-02', fractions: '10', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5],
      courses: [{ id: 'cc', kind: 'chemo', title: '同步化疗', cycles: [{ id: 'cyc', n: 1, startDate: '2026-03-04' }] }]
    });
    const ev = treatmentTimeline(p);
    const segs = radioSegments(ev);
    const radioTotal = ev.filter(function (x) { return x.kind === 'radio'; }).length;
    ok(radioTotal === 10, 'F6 放疗共 10 次', radioTotal);
    ok(segs.length === 2, 'F6 真实数据：化疗夹在中间 → 2 段', segs.length);
    ok(segs.reduce(function (a, s) { return a + s.count; }, 0) === 10, 'F6 真实数据：段计数之和为 10');
  }
}

/* ================================================================ */
group('G. 折叠行为（渲染层）');

{
  /* G0. 纯放疗、无掺杂：默认全部折叠，只出 1 条段头 */
  {
    const p = mk({ id: 'g0', name: 'G0', startDate: '2026-03-02', fractions: '20', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5] });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    let h = timelineHtml(p);
    const segHeads = (h.match(/class="tl-item radio tl-seg"/g) || []).length;
    const radioRows = (h.match(/class="tl-item radio"/g) || []).length;
    ok(segHeads === 1, 'G0 默认渲染：1 条放疗段头', segHeads);
    ok(radioRows === 0, '★ G0 默认渲染：放疗逐次行完全不出现（默认折叠）', radioRows);
    ok(/data-act="timeline-fold"/.test(h), 'G0 段头带 timeline-fold');
    ok(/data-key="r2026-03-02_/.test(h), 'G0 段头带 data-key（r + from…）', (h.match(/data-key="[^"]*"/) || [])[0]);
    ok(/▸ 展开逐次/.test(h), 'G0 折叠态文案为「▸ 展开逐次」');

    /* 展开该段：逐次行出现，数量 = count */
    const key = (h.match(/data-key="(r[^"]*)"/) || [])[1];
    view.tlOpen[key] = 1;
    h = timelineHtml(p);
    const rows2 = (h.match(/class="tl-item radio"/g) || []).length;
    ok(rows2 === 20, '★ G0 展开后：放疗逐次行 = 20', rows2);
    ok(/▾ 收起逐次/.test(h), 'G0 展开态文案为「▾ 收起逐次」');
    view.tlOpen = {};
  }

  /* G1. 走 fireFromHtml：点击段头能真正触发展开（渲染层闭环） */
  {
    const p = mk({ id: 'g1', name: 'G1', startDate: '2026-03-02', fractions: '6', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5] });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h0 = timelineHtml(p);
    ok((h0.match(/class="tl-item radio"/g) || []).length === 0, 'G1 前置：默认无逐次行');
    fireFromHtml(h0, 'timeline-fold', 0);
    const h1 = timelineHtml(p);
    ok((h1.match(/class="tl-item radio"/g) || []).length === 6, '★ G1 点击段头后逐次行出现 6 条',
      (h1.match(/class="tl-item radio"/g) || []).length);
    fireFromHtml(h1, 'timeline-fold', 0);
    ok((timelineHtml(p).match(/class="tl-item radio"/g) || []).length === 0, 'G1 再点一次收起');
    view.tlOpen = {};
  }

  /* G2. 掺杂化疗：段数正确，化疗行始终可见（不被折叠吞掉） */
  {
    const p = mk({
      id: 'g2', name: 'G2', startDate: '2026-03-02', fractions: '10', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5],
      courses: [{ id: 'cc2', kind: 'chemo', title: '同步化疗', cycles: [{ id: 'cyc2', n: 1, startDate: '2026-03-04' }] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    const segHeads = (h.match(/class="tl-item radio tl-seg"/g) || []).length;
    ok(segHeads === 2, '★ G2 掺杂化疗 → 2 条放疗段头', segHeads);
    ok((h.match(/class="tl-item chemo"/g) || []).length === 1, '★ G2 化疗周期行保持可见');
    ok((h.match(/class="tl-item radio"/g) || []).length === 0, 'G2 两段默认均折叠');
  }

  /* G3. 修复假折叠：化疗给药子行默认隐藏，展开后才出现 */
  {
    const p = mk({
      id: 'g3', name: 'G3',
      courses: [{
        id: 'cc3', kind: 'chemo', title: 'AC 方案', cycles: [{
          id: 'cyc3', n: 1, startDate: '2026-02-01',
          doses: [
            { id: 'd31', date: '2026-02-01', drug: '阿霉素', dose: '60', unit: 'mg/m2' },
            { id: 'd32', date: '2026-02-01', drug: '环磷酰胺', dose: '600', unit: 'mg/m2' }
          ]
        }]
      }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    let h = timelineHtml(p);
    ok((h.match(/class="tl-item chemo sub"/g) || []).length === 0,
      '★★ G3 修复假折叠：给药子行默认不渲染',
      (h.match(/class="tl-item chemo sub"/g) || []).length);
    ok(/▸ 展开给药/.test(h), 'G3 化疗折叠按钮文案为「▸ 展开给药」');
    ok((h.match(/data-act="timeline-fold"/g) || []).length === 1, 'G3 化疗周期带折叠按钮');

    fireFold(h, 'cyc3');
    h = timelineHtml(p);
    ok((h.match(/class="tl-item chemo sub"/g) || []).length === 2,
      '★ G3 展开后给药子行 = 2', (h.match(/class="tl-item chemo sub"/g) || []).length);
    ok(/▾ 收起给药/.test(h), 'G3 展开态文案为「▾ 收起给药」');
    view.tlOpen = {};
  }

  /* G4. 倒序模式下段头位置正确（不应跑到段尾） */
  {
    const p = mk({ id: 'g4', name: 'G4', startDate: '2026-03-02', fractions: '5', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5] });
    view.pid = p.id; view.tlDesc = true; view.tlOpen = {};
    const h = timelineHtml(p);
    const segPos = h.indexOf('class="tl-item radio tl-seg"');
    const foldPos = h.indexOf('data-act="timeline-fold"');
    ok(segPos >= 0 && foldPos > segPos, 'G4 倒序：段头仍在折叠按钮之前', { segPos: segPos, foldPos: foldPos });
    view.tlDesc = false; view.tlOpen = {};
  }
}

/* ================================================================ */
group('H. 顶部治疗概况与末尾疗程管理（渲染层）');

{
  /* H1. courseSummaryHtml 存在、返回字符串、无治疗时给空态 */
  ok(typeof courseSummaryHtml === 'function', 'H1 courseSummaryHtml 存在');
  {
    const p = mk({ name: 'H1空', startDate: '', fractions: '' });
    const s = courseSummaryHtml(p);
    ok(typeof s === 'string' && s.length > 0, 'H1 返回非空字符串');
    ok(s.indexOf('tls-empty') >= 0, 'H1 无任何治疗 → 空态', s.slice(0, 80));
    ok(s.indexOf('tls-row') < 0, 'H1 空态不含治疗行');
  }

  /* H2. ★ 概况区绝不污染 tl-item / timeline-fold 正则计数
     （test-course.js G 组对 tl-item 系列做精确等值断言，match 是子串匹配，
       概况区一旦蹭到这些片段，G0/G2/G3 会集体误红 —— 这条断言把约束钉死） */
  {
    const p = mk({
      name: 'H2', startDate: '2026-03-02', fractions: '10', dosePerFraction: '2',
      courses: [
        { id: 'hs', kind: 'surgery', title: '手术', date: '2026-02-01' },
        { id: 'hc', kind: 'chemo', title: '化疗', cycles: [{ id: 'hy', n: 1, startDate: '2026-03-03' }] }
      ]
    });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tl-item') < 0, '★★ H2 概况区不含 tl-item 片段', s.indexOf('tl-item'));
    ok(s.indexOf('timeline-fold') < 0, '★★ H2 概况区不含 timeline-fold');
    ok(s.indexOf('data-key="r') < 0, '★★ H2 概况区不含 data-key="r');
    ok(s.indexOf('展开逐次') < 0 && s.indexOf('展开给药') < 0, '★ H2 概况区不含折叠文案');
  }

  /* H3. 放疗行：数字与治疗进度同口径（doneCount / plannedCount） */
  {
    const p = mk({ name: 'H3', startDate: '2026-03-02', fractions: '20', dosePerFraction: '2' });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tls-radio') >= 0, 'H3 纯放疗患者概况含放疗行');
    ok(s.indexOf('已完成 ' + doneCount(p) + '/' + plannedCount(p) + ' 次') >= 0,
      '★★ H3 放疗「已完成 x/y 次」与 doneCount/plannedCount 一致',
      { expect: doneCount(p) + '/' + plannedCount(p) });
    ok(s.indexOf('tls-chemo') < 0 && s.indexOf('tls-surgery') < 0,
      'H3 无化疗/手术 → 对应行隐藏');
  }

  /* H4. 放疗数字随处方次数变化（动态正确性，防写死） */
  {
    const a = mk({ name: 'H4a', startDate: '2026-03-02', fractions: '10' });
    const b = mk({ name: 'H4b', startDate: '2026-03-02', fractions: '25' });
    const sa = courseSummaryHtml(a), sb = courseSummaryHtml(b);
    ok(sa.indexOf('/10 次') >= 0 && sb.indexOf('/25 次') >= 0,
      '★ H4 放疗总数随 fractions 变化', { a: sa.match(/已完成 \d+\/\d+/), b: sb.match(/已完成 \d+\/\d+/) });
  }

  /* H5. 化疗行：方案名 + 周期数 */
  {
    const p = mk({
      name: 'H5',
      courses: [{ id: 'c5', kind: 'chemo', title: '第1程', regimen: 'TP方案', cycles: [
        { id: 'y51', n: 1, startDate: '2026-02-01' }, { id: 'y52', n: 2, startDate: '2026-02-21' }
      ] }]
    });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tls-chemo') >= 0, 'H5 化疗行出现');
    ok(s.indexOf('第1程') >= 0 && s.indexOf('TP方案') >= 0, 'H5 含疗程名与方案名');
    ok(/2 周期/.test(s), '★ H5 周期数正确（2）', s.match(/\d+ 周期/));
    ok(s.indexOf('最近 02/21') >= 0, '★ H5 最近周期日期取最新一条', s.match(/最近 [\d/]*/));
  }

  /* H6. 手术行：术式名 + 日期 */
  {
    const p = mk({ name: 'H6', courses: [{ id: 's6', kind: 'surgery', title: '根治术', date: '2026-01-10' }] });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tls-surgery') >= 0, 'H6 手术行出现');
    ok(s.indexOf('根治术') >= 0, 'H6 含术式名');
    ok(s.indexOf('01/10') >= 0, '★ H6 含日期', s.match(/tls-meta">[^<]*/));
  }

  /* H7. 三类齐全 → 三个 class 各出现 */
  {
    const p = mk({
      name: 'H7', startDate: '2026-03-02', fractions: '5',
      courses: [
        { id: 'h7s', kind: 'surgery', title: '手术', date: '2026-02-01' },
        { id: 'h7c', kind: 'chemo', title: '化疗', cycles: [{ id: 'h7y', n: 1, startDate: '2026-03-03' }] }
      ]
    });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tls-radio') >= 0 && s.indexOf('tls-chemo') >= 0 && s.indexOf('tls-surgery') >= 0,
      '★ H7 三类行齐全');
    ok((s.match(/class="tls-row/g) || []).length === 3, 'H7 恰好 3 行', (s.match(/class="tls-row/g) || []).length);
  }

  /* H8. ★ 无事件化疗疗程（刚建、还没排周期）仍能拿到「＋ 周期」——
     这是 test-course.js D2 的命脉，也是真实用户必经路径。
     ★ v0.14.0：入口从时间轴末尾移到顶部管理区，且时间轴走空态分支也不再
       重复给出按钮（管理区已是唯一入口）。 */
  {
    const p = mk({
      name: 'H8', startDate: '2026-03-02', fractions: '5',
      courses: [{ id: 'h8c', kind: 'chemo', title: '空化疗', cycles: [] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    const btn = String(h).match(/<button[^>]*data-act="cycle-add"[^>]*>/);
    ok(!!btn, '★★ H8 无事件化疗疗程仍渲染「＋ 周期」', btn && btn[0]);
    ok(!!btn && btn[0].indexOf('data-id="h8c"') >= 0, '★★ H8 该按钮自带正确 data-id', btn && btn[0]);
    /* 管理区行用 tls-row 承载（不再是末尾的 tls-actrow） */
    ok((h.match(/class="tls-row tls-chemo"/g) || []).length === 1, 'H8 管理区用 tls-row 承载该疗程');
  }

  /* H9. 完全无事件且无疗程 → 纯空态文案 */
  {
    const p = mk({ name: 'H9', startDate: '', fractions: '' });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    ok(h.indexOf('tl-empty') >= 0, 'H9 全空 → 空态提示');
    ok(h.indexOf('cycle-add') < 0, 'H9 无疗程 → 无 cycle-add');
    ok(h.indexOf('tls-empty') >= 0, 'H9 无疗程 → 管理区给空态');
  }

  /* H10. ★ 管理区（顶部）：每个疗程恰好一个 course-del，且都带 data-id。
     ★ v0.14.0：管理区从时间轴**末尾**移到**顶部**，行 class 由 tls-actrow
       改为 tls-row（带类别后缀），但「每疗程恰好一个删除按钮」的约束不变。 */
  {
    const p = mk({
      name: 'H10', startDate: '2026-03-02', fractions: '6', dosePerFraction: '2',
      courses: [
        { id: 'hAs', kind: 'surgery', title: '手术', date: '2026-03-03' },
        { id: 'hAc', kind: 'chemo', title: '化疗', cycles: [{ id: 'hAy', n: 1, startDate: '2026-03-04' }] },
        { id: 'hAr', kind: 'radio', title: '放疗' }
      ]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    /* 管理区在卡片顶部：应出现在时间轴「年」分节之前 */
    const mgrPos = h.indexOf('tls-surgery');
    const yearPos = h.indexOf('class="tl-year"');
    ok(mgrPos >= 0 && (yearPos < 0 || mgrPos < yearPos), '★★ H10 管理区位于时间轴之前（顶部）', { mgrPos: mgrPos, yearPos: yearPos });
    const dels = h.match(/<button[^>]*data-act="course-del"[^>]*>/g) || [];
    ok(dels.length === 2, '★★ H10 course-del 恰好 2 个（手术+化疗；放疗行只给备注）', dels.length);
    ok(dels.every(d => d.indexOf('data-id="') >= 0), '★★ H10 每个 course-del 都自带 data-id');
    /* D6 就是抓第一个 course-del —— 这里正面复验它可用 */
    ok(dels.length > 0 && dels[0].indexOf('data-id="') >= 0, '★ H10 第一个 course-del 可被 D6 抓取且带 data-id', dels[0]);
    ok(h.indexOf('tls-radio') >= 0, '★ H10 放疗在管理区也有一行');
    ok(h.indexOf('data-act="radio-note"') >= 0, '★ H10 放疗行给「备注」按钮');
  }

  /* H11. 放疗被切成多段时，疗程级按钮**不重复**堆在每段段头上 */
  {
    const p = mk({
      name: 'H11', startDate: '2026-03-02', fractions: '10', dosePerFraction: '2',
      courses: [
        { id: 'hBc', kind: 'chemo', title: '同步化疗', cycles: [{ id: 'hBy', n: 1, startDate: '2026-03-04' }] },
        { id: 'hBr', kind: 'radio', title: '放疗' }
      ]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    const segs = (h.match(/class="tl-item radio tl-seg"/g) || []).length;
    ok(segs === 2, 'H11 前置：放疗被切成 2 段', segs);
    const rDel = (h.match(/<button[^>]*data-act="course-del"[^>]*data-id="hBr"[^>]*>/g) || []).length;
    ok(rDel === 0, '★ H11 放疗不提供 course-del（改为备注入口，避免删掉自动排程）', rDel);
    const rNote = (h.match(/<button[^>]*data-act="radio-note"[^>]*>/g) || []).length;
    ok(rNote === 1, '★ H11 放疗「备注」只出现 1 次（不随段数膨胀）', rNote);
    const segsFold = (h.match(/data-act="timeline-fold"/g) || []).length;
    ok(segsFold === 2, '★ H11 两个放疗段头各有折叠按钮（浏览用）', segsFold);
  }

  /* H12. 时间轴不再输出废弃的疗程头 class（tl-cname/tl-course） */
  {
    const p = mk({ name: 'H12', startDate: '2026-03-02', fractions: '5' });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    ok(h.indexOf('tl-cname') < 0, '★ H12 不再输出 tl-cname（疗程头已废弃）');
    ok(h.indexOf('tl-course') < 0, '★ H12 不再输出 tl-course');
  }

  /* H13. 倒序不影响管理区与按钮可用性。
     ★ v0.14.0：管理区在时间轴之前、且**不随倒序反转**（它不参与日期语义），
       所以倒序下它仍在顶部。 */
  {
    const p = mk({
      name: 'H13', startDate: '2026-03-02', fractions: '6', dosePerFraction: '2',
      courses: [{ id: 'hCc', kind: 'chemo', title: '化疗', cycles: [{ id: 'hCy', n: 1, startDate: '2026-03-04' }] }]
    });
    view.pid = p.id; view.tlDesc = true; view.tlOpen = {};
    const h = timelineHtml(p);
    ok(h.indexOf('tls-radio') >= 0, 'H13 倒序下管理区放疗行仍在');
    ok((h.match(/class="tls-row tls-chemo"/g) || []).length === 1, 'H13 倒序下化疗管理行完整');
    ok((h.match(/<button[^>]*data-act="cycle-add"[^>]*>/g) || []).length === 1, 'H13 倒序下 cycle-add 仍可用');
    /* 倒序下放疗段头仍排在管理区之后 */
    const mgrEnd = h.indexOf('tls-actrow') >= 0 ? h.indexOf('tls-actrow') : h.indexOf('class="tl-year"');
    const segPos = h.indexOf('class="tl-item radio tl-seg"');
    ok(segPos > mgrEnd, '★ H13 倒序下管理区仍在时间轴之前', { segPos: segPos, mgrEnd: mgrEnd });
    view.tlDesc = false; view.tlOpen = {};
  }

  /* H14. 管理区在详情页里真实渲染出来（端到端，不只手调函数） */
  {
    const p = mk({
      name: 'H14', startDate: '2026-03-02', fractions: '5',
      courses: [{ id: 'hDs', kind: 'surgery', title: '根治术', date: '2026-03-03' }]
    });
    view.page = 'patient'; view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    render();
    const pageHtml = String(getEl('view').innerHTML);
    ok(pageHtml.indexOf('tls-radio') >= 0, '★★ H14 详情页渲染出管理区放疗行');
    ok(pageHtml.indexOf('tls-surgery') >= 0, '★★ H14 详情页渲染出管理区手术行');
    ok(pageHtml.indexOf('tls-row') >= 0, '★ H14 详情页渲染出管理区行容器（tls-row）');
    ok(pageHtml.indexOf('data-act="radio-note"') >= 0, '★ H14 详情页渲染出放疗备注入口');
  }
}

/* ================================================================ */
group('I. 其他治疗（kind=other）：枚举钳制 / 时间轴 / 概况 / AI 通道');

{
  /* I1. 枚举与配色表齐备 —— 缺任何一张表，normalize 都会把 other 改写成化疗 */
  ok(COURSE_KINDS.indexOf('other') >= 0, '★ I1 COURSE_KINDS 含 other', COURSE_KINDS);
  ok(COURSE_KIND_LABELS.other === '其他治疗', '★ I1 标签为「其他治疗」', COURSE_KIND_LABELS.other);
  ok(typeof COURSE_KIND_CHIPS.other === 'string' && COURSE_KIND_CHIPS.other, '★ I1 有 chip 配色', COURSE_KIND_CHIPS.other);
  ok(COURSE_KINDS_CYCLIC.indexOf('other') >= 0 && COURSE_KINDS_CYCLIC.indexOf('chemo') >= 0,
    '★ I1 other 与 chemo 同为「有周期结构」类别', COURSE_KINDS_CYCLIC);

  /* I2. ★★ 归一化保真：other 不被静默改写成 chemo
     （normalize 里 `COURSE_KINDS.indexOf(c.kind)>=0 ? c.kind : 'chemo'` 是最大陷阱） */
  {
    const p = mk({
      name: 'I2', startDate: '2026-03-02', fractions: '5',
      courses: [{ kind: 'other', title: '奥希替尼靶向治疗', cycles: [{ n: 1, startDate: '2026-03-05', doses: [{ date: '2026-03-05', drug: '奥希替尼', dose: '80', unit: 'mg' }] }] }]
    });
    ok(p.courses.length === 1, 'I2 一条 other 疗程保留');
    ok(p.courses[0].kind === 'other', '★★ I2 kind 保真为 other（未被钳制成 chemo）', p.courses[0].kind);
    ok(p.courses[0].cycles.length === 1 && p.courses[0].cycles[0].doses.length === 1, 'I2 周期与用药层级保留');
    ok(p.courses[0].id && p.courses[0].cycles[0].id && p.courses[0].cycles[0].doses[0].id, 'I2 三层 id 均已补齐');
  }

  /* I3. 未知 kind 仍然回落 chemo（不能因为加了 other 就放宽钳制） */
  {
    const p = mk({ name: 'I3', startDate: '2026-03-02', fractions: '5', courses: [{ kind: 'nonsense', title: 'X' }] });
    ok(p.courses[0].kind === 'chemo', '★ I3 未知 kind 仍回落到 chemo', p.courses[0].kind);
  }

  /* I4. 时间轴：other 事件按周期/用药展开，权重 2 / 2.5 */
  {
    const p = mk({
      name: 'I4', startDate: '2026-03-02', fractions: '5',
      courses: [
        { kind: 'chemo', title: 'AP方案', cycles: [{ n: 1, startDate: '2026-03-10' }] },
        { kind: 'other', title: '靶向治疗', cycles: [{ n: 1, startDate: '2026-03-10', doses: [{ date: '2026-03-10', drug: '奥希替尼', dose: '80', unit: 'mg' }] }] }
      ]
    });
    const ev = treatmentTimeline(p);
    const oth = ev.filter(x => x.kind === 'other');
    ok(oth.length === 2, '★ I4 other 展开为「周期 + 用药」两条', oth.length);
    ok(oth.every(x => x.kind === 'other'), '★ I4 事件 kind 标为 other');
    ok(oth.some(x => x.title === '靶向治疗 · 第 1 周期'), 'I4 周期行标题含疗程名与周期号',
      oth.map(x => x.title));
    ok(oth.some(x => x.parentId), 'I4 用药子行带 parentId（可折叠）');
    /* 同日排序：surgery0 < chemo1 < other2 < radio3 */
    const same = ev.filter(x => x.date === '2026-03-10');
    ok(same[0].kind === 'chemo' && same[1].kind === 'other', '★ I4 同日 other 排在 chemo 之后', same.map(x => x.kind));
  }

  /* I5. ★ radio 仍是全局最末权重 —— 保证 radioSegments 切段行为不变 */
  {
    const p = mk({
      name: 'I5', startDate: '2026-03-10', fractions: '3',
      courses: [{ kind: 'other', title: '靶向治疗', cycles: [{ n: 1, startDate: '2026-03-10' }] }]
    });
    const same = treatmentTimeline(p).filter(x => x.date === '2026-03-10');
    ok(same[same.length - 1].kind === 'radio',
      '★★ I5 同日 radio 仍排最后（否则 G 组切段断言会漂移）', same.map(x => x.kind));
  }

  /* I6. 只有日期、没有周期的 other（AI 简写常见）也必须在时间轴上可见 */
  {
    const p = mk({ name: 'I6', startDate: '2026-03-02', fractions: '5', courses: [{ kind: 'other', title: '中药调理', date: '2026-04-01' }] });
    const oth = treatmentTimeline(p).filter(x => x.kind === 'other');
    ok(oth.length === 1, '★★ I6 无周期但有日期的 other，合成一条可见事件', oth.length);
    ok(oth[0].date === '2026-04-01' && oth[0].title === '中药调理', 'I6 事件日期与名称正确',
      oth.length ? oth[0].date + '/' + oth[0].title : '(空)');
  }

  /* I7. 概况区多出 tls-other 行，且仍不污染 tl-item 精确计数 */
  {
    const p = mk({
      name: 'I7', startDate: '2026-03-02', fractions: '5',
      courses: [
        { kind: 'surgery', title: '术', date: '2026-03-01' },
        { kind: 'chemo', title: '化', cycles: [{ n: 1, startDate: '2026-03-04' }] },
        { kind: 'other', title: '靶', cycles: [{ n: 1, startDate: '2026-03-05' }] }
      ]
    });
    const s = courseSummaryHtml(p);
    ok(s.indexOf('tls-other') >= 0, '★ I7 概况区出现其他治疗行');
    ok((s.match(/class="tls-row/g) || []).length === 4, '★★ I7 四类各一行（放疗+化疗+其他+手术）',
      (s.match(/class="tls-row/g) || []).length);
    ok(s.indexOf('tl-item') < 0, '★★ I7 概况区仍不含 tl-item 片段（不污染 G 组计数）', s.indexOf('tl-item'));
    ok(s.indexOf('其他治疗') >= 0, 'I7 行内显示中文标签');
  }

  /* I8. 管理区：other 也有「＋ 周期」，且按钮自带 data-id */
  {
    const p = mk({
      name: 'I8', startDate: '2026-03-02', fractions: '5',
      courses: [{ id: 'iO', kind: 'other', title: '靶向', cycles: [{ id: 'iOc', n: 1, startDate: '2026-03-05' }] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = timelineHtml(p);
    const add = h.match(/<button[^>]*data-act="cycle-add"[^>]*>/g) || [];
    ok(add.length === 1, '★ I8 other 疗程也有「＋ 周期」按钮', add.length);
    ok(add.length > 0 && add[0].indexOf('data-id="iO"') >= 0, '★ I8 按钮带正确的 data-id', add[0]);
    ok((h.match(/class="tls-row tls-other"/g) || []).length === 1, '★ I8 管理区用 tls-row tls-other 承载');
  }

  /* I9. other 的周期级操作：走「＋ 用药 / 编辑周期 / 删除」（管理区展开后） */
  {
    const p = mk({
      name: 'I9', startDate: '2026-03-02', fractions: '5',
      courses: [{ id: 'iO2', kind: 'other', title: '靶向', cycles: [{ id: 'iOc2', n: 1, startDate: '2026-03-05', doses: [{ id: 'iOd2', date: '2026-03-05', drug: '奥希替尼', dose: '80', unit: 'mg' }] }] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    /* 时间轴仍渲染 other 周期行（浏览），且折叠文案为「用药」 */
    let h = timelineHtml(p);
    ok((h.match(/class="tl-item other"/g) || []).length === 1, '★ I9 时间轴渲染出 other 周期行');
    ok(h.indexOf('▸ 展开用药') >= 0, '★ I9 时间轴折叠文案为「▸ 展开用药」（区别于化疗「给药」）');
    /* 展开管理区：周期级按钮文案为「＋ 用药」 */
    view.tlOpen = {}; view.pid = p.id; render();
    const mgKeyV = 'mg' + 'iO2';
    const hMgrOpen = (function () { view.tlOpen[mgKeyV] = 1; return timelineHtml(p); })();
    ok(hMgrOpen.indexOf('＋ 用药') >= 0, '★ I9 管理区周期按钮文案为「＋ 用药」');
    ok(hMgrOpen.indexOf('第 1 其他治疗周期') >= 0, '★ I9 管理区周期标题带上类别名',
      (hMgrOpen.match(/tls-cyc-n">[^<]*/) || [])[0]);
    ok(hMgrOpen.indexOf('tls-dose') >= 0, '★ I9 管理区列出给药明细（tls-dose）');
    /* 展开时间轴用药明细 */
    view.tlOpen = { iOc2: 1 };
    h = timelineHtml(p);
    ok((h.match(/class="tl-item other sub"/g) || []).length === 1, '★ I9 时间轴展开后出现 other 用药子行',
      (h.match(/class="tl-item other sub"/g) || []).length);
    ok(h.indexOf('▾ 收起用药') >= 0, 'I9 时间轴折叠按钮文案为「收起用药」');
    view.tlOpen = {};
  }

  /* I10. 化疗文案未被污染：时间轴与管理员都仍是「给药」 */
  {
    const p = mk({
      name: 'I10', startDate: '2026-03-02', fractions: '5',
      courses: [{ id: 'iC', kind: 'chemo', title: '化疗', cycles: [{ id: 'iCc', n: 1, startDate: '2026-03-05', doses: [{ id: 'iCd', date: '2026-03-05', drug: '顺铂' }] }] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    let h = timelineHtml(p);
    view.tlOpen['iCc'] = 1;
    h = timelineHtml(p);
    ok(h.indexOf('收起给药') >= 0, '★★ I10 时间轴化疗折叠文案仍为「给药」');
    view.tlOpen = { mgiC: 1 };
    h = timelineHtml(p);
    ok(h.indexOf('＋ 给药') >= 0, '★★ I10 管理区化疗周期按钮仍为「＋ 给药」（未被 other 覆盖）');
    ok(h.indexOf('第 1 化疗周期') >= 0, '★ I10 管理区化疗周期标题为「第 1 化疗周期」',
      (h.match(/tls-cyc-n">[^<]*/) || [])[0]);
    view.tlOpen = {};
  }

  /* I11. AI 通道：normalizeAiOtherList 结构化 + 容错 */
  {
    ok(typeof normalizeAiOtherList === 'function', 'I11 normalizeAiOtherList 存在');
    const l = normalizeAiOtherList([
      { title: '奥希替尼靶向治疗', startDate: '2026-03-01', cycles: [{ n: 1, startDate: '2026-03-01', drug: '奥希替尼', dose: '80', unit: 'mg' }] },
      { name: 'PD-1免疫治疗', courses: [{ date: '2026/05/06', drug: '帕博利珠单抗' }] }
    ]);
    ok(l.length === 2, '★ I11 两条其他治疗被识别', l.length);
    ok(l.every(c => c.kind === 'other'), '★★ I11 kind 一律落成 other（AI 通道不产生别的 kind）');
    ok(l.every(c => c.createdVia === 'ai'), '★ I11 createdVia 标记为 ai（可追溯来源）');
    ok(l[1].title === 'PD-1免疫治疗', 'I11 近义字段名 name 被接受', l[1].title);
    ok(l[1].startDate === '2026-05-06', '★ I11 斜杠日期被规范成 ISO', l[1].startDate);
    ok(l[1].cycles.length === 1 && l[1].cycles[0].doses.length === 1, '★ I11 近义 cycles/drug 被归一，单次用药合成 doses',
      JSON.stringify(l[1].cycles));
    ok(normalizeAiOtherList([]).length === 0 && normalizeAiOtherList(null).length === 0, '★ I11 空值安全');
    ok(normalizeAiOtherList([{ title: '', note: '' }]).length === 0, '★ I11 全空条目被丢弃');
    ok(normalizeAiOtherList('靶向治疗\n免疫治疗').length === 2, '★ I11 纯字符串按行拆成多条');
  }

  /* I12. AI 通道：parseAiOtherText 两种写法 + 非法 JSON 必须报错而非静默清空 */
  {
    const simple = parseAiOtherText('奥希替尼靶向治疗 | 2026-03-01 | 2026-06-01 | 80mg qd');
    ok(simple.ok && simple.list.length === 1, '★ I12 简写「名称|开始|结束|备注」可解析');
    ok(simple.list[0].title === '奥希替尼靶向治疗' && simple.list[0].startDate === '2026-03-01'
      && simple.list[0].endDate === '2026-06-01' && simple.list[0].note === '80mg qd',
      '★ I12 简写四个字段各就各位', JSON.stringify(simple.list[0]));
    ok(parseAiOtherText('').ok && parseAiOtherText('').list.length === 0, '★ I12 空文本 = 无其他治疗（合法）');
    ok(parseAiOtherText(JSON.stringify([{ title: 'X' }])).ok, '★ I12 JSON 数组可解析');
    const bad = parseAiOtherText('[{"title":"x",}]');
    ok(bad.ok === false && !!bad.err, '★★ I12 非法 JSON 返回 ok=false 与错误信息（不静默清空）', bad.err);
  }

  /* I13. 端到端：AI 复核文本框 → 落库 → 时间轴可见 */
  {
    const parsed = parseAiOtherText('奥希替尼靶向治疗 | 2026-03-01 |  | 80mg qd');
    const p = normalize({ version: 2, patients: [{
      name: 'I13', status: '在治', treatDays: [1, 2, 3, 4, 5],
      startDate: '2026-03-02', fractions: '5',
      pauses: [], extras: [], doneDates: [], reactions: [], followupPlans: [], notes: [],
      courses: parsed.list
    }]}).patients[0];
    ok(p.courses.length === 1 && p.courses[0].kind === 'other', '★★ I13 导入后 kind 仍为 other', p.courses[0].kind);
    ok(treatmentTimeline(p).filter(x => x.kind === 'other').length === 1,
      '★★ I13 导入的患者在时间轴上能看到这条其他治疗');
    ok(courseSummaryHtml(p).indexOf('tls-other') >= 0, '★★ I13 概览区也显示出来');
  }

  /* I14. 幂等：other 往返不丢、不被改写成 chemo */
  {
    const p = mk({
      name: 'I14', startDate: '2026-03-02', fractions: '5',
      courses: [{ kind: 'other', title: '靶向', cycles: [{ n: 1, startDate: '2026-03-05', doses: [{ date: '2026-03-05', drug: '奥希替尼' }] }] }]
    });
    const again = normalize({ version: 2, patients: [JSON.parse(JSON.stringify(p))] }).patients[0];
    ok(again.courses[0].kind === 'other', '★★ I14 二次归一化 kind 仍为 other');
    ok(again.courses[0].cycles.length === 1 && again.courses[0].cycles[0].doses.length === 1, '★ I14 二次归一化周期/用药不丢');
  }

  /* I15. AI_FIELDS 不得被污染（其他治疗走独立通道） */
  {
    ok(AI_FIELDS.length === 15, '★★ I15 AI_FIELDS 仍为 15 项（其他治疗未塞进扁平字段表）', AI_FIELDS.length);
    ok(AI_FIELDS.indexOf('otherTreatments') < 0, '★★ I15 AI_FIELDS 不含 otherTreatments（避免破坏单值假设）');
  }

  /* I16. 手工新增 other 疗程：保存后引导录入第 1 周期（走真实弹层 onSave） */
  {
    const p = mk({ name: 'I16', startDate: '2026-03-02', fractions: '5' });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    sheetCourse(p, null);
    const r = sheetCtx && sheetCtx.onSave ? sheetCtx.onSave({ kind: 'other', title: '免疫治疗', note: '' }) : null;
    const created = p.courses[p.courses.length - 1];
    ok(p.courses.length === 1, '★ I16 新增 other 疗程成功', p.courses.length);
    ok(created.kind === 'other' && created.title === '免疫治疗', '★ I16 kind/名称写入正确', created.kind + '/' + created.title);
    ok(r === false, '★ I16 onSave 返回 false（让位给周期弹层，不直接关窗）', r);
    ok(!!sheetCtx && String(sheetCtx.title).indexOf('周期') >= 0,
      '★ I16 已自动切到「周期」弹层', sheetCtx && sheetCtx.title);
  }
}

/* ================================================================ */
group('J. 操作上移：管理区承载全部按钮 / 时间轴纯浏览（v0.14.0）');

{
  /* 造一个四类齐全、化疗与其他治疗各有周期与给药的患者 */
  function jPatient() {
    return mk({
      name: 'J', startDate: '2026-03-02', fractions: '10', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5],
      courses: [
        { id: 'js', kind: 'surgery', title: '根治术', date: '2026-03-01' },
        { id: 'jc', kind: 'chemo', title: '第1程化疗', regimen: 'AP方案', cycles: [
          { id: 'jcy1', n: 1, startDate: '2026-03-04', doses: [{ id: 'jd1', date: '2026-03-04', drug: '培美曲塞', dose: '500', unit: 'mg/m2' }] },
          { id: 'jcy2', n: 2, startDate: '2026-03-11', doses: [{ id: 'jd2', date: '2026-03-11', drug: '顺铂', dose: '75', unit: 'mg/m2' }] }
        ]},
        { id: 'jo', kind: 'other', title: '奥希替尼靶向治疗', cycles: [
          { id: 'joy1', n: 1, startDate: '2026-03-05', doses: [{ id: 'jod1', date: '2026-03-05', drug: '奥希替尼', dose: '80', unit: 'mg' }] }
        ]},
        { id: 'jr', kind: 'radio', title: '原发灶放疗' }
      ]
    });
  }
  const MGR_ACTS = ['mg-fold', 'cycle-add', 'cycle-edit', 'cycle-del', 'dose-add', 'dose-edit', 'dose-del', 'course-edit', 'course-del', 'radio-note'];

  /* J1. ★★ 时间轴事件流内**零**操作按钮（仅保留 course-add / timeline-dir / timeline-fold） */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const full = String(timelineHtml(p));
    const mgr = String(courseSummaryHtml(p));
    const cut = full.indexOf(mgr);
    ok(cut > 0, 'J1 前置：能在卡片里定位到管理区');
    const tlOnly = full.slice(cut + mgr.length);
    const leaked = MGR_ACTS.filter(function (a) { return tlOnly.indexOf('data-act="' + a + '"') >= 0; });
    ok(leaked.length === 0, '★★ J1 时间轴事件流内不含任何管理类按钮', leaked);
    /* 浏览态按钮必须保留。注意：正/倒序在卡片头（管理区**之前**），
       所以要在整张卡片里查，而不是切出来的 tlOnly。 */
    ok(full.indexOf('data-act="timeline-dir"') >= 0, '★ J1 保留正/倒序切换');
    ok(tlOnly.indexOf('data-act="timeline-fold"') >= 0, '★ J1 保留折叠展开（浏览用）');
    ok(full.indexOf('data-act="course-add"') >= 0, '★ J1 保留「＋ 疗程」');
  }

  /* J2. ★★ 管理区含齐四类的操作入口（放疗备注 / 化疗 / 其他 / 手术） */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const m = String(courseSummaryHtml(p));
    ok(m.indexOf('data-act="radio-note"') >= 0, '★ J2 放疗行有「备注」');
    ok((m.match(/class="tls-row tls-chemo"/g) || []).length === 1, '★ J2 化疗管理行 1 行');
    ok((m.match(/class="tls-row tls-other"/g) || []).length === 1, '★ J2 其他治疗管理行 1 行');
    ok((m.match(/class="tls-row tls-surgery"/g) || []).length === 1, '★ J2 手术管理行 1 行');
    ok((m.match(/class="tls-row tls-radio"/g) || []).length === 1, '★ J2 放疗管理行 1 行');
    ok((m.match(/class="tls-row/g) || []).length === 4, '★★ J2 恰好 4 行（四类各一）', (m.match(/class="tls-row/g) || []).length);
    /* 手术行必须有「改日期」 */
    ok(m.indexOf('>改日期</button>') >= 0, '★ J2 手术行有「改日期」');
  }

  /* J3. ★★ 周期明细默认收起；展开后逐周期列出且每周期带三按钮 */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    let m = String(courseSummaryHtml(p));
    ok(m.indexOf('tls-cyc') < 0, '★★ J3 默认不渲染周期明细（收起）');
    ok(m.indexOf('data-act="dose-add"') < 0, '★★ J3 收起时无「＋给药」（用户看不到也不该有）');
    /* 展开化疗疗程 */
    view.tlOpen['mgjc'] = 1;
    m = String(courseSummaryHtml(p));
    ok((m.match(/class="tls-cyc"/g) || []).length === 2, '★★ J3 展开后渲染 2 个周期行',
      (m.match(/class="tls-cyc"/g) || []).length);
    ok((m.match(/data-act="cycle-edit"/g) || []).length === 2, '★ J3 每周期一个「编辑周期」');
    ok((m.match(/data-act="cycle-del"/g) || []).length === 2, '★ J3 每周期一个「删除」');
    ok((m.match(/data-act="dose-add"/g) || []).length === 2, '★ J3 每周期一个「＋给药」');
    ok(m.indexOf('第 1 化疗周期') >= 0 && m.indexOf('第 2 化疗周期') >= 0, '★ J3 周期标题带序号与类别名');
    /* 给药明细行：每周期各 1 条 */
    ok((m.match(/class="tls-dose"/g) || []).length === 2, '★ J3 列出 2 条给药明细',
      (m.match(/class="tls-dose"/g) || []).length);
    ok((m.match(/data-act="dose-edit"/g) || []).length === 2, '★ J3 每条明细一个「编辑」');
    ok((m.match(/data-act="dose-del"/g) || []).length === 2, '★ J3 每条明细一个「删除」');
  }

  /* J4. ★★ 每个按钮都自带定位参数（绝不依赖 view.pid） */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = { mgjc: 1, mgjo: 1 };
    const m = String(courseSummaryHtml(p));
    const grab = function (act) { return m.match(new RegExp('<button[^>]*data-act="' + act + '"[^>]*>', 'g')) || []; };
    grab('cycle-add').forEach(function (b) { ok(b.indexOf('data-id="') >= 0, '★ J4 cycle-add 带 data-id', b); });
    grab('cycle-edit').forEach(function (b) { ok(b.indexOf('data-id="') >= 0 && b.indexOf('data-n="') >= 0, '★ J4 cycle-edit 带 data-id + data-n', b); });
    grab('cycle-del').forEach(function (b) { ok(b.indexOf('data-id="') >= 0 && b.indexOf('data-n="') >= 0, '★ J4 cycle-del 带 data-id + data-n', b); });
    grab('dose-add').forEach(function (b) { ok(b.indexOf('data-id="') >= 0 && b.indexOf('data-n="') >= 0, '★ J4 dose-add 带 data-id + data-n', b); });
    grab('dose-edit').forEach(function (b) { ok(b.indexOf('data-dose="') >= 0, '★ J4 dose-edit 带 data-dose', b); });
    grab('dose-del').forEach(function (b) { ok(b.indexOf('data-dose="') >= 0, '★ J4 dose-del 带 data-dose', b); });
    grab('course-edit').forEach(function (b) { ok(b.indexOf('data-id="') >= 0, '★ J4 course-edit 带 data-id', b); });
    grab('course-del').forEach(function (b) { ok(b.indexOf('data-id="') >= 0, '★ J4 course-del 带 data-id', b); });
  }

  /* J5. ★★ 化疗与其他治疗的措辞互不污染（给药 vs 用药） */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = { mgjc: 1, mgjo: 1 };
    const m = String(courseSummaryHtml(p));
    ok(m.indexOf('＋ 给药') >= 0, '★★ J5 化疗周期按钮为「＋ 给药」');
    ok(m.indexOf('＋ 用药') >= 0, '★★ J5 其他治疗周期按钮为「＋ 用药」');
    ok(m.indexOf('第 1 化疗周期') >= 0, '★★ J5 化疗周期标题用「化疗」');
    ok(m.indexOf('第 1 其他治疗周期') >= 0, '★★ J5 其他治疗周期标题用「其他治疗」');
  }

  /* J6. ★★ 管理区展开键（mg 前缀）与时间轴折叠键互不干扰 */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false;
    /* 只展开时间轴的化疗周期，不展开管理区 */
    view.tlOpen = { jcy1: 1 };
    const m1 = String(courseSummaryHtml(p));
    ok(m1.indexOf('tls-cyc') < 0, '★★ J6 时间轴展开周期不影响管理区（管理区仍收起）');
    /* 只展开管理区，不展开时间轴 */
    view.tlOpen = { mgjc: 1 };
    const h2 = String(timelineHtml(p));
    ok((h2.match(/class="tl-item chemo sub"/g) || []).length === 0, '★★ J6 管理区展开不影响时间轴（给药子行仍收起）');
    ok(h2.indexOf('tls-cyc') >= 0, '★ J6 管理区自身确实展开了');
    view.tlOpen = {};
  }

  /* J7. ★★ 管理区在时间轴**之前**（含倒序），且不随时间倒序反转 */
  {
    const p = jPatient();
    view.pid = p.id; view.tlOpen = {};
    [false, true].forEach(function (desc) {
      view.tlDesc = desc;
      const h = String(timelineHtml(p));
      const mgrPos = h.indexOf('class="tls"');
      const tlPos = h.indexOf('class="tl-item');
      ok(mgrPos >= 0 && tlPos > mgrPos, '★★ J7 ' + (desc ? '倒序' : '正序') + '下管理区仍排在时间轴之前',
        { mgrPos: mgrPos, tlPos: tlPos });
    });
    view.tlDesc = false;
  }

  /* J8. ★★ 无事件疗程不再「死路」：管理区仍给出 ＋周期。
     ★ 注意事项：患者**必须不带放疗**（fractions 为空），否则放疗逐次会自己
       产生大量事件、走不到时间轴空态分支 —— 这条断言就失去意义了。 */
  {
    const p = mk({
      name: 'J8', startDate: '', fractions: '',
      courses: [{ id: 'j8o', kind: 'other', title: '刚建的其他治疗', cycles: [] }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = String(timelineHtml(p));
    const btn = h.match(/<button[^>]*data-act="cycle-add"[^>]*>/);
    ok(!!btn && btn[0].indexOf('data-id="j8o"') >= 0, '★★ J8 无周期无事件的其他治疗仍能加周期', btn && btn[0]);
    ok(h.indexOf('tl-empty') >= 0, '★ J8 时间轴走空态文案');
    ok(h.indexOf('tls-row') >= 0, '★ J8 管理区仍在（不随空态消失）');
  }

  /* J9. ★★ 放疗「备注」按钮：无 radio 疗程时 data-id 为空（由处理器兜底补建） */
  {
    const p = mk({ name: 'J9', startDate: '2026-03-02', fractions: '5' });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const m = String(courseSummaryHtml(p));
    ok(m.indexOf('data-act="radio-note"') >= 0, '★★ J9 纯放疗患者也有「备注」入口');
    const btn = m.match(/<button[^>]*data-act="radio-note"[^>]*>/);
    ok(!!btn && btn[0].indexOf('data-id=""') >= 0, '★ J9 无 radio 疗程时 data-id 为空（交由处理器补建）', btn && btn[0]);
  }

  /* J10. ★★ 管理区不污染 tl-item 精确计数（G 组红线） */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = { mgjc: 1, mgjo: 1 };
    const m = String(courseSummaryHtml(p));
    ok(m.indexOf('tl-item') < 0, '★★ J10 管理区（含展开态）不含 tl-item 片段', m.indexOf('tl-item'));
    ok(m.indexOf('timeline-fold') < 0, '★★ J10 管理区不含 timeline-fold');
    ok(m.indexOf('data-key="r') < 0, '★★ J10 管理区不含 data-key="r');
    ok(m.indexOf('class="tl-') < 0, '★★ J10 管理区不含任何 tl- 前缀 class');
  }

  /* J11. ★★ 展开态下 G 组计数仍精确（端到端：管理区展开 + 时间轴展开同时进行）
     ★ 注意 J11 自身的局限：G 组用的是 /class="tl-item chemo"/g 形式，
       它要求 class 的**第一个** token 就是 tl-item。若有人把管理区写成
       class="tls-cyc tl-item chemo"，这个正则**匹配不到**，J11 会漏报。
       所以下面补一条「裸子串」断言把这条路堵死 —— J10 只查管理区函数本身，
       而这里查的是拼接后的整张卡片，覆盖面更宽。 */
  {
    const p = jPatient();
    view.pid = p.id; view.tlDesc = false; view.tlOpen = { mgjc: 1, mgjo: 1, jcy1: 1 };
    const h = String(timelineHtml(p));
    ok((h.match(/class="tl-item chemo"/g) || []).length === 2, '★★ J11 化疗周期行 = 2（管理区展开不干扰）',
      (h.match(/class="tl-item chemo"/g) || []).length);
    ok((h.match(/class="tl-item chemo sub"/g) || []).length === 1, '★★ J11 化疗给药子行 = 1（只展开了第 1 周期）',
      (h.match(/class="tl-item chemo sub"/g) || []).length);
    ok((h.match(/class="tl-item other"/g) || []).length === 1, '★★ J11 其他治疗周期行 = 1');
    /* ★★ 裸子串检查：整张卡片里 tl-item 的出现次数必须是「时间轴事件数」这一确定值。
       本用例构成（放疗 10 次被 3 个非放疗事件打断 → 4 段）：
         放疗段头 ×4 + 手术 ×1 + 化疗周期 ×2 + 化疗给药子行 ×1 + 其他治疗周期 ×1 = 9
       管理区若蹭到任何 tl-item 片段（哪怕不在 class 首位），这里就会多出来。 */
    ok((h.match(/tl-item/g) || []).length === 9,
      '★★ J11 整卡片 tl-item 裸子串 = 9（4 放疗段 + 手术1 + 化疗2 + 给药子行1 + 其他1；管理区零污染）',
      { got: (h.match(/tl-item/g) || []).length, detail: h.match(/class="[^"]*tl-item[^"]*"/g) });
    view.tlOpen = {};
  }
}

/* ================================================================ */
group('K. 可读性优化：时间轴瘦身 / 尾部入卡 / 枚举容错（v0.14.1）');

{
  /* K1. ★ 时间轴尾部提示已缩短（旧文案 40 字 → 新文案 24 字），且不再重复描述放疗推算规则 */
  {
    const p = mk({ name: 'K1', startDate: '2026-03-02', fractions: '5', dosePerFraction: '2' });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = String(timelineHtml(p));
    ok(h.indexOf('仅供浏览，录入与修改请用上方「治疗管理与概况」。') >= 0, '★ K1 尾部提示已缩短');
    ok(h.indexOf('放疗部分由排程自动推算') < 0, '★ K1 删掉与治疗进度卡重复的放疗说明');
  }

  /* K2. ★★ 放疗段头「本段已完成 x/y 次」——与管理区全疗程口径「已完成 x/N 次」区分。
     旧文案两处都写「已完成 x 次」，读者会误以为重复；新文案带「本段」与分母。
     ★ 必须用**相对 today 的过去日期**造数据：若把 startDate 写成固定的未来日期，
       到那天之前没有任何已完成次数，段头不会输出 chip，断言就会随当天日期漂移
       （跨日期扫描在 2026-02-17 抓到过这个坑）。 */
  {
    const p = mk({
      name: 'K2', startDate: addDays(today, -14), fractions: '10', dosePerFraction: '2', treatDays: [1, 2, 3, 4, 5],
      /* 手术插在一次治疗中间，确保放疗被打断成 ≥2 段 */
      courses: [{ id: 'k2s', kind: 'surgery', title: '手术', date: addDays(today, -7) }]
    });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = String(timelineHtml(p));
    const mgr = String(courseSummaryHtml(p));
    /* 分段头出现「本段已完成 x/y 次」 */
    const segChip = h.match(/本段已完成 (\d+)\/(\d+) 次/);
    ok(!!segChip, '★★ K2 放疗段头用「本段已完成 x/y 次」区分口径', h.match(/已完成[^<]{0,20}/g));
    if (segChip) {
      ok(Number(segChip[1]) <= Number(segChip[2]), '★ K2 本段已完成 ≤ 本段总数', segChip[0]);
      ok(Number(segChip[2]) >= 1, '★ K2 本段总数 ≥ 1', segChip[0]);
    }
    /* 管理区仍是全疗程口径：已完成 x/N 次，且**不带**「本段」二字 */
    ok(mgr.indexOf('已完成 ' + doneCount(p) + '/' + plannedCount(p) + ' 次') >= 0,
      '★★ K2 管理区仍是全疗程口径', { done: doneCount(p), planned: plannedCount(p) });
    ok(mgr.indexOf('本段') < 0, '★ K2 管理区不出现「本段」字样（避免口径混淆）');
    /* 前置：这份数据确实产生了已完成次数，否则本组断言等于没测 */
    ok(doneCount(p) > 0, '★★ K2 前置：造出的患者已有已完成次数（否则段头无 chip）', doneCount(p));
  }

  /* K3. ★ 空态文案已收紧，且仍指向管理区（不成为死路） */
  {
    const p = mk({ name: 'K3', courses: [{ id: 'k3c', kind: 'chemo', title: '第1程', cycles: [] }] });
    view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    const h = String(timelineHtml(p));
    ok(h.indexOf('以下疗程尚无事件，可回上方「治疗管理与概况」继续录入。') >= 0, '★ K3 空态文案已收紧并指向管理区');
    const p2 = mk({ name: 'K3b' });
    view.pid = p2.id;
    const h2 = String(timelineHtml(p2));
    ok(h2.indexOf('点上方「＋ 疗程」添加手术、化疗、放疗或其他治疗。') >= 0, '★ K3 无疗程空态指向「＋ 疗程」');
  }

  /* K4. ★★ 备注 / 交班记录与患者状态**各自成为一张 card**（此前是裸 section-title + btnrow）。
     这是 v0.14.1 的核心观感修复：页面尾部不再「散架」。 */
  {
    const p = mk({ name: 'K4', startDate: '2026-03-02', fractions: '5' });
    p.notes = [{ id: 'kn1', at: '2026-03-02T09:00', content: '交班：血象偏低' }];
    view.page = 'patient'; view.pid = p.id; view.tlDesc = false; view.tlOpen = {};
    render();
    const v = String(getEl('view').innerHTML);
    /* 备注块被 card 包住：card 内先出现 section-title「备注 / 交班记录」 */
    ok(/<div class="card"><div class="section-title">备注 \/ 交班记录/.test(v),
      '★★ K4 备注区块已被 .card 包裹', v.slice(v.indexOf('备注 / 交班记录') - 60, v.indexOf('备注 / 交班记录') + 20));
    ok(/<div class="card"><div class="section-title">患者状态/.test(v),
      '★★ K4 患者状态区块已被 .card 包裹');
    /* 备注条数以 chip 呈现（不再拼在标题里） */
    ok(v.indexOf('<span class="chip sm">1 条</span>') >= 0, '★ K4 备注条数以 chip 呈现');
    /* 底部危险操作仍在，且未被折叠掉 */
    ok(v.indexOf('data-act="delete-patient"') >= 0, '★ K4 删除按钮仍可达');
    /* 备注按钮仍在（R 组会点击它，此处只保证存在） */
    ok(v.indexOf('data-act="note-add"') >= 0, '★ K4 「＋ 添加备注」仍可达');
    view.page = 'tab';
  }

  /* K5. ★★★ 枚举容错：非法写法「根治性放疗」不再被静默清空（v0.14.1 修复的 bug）。
     这是导入/开机的唯一数据关口，修复前会把这一格永久变成空串且不报错。 */
  {
    function normEnum(k, v) {
      var o = { name: 'K5' }; o[k] = v;
      return normalize({ version: 2, updatedAt: '', patients: [o] }).patients[0][k];
    }
    ok(normEnum('purpose', '根治性放疗') === '根治性', '★★★ K5 「根治性放疗」归一化为「根治性」（此前被清空）');
    ok(normEnum('purpose', '术后辅助放疗') === '术后辅助', '★★ K5 「术后辅助放疗」→「术后辅助」');
    ok(normEnum('purpose', '新辅助') === '术前新辅助', '★ K5 别名「新辅助」→「术前新辅助」');
    ok(normEnum('purpose', '姑息减症') === '姑息性', '★ K5 别名「姑息减症」→「姑息性」');
    ok(normEnum('technique', '容积旋转调强放疗') === 'VMAT', '★★ K5 技术别名长键优先：→ VMAT');
    ok(normEnum('technique', '调强适形') === 'IMRT', '★ K5 「调强适形」→ IMRT');
    ok(normEnum('planStatus', '已批准') === '已通过', '★ K5 流程状态「已批准」→「已通过」');
    /* 关键：完全无法识别的垃圾值仍然清空（容错 ≠ 放行脏数据） */
    ok(normEnum('purpose', '完全看不懂的东西') === '', '★★ K5 无法识别的值仍清空（未放行脏数据）');
    ok(normEnum('technique', 'xyz乱写') === '', '★ K5 技术脏值仍清空');
    /* 关键：合法值必须原样透传（不能被别名表改写） */
    ['根治性', '术后辅助', '术前新辅助', '姑息性'].forEach(function (v) {
      ok(normEnum('purpose', v) === v, '★★ K5 合法值原样透传：' + v);
    });
    /* 空 / null 不得抛错 */
    ok(normEnum('purpose', '') === '' && normEnum('purpose', null) === '', '★ K5 空值与 null 安全');
  }
}

/* ================================================================ */
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
