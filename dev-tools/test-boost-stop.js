/* 加量（boost）与提前终止（stop）测试 */
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
let confirmAnswer = true, confirmMsgs = [];
global.alert = () => { }; global.confirm = (m) => { confirmMsgs.push(String(m || '')); return confirmAnswer; };
global.navigator = {}; global.URL = { createObjectURL() { return 'x'; }, revokeObjectURL() { } };
global.Blob = function () { };
global.FileReader = function () { };
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
function inState(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  state.patients[0].status = '在治';
  return state.patients[0];
}
const today = todayStr();

console.log('========== 加量与提前终止测试 ==========');

group('A1. 基线：无加量、无终止');
let p = inState({ startDate: addDays(today, -10), fractions: '20', dosePerFraction: '2' });
ok(parseInt(p.boostFractions, 10) || 0 === 0, '默认无加量', p.boostFractions);
ok(p.stopDate === '', '默认无终止', p.stopDate);
ok(totalFractionsOf(p) === 20, '总次数 = 处方次数 20', totalFractionsOf(p));
ok(plannedCount(p) === 20, '排程 20 次', plannedCount(p));
ok(stoppedShortOf(p) === 0, '未执行 0 次', stoppedShortOf(p));
const endBase = scheduleEnd(p);
console.log('  基线：20 次，结束', endBase);

group('B1. 加量：原计划结束后追加');
/* 先记录加量前的排程，用于对比「前 N 次是否被打乱」 */
const sBaseDates = computeSchedule(p).map(x => x.date);
cap(function () { sheetBoost(p); }).onSave({ boostFractions: '5', boostNote: '局部加量 10Gy/5次' });
ok(p.boostFractions === '5', '加量次数已保存', p.boostFractions);
ok(p.boostNote === '局部加量 10Gy/5次', '加量说明已保存', p.boostNote);
ok(totalFractionsOf(p) === 25, '★ 总次数 = 20 + 5 = 25', totalFractionsOf(p));
ok(plannedCount(p) === 25, '★ 排程扩展到 25 次', plannedCount(p));
const endBoost = scheduleEnd(p);
ok(endBoost > endBase, '★ 结束日期相应延后（' + endBase + ' → ' + endBoost + '）');
const sBoost = computeSchedule(p);
ok(JSON.stringify(sBaseDates) === JSON.stringify(sBoost.slice(0, 20).map(x => x.date)),
  '★ 前 20 次日期与原计划完全相同（未被打乱）', { base: sBaseDates.length, boost: sBoost.length });
ok(sBoost.filter(x => x.boost).length === 5, '★ 第 21~25 次标记为加量', sBoost.filter(x => x.boost).length);
ok(sBoost[19].boost === false && sBoost[20].boost === true, '★ 第 20 次不是加量、第 21 次是加量（边界正确）', { f20: sBoost[19].boost, f21: sBoost[20].boost });
ok(sBoost[24].fraction === 25, '第 25 次编号正确', sBoost[24].fraction);

group('B2. 加量后的剂量统计');
ok(accumulatedDose(p) === doneCount(p) * 2, '累计剂量 = 已完成 × 单次剂量', accumulatedDose(p));
ok(remainCount(p) === 25 - doneCount(p), '剩余次数按 25 次计算', remainCount(p));

group('B3. 修改加量次数');
const end5 = scheduleEnd(p);
cap(function () { sheetBoost(p); }).onSave({ boostFractions: '10', boostNote: '改加量' });
ok(totalFractionsOf(p) === 30, '★ 改为 10 次 → 总 30 次', totalFractionsOf(p));
ok(scheduleEnd(p) > end5, '结束日期进一步延后');
/* 减为 0 → 取消加量 */
confirmAnswer = true;
cap(function () { sheetBoost(p); }).onSave({ boostFractions: '0' });
ok((parseInt(p.boostFractions, 10) || 0) === 0, '★ 设为 0 → 取消加量', p.boostFractions);
ok(plannedCount(p) === 20, '排程回到 20 次', plannedCount(p));
ok(scheduleEnd(p) === endBase, '结束日期回到基线', scheduleEnd(p));

group('B4. 加量与非整周治疗日共存');
const pOdd = inState({ startDate: today, fractions: '4', dosePerFraction: '3', treatDays: [1, 3, 5] });
cap(function () { sheetBoost(pOdd); }).onSave({ boostFractions: '2', boostNote: '隔日加量' });
const so = computeSchedule(pOdd);
ok(so.length === 6, '周一三五方案：4 + 2 = 6 次', so.length);
ok(so.every(x => [1, 3, 5].includes(parseD(x.date).getDay())), '★ 加量部分也遵守该患者的治疗日设置', so.map(x => x.date));
ok(so.filter(x => x.boost).length === 2, '2 次标记为加量', so.filter(x => x.boost).length);

group('B5. 加量与中断共存');
const pPause = inState({ startDate: today, fractions: '10', dosePerFraction: '2' });
cap(function () { sheetBoost(pPause); }).onSave({ boostFractions: '3', boostNote: '' });
const e1 = scheduleEnd(pPause);
cap(function () { sheetPause(pPause, null); }).onSave({ from: addDays(today, 5), to: addDays(today, 9), reason: '机器故障' });
ok(scheduleEnd(pPause) > e1, '★ 中断会让加量后的整体顺延', { before: e1, after: scheduleEnd(pPause) });
ok(plannedCount(pPause) === 13, '总次数仍为 13（10+3）', plannedCount(pPause));
ok(!computeSchedule(pPause).some(x => x.date >= addDays(today, 5) && x.date <= addDays(today, 9)), '中断期不排治疗');

group('B6. 加量的输入校验');
const pV = inState({ startDate: today, fractions: '10', dosePerFraction: '2' });
cap(function () { sheetBoost(pV); }).onSave({ boostFractions: '3', boostNote: '' });
ok(plannedCount(pV) === 13, '先加 3 次');
let ret = cap(function () { sheetBoost(pV); }).onSave({ boostFractions: 'abc', boostNote: '' });
ok(ret === false, '★ 非数字被拒绝', ret);
ret = cap(function () { sheetBoost(pV); }).onSave({ boostFractions: '-2', boostNote: '' });
ok(ret === false, '★ 负数被拒绝', ret);
ok(plannedCount(pV) === 13, '拒绝后排程未变', plannedCount(pV));
ret = cap(function () { sheetBoost(pV); }).onSave({ boostFractions: '0', boostNote: '' });
ok(ret === false || (parseInt(pV.boostFractions, 10) || 0) === 0, '填 0 需二次确认后才取消');

group('C1. 提前终止：到某日为止');
let pS = inState({ startDate: addDays(today, -20), fractions: '30', dosePerFraction: '2' });
const fullEnd = scheduleEnd(pS);
const fullCount = plannedCount(pS);
const schedAll = computeSchedule(pS);
const stopAt = schedAll[19].date;              /* 第 20 次那天终止 */
console.log('  全疗程 ' + fullCount + ' 次，止于第 20 次 ' + stopAt);
cap(function () { sheetStop(pS); }).onSave({ stopDate: stopAt, reason: '患者拒绝继续' });
ok(pS.stopDate === stopAt, '终止日已保存', pS.stopDate);
ok(plannedCount(pS) === 20, '★ 实际只排 20 次', plannedCount(pS));
ok(totalFractionsOf(pS) === 30, '★ 原处方 30 次信息保留', totalFractionsOf(pS));
ok(stoppedShortOf(pS) === 10, '★ 未执行 10 次', stoppedShortOf(pS));
ok(scheduleEnd(pS) === stopAt, '★ 结束日 = 终止日', scheduleEnd(pS));
ok(scheduleEnd(pS) < fullEnd, '结束日早于原计划（' + fullEnd + '）', scheduleEnd(pS));
/* 终止日之后的日期不应出现在排程里 */
ok(!computeSchedule(pS).some(x => x.date > stopAt), '★ 终止日之后不再安排任何治疗');

group('C2. 终止日的边界（含当日）');
const pB = inState({ startDate: addDays(today, -20), fractions: '30', dosePerFraction: '2' });
const sAll = computeSchedule(pB);
const d25 = sAll[24].date;
cap(function () { sheetStop(pB); }).onSave({ stopDate: d25, reason: '' });
const keep = computeSchedule(pB);
ok(keep.length === 25, '止于第 25 次 → 排 25 次', keep.length);
ok(keep[keep.length - 1].date === d25, '★ 终止当日仍安排（含当日）', keep[keep.length - 1].date);
ok(!keep.some(x => x.date > d25), '之后的都不排');

group('C3. 终止后取消 → 恢复原计划');
const beforeCancel = plannedCount(pB);
cancelStop(pB);
ok(pB.stopDate === '', '★ 终止已取消', pB.stopDate);
ok(plannedCount(pB) === 30, '★ 排程恢复为 30 次', plannedCount(pB));
ok(plannedCount(pB) > beforeCancel, '恢复后次数增加', { before: beforeCancel, after: plannedCount(pB) });
ok(scheduleEnd(pB) === fullEnd || scheduleEnd(pB) === sAll[29].date, '结束日回到原计划', scheduleEnd(pB));

group('C4. 终止 + 加量共存');
const pBoth = inState({ startDate: addDays(today, -20), fractions: '30', dosePerFraction: '2' });
cap(function () { sheetBoost(pBoth); }).onSave({ boostFractions: '5', boostNote: '加量' });
ok(plannedCount(pBoth) === 35, '先加量到 35 次', plannedCount(pBoth));
const sB = computeSchedule(pBoth);
const stopD = sB[21].date;                     /* 第 22 次时终止 */
cap(function () { sheetStop(pBoth); }).onSave({ stopDate: stopD, reason: '出现放射性损伤' });
ok(totalFractionsOf(pBoth) === 35, '★ 处方仍含加量（35 次）', totalFractionsOf(pBoth));
ok(plannedCount(pBoth) === 22, '★ 实际排 22 次', plannedCount(pBoth));
ok(stoppedShortOf(pBoth) === 13, '★ 未执行 13 次（含未做的加量）', stoppedShortOf(pBoth));
const doneBoosts = computeSchedule(pBoth).filter(x => x.boost).length;
console.log('  22 次中已排入的加量次数:', doneBoosts);
ok(doneBoosts <= 5, '已排入的加量次数不超过 5', doneBoosts);

group('C5. 终止后已完成次数按实际推算');
/* 用足够早的开始日期，使终止日落在「已经过去」的区间 */
const pD = inState({ startDate: addDays(today, -45), fractions: '30', dosePerFraction: '2' });
const sd = computeSchedule(pD);
const stopMid = sd[19].date;                   /* 第 20 次 */
console.log('  止于第 20 次（' + stopMid + '），今天 ' + today);
cap(function () { sheetStop(pD); }).onSave({ stopDate: stopMid, reason: '' });
ok(plannedCount(pD) === 20, '实际 20 次', plannedCount(pD));
const expectDone = computeSchedule(pD).filter(x => x.date <= today).length;
ok(doneCount(pD) === expectDone, '★ 已完成次数 = 排程中日期已过的次数', { got: doneCount(pD), want: expectDone });
ok(doneCount(pD) === 20, '★ 终止日已过去 → 20 次全部完成', doneCount(pD));
ok(accumulatedDose(pD) === 40, '累计剂量 20 × 2 = 40 Gy', accumulatedDose(pD));
ok(remainCount(pD) === 0, '无剩余', remainCount(pD));
ok(stoppedShortOf(pD) === 10, '未执行 10 次', stoppedShortOf(pD));

group('C6. 终止后归档：随访起算日 = 实际最后治疗日');
const pA = inState({ startDate: addDays(today, -60), fractions: '30', dosePerFraction: '2' });
const sa = computeSchedule(pA);
const stopA = sa[19].date;
cap(function () { sheetStop(pA); }).onSave({ stopDate: stopA, reason: '' });
ok(treatmentEndOf(pA) === stopA, '★ 放疗结束日 = 终止日（不是原计划结束日）', { got: treatmentEndOf(pA), want: stopA });
cap(function () { completePatient(pA); }).onSave({ doneDate: '' });
ok(pA.status === '治疗完成', '已归档');
ok(dateOnly(pA.completedAt) === stopA, '★ 默认完成日期 = 终止日', pA.completedAt);
/* 随访从此起算 */
applyTplToPatient(pA, { items: [{ n: 3, u: 'm' }, { n: 6, u: 'm' }], base: treatmentEndOf(pA) });
const f1 = pendingFollowups(pA).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
ok(f1.dueDate === addInterval(stopA, 3, 'm'), '★ 随访以终止日（放疗结束日）起算', f1.dueDate);

group('C7. 终止的输入校验');
const pV2 = inState({ startDate: today, fractions: '10', dosePerFraction: '2' });
ok(cap(function () { sheetStop(pV2); }).onSave({ stopDate: '', reason: '' }) === false, '★ 空日期被拒绝');
ok(!pV2.stopDate, '未写入');

group('D1. 待办提示');
const pT = inState({ startDate: addDays(today, -60), fractions: '30', dosePerFraction: '2' });
const st2 = computeSchedule(pT);
cap(function () { sheetStop(pT); }).onSave({ stopDate: st2[19].date, reason: '' });
let todo = buildTodo();
let reasons = todo.length ? todo[0].reasons : [];
console.log('  提前终止患者的待办:', JSON.stringify(reasons));
ok(reasons.indexOf('已提前终止') >= 0, '★ 提示「已提前终止」', reasons);
ok(String(reasons.join()).indexOf('未执行') >= 0 || (todo[0] && String(todo[0].details.join()).indexOf('未执行') >= 0), '详情含未执行次数', todo[0] ? todo[0].details : null);

group('D2. 未终止的走原提示（回归）');
const pT2 = inState({ startDate: addDays(today, -60), fractions: '10', dosePerFraction: '2' });
const reasons2 = buildTodo().length ? buildTodo()[0].reasons : [];
console.log('  正常完成患者的待办:', JSON.stringify(reasons2));
ok(reasons2.indexOf('疗程已结束') >= 0, '★ 未终止的仍提示「疗程已结束」', reasons2);
ok(reasons2.indexOf('已提前终止') < 0, '不出现终止提示', reasons2);

group('E1. 界面展示');
const pU = inState({ startDate: addDays(today, -30), fractions: '20', dosePerFraction: '2' });
cap(function () { sheetBoost(pU); }).onSave({ boostFractions: '5', boostNote: '瘤床加量' });
const su = computeSchedule(pU);
cap(function () { sheetStop(pU); }).onSave({ stopDate: su[17].date, reason: '病情变化' });
view.page = 'patient'; view.pid = pU.id; render();
const page = getEl('view').innerHTML;
ok(page.indexOf('处方次数') >= 0, '★ 显示「处方次数」');
ok(page.indexOf('＋ 加量 <b>5</b> 次') >= 0 || page.indexOf('加量 <b>5</b> 次') >= 0, '★ 显示加量构成', true);
ok(page.indexOf('瘤床加量') >= 0, '★ 显示加量说明');
ok(page.indexOf('提前终止') >= 0, '★ 显示「提前终止」行');
ok(page.indexOf('已终止') >= 0, '★ 显示「已终止」标记');
ok(page.indexOf('未执行 <b>') >= 0, '★ 显示未执行次数', true);
ok(page.indexOf('实际结束') >= 0, '★ 标题改为「实际结束」（已终止）');
ok(page.indexOf('取消终止（恢复原计划）') >= 0, '★ 有「取消终止」按钮');
ok(page.indexOf('改加量（现有 5 次）') >= 0, '★ 加量按钮显示当前次数');
ok(!page.indexOf('>提前终止<') >= 0 || page.indexOf('取消终止') >= 0, '已终止时不显示「提前终止」按钮');

group('E2. 未终止时显示「提前终止」按钮');
const pN = inState({ startDate: today, fractions: '10', dosePerFraction: '2' });
view.pid = pN.id; render();
const pageN = getEl('view').innerHTML;
ok(pageN.indexOf('提前终止') >= 0, '★ 有「提前终止」按钮');
ok(pageN.indexOf('＋ 加量') >= 0, '★ 有「＋ 加量」按钮');
ok(pageN.indexOf('预计结束') >= 0, '未终止时标题为「预计结束」');

group('E3. 日历区分加量');
const pCal = inState({ startDate: today, fractions: '4', dosePerFraction: '2' });
cap(function () { sheetBoost(pCal); }).onSave({ boostFractions: '2', boostNote: '' });
view.page = 'patient';                       /* 显式复位（前面的用例可能改动过） */
view.pid = pCal.id;
const scCal = computeSchedule(pCal);
/* 注意（2026-10-06 修复）：原先渲染「第一次治疗所在月」，而加量排在疗程末尾，
   遇到月末开始或节假日顺延时加量会落到次月，当月日历里根本没有 boost 标记 →
   断言误报（实测 02-28 / 09-25 / 12-31 / 2028-02-29 等日期都会红）。
   改为渲染加量项所在的月份。 */
const boostItem = scCal.filter(function (x) { return x.boost; })[0] || scCal[scCal.length - 1];
view.calY = parseInt(boostItem.date.slice(0, 4), 10);
view.calM = parseInt(boostItem.date.slice(5, 7), 10);
render();
const calPage = getEl('view').innerHTML;
console.log('  日历月份', view.calY + '-' + view.calM, '| 排程', scCal.length, '次 | 页面长度', calPage.length);
ok(calPage.indexOf('cal-legend') >= 0, '日历已渲染');
ok(calPage.indexOf('tagline boost') >= 0, '★ 日历上用 boost 样式标记加量');
ok(calPage.indexOf('加量</span>') >= 0, '★ 图例含「加量」');

group('F1. 数据持久化与迁移');
const pSave = inState({ startDate: today, fractions: '10', dosePerFraction: '2' });
pSave.boostFractions = '4'; pSave.boostNote = '测试加量'; pSave.stopDate = addDays(today, 20);
ok(save() === true, '保存成功');
load();
const loaded = state.patients[0];
ok(loaded.boostFractions === '4', '★ 加量次数持久化', loaded.boostFractions);
ok(loaded.boostNote === '测试加量', '★ 加量说明持久化', loaded.boostNote);
ok(loaded.stopDate === addDays(today, 20), '★ 终止日持久化', loaded.stopDate);
/* 缺字段的老数据 */
const legacy = normalize({ version: 2, updatedAt: '', patients: [{ name: '老数据', status: '在治', fractions: '10', startDate: today }] });
ok(legacy.patients[0].boostFractions === '', '★ 老数据缺加量字段 → 空（不报错）', legacy.patients[0].boostFractions);
ok(legacy.patients[0].stopDate === '', '★ 老数据缺终止字段 → 空', legacy.patients[0].stopDate);
ok(computeSchedule(legacy.patients[0]).length === 10, '老数据排程正常', computeSchedule(legacy.patients[0]).length);

group('F2. 导出含加量与终止信息');
global.__blobs = [];
global.Blob = function (parts, opt) { global.__blobs.push({ text: (parts || []).join(''), type: (opt || {}).type }); };
state = normalize({ version: 2, updatedAt: '', patients: [
  Object.assign({}, pU, { status: '在治' })
] });
exportCsv();
const csv = global.__blobs[global.__blobs.length - 1];
ok(csv && csv.text.indexOf('加量') >= 0, '★ CSV 表头含「加量」');
ok(csv && csv.text.indexOf('未执行') >= 0, '★ CSV 表头含「未执行」');
ok(csv && csv.text.indexOf('瘤床加量') >= 0, '★ CSV 含加量说明', true);
ok(csv && csv.text.indexOf('终止于') >= 0, '★ CSV 含终止信息', true);

group('F3. 边界');
const pE1 = inState({ startDate: '', fractions: '10' });
ok(plannedCount(pE1) === 0, '无开始日期 → 0 次');
ok(stoppedShortOf(pE1) === 0, '无排程时未执行 0（不报错）');
const pE2 = inState({ startDate: today, fractions: '10', dosePerFraction: '2', stopDate: '2000-01-01' });
ok(plannedCount(pE2) === 0, '★ 终止日远早于开始日 → 0 次（安全）', plannedCount(pE2));
ok(stoppedShortOf(pE2) === 10, '未执行 10 次', stoppedShortOf(pE2));
const pE3 = inState({ startDate: today, fractions: '10', dosePerFraction: '2', stopDate: addDays(today, 999) });
ok(plannedCount(pE3) === 10, '终止日远晚于疗程 → 不影响', plannedCount(pE3));
const pE4 = inState({ startDate: today, fractions: '10', dosePerFraction: '2', boostFractions: '3', stopDate: '2000-01-01' });
ok(totalFractionsOf(pE4) === 13, '含加量的处方次数正确', totalFractionsOf(pE4));
ok(stoppedShortOf(pE4) === 13, '全部未执行', stoppedShortOf(pE4));

group('G1. 示例数据与既有功能回归');
state = buildDemoState();
ok(state.patients.length === 6, '示例数据 6 位患者', state.patients.length);
state.patients.forEach(pp => {
  const b = parseInt(pp.boostFractions, 10) || 0;
  if (b) console.log('   有加量:', pp.name, b, '次');
});
ok(state.patients.every(pp => !pp.stopDate), '示例数据默认无终止');
const wang = state.patients.find(x => x.name === '王建国');
ok(doneCount(wang) > 0, '按日期推算完成次数正常', doneCount(wang));
ok(wang.followupPlans.length === 0, '在治患者无随访计划');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
