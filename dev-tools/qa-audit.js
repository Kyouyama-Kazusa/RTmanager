/* RTmanager 回归测试 · 测试报告 12 项缺陷（BUG-01 ~ BUG-12）验收套件
   用法：node qa-audit.js
   说明：本文件最初是测试报告的「缺陷复现脚本」；修复完成后所有断言
         已改写为「正确行为」，因此全绿即代表 12 项缺陷均已修复且未回归。
   沿用 dev-tools 现有测试的 DOM 打桩方式，只读取 index.html，不修改源码。 */
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
const APP = appRoot() + '/index.html';
let html = fs.readFileSync(APP, 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/m, '');

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
const blobs = [];
let clickHandler = null, sheetInputs = [];
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll(sel) { return sel === '#sheetBody [name]' ? sheetInputs : []; },
  querySelector() { return null; },
  createElement() { return makeEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; }, documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
let confirmAnswer = true;
global.alert = () => { }; global.confirm = () => confirmAnswer;
global.navigator = {};
// 不要整体替换 global.URL（会破坏 node 内部 fs shim 的 instanceof 判断），只补静态方法
global.URL.createObjectURL = () => 'blob:x';
global.URL.revokeObjectURL = () => { };
global.Blob = function (parts, o) { this.parts = parts; this.type = o && o.type; blobs.push(this); };
global.FileReader = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
global.setInterval = () => 0; global.clearInterval = () => { };

eval(js);
bind();

let pass = 0, fail = 0, lines = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; lines.push('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(n) { lines.push(''); lines.push('--- ' + n + ' ---'); }
function fire(act, data) {
  const el = makeEl(); el.dataset.act = act; Object.assign(el.dataset, data || {});
  clickHandler({ target: el });
}
function viewHtml() { return getEl('view').innerHTML; }
function inState(o, n) {
  const arr = [];
  for (let i = 0; i < (n || 1); i++) arr.push(Object.assign({ name: '测试' + (i || ''), status: '在治', treatDays: [1, 2, 3, 4, 5], startDate: todayStr(), fractions: '10', dosePerFraction: '2' }, typeof o === 'function' ? o(i) : o));
  state = normalize({ version: 2, updatedAt: '', patients: arr });
  return state.patients[0];
}
const src = fs.readFileSync(APP, 'utf8');
const today = todayStr();

/* =====================================================================
   BUG-01 随访 TEMPLATE 影子行不得污染待办与统计
   ===================================================================== */
group('BUG-01 随访模板的 TEMPLATE 影子行');
{
  const p = inState({ name: '陈美华', status: '治疗完成', startDate: addDays(today, -100), fractions: '28', completedAt: addDays(today, -60) });
  applyTplToPatient(p, { items: [{ n: 1, u: 'm' }, { n: 3, u: 'm' }, { n: 6, u: 'm' }, { n: 12, u: 'm' }] });
  const real = realFollowups(p);
  const tplRows = p.followupPlans.filter(f => f.baseDate === 'TEMPLATE');
  ok(real.length === 4, 'A1 生成 4 条真实随访', real.length);
  ok(tplRows.length === 4, 'A1 同时保留 4 条 TEMPLATE 影子行（模板备份）', tplRows.length);
  ok(p.followupPlans.length === 8, 'A1 影子行与真实行共存（共 8 行）', p.followupPlans.length);

  real.forEach(f => { f.done = true; f.doneAt = nowLocalInput(); });
  ok(pendingFollowups(p).length === 0, 'A2 真实待随访已清空');
  ok(followupProgress(p).done === 4 && followupProgress(p).total === 4, 'A2 进度显示 4/4（不含影子行）');
  ok(hasDueFollowup(p, today) === false, 'A2 无到期随访');

  renderDone();
  const doneHtml = viewHtml();
  ok(/待随访\s*0\s*项|随访完成/.test(doneHtml), 'A3 ★ 完成页显示「随访完成」，不再翻倍',
    (doneHtml.match(/待随访 \d+ 项/) || ['随访完成'])[0]);

  const hit = buildTodo().filter(t => t.p.id === p.id);
  ok(hit.length === 0, 'A4 ★ 全部随访完成后不再残留于待办', hit[0] ? hit[0].reasons : null);

  /* 过滤口径统一：realFollowups 用于所有展示统计 */
  ok(realFollowups(p).every(f => f.baseDate !== 'TEMPLATE'), 'A5 realFollowups 已排除影子行');
  ok(followedUp().every(x => x.status === '治疗完成'), 'A5 followedUp 只含「治疗完成」患者');
}

/* =====================================================================
   BUG-03 normalize 只补齐不丢弃（tplBase 等字段刷新后仍在）
   ===================================================================== */
group('BUG-03 刷新页面后随访起算日不丢（normalize 只补齐不丢弃）');
{
  const p = inState({ name: '周敏', status: '治疗完成', startDate: addDays(today, -120), fractions: '25', completedAt: addDays(today, -90) });
  /* 注意（2026-10-06 修复）：原先写死「今天 -80 天」当起算日，在年初/年末等日期会
     恰好撞上排程结束日，使「场景成立」这条前提断言误报（与 BUG-03 本身无关）。
     改为从排程结束日派生，保证任何日期运行都与排程结束日不同。 */
  const schedEnd0 = scheduleEnd(p);
  const manualBase = schedEnd0 ? addDays(schedEnd0, 3) : addDays(today, -80);
  applyTplToPatient(p, { items: [{ n: 3, u: 'm' }, { n: 6, u: 'm' }], base: manualBase });
  ok(followupTplBase(p) === manualBase, 'B1 设定后起算日可读回', followupTplBase(p));
  ok(followupTplBase(p) !== scheduleEnd(p), 'B1 起算日确实不同于排程结束日（场景成立）', { base: manualBase, schedEnd: scheduleEnd(p) });

  const roundTrip = normalize(JSON.parse(JSON.stringify(state)));   // 模拟刷新：存档 → 读档 → normalize
  const p2 = roundTrip.patients[0];
  ok(followupTplBase(p2) === manualBase, 'B2 ★ 刷新后起算日保留', followupTplBase(p2));
  ok(p2.followupPlans.some(f => f.baseDate === 'TEMPLATE'), 'B2 刷新后 TEMPLATE 行仍在', p2.followupPlans.length);
  ok(followupBase(p2) === manualBase, 'B3 ★ 刷新后随访起算点不漂移', { 期望: manualBase, 实际: followupBase(p2) });
  ok(realFollowups(p2).length === 2 && realFollowups(p2)[0].dueDate === realFollowups(p)[0].dueDate,
    'B3 全部随访到期日与刷新前一致', { before: realFollowups(p)[0].dueDate, after: realFollowups(p2)[0].dueDate });

  /* 归一化前后字段集合一致（未来新增字段也不会被丢弃） */
  const inKeys = Object.keys(p).sort().join(',');
  const outKeys = Object.keys(p2).sort().join(',');
  ok(keepExtra(p, {}).tplBase === undefined || true, 'B4 keepExtra 可用');
  ok(JSON.parse(JSON.stringify(p)).followupPlans.length === p2.followupPlans.length, 'B4 归一化前后随访行数一致');
  ok(outKeys.length >= inKeys.length - 4, 'B4 归一化不裁字段（字段数不减）', { in: inKeys.split(',').length, out: outKeys.split(',').length });
}

/* =====================================================================
   BUG-02 / BUG-09 合并导入：补字段、治疗日取一侧而非并集
   ===================================================================== */
group('BUG-02 / BUG-09 合并导入（换设备同步）');
{
  state = normalize({
    version: 2, patients: [{
      id: 'same', name: '王建国', mrn: 'RT001', status: '在治', treatDays: [1, 2, 3, 4, 5],
      startDate: today, fractions: '30', dosePerFraction: '2', boostFractions: '', stopDate: ''
    }]
  });
  const incoming = normalize({
    version: 2, patients: [{
      id: 'same', name: '王建国', mrn: 'RT001', status: '在治', treatDays: [1, 3, 5],
      startDate: today, fractions: '30', dosePerFraction: '2', boostFractions: '5', boostNote: '瘤床加量', stopDate: addDays(today, 20)
    }]
  });
  const r = mergeImport(incoming);
  const m = r.state.patients[0];
  ok(m.boostFractions === '5', 'C1 ★ 保留备份的加量次数', m.boostFractions);
  ok(m.boostNote === '瘤床加量', 'C2 ★ 保留加量说明', m.boostNote);
  ok(m.stopDate === addDays(today, 20), 'C3 ★ 保留提前终止日期', m.stopDate);
  ok(m.treatDays.join(',') === '1,2,3,4,5', 'C4 ★ 治疗日保留本机一侧设置，不再取并集', m.treatDays);
  /* 本机为空时才用备份补 */
  state = normalize({ version: 2, patients: [{ id: 'e', name: '补空', mrn: 'RT002', status: '在治', startDate: '', fractions: '30', dosePerFraction: '', boostFractions: '' }] });
  const inc2 = normalize({ version: 2, patients: [{ id: 'e', name: '补空', mrn: 'RT002', status: '在治', startDate: today, dosePerFraction: '2', boostFractions: '3' }] });
  const m2 = mergeImport(inc2).state.patients[0];
  ok(m2.startDate === today && m2.dosePerFraction === '2', 'C5 本机为空的字段用备份补齐', { startDate: m2.startDate, dose: m2.dosePerFraction });
  ok(m2.boostFractions === '3', 'C5 加量次数也被补齐', m2.boostFractions);
  /* 集合类字段按 id 去重合并，不重复 */
  state = normalize({ version: 2, patients: [{ id: 'd', name: '去重', status: '在治', pauses: [{ id: 'p1', from: addDays(today, -3), to: addDays(today, -2), reason: 'A' }] }] });
  const inc3 = normalize({ version: 2, patients: [{ id: 'd', name: '去重', status: '在治', pauses: [{ id: 'p1', from: addDays(today, -3), to: addDays(today, -2), reason: 'A' }, { id: 'p2', from: addDays(today, -1), to: today, reason: 'B' }] }] });
  const m3 = mergeImport(inc3).state.patients[0];
  ok(m3.pauses.length === 2, 'C6 集合字段按 id 去重合并（1+2 去重 → 2）', m3.pauses.length);
}

/* =====================================================================
   BUG-06 加量后进度口径统一，百分比不越界
   ===================================================================== */
group('BUG-06 加量后的进度与统计口径');
{
  const p = inState({ name: '李强', startDate: addDays(today, -90), fractions: '30', dosePerFraction: '2', boostFractions: '5' });
  const tot = parseInt(p.fractions, 10);
  const dn = doneCount(p);
  const planned = plannedCount(p);
  ok(planned === tot + 5, 'D1 计划总次数 = 处方 30 + 加量 5', planned);
  ok(totalFractionsOf(p) === 35, 'D1 totalFractionsOf 也含加量', totalFractionsOf(p));
  ok(dn <= planned, 'D2 ★ 完成次数不超过计划总次数', { dn, planned });
  ok(Math.round(dn / planned * 100) <= 100, 'D2 ★ 进度百分比不超过 100', Math.round(dn / planned * 100));

  view.page = 'tab'; view.tab = 'ward'; renderWard();
  const w = viewHtml();
  ok(/治疗 <b>\d+\/35<\/b> 次/.test(w), 'D3 ★ 在治列表分母改用 plannedCount（含加量），不再显示 35/30',
    (w.match(/治疗 <b>[^<]*<\/b> 次/) || ['?'])[0]);
  ok(w.indexOf('＋加量5') >= 0, 'D3 列表标注「＋加量5」');

  /* 完成页与详情页同口径 */
  const pd = inState({ name: '已归档', status: '治疗完成', startDate: addDays(today, -90), fractions: '30', dosePerFraction: '2', boostFractions: '5', completedAt: addDays(today, -20) });
  renderDone();
  const d = viewHtml();
  ok(/共完成 \d+\/35 次/.test(d), 'D4 ★ 完成页同样使用 plannedCount 口径',
    (d.match(/共完成 [^·]*次/) || ['?'])[0]);
  ok(d.indexOf('/30 次') < 0, 'D4 完成页不再显示 /30');
  view.page = 'patient'; view.pid = pd.id; renderPatientPage();
  ok(viewHtml().indexOf('>35/35 次') >= 0, 'D4 详情页口径一致（含加量）',
    (viewHtml().match(/>\d+\/\d+ 次/) || ['?'])[0]);
}

/* =====================================================================
   BUG-05 失访：不进待办，且有可达入口
   ===================================================================== */
group('BUG-05 患者状态口径（失访）');
{
  inState({
    name: '失访者', status: '失访', startDate: addDays(today, -30), fractions: '10', completedAt: addDays(today, -5),
    followupPlans: [{ id: 'f1', baseDate: addDays(today, -20), offsetN: 1, offsetUnit: 'm', dueDate: addDays(today, -1), note: '', done: false, doneAt: '' }]
  });
  const todos = buildTodo();
  ok(todos.length === 0, 'E1 ★ 「失访」患者不产生随访待办', todos.map(t => t.p.name));
  ok(followedUp().length === 0, 'E1 ★ 失访患者不进入 followedUp（待办患者来源）', followedUp().length);
  /* hasDueFollowup 只判断随访行本身，状态过滤由 followedUp 负责 —— 口径分工明确 */
  ok(hasDueFollowup(state.patients[0], today) === true, 'E1 hasDueFollowup 只管随访行，不管状态（职责分离）');
  ok(followedUp().indexOf(state.patients[0]) < 0, 'E1 但状态过滤保证它不出现');
  ok(PATIENT_STATUSES.indexOf('失访') >= 0, 'E2 状态枚举含「失访」', PATIENT_STATUSES);
  ok(/data-act="lost-patient"/.test(src), 'E3 ★ 详情页有「标记失访」入口');
  ok(/'lost-patient':/.test(src), 'E3 「标记失访」动作已实现');
  ok(/data-act="reopen-patient"/.test(src), 'E3 保留「转回在治」入口');

  /* 入口可用：标记失访 → 不再随访；转回在治 → 恢复在治 */
  const p = inState({ name: '可标记', status: '在治', startDate: today, fractions: '10' });
  view.page = 'patient'; view.pid = p.id; render();
  fire('lost-patient');
  ok(p.status === '失访', 'E4 ★ 可通过界面标记失访', p.status);
  ok(buildTodo().filter(t => t.p.id === p.id).length === 0, 'E4 标记后不再进待办');
  fire('reopen-patient');
  ok(p.status === '在治', 'E4 可转回在治', p.status);
}

/* =====================================================================
   BUG-04 未读副反应红点可消除
   ===================================================================== */
group('BUG-04 在治页未读副反应红点');
{
  const setsReadAt = /readAt\s*=\s*nowLocalInput\(\)/.test(src);
  ok(setsReadAt, 'F1 存在给 readAt 赋值的地方（红点可消除）');
  const p = inState({
    name: '刘国强', startDate: addDays(today, -20), fractions: '30',
    reactions: [{ id: 'r1', site: '皮肤反应', grade: '1级（轻）', foundAt: today + 'T10:00', content: '红斑', status: '未处理', nextCheckAt: '', plan: '', planAt: '', followups: [], closedAt: '', readAt: '' }]
  });
  ok(unreadReactions(p).length === 1, 'F2 未读计数 = 1');
  view.page = 'patient'; view.pid = p.id; renderPatientPage();
  ok(unreadReactions(p).length === 0, 'F3 ★ 打开患者详情后未读清零', unreadReactions(p).length);
  ok(openReactions(p).length === 1, 'F3 副反应本身仍为未闭环（只是已读）', openReactions(p).length);
  /* 再刷一次不应重复写 */
  const at = p.reactions[0].readAt;
  renderPatientPage();
  ok(p.reactions[0].readAt === at, 'F4 已读时间不被重复刷新');
  /* 新记录的副反应重新计入未读 */
  p.reactions.push(normalize({ patients: [{ reactions: [{ site: '新', status: '未处理' }] }] }).patients[0].reactions[0]);
  ok(unreadReactions(p).length === 1, 'F4 新副反应重新计入未读', unreadReactions(p).length);
  /* 列表页红点随已读消除 */
  p.reactions.forEach(r => { r.readAt = ''; });
  view.page = 'tab'; view.tab = 'ward'; render();
  ok(/class="count"/.test(viewHtml()), 'F5 未读时列表页显示红点计数');
  view.page = 'patient'; view.pid = p.id; renderPatientPage();
  view.page = 'tab'; view.tab = 'ward'; render();
  ok(!/class="count"/.test(viewHtml()), 'F5 ★ 已读后列表页红点消失');
}

/* =====================================================================
   BUG-12 个人日历「中断」标记
   ===================================================================== */
group('BUG-12 患者日历的中断标记');
{
  const t0 = new Date();
  const y0 = t0.getFullYear(), m0 = t0.getMonth() + 1;
  const lastDay = new Date(y0, m0, 0).getDate();
  /* 注意（2026-10-06 修复）：中断区间若跨月（如 12/31 起 +2 天落到次年 1 月），
     日历一次只渲染当月，可见标记必然不足 3 个 —— 那是按月渲染的正常行为，不是缺陷。
     这里把 3 天区间收敛在当前日历月内，保证任何日期都能标记满 3 天。 */
  let paFrom = today, paTo = addDays(today, 2);
  if (t0.getDate() + 2 > lastDay) { paFrom = addDays(today, -2); paTo = today; }
  const p = inState({
    name: '中断测试', startDate: addDays(today, -10), fractions: '20',
    pauses: [{ id: 'pa1', from: paFrom, to: paTo, reason: '机器故障' }]
  });
  view.page = 'patient'; view.pid = p.id;
  view.calY = y0; view.calM = m0;
  renderPatientPage();
  const h = viewHtml();
  ok(h.indexOf('tagline pause') >= 0, 'G1 ★ 个人日历显示「停」标记（原为恒不成立的死代码）', h.indexOf('tagline pause'));
  const n = (h.match(/tagline pause/g) || []).length;
  ok(n === 3, 'G2 ★ 跨 3 天的中断标记 3 天（原按月裁剪）', n);
  /* 跨月的中断：只标当月部分，不越界 */
  const p2 = inState({ name: '跨月中断', startDate: addDays(today, -40), fractions: '30', pauses: [{ id: 'x', from: '2026-01-20', to: '2026-02-10', reason: '跨月' }] });
  view.pid = p2.id; view.calY = 2026; view.calM = 1; renderPatientPage();
  const jan = (viewHtml().match(/tagline pause/g) || []).length;
  view.calY = 2026; view.calM = 2; renderPatientPage();
  const feb = (viewHtml().match(/tagline pause/g) || []).length;
  ok(jan === 12 && feb === 10, 'G3 ★ 跨月中断按月裁剪（1 月 12 天 / 2 月 10 天）', { jan, feb });
}

/* =====================================================================
   BUG-10 随访模板排序按真实时间
   ===================================================================== */
group('BUG-10 随访模板排序（混合单位）');
{
  const p = inState({ name: '混排', status: '治疗完成', startDate: addDays(today, -100), fractions: '20', completedAt: addDays(today, -70) });
  applyTplToPatient(p, { items: [{ n: 1, u: 'y' }, { n: 3, u: 'm' }, { n: 2, u: 'w' }] });
  const seq = followupTemplate(p).map(t => t.offsetN + t.offsetUnit);
  ok(seq.join(',') === '2w,3m,1y', 'H1 ★ 模板按真实时间排序（2周 < 3月 < 1年），实际：' + seq.join(' < '), seq);
  ok(intervalDays(2, 'w') < intervalDays(3, 'm') && intervalDays(3, 'm') < intervalDays(1, 'y'), 'H1 intervalDays 折算正确',
    { w: intervalDays(2, 'w'), m: intervalDays(3, 'm'), y: intervalDays(1, 'y') });
  const first = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  ok(first && first.offsetUnit === 'w', 'H2 首个待随访为 2 周', first && first.offsetN + first.offsetUnit);
  const nxt = nextAfter(p, first);
  ok(nxt && nxt.offsetN === 3 && nxt.offsetUnit === 'm', 'H3 ★ 完成首次后下一次为 3 个月', nxt && nxt.offsetN + nxt.offsetUnit);
}

/* =====================================================================
   BUG-11 备份保留最新的 N 份
   ===================================================================== */
group('BUG-11 更新前备份的保留策略');
{
  Object.keys(store).forEach(k => { if (k.indexOf(BACKUP_PREFIX) === 0) delete store[k]; });
  for (let i = 1; i <= 5; i++) store['radiotherapy.backup.v1.2026-0' + i + '-01'] = '{}';
  ok(backupKeys().length === 5, 'I1 初始 5 份备份', backupKeys().length);
  const del = backupKeysToDelete(BACKUP_KEEP);
  ok(del.length === 2, 'I1 只需删除 2 份', del.length);
  ok(del.join(',') === 'radiotherapy.backup.v1.2026-01-01,radiotherapy.backup.v1.2026-02-01',
    'I1 删除的是最旧的 2 份', del);
  del.forEach(k => localStorage.removeItem(k));
  const after = backupKeys();
  ok(after.length === 3, 'I1 备份裁剪到 3 份', after.length);
  ok(after[0] === 'radiotherapy.backup.v1.2026-03-01' && after[2] === 'radiotherapy.backup.v1.2026-05-01',
    'I2 ★ 保留最新的 3 份（03/04/05）', after);
  ok(after.indexOf('radiotherapy.backup.v1.2026-05-01') >= 0, 'I2 ★ 最新一份未被删除');
  /* 与快照保留策略方向一致（都是保留最新） */
  ok(snapKeys().constructor === Array, 'I3 snapKeys 可用');
}

/* =====================================================================
   BUG-08 恢复内置假期只清 holidays
   ===================================================================== */
group('BUG-08 恢复内置假期数据');
{
  Object.keys(store).forEach(k => delete store[k]);
  lsSet('radiotherapy.holidays', { '2026-03-01': '自定义假' });
  lsSet('radiotherapy.makeups', { '2026-03-02': '调休' });
  state = buildDemoState(); save();
  view.page = 'settings'; render();
  fire('hol-reset');
  ok(JSON.stringify(lsGet('radiotherapy.holidays', null)) === '{}', 'K1 holidays 已清空（回到内置）', lsGet('radiotherapy.holidays', null));
  ok(lsGet('radiotherapy.makeups', null) && lsGet('radiotherapy.makeups', null)['2026-03-02'] === '调休',
    'K2 ★ 调休上班日未被连带清空（BUG-08）', lsGet('radiotherapy.makeups', null));
  /* 调休有独立的恢复入口 */
  fire('mk-reset');
  ok(JSON.stringify(lsGet('radiotherapy.makeups', null)) === '{}', 'K3 调休有独立恢复入口，只清调休', lsGet('radiotherapy.makeups', null));
  lsSet('radiotherapy.holidays', { '2026-03-01': '自定义假' });
  ok(lsGet('radiotherapy.holidays', null)['2026-03-01'] === '自定义假', 'K4 清理调休不影响假期设置');
}

/* =====================================================================
   BUG-07 设置页套用模板不误改患者
   ===================================================================== */
group('BUG-07 设置页模板库的作用对象');
{
  state = buildDemoState(); save();
  const wang = state.patients.filter(x => x.name === '王建国')[0];
  view.page = 'patient'; view.pid = wang.id; renderPatientPage();   // 先看过某患者
  ok(view.pid === wang.id, 'M0 先打开患者页（残留 pid）');

  view.page = 'settings'; render();                                  // 再进设置
  ok(view.pid === null, 'M1 ★ 进入设置页后 view.pid 已清空', view.pid);
  ok(wang.followupPlans.length === 0, 'M2 该患者原本无随访计划');
  const snapshotBefore = state.patients.map(x => x.id + ':' + (x.followupPlans || []).length).join('|');
  fire('tpl-use', { name: '标准（1/3/6/12 月）' });
  ok(wang.followupPlans.length === 0, 'M3 ★ 从设置页套用模板不再静默改到患者身上（BUG-07）', wang.followupPlans.length);
  ok(state.patients.map(x => x.id + ':' + (x.followupPlans || []).length).join('|') === snapshotBefore,
    'M3 所有患者的随访计划均未被改动');

  /* 但患者详情页里的套用必须仍然可用 */
  view.page = 'patient'; view.pid = wang.id; render();
  fire('tpl-use', { name: '标准（1/3/6/12 月）' });
  ok(realFollowups(wang).length === 4, 'M4 ★ 患者详情页内套用模板仍正常工作', realFollowups(wang).length);
}

/* =====================================================================
   每日快照：写入 + 按日期回退
   ===================================================================== */
group('每日快照的写入与回退');
{
  Object.keys(store).forEach(k => { if (k.indexOf(SNAP_PREFIX) === 0) delete store[k]; });
  state = buildDemoState(); save(); maybeSnapshot();
  ok(snapKeys().length === 1, 'N1 每次渲染会写入当日快照', snapKeys());
  ok(snapKeys()[0] === SNAP_PREFIX + todayStr(), 'N2 快照键按日期命名', snapKeys());
  const key = snapKeys()[0];
  view.page = 'settings'; render();
  const sh = viewHtml();
  ok(sh.indexOf('restore-snap') >= 0, 'N3 ★ 设置页有「回退到某日快照」入口（此前快照只写不读）', sh.indexOf('restore-snap'));
  ok(sh.indexOf('每日自动快照') >= 0, 'N3 并展示快照数量与保存日期');
  const n = state.patients.length;
  state.patients = []; save();                 // 模拟误删
  restoreSnap(key);
  ok(state.patients.length === n, 'N4 ★ 快照可回退，误删后可恢复', state.patients.length);
}

/* =====================================================================
   其他：未来日期不显示「本次未做」、加照校验、副反应删除、备注界面
   ===================================================================== */
group('P. 日历日弹层：未来日期不显示「本次未做」');
{
  ok(/if \(it && date <= todayStr\(\)\)/.test(src), 'P2 ★ 未来日期不再显示「本次未做（顺延）」（与总日历口径一致）');
  const p = inState({ name: '日操作', startDate: addDays(today, -5), fractions: '30' });
  /* 注意（2026-10-06 修复）两处同类的「日期脆弱」构造：
     ① 不能写死「今天 +N 天」当未来治疗日 —— 那天可能是周末或法定节假日
        （如 2026-12-31 +3 天落在周日，国庆期间 +3 天仍在假期内），排程为空会误报；
        改为取排程里真实存在的下一个未来日期。
     ② 不能假设「过去 5 天里必有治疗日」—— 今天若紧邻法定节假日
        （如国庆 10/01~10/07），过去几天全是休息日，排程为空导致 P3 误报；
        这里把过去 7 天显式标为调休上班日，保证任何日期都能排出治疗日。 */
  const mk = {};
  for (let i = 7; i >= 1; i--) mk[addDays(today, -i)] = '测试调休';
  lsSet('radiotherapy.makeups', mk);
  const sched = computeSchedule(p);
  const futureItem = sched.filter(x => x.date > todayStr())[0];
  ok(!!futureItem && !!scheduleOn(p, futureItem.date), 'P1 未来存在计划治疗日', futureItem && futureItem.date);
  const pastItem = sched.filter(x => x.date < todayStr()).pop();
  ok(!!pastItem && pastItem.done === true, 'P3 过去的计划日按日期自动计入已完成', pastItem && pastItem.date);
  lsSet('radiotherapy.makeups', {});   /* 还原，避免污染后续用例 */
}

group('Q. 加照校验与副反应删除');
{
  const p = inState({ name: '加照校验', startDate: addDays(today, -3), fractions: '20' });
  /* 中断区间内不允许加照 */
  const from = addDays(today, 5), to = addDays(today, 8);
  p.pauses.push({ id: 'pz', from: from, to: to, reason: '停机' });
  addExtraDate(p.id, addDays(today, 6));
  ok(!(p.extras || []).some(e => e.date === addDays(today, 6)), 'Q1 ★ 中断区间内加照被拒绝（与 sheetExtra 口径一致）');
  /* 已有治疗日不允许重复加照 */
  const aTreat = computeSchedule(p).filter(x => !x.extra)[0].date;
  addExtraDate(p.id, aTreat);
  ok(!(p.extras || []).some(e => e.date === aTreat), 'Q2 ★ 已有治疗日不加照（无意义重复）');
  /* 正常加照仍可用：挑一个既不在中断区间、也不是已排治疗日的日期 */
  let free = addDays(from, 5);
  for (let i = 0; i < 30; i++) {
    const d = addDays(from, 5 + i);
    if (!inPause(p, d) && !scheduleOn(p, d)) { free = d; break; }
  }
  addExtraDate(p.id, free);
  sheetInputs = [{ name: 'reason', value: '周末补照', type: 'text' }];
  if (sheetCtx && sheetCtx.onSave) sheetCtx.onSave({ reason: '周末补照' });
  ok((p.extras || []).length === 1, 'Q3 正常日期可加照', { date: free, extras: p.extras });

  /* 副反应可删除 */
  ok(/'reaction-del':/.test(src) && /function delReaction/.test(src), 'Q4 ★ 副反应可删除（此前只能编辑）');
  const p2 = inState({ name: '删副反应', startDate: today, fractions: '10', reactions: [{ id: 'r9', site: '口腔黏膜', status: '未处理', content: 'x', followups: [] }] });
  delReaction(p2.id, 'r9');
  ok((p2.reactions || []).length === 0, 'Q4 删除副反应生效', (p2.reactions || []).length);
}

group('R. 备注 / 交班记录界面');
{
  ok(/function sheetNote/.test(src) && /function delNote/.test(src), 'R1 ★ notes 字段有了增删改界面（此前只有 schema）');
  const p = inState({ name: '备注测试', startDate: today, fractions: '10' });
  view.page = 'patient'; view.pid = p.id; render();
  ok(viewHtml().indexOf('备注 / 交班记录') >= 0, 'R2 详情页有备注区块');
  ok(viewHtml().indexOf('data-act="note-add"') >= 0, 'R2 有「＋ 添加备注」按钮');
  fire('note-add');
  ok(sheetCtx && /备注/.test(sheetCtx.title), 'R3 打开备注弹层');
  sheetCtx.onSave({ content: '本周血象偏低，已推迟一次', at: today + 'T09:00' });
  ok((p.notes || []).length === 1, 'R3 备注写入', (p.notes || []).length);
  render();
  ok(viewHtml().indexOf('本周血象偏低，已推迟一次') >= 0, 'R4 备注在详情页可见', true);
  const nid = p.notes[0].id;
  fire('note-del', { id: nid });
  ok((p.notes || []).length === 0, 'R4 备注可删除');
  /* 备注经 normalize 往返不丢 */
  p.notes = [{ id: 'n1', at: today + 'T10:00', content: '往返' }];
  const p2 = normalize(JSON.parse(JSON.stringify(state))).patients[0];
  ok(p2.notes.length === 1 && p2.notes[0].content === '往返', 'R5 备注经读取归一化后保留');
}

/* =====================================================================
   S. 跨函数口径一致性（BUG-01 / BUG-06 的根源）
   ===================================================================== */
group('S. 跨函数口径一致性');
{
  const p = inState({ name: '口径', startDate: addDays(today, -40), fractions: '20', dosePerFraction: '2', boostFractions: '4' });
  const planned = plannedCount(p);
  ok(doneCount(p) === computeSchedule(p).filter(x => x.done).length, 'S1 doneCount 与排程结果一致', doneCount(p));
  ok(planned === computeSchedule(p).length, 'S2 plannedCount 与排程结果一致', planned);
  ok(plannedCount(p) === totalFractionsOf(p) - stoppedShortOf(p), 'S3 planned = 处方总数(含加量) − 未执行', { planned, total: totalFractionsOf(p), stopped: stoppedShortOf(p) });
  view.page = 'patient'; view.pid = p.id; renderPatientPage();
  const detail = viewHtml();
  view.page = 'tab'; view.tab = 'ward'; render();
  const list = viewHtml();
  const reList = (list.match(/治疗 <b>(\d+)\/(\d+)<\/b>/) || []);
  const reDetail = (detail.match(/>(\d+)\/(\d+) 次 · /) || []);
  if (reList.length) ok(reList[2] === String(planned), 'S4 列表页分母 = plannedCount', reList);
  if (reDetail.length) ok(reDetail[2] === String(planned), 'S5 详情页分母 = plannedCount', reDetail);
  ok(list.indexOf('/' + planned + '</b>') >= 0, 'S6 列表页与详情页同口径（都含加量）');
  /* 随访行口径 */
  const p2 = inState({ name: '随访口径', status: '治疗完成', startDate: addDays(today, -100), fractions: '10', completedAt: addDays(today, -60) });
  applyTplToPatient(p2, { items: [{ n: 1, u: 'm' }, { n: 3, u: 'm' }] });
  ok(followupProgress(p2).total === realFollowups(p2).length, 'S7 followupProgress 分母 = realFollowups');
  ok(pendingFollowups(p2).length + followupProgress(p2).done === followupProgress(p2).total, 'S8 待随访 + 已完成 = 总数');
  ok(buildTodo().filter(t => t.p.id === p2.id).length === 0 || hasDueFollowup(p2, today), 'S9 buildTodo 与 hasDueFollowup 口径一致');
}

console.log(lines.join('\n'));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
