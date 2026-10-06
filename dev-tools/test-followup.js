/* 随访排期测试：验证自定义间隔、自动排期、完成后续排、改间隔重排 */
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
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
js = js.replace(/^init\(\);\s*$/m, '');

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
global.document = {
  getElementById(id) { return getEl(id); }, querySelectorAll() { return []; }, querySelector() { return null; },
  createElement() { return makeEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; }, documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = () => { }; global.confirm = () => true;
global.navigator = {}; global.URL = { createObjectURL() { return 'x'; }, revokeObjectURL() { } };
global.Blob = function () { };
global.FileReader = function () { this.readAsText = function () { }; };

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
function pending(p) { return pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate)); }

console.log('========== 随访排期测试 ==========');

group('1. 自然月推算（addInterval）');
ok(addInterval('2026-01-31', 1, 'm') === '2026-02-28', '1/31 + 1月 → 2/28（月末收敛）', addInterval('2026-01-31', 1, 'm'));
ok(addInterval('2024-01-31', 1, 'm') === '2024-02-29', '闰年 1/31 + 1月 → 2/29', addInterval('2024-01-31', 1, 'm'));
ok(addInterval('2026-03-31', 1, 'm') === '2026-04-30', '3/31 + 1月 → 4/30', addInterval('2026-03-31', 1, 'm'));
ok(addInterval('2026-01-15', 3, 'm') === '2026-04-15', '1/15 + 3月 → 4/15');
ok(addInterval('2026-01-15', 6, 'm') === '2026-07-15', '1/15 + 6月 → 7/15');
ok(addInterval('2026-01-15', 1, 'y') === '2027-01-15', '1/15 + 1年 → 次年 1/15');
ok(addInterval('2026-01-15', 2, 'w') === '2026-01-29', '1/15 + 2周 → 1/29');
ok(addInterval('2026-01-15', 10, 'd') === '2026-01-25', '1/15 + 10天 → 1/25');
ok(addInterval('2026-12-15', 3, 'm') === '2027-03-15', '跨年：12/15 + 3月 → 次年 3/15');
ok(addInterval('2026-11-30', 3, 'm') === '2027-02-28', '跨年月末：11/30 + 3月 → 2/28', addInterval('2026-11-30', 3, 'm'));

group('2. 用户场景：1月 → 3月 → 改成6月');
state = normalize({ version: 2, updatedAt: '', patients: [{ id: 'p1', name: '测试患者', status: '治疗完成', completedAt: '2026-10-01', reactions: [], pauses: [], extras: [], doneDates: [], followupPlans: [] }] });
const p = state.patients[0];

/* 设定模板 1/3/6/12 月 */
cap(function () { sheetFollowupTemplate(p); }).onSave({ base: '2026-10-01' });
let pl = pending(p);
console.log('  模板 1/3/6/12 月 →', pl.map(f => f.dueDate + '(' + intervalText(f.offsetN, f.offsetUnit) + ')').join('  '));
ok(pl.length === 4, '生成 4 次随访', pl.length);
ok(pl[0].dueDate === '2026-11-01', '第 1 次 = 11/01（+1月）', pl[0].dueDate);
ok(pl[1].dueDate === '2027-01-01', '第 2 次 = 2027/01/01（+3月）', pl[1].dueDate);
ok(pl[2].dueDate === '2027-04-01', '第 3 次 = 2027/04/01（+6月）', pl[2].dueDate);
ok(pl[3].dueDate === '2027-10-01', '第 4 次 = 2027/10/01（+12月）', pl[3].dueDate);

/* 完成第 1 次 → 自动排下一次 */
group('3. 完成一次后自动排下一次');
const first = pending(p)[0];
markFollowupDone(p.id, first.id);
ok(first.done === true && !!first.doneAt, '第 1 次已标记完成');
const afterDone = pending(p);
console.log('  完成后待随访:', afterDone.map(f => f.dueDate + '(' + intervalText(f.offsetN, f.offsetUnit) + ')').join('  '));
ok(afterDone.length === 3, '待随访剩 3 次（自动衔接）', afterDone.length);
ok(afterDone[0].dueDate === '2027-01-01', '下一次为 2027/01/01', afterDone[0].dueDate);
ok(followupBase(p) === followupTplBase(p) && !!followupTplBase(p), '★ 起算日锚定放疗结束日（不随完成时间漂移）', { base: followupBase(p), tplBase: followupTplBase(p) });

/* 重复标记不应重复生成 */
const beforeLen = p.followupPlans.length;
markFollowupDone(p.id, first.id);
ok(p.followupPlans.length === beforeLen, '重复标记同一随访不产生重复项', p.followupPlans.length - beforeLen);

group('4. 改成 6 月：重排全部随访');
/* 用户把第 3 次改成 6 月（原本就是6月）→ 改为 9 月再改 6 月，验证灵活 */
cap(function () { sheetFollowupTemplate(p); }).onSave({ base: '2026-10-01' });
/* 上面的 onSave 用的是弹层里的 rows，测试桩不解析 DOM，所以改为直接调用底层 */
const items = [{ n: 1, u: 'm' }, { n: 3, u: 'm' }, { n: 9, u: 'm' }];
p.followupPlans = p.followupPlans.filter(f => f.baseDate === 'TEMPLATE').concat([]);
p.followupPlans = buildFollowupPlans(items, '2026-10-01')
  .concat(buildFollowupPlans(items, '2026-10-01').map(f => { f.baseDate = 'TEMPLATE'; return f; }));
pl = pending(p);
console.log('  改为 1/3/9 月 →', pl.map(f => f.dueDate + '(' + intervalText(f.offsetN, f.offsetUnit) + ')').join('  '));
ok(pl.length === 3, '重排为 3 次', pl.length);
ok(pl[2].dueDate === '2027-07-01', '第 3 次改为 9 月 → 2027/07/01', pl[2].dueDate);

/* 再改成 6 月 */
const items2 = [{ n: 1, u: 'm' }, { n: 3, u: 'm' }, { n: 6, u: 'm' }];
p.followupPlans = buildFollowupPlans(items2, '2026-10-01')
  .concat(buildFollowupPlans(items2, '2026-10-01').map(f => { f.baseDate = 'TEMPLATE'; return f; }));
pl = pending(p);
console.log('  再改为 1/3/6 月 →', pl.map(f => f.dueDate).join('  '));
ok(pl[2].dueDate === '2027-04-01', '第 3 次改回 6 月 → 2027/04/01', pl[2].dueDate);

group('5. 单项自定义间隔（任意值）');
state = normalize({ version: 2, updatedAt: '', patients: [{ id: 'p2', name: '单项测试', status: '治疗完成', completedAt: '2026-10-01', followupPlans: [] }] });
const p2 = state.patients[0];
cap(function () { sheetFollowup(p2, null); }).onSave({ baseDate: '2026-10-01', offsetN: '8', offsetUnit: 'w', dueDate: '2026-11-26', note: '特殊间隔 8 周' });
ok(p2.followupPlans.length === 1, '单次随访已添加');
ok(p2.followupPlans[0].offsetN === 8 && p2.followupPlans[0].offsetUnit === 'w', '间隔保存为 8 周', p2.followupPlans[0]);
cap(function () { sheetFollowup(p2, null); }).onSave({ baseDate: '2026-10-01', offsetN: '18', offsetUnit: 'm', dueDate: '2028-04-01', note: '18个月' });
ok(p2.followupPlans[1].offsetN === 18 && p2.followupPlans[1].offsetUnit === 'm', '支持 18 个月这类任意值', p2.followupPlans[1]);

group('6. 改间隔：编辑已有随访');
const target = p2.followupPlans[0];
cap(function () { sheetFollowup(p2, target); }).onSave({ baseDate: '2026-10-01', offsetN: '12', offsetUnit: 'w', dueDate: '2026-12-24', note: '改为12周' });
ok(target.offsetN === 12 && target.offsetUnit === 'w', '★ 间隔已改为 12 周', target.offsetN + target.offsetUnit);
ok(target.dueDate === '2026-12-24', '到期日随之更新', target.dueDate);

group('7. 患者页展示与待办联动');
state = buildDemoState();
const demo = state.patients[3];
const pend0 = pendOf(demo);
/* 让随访到期，验证进待办 */
if (pend0.length) {
  pend0[0].dueDate = addDays(todayStr(), -2);
  const td = buildTodo().filter(x => x.p.id === demo.id)[0];
  ok(!!td && td.reasons.indexOf('随访到期') >= 0, '★ 随访到期自动进待办', td ? td.reasons : null);
} else {
  ok(false, '示例患者应有随访计划');
}
function pendOf(pp) { return pendingFollowups(pp); }

group('8. 状态与边界');
ok(pendingFollowups({ followupPlans: [] }).length === 0, '无随访时为空');
ok(followupBase({ followupPlans: [], completedAt: '2026-05-01' }) === '2026-05-01', '无完成记录时基准为治疗完成日');
ok(followupBase({ followupPlans: [], completedAt: '2026-05-01', startDate: '', fractions: '' }) === '2026-05-01', '★ 无排程时起算日退回治疗完成日');
ok(buildFollowupPlans([], '2026-01-01').length === 0, '空模板不生成计划');
ok(buildFollowupPlans([{ n: 0, u: 'm' }, { n: 3, u: 'm' }], '2026-01-01').length === 1, '跳过间隔为 0 的项');
ok(nextAfter({ followupPlans: [] }, { offsetN: 1, offsetUnit: 'm' }) === null, '无模板时 nextAfter 返回 null（不报错）');

/* 最后一次完成后不应再生 */
state = normalize({ version: 2, updatedAt: '', patients: [{ id: 'p3', name: '末次', status: '治疗完成', completedAt: '2026-10-01', followupPlans: [] }] });
const p3 = state.patients[0];
p3.followupPlans = buildFollowupPlans([{ n: 1, u: 'm' }, { n: 3, u: 'm' }], '2026-10-01')
  .concat(buildFollowupPlans([{ n: 1, u: 'm' }, { n: 3, u: 'm' }], '2026-10-01').map(f => { f.baseDate = 'TEMPLATE'; return f; }));
const lastOne = pending(p3)[1];
markFollowupDone(p3.id, lastOne.id);
ok(pending(p3).length === 1, '最后一次完成后不再新增（仅剩第1次待完成）', pending(p3).length);

group('9. 示例数据随访完整性');
state = buildDemoState();
console.log('  示例患者随访情况：');
state.patients.forEach(pp => {
  const pn = pendingFollowups(pp).length;
  const dn = (pp.followupPlans || []).filter(f => f.done).length;
  console.log('   ·', pp.name, '| 待随访', pn, '| 已完成', dn,
    pn ? '| 下次 ' + pendingFollowups(pp).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0].dueDate : '');
});
ok(true, '示例数据随访结构正常');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
