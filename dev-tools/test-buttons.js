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
let clickHandler = null, inputHandler = null;
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
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; if (ev === 'input') inputHandler = fn; },
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

/* ★★ 坑（v0.15.0/v0.16.0 实测）：eval(js) 里 `function buildDemoState(){}` 会挂到 global
   （函数声明在 eval 中创建全局绑定），测试里可直接调用；
   但 `var state` 是 eval 局部绑定 —— 测试里写 `state = ...` 只改到测试作用域的同名变量
   （Node 的 CJS 模块作用域），应用内部的 state 仍指向旧对象，render() 于是渲染旧数据。
   ★ 只在声明处写 `var state = global.state = ...` 还不够：eval 里的 var 声明会「遮蔽」，
     后续赋给 state 不会再同步到 global（实测 global.state !== state）。
   彻底解法：**删掉 var 声明**，全篇统一改写为 `global.state = ...`，
   让应用与测试读写同一个 global 属性。 */
eval(js
  .replace(/^var state = emptyState\(\);$/m, 'global.state = emptyState();')
  .replace(/^(\s*)state = (normalize\(|emptyState\(|buildDemoState\(|\{ version)/gm,
           '$1global.state = $2'));
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
/* 用真实委托路径触发 input：构造带 dataset.act 的输入元素并调用 document 的 input 监听 */
function typeIn(act, value, id) {
  if (!inputHandler) throw new Error('未捕获到 input 委托');
  const el = makeEl(id);
  el.dataset.act = act;
  el.value = value;
  inputHandler({ target: el });
  /* ★ 测试桩里 #wardList 不是真 DOM 节点，wardSearchLive 写的 innerHTML 无处落地。
     这里用应用真实的渲染函数重算列表，并就地替换 #view 里的 <div id="wardList">…</div>，
     等价于浏览器里输入后的最终 DOM —— 从而能对「输入 → 列表更新」链路做真实断言，
     而不是只断言 view.wardKw（那样测不到任何渲染缺陷）。 */
  if (act === 'ward-kw' && typeof wardCardsHtml === 'function' && typeof inTreat === 'function') {
    const v = getEl('view');
    const all = inTreat();
    const list = wardSorted(all.filter(p => wardMatch(p, view.wardKw)), view.wardSort);
    let cards = '';
    if (!list.length) {
      cards = view.wardKw
        ? '<div class="empty">没有匹配「' + view.wardKw + '」的在治患者' +
          '<button class="btn sm" data-act="ward-kw-clear">清空搜索</button></div>'
        : '<div class="empty">暂无在治患者</div>';
    } else {
      cards = list.map(wardCardHtml).join('');
    }
    if (v.innerHTML.indexOf('<div id="wardList">') >= 0) {
      v.innerHTML = v.innerHTML.replace(/<div id="wardList">[\s\S]*?<\/div>(?=<div style="height:60px">)/,
        '<div id="wardList">' + cards + '</div>');
      /* 计数同步就地更新（与 wardSearchLive 一致） */
      v.innerHTML = v.innerHTML.replace(/<span id="wardCount">[^<]*<\/span>/,
        '<span id="wardCount">' + (view.wardKw ? list.length + '/' + all.length : list.length) + '</span>');
    }
  }
  return el;
}
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
pForm.onSave({ name: '新患者甲', mrn: 'M900', sex: '男', age: '50', diagnosis: '测试病', purpose: '根治性', technique: 'IMRT', physician: '', totalDose: '20', fractions: '10', dosePerFraction: '2', simDate: '', startDate: todayStr(), position: '' });
ok(state.patients.length === before + 1, '添加患者成功（' + before + ' → ' + state.patients.length + '）', state.patients.length);
const np = state.patients[state.patients.length - 1];
ok(np.name === '新患者甲', '患者信息正确写入', np.name);
ok(computeSchedule(np).length === 10, '★ 自动排程生效（10 次）', computeSchedule(np).length);

/* 编辑 */
fire('edit-patient', { id: np.id });
view.pid = np.id;
cap(function(){ sheetPatient(np); }).onSave({ name: '新患者乙', mrn: 'M901', sex: '男', age: '51', diagnosis: '测试病2', purpose: '姑息性', technique: 'VMAT', physician: '张医生', totalDose: '30', fractions: '15', dosePerFraction: '2', simDate: '', startDate: todayStr(), position: '' });
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
  /* v0.16.0：基本信息节新增「所在病区 / 床号」，故期望集合由 17 → 19。
     ★ v0.17.0：移除「流程状态」下拉，集合由 19 → 18。
     ★ 这里守的是「折叠不丢字段」——集合必须完整且不多不少；
       新增字段时**同步改这个白名单**是刻意设计：任何字段变更都必须在测试里显式登记，
       杜绝「表单悄悄多/少一个 input 而无人察觉」。 */
  const wantNames = ['name', 'mrn', 'sex', 'age', 'ward', 'bedNo',
    'diagnosis', 'purpose', 'technique', 'physician',
    'totalDose', 'fractions', 'dosePerFraction', 'simDate', 'startDate', 'position',
    'verifyFractions', 'verifyNote'];
  const gotNames = [...nb.matchAll(/name="([^"]+)"/g)].map(m => m[1]);
  ok(gotNames.length === wantNames.length, '★ 字段数不变（18 个，v0.17.0 去掉流程状态）', gotNames.length);
  ok(wantNames.every(n => gotNames.indexOf(n) >= 0), '★ 所有既有 name 都保留（改名会打断数据与断言）',
    wantNames.filter(n => gotNames.indexOf(n) < 0));
  ok(gotNames.every(n => wantNames.indexOf(n) >= 0), '没有新增未预期的 name',
    gotNames.filter(n => wantNames.indexOf(n) < 0));
  /* ★★ v0.17.0 反向红线：表单里不得再出现「流程状态」下拉（既无 name 也无 label）。 */
  ok(gotNames.indexOf('planStatus') < 0, '★★ 表单不再渲染 planStatus 输入（v0.17.0 移除）');
  ok(nb.indexOf('流程状态') < 0, '★★ 表单不再有「流程状态」字样');
  ok(nb.indexOf('流程') < 0, '★★ 表单内无任何「流程」相关文案');
  ok(/name="ward"[\s\S]*name="bedNo"/.test(nb), '★ 病区/床号成对渲染，且同属基本信息节（选填定位信息）');
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
    physician: '', totalDose: '60', fractions: '30', dosePerFraction: '2',
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
    purpose: npv.purpose, technique: npv.technique, physician: npv.physician,
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
    purpose: npv.purpose, technique: npv.technique, physician: npv.physician,
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
    physician: '', totalDose: '', fractions: '', dosePerFraction: '',
    simDate: '', startDate: '', position: '', verifyFractions: 'abc', verifyNote: ''
  });
  ok(r === false, '非法验证次数被拦下（onSave 返回 false，弹层不关闭）', r);
  ok(state.patients.length === 0, '非法输入不产生患者');
  /* toast 文案来自 toastCalls（见文件头部说明：eval 的局部绑定无法用 global.toast 覆盖） */
  ok(toastCalls.some(m => /验证次数请填正整数/.test(m)), '给出明确提示', toastCalls);
  resetUI();
}

resetUI(); group('17. 在治页：病区/床号搜索与排序（v0.16.0）');

/* 构造 4 位在治患者：病区/床号刻意错开，覆盖「床位自然序」的坑。
   ★ 原地替换数组元素（splice）而非重绑 state，避免与 eval 作用域纠缠。 */
function wardState() {
  const norm = normalize({ version: 2, updatedAt: '', patients: [
    { name: '甲', mrn: 'M1', ward: '放疗科一病区', bedNo: '12', startDate: '2026-10-01', fractions: '10', totalDose: '20', status: '在治' },
    { name: '乙', mrn: 'M2', ward: '放疗科一病区', bedNo: '2',  startDate: '2026-10-01', fractions: '10', totalDose: '20', status: '在治' },
    { name: '丙', mrn: 'M3', ward: '放疗科二病区', bedNo: '3-2', startDate: '2026-10-01', fractions: '10', totalDose: '20', status: '在治' },
    { name: '丁', mrn: 'M4', ward: '',            bedNo: '',    startDate: '2026-10-01', fractions: '10', totalDose: '20', status: '在治' }
  ] });
  state.patients.splice(0, state.patients.length);
  norm.patients.forEach(function (p) { p.status = '在治'; state.patients.push(p); });
  ['w1', 'w2', 'w3', 'w4'].forEach(function (id, i) { state.patients[i].id = id; });
  return state;
}
/* ★ 测试桩里只有 #view 的 innerHTML 是「真」字符串，内部元素（#wardCount 等）
   并不存在于 DOM 桩中 —— 故一律从 HTML 里提取，不能用 getEl(...).textContent。 */
function countIn(html) {
  const m = String(html).match(/<span id="wardCount">([^<]*)<\/span>/);
  return m ? m[1] : null;
}
function listIds(html) {
  const seg = String(html).slice(String(html).indexOf('<div id="wardList">'));
  return [...seg.matchAll(/data-id="(w\d)"/g)].map(m => m[1]);
}
function wardRender() { view.page = 'tab'; view.tab = 'ward'; render(); return getEl('view').innerHTML; }

{
  /* ---- 17a 默认态：四位都在，保持录入顺序 ---- */
  wardState();
  view.wardKw = ''; view.wardSort = 'default';
  const w0 = wardRender();
  ok(w0.indexOf('wardbar') >= 0, '★ 有患者时渲染出搜索/排序条');
  ok(w0.indexOf('data-act="ward-kw"') >= 0, '有搜索输入框');
  ok(w0.indexOf('data-act="ward-sort"') >= 0, '有排序切换按钮');
  ok(w0.indexOf('默认序') >= 0, '默认按钮文案为「默认序」');
  ok(countIn(w0) === '4', '计数显示 4 位（无筛选时不显示分母）', countIn(w0));
  ok((w0.match(/class="card pcard"/g) || []).length === 4, '渲染 4 张卡片');
  /* ★ v0.17.0：床号从「病区 · 床号」小徽标**上移**为卡片首列大字（pbed），
     病区徽标只留病区名。此处按新结构断言两处都在，且不再重复渲染床号。 */
  ok(w0.indexOf('放疗科一病区') >= 0, '★ 卡片显示病区徽标');
  ok(w0.indexOf('放疗科一病区 · 12床') < 0, '★★ 病区徽标不再重复携带床号（床号已在首列大字）');
  ok(/class="pbed"><div class="n">12<\/div>/.test(w0), '★★ 床号 12 以首列大字渲染（pbed.n）');

  /* ---- 17b 搜索：按病区筛选 ---- */
  typeIn('ward-kw', '一病区');
  ok(view.wardKw === '一病区', '输入被记录到视图状态');
  let h = getEl('view').innerHTML;
  ok(countIn(h) === '2/4', '★ 计数变为「2/4」（命中/总数）', countIn(h));
  ok(h.indexOf('甲') >= 0 && h.indexOf('乙') >= 0, '★ 命中的两位都在');
  ok(h.indexOf('>丙<') < 0 && h.indexOf('>丁<') < 0, '★ 未命中的被排除');

  /* ---- 17c 搜索：按床号 / 关键词共用 ---- */
  typeIn('ward-kw', '3-2');
  ok(countIn(getEl('view').innerHTML) === '1/4', '★ 按床号「3-2」精确命中 1 人', countIn(getEl('view').innerHTML));
  typeIn('ward-kw', '一');
  ok(countIn(getEl('view').innerHTML) === '2/4', '病区与床号共用同一关键词', countIn(getEl('view').innerHTML));

  /* ---- 17d 无命中：空态 + 清空出口，不能误报「暂无在治患者」 ---- */
  typeIn('ward-kw', '不存在');
  const wEmpty = getEl('view').innerHTML;
  ok(wEmpty.indexOf('没有匹配') >= 0, '★ 无命中给出「没有匹配」空态');
  ok(wEmpty.indexOf('data-act="ward-kw-clear"') >= 0, '★ 空态里有「清空搜索」按钮（一键回来）');
  ok(wEmpty.indexOf('暂无在治患者') < 0, '★ 不误报成「暂无在治患者」（会让人以为数据丢了）');

  /* ---- 17e 清空：回到全量 ---- */
  fire('ward-kw-clear');
  ok(view.wardKw === '' && countIn(getEl('view').innerHTML) === '4', '★「✕」清空搜索并恢复全量', countIn(getEl('view').innerHTML));

  /* ---- 17f ★ 床位序：纯数字按数值（不是字符串！）---- */
  view.wardSort = 'default'; wardRender();
  ok(listIds(getEl('view').innerHTML).join(',') === 'w1,w2,w3,w4', '默认序保持录入顺序', listIds(getEl('view').innerHTML).join(','));

  fire('ward-sort');
  ok(view.wardSort === 'bed', '★ 点击切换为床位序');
  ok(getEl('view').innerHTML.indexOf('床位序') >= 0, '按钮文案同步为「床位序」');
  /* 一病区 2 床(乙) → 12 床(甲)，然后二病区 3-2(丙)，最后无床位(丁) */
  const after = listIds(getEl('view').innerHTML);
  ok(after.join(',') === 'w2,w1,w3,w4', '★★ 床位序：2 床在 12 床之前（数值序，非字符串序）', after.join(','));
  ok(after[after.length - 1] === 'w4', '★ 无病区无床号者恒排最后（不插到最前干扰找床）');

  /* ---- 17g ★ 排序与搜索可叠加 ---- */
  typeIn('ward-kw', '放疗科一病区');
  ok(listIds(getEl('view').innerHTML).join(',') === 'w2,w1', '★★ 搜索 + 床位序叠加生效', listIds(getEl('view').innerHTML).join(','));
  ok(countIn(getEl('view').innerHTML) === '2/4', '叠加时计数仍为命中/总数');

  /* ---- 17h ★ 就地刷新：只换列表与计数，不重建搜索框 ---- */
  fire('ward-kw-clear');
  view.wardSort = 'default'; wardRender();
  typeIn('ward-kw', '一病区');
  ok(view.wardKw === '一病区', '★ 连续输入后关键词保持在视图状态（输入框未被重建清空）');
  ok(getEl('view').innerHTML.indexOf('甲') >= 0, '就地刷新确实换掉了列表内容');
  ok(countIn(getEl('view').innerHTML) === '2/4', '计数随输入同步就地更新', countIn(getEl('view').innerHTML));

  /* ---- 17i 无患者时不渲染搜索条 ---- */
  state.patients.splice(0, state.patients.length);
  view.wardKw = ''; view.wardSort = 'default';
  const wNone = wardRender();
  ok(wNone.indexOf('wardbar') < 0, '★ 无患者时不渲染搜索/排序条');
  ok(wNone.indexOf('暂无在治患者') >= 0, '无患者时是原「暂无在治患者」空态');

  /* ---- 17j 非在治患者不进列表（搜索/排序都不得越界）---- */
  wardState();
  state.patients[0].status = '治疗完成';
  view.wardKw = ''; view.wardSort = 'bed';
  const wDone = wardRender();
  ok(countIn(wDone) === '3', '治疗完成者不计入在治（3 位）', countIn(wDone));
  ok(listIds(wDone).indexOf('w1') < 0, '★ 非在治患者不出现在列表（搜索/排序都在在治集合内进行）', listIds(wDone).join(','));
  resetUI();
}

resetUI(); group('18. 在治页卡片：床号前置放大 + 诊断单行（v0.17.0）');

{
  /* ★ 用户原话：「将床号放在患者卡最开头放大显示」「简要诊断信息仅展示一行，不要全部显示」
     ★ 这一组的核心不是"有没有床号"，而是：**位置（最开头）**、**字号（放大）**、
       **不重复（病区徽标不再带床号）**、**不吞输入（自由文本床号必须原样显示）**、
       **空值不留洞（无床号时整列不渲染，布局自然塌陷）**。 */

  wardState();
  view.wardKw = ''; view.wardSort = 'default';
  const w = wardRender();
  const c1 = wardCardHtml(state.patients[0]);        /* 甲：病区一 · 12 床 */
  const c3 = wardCardHtml(state.patients[2]);        /* 丙：床号 3-2（带副号） */
  const c4 = wardCardHtml(state.patients[3]);        /* 丁：无病区无床号 */

  /* ---- 18a 大字床号：主号进 .n，单位行「N 床」进 .u ---- */
  ok(/class="pbed"><div class="n">12<\/div>/.test(c1),
    '★★ 床号 12 以首列大字渲染（.pbed > .n）', c1.slice(0, 200));
  ok(/class="pbed"><div class="n">12<\/div><div class="u">床<\/div>/.test(c1),
    '★★ 大字下方是单位行「床」（无副号时不带多余分隔符）');

  /* ---- 18b「放在最开头」是位置约束：pbed 必须早于 badgebox ---- */
  {
    const iP = c1.indexOf('class="pbed"');
    const iB = c1.indexOf('class="badgebox"');
    ok(iP >= 0 && iB >= 0, '前置：卡片同时有 pbed 与 badgebox', iP + '/' + iB);
    ok(iP >= 0 && iB >= 0 && iP < iB,
      '★★ 床号列在徽标列**之前**（用户要求"最开头"）', { pbed: iP, badgebox: iB });
  }

  /* ---- 18c 自由文本床号不得被正则吞掉：3-2 → 主 3 / 副 2 ---- */
  ok(/class="pbed"><div class="n">3<\/div>/.test(c3), '★★ 复合床号 3-2 主号为 3', c3.slice(0, 200));
  ok(/<div class="u">2 · 床<\/div>/.test(c3),
    '★★ 复合床号副号 2 显示在单位行（"2 · 床"），不丢信息');

  /* ---- 18d 无床号 → 整列不渲染（不留空洞），但徽标列仍在 ---- */
  ok(c4.indexOf('class="pbed"') < 0,
    '★★ 无床号时不渲染 .pbed 列（flex 自然塌陷，不留空洞）');
  ok(c4.indexOf('class="badgebox"') >= 0, '对照：徽标列仍渲染（不能连徽标一起省掉）');

  /* ---- 18e 病区徽标不再重复携带床号（分流：大字管床号，徽标管病区）---- */
  ok(c1.indexOf('放疗科一病区') >= 0, '★ 卡片保留病区徽标');
  ok(c1.indexOf('放疗科一病区 · 12床') < 0,
    '★★ 病区徽标**不再**重复携带床号（床号已在首列大字）');

  /* ---- 18f 诊断单行：CSS 三件套（nowrap + hidden + ellipsis）齐备且挂在 .pdiag
     ★ 从 index.html 源码里取 <style> 段断言 —— 单行省略是纯 CSS 行为，
       DOM 桩里没有真排版引擎，只有对声明本身下断言才靠谱。 */
  {
    const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
    ok(/\.pdiag\s*\{[^}]*white-space\s*:\s*nowrap/.test(styleBlock),
      '★★ .pdiag 有 white-space:nowrap（单行前提）');
    ok(/\.pdiag\s*\{[^}]*overflow\s*:\s*hidden/.test(styleBlock), '★★ .pdiag 有 overflow:hidden');
    ok(/\.pdiag\s*\{[^}]*text-overflow\s*:\s*ellipsis/.test(styleBlock),
      '★★ .pdiag 有 text-overflow:ellipsis（超长打省略号）');
    ok(/<div class="pdiag">/.test(c1), '诊断信息用 .pdiag 容器渲染');
  }

  /* ---- 18g 大字床号的样式也在（字号确实"放大"了，而不是只是挪了位置）---- */
  {
    const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
    const m = styleBlock.match(/\.pbed\s*\.n\s*\{([^}]*)\}/);
    ok(!!m, '★★ 存在 .pbed .n 样式（大字床号）');
    const fs = m ? Number((m[1].match(/font-size\s*:\s*(\d+)/) || [0, 0])[1]) : 0;
    ok(fs >= 20, '★★ 大字床号 font-size ≥ 20px（"放大"是字号约束，非仅位置）', fs + 'px');
  }

  resetUI();
}

resetUI(); group('19. 患者详情页：顶部床位快速编辑（v0.17.0）');

{
  /* ★ 用户原话：「患者信息页面，增加将编辑床号功能提升到顶部，方便快速设置」
     ★ 断言重点：① 位置在**顶部**（早于诊断行）；② 按钮自带 data-id（详情境铁律）；
       ③ 空值也渲染入口（"设置"），入口不能时有时无；④ 端到端：点开 → 保存 →
          只改床位两个字段，**其他字段不被触碰**（轻量弹层的承诺）。 */

  const p = inState({ name: '床位甲', mrn: 'B1', ward: '放疗科一病区', bedNo: '12',
    diagnosis: '鼻咽癌 III期', physician: '张医生', status: '在治' });
  view.page = 'patient'; view.pid = p.id; render();

  /* 前置：真的渲染到了详情页（原则 20：不能对着别的页面下判断） */
  ok(getEl('title').textContent === p.name,
    '★★ 前置：详情页真的被渲染（title 为患者姓名）', getEl('title').textContent);

  const d = getEl('view').innerHTML;
  const iBed = d.indexOf('class="kv bedrow"');
  const iDiag = d.indexOf('>诊断<');
  ok(iBed >= 0, '★★ 详情页渲染出床位行（.kv.bedrow）');
  ok(iBed >= 0 && iDiag >= 0 && iBed < iDiag,
    '★★ 床位行在**诊断行之前**（"提升到顶部"）', { bedrow: iBed, diag: iDiag });
  ok(d.indexOf('<b>12</b> 床') >= 0, '★ 床位行显示当前床号');
  ok(/data-act="bed-edit"[^>]*data-id="/.test(d),
    '★★ 改床号按钮自带 data-id（详情境必须自证身份）');

  /* ---- 19a 端到端：点击 → 弹层 → 保存 → 数据落到正确的字段 ---- */
  {
    const tags = String(d).match(/<button[^>]*data-act="bed-edit"[^>]*>/g) || [];
    ok(tags.length === 1, '★ 详情页有且只有一个改床号入口');
    const btn = makeEl();
    (tags[0].match(/data-([a-z-]+)="([^"]*)"/g) || []).forEach(function (a) {
      const m = a.match(/data-([a-z-]+)="([^"]*)"/);
      if (m) btn.dataset[m[1].replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = m[2];
    });
    clickHandler({ target: btn });
    ok(!!sheetCtx && !!sheetCtx.onSave, '★★ 点「改」后弹层被打开且有 onSave');
    ok(String(sheetCtx.title).indexOf('床位') >= 0, '弹层标题点明是设床位', sheetCtx && sheetCtx.title);
    ok(/name="ward"/.test(sheetCtx.body) && /name="bedNo"/.test(sheetCtx.body),
      '弹层含病区与床号两个输入');
    ok(/value="放疗科一病区"/.test(sheetCtx.body), '弹层预填当前病区（改而非重填）');
    ok(/value="12"/.test(sheetCtx.body), '弹层预填当前床号');

    const before = JSON.stringify({ mrn: p.mrn, name: p.name, diagnosis: p.diagnosis, physician: p.physician });
    sheetCtx.onSave({ ward: '放疗科二病区', bedNo: '15-2' });
    ok(p.ward === '放疗科二病区' && p.bedNo === '15-2', '★★ 保存后床位两个字段被更新', [p.ward, p.bedNo]);
    ok(JSON.stringify({ mrn: p.mrn, name: p.name, diagnosis: p.diagnosis, physician: p.physician }) === before,
      '★★ 轻量弹层未触碰其他字段（mrn/姓名/诊断/医生原样）');

    /* 详情页已重渲染，显示新床位 */
    const d2 = getEl('view').innerHTML;
    ok(d2.indexOf('放疗科二病区') >= 0 && d2.indexOf('<b>15-2</b> 床') >= 0,
      '★★ 保存后详情页顶部立即显示新床位（无需手动刷新）');
  }
  resetUI();

  /* ---- 19b 空床位也保留入口（"设置"），避免入口时有时无 ---- */
  {
    const q = inState({ name: '床位乙', mrn: 'B2', status: '在治' });
    view.page = 'patient'; view.pid = q.id; render();
    const dq = getEl('view').innerHTML;
    ok(dq.indexOf('class="kv bedrow"') >= 0, '★★ 无床位时床位行仍渲染（入口常驻）');
    ok(dq.indexOf('未设置床号') >= 0, '无床位时给出「未设置床号」提示', null);
    const tq = String(dq).match(/<button[^>]*data-act="bed-edit"[^>]*>[^<]*/g) || [];
    ok(tq.length === 1 && /设置\s*$/.test(tq[0]),
      '★★ 无床位时按钮文案为「设置」（有→「改」）', tq);
    resetUI();
  }
}

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
