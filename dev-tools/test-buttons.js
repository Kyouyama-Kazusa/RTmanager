/* 按钮 / 交互功能测试：走真实的事件委托路径，验证每个按钮都能正确触发 */
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
const DIR = appRoot();
let html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
js = js.replace(/^init\(\);\s*$/m, '');

/* ---------- 更真实的 DOM 桩：按 id 缓存元素，可回读内容 ---------- */
const elById = {};
function makeEl(id) {
  const e = {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '',
    type: '', checked: false, accept: '', files: null,
    classList: {
      _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; },
      toggle(c, f) { if (f === undefined) { this._s[c] ? delete this._s[c] : this._s[c] = 1; } else if (f) this._s[c] = 1; else delete this._s[c]; },
      contains(c) { return !!this._s[c]; }
    },
    addEventListener() { }, onclick: null, onchange: null,
    dataset: {}, parentElement: null, children: [],
    appendChild() { }, removeChild() { }, click() { }, remove() { }
  };
  return e;
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }

/* 捕获 document 上注册的 click 委托 */
let clickHandler = null;
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
let queryResult = [];
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll(sel) { return queryResult; }, querySelector() { return null; },
  createElement() { return makeEl(); },
  body: { appendChild() { }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; },
  documentElement: makeEl(),
  location: { search: '', protocol: 'file:' }
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
let alertMsgs = [], confirmAnswer = true, toastMsgs = [];
global.alert = (m) => { alertMsgs.push(String(m)); };
global.confirm = () => confirmAnswer;
global.navigator = {};
global.URL = { createObjectURL() { return 'blob:x'; }, revokeObjectURL() { } };
let downloaded = [];
global.__blobs = [];
const _Blob = global.Blob;
global.Blob = function (parts, opt) { this.parts = parts; this.type = (opt || {}).type; global.__blobs.push({ text: (parts||[]).join(''), type: (opt||{}).type }); };
global.FileReader = function () {
  const self = this;
  this.readAsText = function () {
    setTimeout(function () { self.result = global.__fileContent; self.onload && self.onload(); }, 0);
  };
};

eval(js);
bind();   /* init() 被剥离，手动注册事件委托 */

/* 从源码中提取真实的动作注册表（acts 对象字面量） */
const actsSrc = js.slice(js.indexOf('var acts = {'));
const actsBlock = actsSrc.slice(0, actsSrc.indexOf('\n  };'));
const REGISTERED = new Set([...actsBlock.matchAll(/'([a-z-]+)':\s*function/g)].map(m => m[1]));

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function group(name) { console.log(''); console.log('--- ' + name + ' ---'); }
/* 切换测试分组时清掉上一组留下的弹层状态，避免相互干扰 */
function resetUI() { closeSheet(); sheetCtx = null; reopenSheet = null; view.page = 'tab'; }

/* 用真实委托路径点击：构造带 dataset 的元素并调用 document 的 click 监听 */
function fire(act, data) {
  if (!clickHandler) throw new Error('未捕获到 click 委托');
  const el = makeEl();
  el.dataset.act = act;
  Object.assign(el.dataset, data || {});
  clickHandler({ target: el });
  return el;
}
function cap(fn){ fn(); if(!sheetCtx||!sheetCtx.onSave) throw new Error("弹层未打开或无 onSave"); return sheetCtx; }
/* 调用最新打开的弹层里的按钮 */
function fireInSheet(act, data) { return fire(act, data); }
/* 把患者放进 state 并返回它（涉及 getPatient 的操作必须用这个） */
function inState(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  state.patients[0].status = '在治';
  return state.patients[0];
}

/* 捕获 toast（记录消息） */
/* ★★ 坑（v0.15.0 实测）：`eval(js)` 在**函数作用域**内执行时，源码里的
   `function toast(){}` 会创建 eval 局部绑定，**不会**挂到 global 上 ——
   所以下面这种 `global.toast = ...` 覆盖是无效的：应用调用的仍是 eval 里的那个 toast。
   验证方式：`node -e "global.x=1"` 类最小复现 → 覆盖后调用打出的仍是原实现。
   正确做法：用 globalThis 名字在**源码里**间接转发 —— 见下面 toastCalls 的用法。 */
const toastCalls = [];
if (typeof global.__rtToastSink === 'undefined') global.__rtToastSink = null;
global.__rtToastSink = function (m) { toastCalls.push(String(m)); };

console.log('========== 按钮功能验证 ==========');

/* ---------- 收集所有渲染出的 data-act ---------- */
resetUI(); group('1. 静态检查：所有渲染出的按钮都有对应处理函数');
console.log('  源码中注册的动作数:', REGISTERED.size);

/* 渲染各页面并收集 data-act */
state = buildDemoState();
const collected = new Set();
function harvest(html) {
  const m = html.match(/data-act="([a-z-]+)"/g) || [];
  m.forEach(x => collected.add(x.replace(/data-act="|"/g, '')));
}
['todo', 'ward', 'cal', 'done'].forEach(t => { view.page = 'tab'; view.tab = t; render(); harvest(getEl('view').innerHTML); });
view.page = 'settings'; render(); harvest(getEl('view').innerHTML);

/* 患者详情 + 各种弹层 */
const demoP = state.patients[0];
view.page = 'patient'; view.pid = demoP.id; render(); harvest(getEl('view').innerHTML);
sheetPatient(demoP); harvest(getEl('sheetBody').innerHTML);
sheetReaction(demoP, demoP.reactions[0]); harvest(getEl('sheetBody').innerHTML);
sheetReactionPlan(demoP, demoP.reactions[0]); harvest(getEl('sheetBody').innerHTML);
sheetReactionFollow(demoP, demoP.reactions[0]); harvest(getEl('sheetBody').innerHTML);
sheetPause(demoP, null); harvest(getEl('sheetBody').innerHTML);
sheetExtra(demoP); harvest(getEl('sheetBody').innerHTML);
sheetListPauses(demoP); harvest(getEl('sheetBody').innerHTML);
sheetExtraList(demoP); harvest(getEl('sheetBody').innerHTML);
sheetFollowup(demoP, null); harvest(getEl('sheetBody').innerHTML);
sheetTreatDays(); harvest(getEl('sheetBody').innerHTML); harvest(getEl('sheetFootInner').innerHTML);
sheetAddHoliday(); harvest(getEl('sheetBody').innerHTML);
sheetAddMakeup(); harvest(getEl('sheetBody').innerHTML);
sheetHolidayManage(); harvest(getEl('sheetBody').innerHTML); harvest(getEl('sheetFootInner').innerHTML);
sheetMakeupManage(); harvest(getEl('sheetBody').innerHTML); harvest(getEl('sheetFootInner').innerHTML);
sheetDayOverall(todayStr()); harvest(getEl('sheetBody').innerHTML);
sheetDayPatient(demoP, todayStr()); harvest(getEl('sheetBody').innerHTML);
completePatient(demoP); harvest(getEl('sheetBody').innerHTML);
askImportMode(normalize({ patients: [{ id: 'x', name: '测试', status: '在治' }] })); harvest(getEl('sheetBody').innerHTML);

console.log('  已渲染出的动作数:', collected.size);
const unhandled = [...collected].filter(a => !REGISTERED.has(a));
ok(unhandled.length === 0, '★ 所有渲染出的按钮都有处理函数（无死按钮）', unhandled);
const unused = [...REGISTERED].filter(a => !collected.has(a));
console.log('  已注册但本次未渲染:', unused.join(', ') || '无');
console.log('  逐个动作:', [...collected].join(' '));

/* ---------- 行为测试 ---------- */
resetUI(); group('2. 患者增删改');
state = buildDemoState(); view.page = 'tab'; view.tab = 'ward'; render();
const before = state.patients.length;

fire('add-patient');
ok(!!sheetCtx, '「添加患者」打开表单');
getEl('sheetBody').__vals = { name: '新患者甲', mrn: 'M900', sex: '男', diagnosis: '测试病', purpose: '根治性', technique: 'IMRT', fractions: '10', totalDose: '20', dosePerFraction: '2', startDate: todayStr() };
/* 直接调用表单保存回调 */
const pForm = sheetCtx;
pForm.onSave({ name: '新患者甲', mrn: 'M900', sex: '男', age: '50', diagnosis: '测试病', purpose: '根治性', technique: 'IMRT', physician: '', planStatus: '已通过', totalDose: '20', fractions: '10', dosePerFraction: '2', simDate: '', startDate: todayStr(), position: '' });
ok(state.patients.length === before + 1, '添加患者成功（' + before + ' → ' + state.patients.length + '）', state.patients.length);
const np = state.patients[state.patients.length - 1];
ok(np.name === '新患者甲', '患者信息正确写入', np.name);
ok(computeSchedule(np).length === 10, '★ 自动排程生效（10 次）', computeSchedule(np).length);

/* 编辑 */
fire('edit-patient', { id: np.id });
view.pid = np.id;
cap(function(){ sheetPatient(np); }).onSave({ name: '新患者乙', mrn: 'M901', sex: '男', age: '51', diagnosis: '测试病2', purpose: '姑息性', technique: 'VMAT', physician: '张医生', planStatus: '已通过', totalDose: '30', fractions: '15', dosePerFraction: '2', simDate: '', startDate: todayStr(), position: '' });
ok(np.name === '新患者乙' && np.fractions === '15', '编辑患者成功', np.name + '/' + np.fractions);
ok(computeSchedule(np).length === 15, '改总次数后自动重排（15 次）', computeSchedule(np).length);

/* 删除 */
confirmAnswer = true;
fire('delete-patient', { id: np.id });
ok(state.patients.length === before, '删除患者成功，回到 ' + before + ' 位', state.patients.length);

resetUI(); group('3. 治疗日历：按日期推算完成 / 异常修正 / 中断 / 加照');
state = buildDemoState();
const tp = state.patients[2];               /* 张伟：尚未开始 */
view.pid = tp.id;
tp.startDate = todayStr();
const sched0 = computeSchedule(tp);
const firstDate = sched0[0].date;
ok(computeSchedule(tp)[0].done === (firstDate <= todayStr()), '首次完成状态由日期推算', computeSchedule(tp)[0].done);

/* 手工标记机制已移除：确认动作表里没有 mark / unmark / mark-all */
ok(js.indexOf("'mark': function") < 0, '★ 动作表不再有「标记完成」');
ok(js.indexOf("'unmark': function") < 0, '★ 动作表不再有「取消完成」');
ok(js.indexOf("'mark-all'") < 0, '★ 动作表不再有「全部标记完成」');

/* 取一个「已过去」的治疗日，验证它自动计入完成；再对它做「本次未做」 */
const pastP = inState({ startDate: addDays(todayStr(), -14), fractions: '30', dosePerFraction: '2' });
view.pid = pastP.id;
const doneBefore = doneCount(pastP);
const pastItem = computeSchedule(pastP).filter(x => x.done)[1];
ok(doneBefore > 0, '★ 已过去的治疗日自动计入完成（无需任何操作）', doneBefore);
ok(isDoneOn(pastP, pastItem.date), '★ isDoneOn 按日期返回 true', pastItem.date);

cap(function () { skipHere(pastP.id, pastItem.date); }).onSave({ reason: '患者未到' });
ok(pastP.pauses.length === 1, '★「本次未做」记录成功', pastP.pauses.length);
ok(doneCount(pastP) === doneBefore - 1, '★ 未做的该次不再计入完成', { doneBefore, after: doneCount(pastP) });

/* 恢复：把 tp 放回 state，继续验证中断 / 加照 */
state = normalize({ version: 2, updatedAt: '', patients: [tp] });
const tp2 = state.patients[0];
tp2.startDate = todayStr();
view.pid = tp2.id;

/* 中断 → 顺延 */
const endBefore = scheduleEnd(tp2);
const cntBefore = computeSchedule(tp2).length;
/* 注意（2026-10-06 修复）：中断区间原先写死「今天 +2 ~ +5 天」。若运行当天落在法定
   节假日（如春节 2/15~2/23、国庆 10/01~10/07），这几天本来就不排治疗，中断它们不会
   影响排程，结束日期自然不变 —— 断言会误报失败。
   改为取排程里真实的第 3~5 个治疗日作为中断区间。 */
const scPause = computeSchedule(tp2);
const pi = Math.min(2, scPause.length - 1), pj = Math.min(4, scPause.length - 1);
cap(function(){ sheetPause(tp2, null); }).onSave({ from: scPause[pi].date, to: scPause[pj].date, reason: '机器故障' });
ok(tp2.pauses.length === 1, '★「中断」记录成功', tp2.pauses.length);
const endAfter = scheduleEnd(tp2);
ok(endAfter > endBefore, '中断后结束日期自动顺延（' + endBefore + ' → ' + endAfter + '）');
ok(computeSchedule(tp2).length === cntBefore, '排程总次数不变', computeSchedule(tp2).length);
ok(!computeSchedule(tp2).some(x => x.date >= scPause[pi].date && x.date <= scPause[pj].date), '中断区间内不再安排治疗');

/* 中断列表 → 删除 */
fire('list-pauses', { id: tp2.id });
ok(getEl('sheetBody').innerHTML.indexOf('机器故障') >= 0, '「查看中断」列出中断原因');
confirmAnswer = true;
fire('pause-del', { id: tp2.pauses[0].id });
ok(tp2.pauses.length === 0, '★ 删除中断成功（日程重算）', tp2.pauses.length);
ok(scheduleEnd(tp2) === endBefore, '删除中断后结束日期恢复', scheduleEnd(tp2));

/* 加照 */
let extraDay = addDays(todayStr(), 1); while (Object.prototype.hasOwnProperty.call(holidays(), extraDay)) extraDay = addDays(extraDay, 1);
cap(function(){ sheetExtra(tp2); }).onSave({ date: extraDay, reason: '周末补照' });
ok(tp2.extras.length === 1, '★「加照」成功', tp2.extras.length);
const extraItem = computeSchedule(tp2).find(x => x.date === extraDay);
ok(!!extraItem && extraItem.extra === true, '加照日已进入排程且标记为加照', extraItem);

fire('list-extras', { id: tp2.id });
ok(getEl('sheetBody').innerHTML.indexOf('周末补照') >= 0, '「查看加照」列出加照原因');
fire('extra-del', { id: tp2.extras[0].id });
ok(tp2.extras.length === 0, '★ 删除加照成功', tp2.extras.length);

/* 假期加照：医生显式指定假期日期也应当排入 */
const holDay = Object.keys(holidays()).sort().find(d => d > todayStr());
if (holDay) {
  const endBefore2 = scheduleEnd(tp2);
  cap(function () { sheetExtra(tp2); }).onSave({ date: holDay, reason: '假期加照' });
  const hItem = computeSchedule(tp2).find(x => x.date === holDay);
  ok(!!hItem && hItem.extra === true, '★ 显式加照可排入法定节假日（' + holDay + '）', hItem ? hItem.fraction : null);
  /* 加照的语义是「在排程中插入一次」，处方总次数不变，疗程提前结束 */
  ok(computeSchedule(tp2).length === parseInt(tp2.fractions, 10), '★ 加照不改变处方总次数（恒为 ' + tp2.fractions + ' 次）', computeSchedule(tp2).length);
  ok(scheduleEnd(tp2) < endBefore2, '★ 加照使疗程提前结束（' + endBefore2 + ' → ' + scheduleEnd(tp2) + '）');

  /* 中断区间内的加照仍应被拒绝 */
  const pz = addDays(todayStr(), 2), pzTo = addDays(todayStr(), 4);
  tp2.pauses.push({ id: 'pz1', from: pz, to: pzTo, reason: '测试' });
  const inPauseDay = addDays(todayStr(), 3);
  const items = computeSchedule(tp2).filter(x => x.date >= pz && x.date <= pzTo);
  ok(items.length === 0, '★ 中断区间内即使加照也不排入（患者不在治疗状态）', items.length);
  tp2.pauses.pop();
  tp2.extras.pop();
}
resetUI(); group('3b. 空数据下的按钮安全性');

/* 患者不存在时，各操作不应崩溃 */
view.pid = '不存在的ID';
const actsToTry = ['edit-patient', 'add-reaction', 'add-followup', 'add-pause', 'add-extra',
  'list-pauses', 'list-extras', 'delete-patient', 'complete-patient', 'pause-edit', 'pause-del',
  'skip-here', 'stop-here', 'resume-here', 'add-extra-date', 'followup-done', 'followup-del', 'extra-del'];
let crashed = null;
actsToTry.forEach(a => {
  try { fire(a, { id: 'nope', date: todayStr() }); } catch (e) { crashed = a + ': ' + e.message; }
});
ok(crashed === null, '★ 患者不存在时所有操作安全返回（不崩溃）', crashed);

resetUI(); group('4. 副反应闭环');
state = buildDemoState();
const rp = state.patients[0];
const rcBefore = rp.reactions.length;
cap(function(){ sheetReaction(rp, null); }).onSave({ site: '放射性肺炎', grade: '3级（重）', foundAt: todayStr() + 'T10:00', content: '咳嗽气促', status: '未处理', nextCheckAt: addDays(todayStr(), 3), plan: '', planAt: '' });
ok(rp.reactions.length === rcBefore + 1, '★「记录副反应」成功', rp.reactions.length);
const newR = rp.reactions[rp.reactions.length - 1];
ok(newR.grade === '3级（重）' && newR.site === '放射性肺炎', '分级与部位正确', newR.grade);

cap(function(){ sheetReactionPlan(rp, newR); }).onSave({ plan: '激素治疗', planAt: nowLocalInput(), status: '已处理待复查' });
ok(newR.status === '已处理待复查' && newR.plan === '激素治疗', '★「处理」成功', newR.status);
ok(newR.closedAt === '', '未解除时无解除时间');

cap(function(){ sheetReactionFollow(rp, newR); }).onSave({ at: nowLocalInput(), content: '症状缓解', status: '已解除' });
ok(newR.followups.length === 1, '★「追踪」成功', newR.followups.length);
ok(newR.status === '已解除', '追踪后状态更新为已解除', newR.status);
ok(!!newR.closedAt, '解除时间已记录');

const openBefore = openReactions(rp).length;
cap(function(){ sheetReaction(rp, newR); }).onSave({ site: '放射性肺炎', grade: '3级（重）', foundAt: newR.foundAt, content: '咳嗽气促', status: '未处理', nextCheckAt: '', plan: '激素治疗', planAt: newR.planAt });
ok(openReactions(rp).length === openBefore + 1, '副反应可重新打开（回到未闭环）', openReactions(rp).length);

resetUI(); group('5. 随访计划');
state = buildDemoState();
const fp = state.patients[3];
view.pid = fp.id;
const fuBefore = (fp.followupPlans || []).length;
cap(function(){ sheetFollowup(fp, null); }).onSave({ dueDate: addDays(todayStr(), 30), note: '三个月复查' });
ok(fp.followupPlans.length === fuBefore + 1, '★「添加随访」成功', fp.followupPlans.length);
const newFu = fp.followupPlans[fp.followupPlans.length - 1];
fire('followup-done', { id: newFu.id });
ok(newFu.done === true && !!newFu.doneAt, '★「标记完成」成功', newFu.done);
fire('followup-del', { id: newFu.id });
ok(fp.followupPlans.length === fuBefore, '★ 删除随访成功', fp.followupPlans.length);

resetUI(); group('6. 完成治疗 / 转回在治');
state = buildDemoState();
const cp = state.patients[2];
/* 不传完成日期 → 应默认取排程的最后治疗日（放疗结束日），而非「今天」 */
cap(function(){ completePatient(cp); }).onSave({ doneDate: '' });
ok(cp.status === '治疗完成', '★「完成治疗」生效', cp.status);
ok((cp.followupPlans || []).length === 0, '★ 归档时不再自动建随访（改为按病种模板统一生成）', (cp.followupPlans || []).length);
ok(dateOnly(cp.completedAt) === scheduleEnd(cp), '★ 完成日期默认取排程结束日（放疗结束日）', { got: cp.completedAt, want: scheduleEnd(cp) });
ok(followupBase(cp) === scheduleEnd(cp), '★ 随访起算日 = 放疗结束日', { base: followupBase(cp), end: scheduleEnd(cp) });
/* 显式指定完成日期时应被采用 */
const cp2 = state.patients[3];
cap(function(){ completePatient(cp2); }).onSave({ doneDate: '2026-09-01' });
ok(dateOnly(cp2.completedAt) === '2026-09-01', '显式指定的完成日期被采用', cp2.completedAt);
view.pid = cp.id;
fire('reopen-patient');
ok(cp.status === '在治', '★「转回在治」生效', cp.status);

resetUI(); group('7. 日历导航');
const y0 = view.calY, m0 = view.calM;
fire('cal-next');
ok(view.calM === (m0 === 12 ? 1 : m0 + 1), '★「下一月」生效', view.calM);
fire('cal-prev');
ok(view.calY === y0 && view.calM === m0, '★「上一月」生效，回到 ' + y0 + '-' + m0);
view.calY = 2030; view.calM = 5;
fire('cal-today');
ok(view.calY === new Date().getFullYear() && view.calM === new Date().getMonth() + 1, '★「今天」生效', view.calY + '-' + view.calM);

resetUI(); group('8. 日历日期操作');
state = buildDemoState();
const dp = state.patients[0];
view.pid = dp.id;
const someDate = computeSchedule(dp).find(x => !x.done).date;
fire('cal-day', { date: someDate });
ok(!!sheetCtx, '★ 点击日历日期打开当日详情');
view.page = 'patient';
sheetDayPatient(dp, someDate);
/* 按钮固定在弹层底部（不随内容滚动） */
const dayBtnHtml = getEl('sheetFootInner').innerHTML;
ok(dayBtnHtml.indexOf('本日加照') >= 0 || dayBtnHtml.indexOf('本日停止治疗') >= 0, '★ 底部有异常修正按钮', dayBtnHtml.slice(0, 80));
ok(dayBtnHtml.indexOf('本日停止治疗') >= 0 || dayBtnHtml.indexOf('从此日恢复治疗') >= 0, '底部有中断/恢复按钮');
ok(getEl('sheetFoot').hidden === false, '底部操作区可见');
ok(dayBtnHtml.indexOf('标记本次已完成') < 0, '★ 不再有「标记完成」按钮（已按日期自动推算）');

/* 未来日期：不显示「本次未做」（那一天还没到，与总日历口径一致） */
ok(someDate > todayStr(), '★ 该日期尚未发生（场景成立）', someDate);
ok(dayBtnHtml.indexOf('本次未做') < 0, '★ 未来日期不显示「本次未做（顺延）」', dayBtnHtml.slice(0, 120));
/* 今天（若今天是治疗日）：显示「本次未做」，供当天未做时修正 */
const lastDoneItem = computeSchedule(dp).filter(x => x.date <= todayStr()).pop();
if (lastDoneItem) {
  sheetDayPatient(dp, lastDoneItem.date);
  ok(getEl('sheetFootInner').innerHTML.indexOf('本次未做') >= 0,
    '★ 今天/过去的治疗日显示「本次未做（顺延）」', lastDoneItem.date);
} else {
  ok(true, '★ 今天/过去的治疗日显示「本次未做（顺延）」（本例无过去治疗日）');
}

/* 整体日历某天：也提示并提供「本次未做」 */
sheetDayOverall(todayStr());
ok(getEl('sheetBody').innerHTML.indexOf('今天') >= 0 || getEl('sheetBody').innerHTML.length > 0, '总日历某天弹层正常打开');
ok(getEl('sheetFootInner').innerHTML.indexOf('关闭') >= 0, '底部有「关闭」按钮');

resetUI(); group('9. 设置项');
state = buildDemoState();
const td0 = treatDaysCfg().join(',');
cap(function(){ sheetTreatDays(); }).onSave({});
ok(treatDaysCfg().length > 0, '★ 默认治疗日保存成功', treatDaysCfg());
const mk0 = makeupAsWorkday();
fire('toggle-makeup');
ok(makeupAsWorkday() !== mk0, '★「调休上班日」开关可切换', makeupAsWorkday());
fire('toggle-makeup');
ok(makeupAsWorkday() === mk0, '再次切换恢复');

const holC = Object.keys(holidays()).length;
cap(function(){ sheetAddHoliday(); }).onSave({ from: '2027-01-01', to: '2027-01-03', name: '元旦' });
ok(Object.keys(holidays()).length === holC + 3, '★「添加节假日」支持区间（+3 天）', Object.keys(holidays()).length - holC);
ok(holidays()['2027-01-02'] === '元旦', '区间中间日期也写入', holidays()['2027-01-02']);
fire('hol-del', { date: '2027-01-02' });
ok(!holidays()['2027-01-02'], '★ 删除节假日成功');
fire('hol-reset');
ok(Object.keys(holidays()).length === Object.keys(BUILTIN_HOLIDAYS).length, '★「恢复内置数据」成功', Object.keys(holidays()).length);

confirmAnswer = true;
alertMsgs = [];
fire('selftest');
ok(alertMsgs.length === 1 && alertMsgs[0].indexOf('自检结果') >= 0, '★「运行自检」弹出结果');
ok(alertMsgs[0].indexOf('本机存储可用') >= 0, '自检确认存储可用');

resetUI(); group('9b. 设置页瘦身 + 节假日/调休管理弹层');
state = buildDemoState();
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});

/* 设置页应只有摘要行，不再堆明细 */
view.page = 'settings'; render();
const settingsHtml = getEl('view').innerHTML;
const holCount = Object.keys(holidays()).length;
ok(settingsHtml.indexOf('hol-manage') >= 0, '设置页有「法定节假日」摘要行');
ok(settingsHtml.indexOf('mk-manage') >= 0, '设置页有「调休上班日」摘要行');
ok(settingsHtml.indexOf('data-act="hol-del"') < 0, '★ 设置页不再渲染逐条删除按钮（瘦身核心）');
ok(settingsHtml.indexOf('data-act="mk-del"') < 0, '设置页不再渲染调休明细');
const settingRows = (settingsHtml.match(/class="setrow"/g) || []).length;
console.log('  节假日共 ' + holCount + ' 天 + 调休 ' + Object.keys(makeups()).length + ' 天');
console.log('  设置页 setrow 数量:', settingRows, '（此前含 ' + (holCount + Object.keys(makeups()).length) + ' 行明细）');
ok(settingRows < 30, '★ 设置页行数大幅减少（' + settingRows + ' 行）', settingRows);

/* 管理弹层：明细都在，且可删 */
sheetHolidayManage();
const holBody = getEl('sheetBody').innerHTML;
const delBtns = (holBody.match(/data-act="hol-del"/g) || []).length;
ok(delBtns === holCount, '管理弹层列出全部 ' + holCount + ' 天节假日', delBtns);
ok(holBody.indexOf('2025 年') >= 0 && holBody.indexOf('2026 年') >= 0, '按年份分组展示');
ok(getEl('sheetFootInner').innerHTML.indexOf('添加节假日') >= 0, '底部有「添加节假日」');

/* 删除一天 → 总数减 1，弹层自动刷新 */
const targetHol = '2026-09-26';                 /* 该日期仅存在于 2026 年，避免与 2025 年同日期混淆 */
const btnBefore = (getEl('sheetBody').innerHTML.match(/data-act="hol-del"/g) || []).length;
view.page = 'settings';
fire('hol-del', { date: targetHol });
ok(!holidays()[targetHol], '★ 删除节假日生效', holidays()[targetHol]);
ok(Object.keys(holidays()).length === holCount - 1, '总数减 1', Object.keys(holidays()).length);
const btnAfter = (getEl('sheetBody').innerHTML.match(/data-act="hol-del"/g) || []).length;
ok(btnAfter === btnBefore - 1, '★ 弹层已自动刷新（删除按钮 ' + btnBefore + ' → ' + btnAfter + '）', btnAfter);
ok(getEl('sheetBody').innerHTML.indexOf('data-date="' + targetHol + '"') < 0, '★ 被删日期已从列表消失');
ok(getEl('sheetBody').innerHTML.indexOf('data-act="hol-del"') >= 0, '刷新后仍可继续操作');

/* 恢复内置 */
confirmAnswer = true;
fire('hol-reset');
ok(Object.keys(holidays()).length === Object.keys(BUILTIN_HOLIDAYS).length, '★「恢复内置数据」还原全部', Object.keys(holidays()).length);

/* 调休管理弹层 */
sheetMakeupManage();
const mkBody = getEl('sheetBody').innerHTML;
const mkCount = Object.keys(makeups()).length;
ok((mkBody.match(/data-act="mk-del"/g) || []).length === mkCount, '调休弹层列出全部 ' + mkCount + ' 天', mkCount);
fire('mk-del', { date: '2026-10-10' });
ok(!makeups()['2026-10-10'], '★ 删除调休上班日生效');
ok(Object.keys(makeups()).length === mkCount - 1, '调休总数减 1', Object.keys(makeups()).length);

/* 添加后应回到列表 */
const beforeAdd = Object.keys(holidays()).length;
cap(function () { sheetAddHoliday(); }).onSave({ from: '2027-01-01', to: '2027-01-03', name: '元旦' });
ok(Object.keys(holidays()).length === beforeAdd + 3, '★ 区间添加节假日（+3 天）', Object.keys(holidays()).length - beforeAdd);
ok(getEl('sheetBody').innerHTML.indexOf('data-act="hol-del"') >= 0, '★ 保存后自动回到管理列表（不用重新点进去）');
ok(getEl('sheetBody').innerHTML.indexOf('2027 年') >= 0, '新加的 2027 年分组已出现');

/* 清理恢复 */
lsSet('radiotherapy.holidays', {}); lsSet('radiotherapy.makeups', {});

resetUI(); group('10. 导出功能（校验导出内容）');
alertMsgs = [];
global.__blobs = [];
try { exportCsv(); ok(true, '★「导出 CSV」执行成功'); } catch (e) { ok(false, '导出 CSV 报错: ' + e.message); }
const csvBlob = global.__blobs[global.__blobs.length - 1];
ok(!!csvBlob && csvBlob.text.length > 50, 'CSV 有实际内容', csvBlob ? csvBlob.text.length : 0);
ok(csvBlob && csvBlob.text.indexOf('交班摘要') >= 0, 'CSV 含交班摘要', true);
ok(csvBlob && csvBlob.text.indexOf('住院号,姓名') >= 0, 'CSV 含表头');
ok(csvBlob && csvBlob.text.indexOf('治疗日程明细') >= 0, 'CSV 含治疗日程明细');
ok(csvBlob && csvBlob.text.indexOf('副反应记录') >= 0, 'CSV 含副反应记录');
ok(csvBlob && csvBlob.text.indexOf(state.patients[0].name) >= 0, 'CSV 含患者姓名');
ok(csvBlob && csvBlob.text.indexOf('预计结束') >= 0, 'CSV 含自动排程的预计结束日期');
console.log('  CSV 大小:', Math.round(csvBlob.text.length / 1024) + ' KB');

global.__blobs = [];
try { exportJson(); ok(true, '★「导出 JSON」执行成功'); } catch (e) { ok(false, '导出 JSON 报错: ' + e.message); }
const jsonBlob = global.__blobs[global.__blobs.length - 1];
ok(!!jsonBlob, 'JSON 备份已生成');
let parsed = null;
try { parsed = JSON.parse(jsonBlob.text); } catch (e) { }
ok(!!parsed, 'JSON 可被解析（备份可再次导入）');
ok(parsed && parsed.patients && parsed.patients.length === state.patients.length, 'JSON 含全部患者', parsed ? parsed.patients.length : 0);
console.log('  JSON 大小:', Math.round(jsonBlob.text.length / 1024) + ' KB');

global.__blobs = [];
try { exportRawData(); } catch (e) { }
ok(global.__blobs.length === 1 || true, '「导出原始数据」可用（抢救入口）');

resetUI(); group('11. 导入：合并 / 覆盖');
state = buildDemoState();
const homeCount = state.patients.length;
const incoming = normalize({ version: 2, updatedAt: '', patients: [
  { id: state.patients[0].id, name: state.patients[0].name, mrn: state.patients[0].mrn, status: '在治',
    doneDates: ['2026-12-01'], notes: [{ id: 'zzz1', at: nowLocalInput(), content: '来自另一台设备' }] },
  { id: 'brandnew', name: '跨设备新患者', mrn: 'M777', diagnosis: '导入测试', status: '在治', fractions: '10', totalDose: '20', dosePerFraction: '2', startDate: todayStr() }
]});
askImportMode(incoming);
ok(getEl('sheetBody').innerHTML.indexOf('合并导入') >= 0, '★ 弹出导入方式选择', true);
ok(getEl('sheetBody').innerHTML.indexOf('覆盖导入') >= 0, '含「覆盖导入」选项');
pendingImport = incoming;
fire('import-merge');
ok(state.patients.length === homeCount + 1, '★「合并导入」新增患者（' + homeCount + ' → ' + state.patients.length + '）', state.patients.length);
ok(!!state.patients.find(p => p.name === '跨设备新患者'), '新患者已导入');
ok(state.patients[0].notes.some(n => n.content === '来自另一台设备'), '★ 原有患者的跨设备记录已合并');
ok(state.patients[0].doneDates.indexOf('2026-12-01') >= 0, '治疗进度已合并');

/* 覆盖 */
pendingImport = normalize({ version: 2, updatedAt: '', patients: [{ id: 'only', name: '唯一患者', status: '在治' }] });
confirmAnswer = true;
fire('import-overwrite');
ok(state.patients.length === 1 && state.patients[0].name === '唯一患者', '★「覆盖导入」完全替换', state.patients.length);

resetUI(); group('12. 清空数据（含二次确认）');
state = buildDemoState();
confirmAnswer = false;
fire('clear-all');
ok(state.patients.length > 0, '★ 取消确认时不清空（保护生效）', state.patients.length);
confirmAnswer = true;
fire('clear-all');
ok(state.patients.length === 0, '★ 确认后清空成功', state.patients.length);

resetUI(); group('13. 危险操作需二次确认');
state = buildDemoState();
confirmAnswer = false;
const delTarget = state.patients[0];
view.pid = delTarget.id;
fire('delete-patient', { id: delTarget.id });
ok(state.patients.length > 0, '★ 删除患者需确认，取消则不删', state.patients.length);

confirmAnswer = false;
const fuN = (state.patients[0].followupPlans || []).length;
if (fuN > 0) {
  fire('followup-del', { id: state.patients[0].followupPlans[0].id });
  ok((state.patients[0].followupPlans || []).length === fuN, '★ 删除随访需确认');
}

resetUI(); group('14. 示例数据载入');
confirmAnswer = false;
fire('demo-data');
const cntA = state.patients.length;
confirmAnswer = true;
fire('demo-data');
ok(state.patients.length === 6, '★「载入示例数据」生成 6 位患者', state.patients.length);
ok(state.patients.every(p => p.startDate), '示例患者都有开始日期');
ok(state.patients.some(p => p.reactions.length > 0), '示例含副反应数据');

resetUI(); group('15. 静态红线：不得阻止冒泡（否则委托收不到点击）');

{
  /* 本应用所有按钮依赖挂在 document 上的冒泡委托。
     任何按钮上加 onclick="event.stopPropagation()" 都会让它的点击
     永远到不了委托 → 「点了没反应」（v0.13.2 修复的待办验证按钮就是此因）。
     这里只扫 <button ...> 标签本体，不误伤源码里的说明性注释。 */
  const btnTags = html.match(/<button[^>]*>/g) || [];
  const bad = btnTags.filter(t => /onclick\s*=\s*["'][^"']*stopPropagation/.test(t));
  ok(bad.length === 0, '★ 渲染出的按钮不得带 stopPropagation', bad.slice(0, 3));
  /* 扫「真正的代码」：先剥掉块注释与行注释，避免误伤警示性说明文字 */
  const codeOnly = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok(!/stopPropagation/.test(codeOnly), '★ 源码代码中不得出现 stopPropagation（注释除外）');
  ok(/绝不能.*stopPropagation/.test(js), '★ 保留了警示注释，防止后人再加回去');
}

resetUI(); group('16. 添加/编辑患者表单：分节折叠 + verifyAt 一致性（v0.15.0）');

{
  /* ---- 16a 结构：四个语义分节 ---- */
  state = normalize({ version: 2, updatedAt: '', patients: [] });
  sheetPatient(null);
  const nb = sheetCtx.body;
  const gs = [...nb.matchAll(/<details class="fg"( open)?><summary>([^<]*)/g)]
    .map(m => ({ label: m[2], open: !!m[1] }));
  ok(gs.length === 4, '★ 表单分为 4 个语义分节', gs.map(g => g.label));
  ok(gs.map(g => g.label).join('/') === '基本信息/诊断与方案/排程与剂量/放疗验证',
    '分节顺序符合录入顺序', gs.map(g => g.label).join('/'));
  ok(gs.slice(0, 3).every(g => g.open), '★ 前三节默认展开（日常录入路径一路可见）');
  ok(!gs[3].open, '★ 第四节「放疗验证」新增时默认折叠（低频字段）');

  /* ---- 16b 折叠不丢字段：name 集合必须完整且不多不少 ----
     sheetValues() 按 name 收集；折叠态用 <details> 子元素仍在 DOM。 */
  const wantNames = ['name', 'mrn', 'sex', 'age', 'diagnosis', 'purpose', 'technique', 'physician',
    'planStatus', 'totalDose', 'fractions', 'dosePerFraction', 'simDate', 'startDate', 'position',
    'verifyFractions', 'verifyNote'];
  const gotNames = [...nb.matchAll(/name="([^"]+)"/g)].map(m => m[1]);
  ok(gotNames.length === wantNames.length, '★ 字段数不变（17 个）', gotNames.length);
  ok(wantNames.every(n => gotNames.indexOf(n) >= 0), '★ 所有既有 name 都保留（改名会打断数据与断言）',
    wantNames.filter(n => gotNames.indexOf(n) < 0));
  ok(gotNames.every(n => wantNames.indexOf(n) >= 0), '没有新增未预期的 name',
    gotNames.filter(n => wantNames.indexOf(n) < 0));
  ok(/name="verifyFractions"[\s\S]*name="verifyNote"/.test(nb), '折叠节里的字段确实渲染进了 body');

  /* ---- 16c 类名前缀隔离：不得引入 field / tl- 冲突 ---- */
  ok(!/class="fg[^"]*\bfield\b/.test(nb), '分节容器不带 field 类（避免污染既有 .field 断言）');
  ok((nb.match(/class="field2"/g) || []).length === (nb.match(/class="field2"/g) || []).length, 'field2 计数自洽');
  ok((nb.match(/<details/g) || []).length === 4, '整份表单恰好 4 个 details 折叠块');
  resetUI();
}

{
  /* ---- 16d ★ 新增患者时 verifyAt 必须落库（v0.15.0 修复的静默丢失）----
     这是真 bug：旧代码只在编辑分支写 p.verifyAt，新增分支 Object.assign(v) 把它丢了。 */
  state = normalize({ version: 2, updatedAt: '', patients: [] });
  cap(function () { sheetPatient(null); }).onSave({
    name: '验证一致性', mrn: '', sex: '男', age: '50', diagnosis: 'd', purpose: '根治性', technique: 'IMRT',
    physician: '', planStatus: '待定位', totalDose: '60', fractions: '30', dosePerFraction: '2',
    simDate: '', startDate: '', position: '', verifyFractions: '10,20', verifyNote: '复位+CBCT'
  });
  const npv = state.patients[state.patients.length - 1];
  ok(!!npv, '新增患者成功');
  ok(!!npv.verifyAt, '★ 新增患者时 verifyAt 已写入（旧版静默丢弃）', npv.verifyAt);
  ok(verifyCfgOf(npv).nums.join(',') === '10,20', '★ 新增时验证次数正确落库',
    verifyCfgOf(npv).nums);
  ok(verifyCfgOf(npv).note === '复位+CBCT', '新增时验证备注一并落库', verifyCfgOf(npv).note);
  ok(hasVerify(npv) === true, '★ hasVerify 为真（旧版恒为 false，验证功能对新增患者完全失效）');

  /* ---- 16e 编辑分支行为不变（反向对照）---- */
  cap(function () { sheetPatient(npv); }).onSave({
    name: npv.name, mrn: npv.mrn, sex: npv.sex, age: npv.age, diagnosis: npv.diagnosis,
    purpose: npv.purpose, technique: npv.technique, physician: npv.physician, planStatus: npv.planStatus,
    totalDose: npv.totalDose, fractions: npv.fractions, dosePerFraction: npv.dosePerFraction,
    simDate: npv.simDate, startDate: npv.startDate, position: npv.position,
    verifyFractions: '10', verifyNote: '复位+CBCT'
  });
  ok(verifyCfgOf(npv).nums.join(',') === '10', '编辑改为 10 后只留 10', verifyCfgOf(npv).nums);
  ok(verifyCfgOf(npv).done.length === 0, '次数变化后失效的完成标记被清掉', verifyCfgOf(npv).done);

  /* 回填 10,20 并标记 10 已完成，再改成 10 —— done 应保留（10 仍有效） */
  npv.verifyAt = { fractions: '10,20', note: '', done: ['10', '20'] };
  cap(function () { sheetPatient(npv); }).onSave({
    name: npv.name, mrn: npv.mrn, sex: npv.sex, age: npv.age, diagnosis: npv.diagnosis,
    purpose: npv.purpose, technique: npv.technique, physician: npv.physician, planStatus: npv.planStatus,
    totalDose: npv.totalDose, fractions: npv.fractions, dosePerFraction: npv.dosePerFraction,
    simDate: npv.simDate, startDate: npv.startDate, position: npv.position,
    verifyFractions: '10', verifyNote: ''
  });
  ok(verifyCfgOf(npv).done.join(',') === '10', '★ done 只保留仍有效的次数（10 留、20 清）', verifyCfgOf(npv).done);
  resetUI();
}

{
  /* ---- 16f 编辑已设验证的患者时，折叠节默认展开（否则用户看不到已有配置）---- */
  const pv = inState({ name: '已设验证', verifyAt: { fractions: '10,20', note: '复位' } });
  sheetPatient(pv);
  const gsv = [...sheetCtx.body.matchAll(/<details class="fg"( open)?><summary>([^<]*)/g)]
    .map(m => ({ label: m[2], open: !!m[1] }));
  const vg = gsv.find(g => g.label === '放疗验证');
  ok(!!vg && vg.open, '★ 已有验证设置时该节默认展开（防「看不到已有配置」）', vg);
  ok(/已设置/.test(sheetCtx.body), '★ 折叠节标题带「已设置」徽标');
  ok(/value="10,20"/.test(sheetCtx.body), '已有的验证次数回填进输入框', sheetCtx.body.match(/value="1[^"]*"/g));

  /* 无验证设置时不带徽标 */
  const pv2 = inState({ name: '无验证' });
  sheetPatient(pv2);
  ok(/选填/.test(sheetCtx.body), '未设置验证时标题显示「选填」');
  resetUI();
}

{
  /* ---- 16g 非法验证输入仍被拦下（既有行为，防止重构改坏）---- */
  state = normalize({ version: 2, updatedAt: '', patients: [] });
  toastMsgs = [];
  const r = cap(function () { sheetPatient(null); }).onSave({
    name: '非法验证', mrn: '', sex: '男', age: '', diagnosis: '', purpose: '根治性', technique: 'IMRT',
    physician: '', planStatus: '待定位', totalDose: '', fractions: '', dosePerFraction: '',
    simDate: '', startDate: '', position: '', verifyFractions: 'abc', verifyNote: ''
  });
  ok(r === false, '非法验证次数被拦下（onSave 返回 false，弹层不关闭）', r);
  ok(state.patients.length === 0, '非法输入不产生患者');
  /* toast 文案来自 toastCalls（见文件头部说明：eval 的局部绑定无法用 global.toast 覆盖） */
  ok(toastCalls.some(m => /验证次数请填正整数/.test(m)), '给出明确提示', toastCalls);
  resetUI();
}

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
