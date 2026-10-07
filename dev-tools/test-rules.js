/* 排程规则测试：
   A. 节假日 / 调休上班日的冲突、优先级、删除回退、更新保留（用户问题1）
   B. 按日期推算完成次数与剂量、异常修正（用户问题2）  */
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
let html = fs.readFileSync(appRoot() + '/index.html', 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/m, '');

const elById = {};
function makeEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() { }, contains() { return false; } },
    addEventListener() { }, onclick: null, dataset: {}, parentElement: null, appendChild() { }, removeChild() { }, click() { }, remove() { }
  };
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
let clickHandler = null;
let sheetInputs = [];
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
global.navigator = {}; global.URL = { createObjectURL() { return 'x'; }, revokeObjectURL() { } };
global.Blob = function () { };
global.FileReader = function () { this.readAsText = function () { }; this.readAsDataURL = function () { }; };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
global.setInterval = () => 0; global.clearInterval = () => { };

eval(js);
bind();

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }
function fire(act, data) {
  const el = makeEl(); el.dataset.act = act; Object.assign(el.dataset, data || {});
  clickHandler({ target: el });
}
function cap(fn) { fn(); if (!sheetCtx || !sheetCtx.onSave) throw new Error('弹层未打开'); return sheetCtx; }
function mkPatient(o) {
  return normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] }).patients[0];
}
/* 把患者放进 state（涉及 getPatient 的操作必须用这个） */
function inState(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  state.patients[0].status = '在治';
  return state.patients[0];
}
function has(sched, d) { return sched.some(x => x.date === d); }

console.log('========== 排程规则测试 ==========');

/* =========================================================
   A. 用户问题1：节假日 / 调休上班日
   ========================================================= */
group('A1. 基线：节假日不排治疗');
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});
let p = mkPatient({ startDate: '2026-10-02', fractions: '6', dosePerFraction: '2' });
let s = computeSchedule(p);
console.log('  排程:', s.map(x => x.date + '(' + x.fraction + ')').join(' '));
ok(!has(s, '2026-10-02'), '10/02 是国庆 → 不排', has(s, '2026-10-02'));
ok(!has(s, '2026-10-05'), '10/05 假期内 → 不排');
ok(!has(s, '2026-10-06'), '10/06 假期内 → 不排');
ok(has(s, '2026-10-08'), '10/08 假期后 → 排入');
const base6 = s.length;
ok(base6 === 6, '共 6 次', base6);

group('A2. 把节假日日期加入「调休上班日」→ 是否冲突');
setMakeup('2026-10-05', '国庆调休');
s = computeSchedule(p);
console.log('  排程:', s.map(x => x.date + '(' + x.fraction + ')').join(' '));
ok(has(s, '2026-10-05'), '★ 10/05 现在排入治疗（调休优先，不冲突）', has(s, '2026-10-05'));
ok(holidays()['2026-10-05'] === '国庆', '10/05 仍在节假日列表中（两层独立，不互相删除）', holidays()['2026-10-05']);
ok(Object.prototype.hasOwnProperty.call(makeups(), '2026-10-05'), '10/05 同时在调休列表中');
ok(s.length === 6, '总次数仍为 6', s.length);
ok(s[0].date === '2026-10-05', '★ 疗程提前一天开始（10/05 成为第 1 次）', s[0].date);
console.log('  10/05 既是节假日又是调休 → 实践上按工作日治疗');

group('A3. 从调休中删除 → 是否回到节假日');
delMakeup('2026-10-05');
s = computeSchedule(p);
console.log('  排程:', s.map(x => x.date + '(' + x.fraction + ')').join(' '));
ok(!has(s, '2026-10-05'), '★ 10/05 恢复为休息（不再排治疗）', has(s, '2026-10-05'));
ok(holidays()['2026-10-05'] === '国庆', '★ 10/05 依然是节假日（未被连带删除）', holidays()['2026-10-05']);
ok(s.length === 6 && s[0].date === '2026-10-08', '排程回到初始状态', s[0].date);

group('A4. 自定义节假日 + 加入调休 + 再删除');
/* 用足够长的疗程，确保能排到 10/20 */
const pLong = mkPatient({ startDate: '2026-10-02', fractions: '20', dosePerFraction: '2' });
setHoliday('2026-10-20', '院庆');
s = computeSchedule(pLong);
console.log('  设院庆后 10/20 附近:', s.filter(x => x.date >= '2026-10-16' && x.date <= '2026-10-23').map(x => x.date).join(' '));
ok(!has(s, '2026-10-20'), '自定义假期生效（10/20 不排）');
setMakeup('2026-10-20', '院庆上班');
s = computeSchedule(pLong);
ok(has(s, '2026-10-20'), '★ 加入调休后 10/20 恢复排入', has(s, '2026-10-20'));
delMakeup('2026-10-20');
s = computeSchedule(pLong);
ok(!has(s, '2026-10-20'), '★ 删除调休后 10/20 又不排（假期仍在）');
delHoliday('2026-10-20');
s = computeSchedule(pLong);
ok(has(s, '2026-10-20'), '★ 两者都删除后，10/20 成为普通工作日（排入）', has(s, '2026-10-20'));

group('A5. 应用更新后，自定义内容是否保留（关键诉求）');
/* 模拟：用户做了自定义 */
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});
setHoliday('2027-04-01', '院庆');
delHoliday('2026-10-01');                        /* 用户删掉内置的国庆 */
setMakeup('2026-10-10', '自定义调休');            /* 用户改内置调休的名字 */
const beforeHol = JSON.stringify(holidayOverride());
const beforeMk = JSON.stringify(makeupOverride());
console.log('  升级前 用户覆盖层: holidays=' + beforeHol);
console.log('                      makeups=' + beforeMk);

/* 模拟「应用更新」：内置层新增 2027 年数据并改名 */
BUILTIN_HOLIDAYS['2027-01-01'] = '元旦';
BUILTIN_HOLIDAYS['2027-02-05'] = '春节';
BUILTIN_HOLIDAYS['2027-04-02'] = '清明';
BUILTIN_MAKEUPS['2027-02-06'] = '春节调休';
BUILTIN_YEARS.push('2027');

ok(holidayOverride()['2027-04-01'] === '院庆', '★ 用户添加的自定义假期保留', holidayOverride()['2027-04-01']);
ok(holidayOverride()['2026-10-01'] === null, '★ 用户删除内置假期的操作保留（仍为 null）', holidayOverride()['2026-10-01']);
ok(makeupOverride()['2026-10-10'] === '自定义调休', '★ 用户修改的内置调休保留', makeupOverride()['2026-10-10']);
ok(holidays()['2027-01-01'] === '元旦', '★ 新版内置的 2027 元旦已生效（新数据自动可用）', holidays()['2027-01-01']);
ok(holidays()['2027-02-05'] === '春节', '新版内置春节生效');
ok(!holidays()['2026-10-01'], '★ 用户删除的国庆仍然不在（不被新版内置覆盖回来）', holidays()['2026-10-01']);
ok(holidays()['2027-04-01'] === '院庆', '自定义假期与新版内置共存');
ok(coveredYears().indexOf('2027') >= 0, '覆盖年份含 2027');

group('A6. 「恢复内置数据」能还原');
ok(Object.keys(holidayOverride()).length > 0, '恢复前存在自定义');
fire('hol-reset');
ok(Object.keys(holidayOverride()).length === 0, '★ 覆盖层已清空', Object.keys(holidayOverride()).length);
ok(holidays()['2026-10-01'] === '国庆', '★ 国庆回到内置状态', holidays()['2026-10-01']);
ok(holidays()['2027-04-01'] === '春节' || holidays()['2027-04-01'] === undefined, '自定义院庆已移除', holidays()['2027-04-01']);

group('A7. 重叠时界面给出提示（避免用户困惑）');
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});
setMakeup('2026-10-05', '国庆调休');            /* 与内置节假日重叠 */
sheetHolidayManage();
const holBody = getEl('sheetBody').innerHTML;
ok(holBody.indexOf('也是调休上班') >= 0, '★ 节假日列表标注「也是调休上班」');
ok(holBody.indexOf('按调休上班处理') >= 0, '★ 顶部说明优先级规则');
sheetMakeupManage();
const mkBody = getEl('sheetBody').innerHTML;
ok(mkBody.indexOf('也是节假日') >= 0, '★ 调休列表标注「也是节假日」');
ok(mkBody.indexOf('优先于节假日') >= 0, '说明调休优先级');

group('A8. 添加时的冲突预警');
confirmAnswer = false;
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});
setMakeup('2026-10-05', '国庆调休');
cap(function () { sheetAddHoliday(); }).onSave({ from: '2026-10-05', to: '2026-10-05', name: '测试' });
ok(holidays()['2026-10-05'] === '国庆', '取消时未写入（仍是原生国庆名）', holidays()['2026-10-05']);
confirmAnswer = true;
cap(function () { sheetAddHoliday(); }).onSave({ from: '2026-10-05', to: '2026-10-05', name: '测试假日' });
ok(holidays()['2026-10-05'] === '测试假日', '★ 确认后写入', holidays()['2026-10-05']);

confirmAnswer = false;
const mkLenBefore = Object.keys(makeupOverride()).length;
cap(function () { sheetAddMakeup(); }).onSave({ from: '2026-10-06', to: '2026-10-06', name: '与假期重叠' });
ok(Object.keys(makeupOverride()).length === mkLenBefore, '★ 与节假日重叠时取消则不写入', Object.keys(makeupOverride()).length);

/* =========================================================
   B. 用户问题2：按日期推算完成次数与剂量
   ========================================================= */
group('B1. 完成次数由日期推算（无需手工标记）');
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});
const today = todayStr();
/* 起于 10 个工作日前，30 次疗程 */
let p2 = mkPatient({ startDate: addDays(today, -14), fractions: '30', dosePerFraction: '2' });
let sc = computeSchedule(p2);
const pastDays = sc.filter(x => x.date <= today);
const futureDays = sc.filter(x => x.date > today);
console.log('  开始 ' + addDays(today, -14) + ' · 计划 30 次 · 今天 ' + today);
console.log('  计划中已过去 ' + pastDays.length + ' 次 → 已完成 ' + doneCount(p2) + ' 次 / 累计 ' + accumulatedDose(p2) + ' Gy');
ok(doneCount(p2) === pastDays.length, '★ 已完成次数 = 计划中日期 ≤ 今天的次数', doneCount(p2));
ok(pastDays.length > 0, '确实有已过去的部分', pastDays.length);
ok(futureDays.every(x => x.done === false), '★ 未来日期一律为「待治疗」');
ok(pastDays.every(x => x.done === true), '★ 过去日期一律为「已完成」');
ok(accumulatedDose(p2) === doneCount(p2) * 2, '★ 累计剂量 = 已完成次数 × 单次剂量', accumulatedDose(p2));
ok(remainCount(p2) === 30 - doneCount(p2), '剩余次数正确', remainCount(p2));

group('B2. 时间推移 → 次数自动增长（不需要任何操作）');
const p3 = mkPatient({ startDate: addDays(today, -7), fractions: '20', dosePerFraction: '2.5' });
const n1 = doneCount(p3);
/* 模拟日期推进：把开始日期前移一天，等价于"过了一天" */
p3.startDate = addDays(p3.startDate, -1);
const n2 = doneCount(p3);
console.log('  开始日期前移一天：已完成 ' + n1 + ' → ' + n2);
ok(n2 >= n1, '★ 日期推进后已完成次数不会减少', { n1, n2 });
ok(n2 === n1 || n2 === n1 + 1, '★ 最多增加 1 次（按治疗日推进）', { n1, n2 });

group('B3. 未来开始的患者 → 一次未做');
const p4 = mkPatient({ startDate: addDays(today, 5), fractions: '10', dosePerFraction: '2' });
ok(doneCount(p4) === 0, '★ 尚未开始 → 已完成 0 次', doneCount(p4));
ok(accumulatedDose(p4) === 0, '累计剂量 0');
ok(remainCount(p4) === 10, '剩余 10 次');

group('B4. 全部日期已过 → 全部完成');
const p5 = mkPatient({ startDate: addDays(today, -120), fractions: '5', dosePerFraction: '2' });
ok(doneCount(p5) === 5, '★ 疗程已结束 → 5/5 完成', doneCount(p5));
ok(accumulatedDose(p5) === 10, '剂量 10 Gy');
ok(remainCount(p5) === 0, '剩余 0 次');
ok(scheduleEnd(p5) < today, '结束日期在过去');

group('B5. 异常修正：本次未做 → 不计入且后续顺延');
const p6 = inState({ startDate: addDays(today, -14), fractions: '30', dosePerFraction: '2' });
const before = doneCount(p6);
const endBefore = scheduleEnd(p6);
const schedBefore = computeSchedule(p6);
const target = schedBefore.filter(x => x.done)[2];   /* 取一个已过去的治疗日 */
console.log('  对已过去的 ' + target.date + '（第 ' + target.fraction + ' 次）执行「本次未做」');
cap(function () { skipHere(p6.id, target.date); }).onSave({ reason: '患者未到' });
ok(p6.pauses.length === 1, '★ 生成 1 条中断记录', p6.pauses.length);
ok(p6.pauses.length && p6.pauses[0].from === target.date && p6.pauses[0].to === target.date, '中断区间为单日', p6.pauses[0]);
ok(p6.pauses.length && p6.pauses[0].reason === '患者未到', '原因已记录', p6.pauses[0] && p6.pauses[0].reason);
ok(!has(computeSchedule(p6), target.date), '★ 该日期不再安排治疗（不计入已完成）', has(computeSchedule(p6), target.date));
ok(doneCount(p6) === before - 1, '★ 已完成次数减 1', { before, after: doneCount(p6) });
ok(computeSchedule(p6).length === 30, '★ 总次数仍为 30（顺延，不丢次数）', computeSchedule(p6).length);
ok(scheduleEnd(p6) > endBefore, '★ 结束日期顺延', { endBefore, after: scheduleEnd(p6) });

group('B6. 撤销「本次未做」→ 恢复');
const p6End = scheduleEnd(p6);
p6.pauses = [];
ok(doneCount(p6) === before, '★ 撤销后已完成次数恢复', doneCount(p6));
ok(scheduleEnd(p6) === endBefore, '结束日期恢复', scheduleEnd(p6));

group('B7. 加照：额外安排一次治疗');
const p7 = inState({ startDate: addDays(today, -7), fractions: '10', dosePerFraction: '2' });
const extraDay = addDays(today, -3);      /* 取一个已过去的日子 */
if (!scheduleOn(p7, extraDay)) {
  const before7 = doneCount(p7);
  cap(function () { sheetExtra(p7); }).onSave({ date: extraDay, reason: '周末补照' });
  ok(doneCount(p7) === before7 + 1, '★ 过去的加照日立即计入已完成', { before7, after: doneCount(p7) });
  ok(computeSchedule(p7).length === 10, '总次数不变（加照是插入，疗程提前结束）', computeSchedule(p7).length);
} else {
  ok(true, '（该日已有安排，跳过加照用例）');
}

group('B8. 手工标记机制已移除');
ok(typeof markDone === 'undefined', '★ markDone 已移除');
ok(typeof unmarkDone === 'undefined', '★ unmarkDone 已移除');
ok(typeof markAllDone === 'undefined', '★ 批量标记已移除');
ok(typeof skipHere === 'function', '★ 异常修正 skipHere 可用');
ok(js.indexOf("'mark-all'") < 0, '动作表中不再有 mark-all');
ok(js.indexOf('尚无手工标记') > 0 || js.indexOf('无需逐次标记') > 0, '界面已说明按日期推算');

group('B9. 待办联动（2026-10-07 收窄后）');
/* 需求变更：待办只保留「即将结束 / 还未开始 / 验证」+ 副反应 + 随访。
   「疗程已结束待归档」「今日应治疗」不再进待办 —— 在治页与详情页已可见。 */
setMakeup(today, '测试·今天上班');
const p8 = mkPatient({ startDate: addDays(today, -120), fractions: '5', dosePerFraction: '2' });
state = normalize({ version: 2, updatedAt: '', patients: [p8] });
state.patients[0].status = '在治';
let todo = buildTodo();
const reasons = todo.length ? todo[0].reasons : [];
console.log('  疗程已结束的患者待办:', JSON.stringify(reasons));
ok(reasons.indexOf('疗程已结束') < 0, '★ 不再提示「疗程已结束」待归档（移出待办）', reasons);
ok(reasons.indexOf('遗漏') < 0 && reasons.indexOf('尚未标记完成') < 0, '不再出现依赖手工标记的旧提示', reasons);

const p9 = mkPatient({ startDate: today, fractions: '10', dosePerFraction: '2' });
state = normalize({ version: 2, updatedAt: '', patients: [p9] });
state.patients[0].status = '在治';
ok(!!scheduleOn(state.patients[0], today), '（前置）今天确实有治疗安排');
todo = buildTodo();
const r9 = todo.length ? todo[0].reasons : [];
console.log('  今日有治疗的患者待办:', JSON.stringify(r9));
ok(r9.indexOf('今日应治疗') < 0, '★ 不再因「今日应治疗」进待办（移出待办）', r9);
ok(String(r9.join()).indexOf('未标记') < 0, '提示文案不再提「标记」', r9);

/* 未开始：开始日期在将来 → 必须提醒 */
const pNd = mkPatient({ startDate: addDays(today, 7), fractions: '30', dosePerFraction: '2' });
state = normalize({ version: 2, updatedAt: '', patients: [pNd] });
state.patients[0].status = '在治';
todo = buildTodo();
const rNd = todo.length ? todo[0].reasons : [];
console.log('  未开始患者待办:', JSON.stringify(rNd));
ok(rNd.indexOf('还未开始') >= 0, '★ 开始日期在将来 → 提示「还未开始」', rNd);

/* 待排程（缺开始日期）→ 归入「未开始」 */
const pNo = mkPatient({ startDate: '', fractions: '' });
state = normalize({ version: 2, updatedAt: '', patients: [pNo] });
state.patients[0].status = '在治';
todo = buildTodo();
const rNo = todo.length ? todo[0].reasons : [];
console.log('  待排程患者待办:', JSON.stringify(rNo));
ok(rNo.indexOf('待排程') >= 0 || rNo.indexOf('流程：') >= 0, '★ 缺排程信息 → 仍进待办（归未开始）', rNo);
delMakeup(today);      /* 复原 */

group('B10. 边界');
ok(doneCount(mkPatient({ startDate: '', fractions: '10' })) === 0, '无开始日期 → 0');
ok(doneCount(mkPatient({ startDate: today, fractions: '' })) === 0, '无总次数 → 0');
ok(accumulatedDose(mkPatient({ startDate: addDays(today, -10), fractions: '10', dosePerFraction: '' })) === 0, '无单次剂量 → 累计 0');
/* 当天即算已完成（含今天）——需保证今天确实是治疗日，故临时设为调休上班 */
setMakeup(today, '测试');
const p10 = mkPatient({ startDate: today, fractions: '1', dosePerFraction: '2' });
const s10 = computeSchedule(p10);
ok(s10.length === 1 && s10[0].date === today, '疗程首次落在今天', s10.map(x => x.date));
ok(s10[0] && s10[0].done === true, '★ 今天当天即算已完成（含今天）', s10[0] && s10[0].done);
ok(doneCount(p10) === 1, '完成次数 1', doneCount(p10));
delMakeup(today);

group('B11. 示例数据自然推算');
state = buildDemoState();
console.log('  示例患者完成情况（按日期自动推算）：');
state.patients.forEach(pp => {
  console.log('   ·', pp.name, '| 状态', pp.status, '| 处方', pp.fractions,
    '| 已完成', doneCount(pp), '| 累计', accumulatedDose(pp).toFixed(1) + 'Gy', '| 结束', scheduleEnd(pp) || '-');
});
const zhang = state.patients.find(x => x.name === '张伟');
ok(zhang && doneCount(zhang) === 0, '未开始的患者（张伟，未来开始）已完成 0 次', zhang ? doneCount(zhang) : null);
const wang = state.patients.find(x => x.name === '王建国');
ok(wang && doneCount(wang) > 0, '已进行的患者（王建国）已完成若干次', wang ? doneCount(wang) : null);

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
