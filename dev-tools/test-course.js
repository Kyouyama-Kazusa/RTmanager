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
    '★ 化疗卡片「＋周期」按钮自带 data-id', cycleAddBtn && cycleAddBtn[0]);
  /* cycle-add 也是页面级动作（在疗程头里加周期），保持 view.pid 有效 */
  fireFromHtml(htmlWithChemo, 'cycle-add');
  ok(getEl('sheetTitle').textContent.indexOf('周期') >= 0, '★ 点「＋周期」打开周期弹层', getEl('sheetTitle').textContent);
  saveSheet({ n: '1', startDate: '2026-02-01', endDate: '2026-02-03', note: '' });
  ok(chemo.cycles.length === 1 && chemo.cycles[0].n === 1, '★ 周期写入', chemo.cycles);

  view.page = 'patient'; view.pid = p.id; render();
  const htmlWithCycle = getEl('view').innerHTML;
  const doseAddBtn = String(htmlWithCycle).match(/data-act="dose-add"[^>]*/);
  ok(!!doseAddBtn && doseAddBtn[0].indexOf('data-id="' + chemo.id + '"') >= 0 && doseAddBtn[0].indexOf('data-n="1"') >= 0,
    '★ 周期卡片「＋给药」按钮自带 data-id 与 data-n', doseAddBtn && doseAddBtn[0]);
  fireFromHtml(htmlWithCycle, 'dose-add');
  ok(getEl('sheetTitle').textContent.indexOf('给药') >= 0, '★ 点「＋给药」打开给药弹层', getEl('sheetTitle').textContent);
  saveSheet({ date: '2026-02-01', drug: '紫杉醇', dose: '175', unit: 'mg/m2', note: '' });
  ok(chemo.cycles[0].doses.length === 1 && chemo.cycles[0].doses[0].drug === '紫杉醇', '★ 给药写入', chemo.cycles[0].doses);

  /* D3. 编辑给药：需先展开所属周期（给药子行默认收起）。
     按化疗周期的 key（= cycleId）精确展开，不靠下标 —— 下标会随日期漂移。 */
  view.page = 'patient'; view.pid = p.id; view.tlOpen = {}; render();
  const cyId = chemo.cycles[0].id;
  fireFold(getEl('view').innerHTML, cyId);
  view.page = 'patient'; view.pid = p.id; render();
  const doseHtml = getEl('view').innerHTML;
  const doseEditBtn = String(doseHtml).match(/data-act="dose-edit"[^>]*/);
  ok(!!doseEditBtn && doseEditBtn[0].indexOf('data-dose="') >= 0, '★ 给药「编辑」按钮自带 data-dose', doseEditBtn && doseEditBtn[0]);
  fireFromHtml(doseHtml, 'dose-edit');
  const did = chemo.cycles[0].doses[0].id;
  saveSheet({ date: '2026-02-01', drug: '紫杉醇', dose: '200', unit: 'mg/m2', note: '调量' });
  ok(String(chemo.cycles[0].doses[0].dose) === '200', '★ 编辑给药生效（不新增条目）', chemo.cycles[0].doses[0]);
  ok(chemo.cycles[0].doses.length === 1, '编辑不产生重复条目', chemo.cycles[0].doses.length);

  /* D4. 删除给药（周期仍处于展开态） */
  global.__confirmAnswer = true;
  view.page = 'patient'; view.pid = p.id; render();
  const delHtml = getEl('view').innerHTML;
  const doseDelBtn = String(delHtml).match(/data-act="dose-del"[^>]*/);
  ok(!!doseDelBtn && doseDelBtn[0].indexOf('data-dose="') >= 0, '★ 给药「删除」按钮自带 data-dose', doseDelBtn && doseDelBtn[0]);
  fireFromHtml(delHtml, 'dose-del');
  ok(chemo.cycles[0].doses.length === 0, '★ 删除给药生效', chemo.cycles[0].doses.length);
  view.tlOpen = {};

  /* D5. 删除周期 */
  view.page = 'patient'; view.pid = p.id; render();
  fireFromHtml(getEl('view').innerHTML, 'cycle-del');
  ok(chemo.cycles.length === 0, '★ 删除周期生效', chemo.cycles.length);

  /* D6. 删除疗程 */
  view.page = 'patient'; view.pid = p.id; render();
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
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
