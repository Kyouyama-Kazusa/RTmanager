/* 随访模板增删改与自定义测试 */
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
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false, focus() { },
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
let confirmAnswer = true;
global.alert = () => { }; global.confirm = () => confirmAnswer;
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
function inState(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '治疗完成', treatDays: [1, 2, 3, 4, 5] }, o)] });
  return state.patients[0];
}
const today = todayStr();

console.log('========== 随访模板增删改测试 ==========');

group('1. 内置模板基线');
resetTpls();
ok(FOLLOWUP_TEMPLATES.length === 6, '内置模板 6 个', FOLLOWUP_TEMPLATES.length);
ok(followupTemplates().length === 6, '可用模板 6 个', followupTemplates().length);
ok(followupTemplates().every(t => t.builtin === true), '★ 全部标记为内置');
ok(isBuiltinTpl('肺癌（3/6/12/18/24/36/60 月）') === true, '识别内置模板名称');
ok(isBuiltinTpl('我的模板') === false, '自建名称不算内置');
ok(findTpl('乳腺癌（3/6/12/18/24/36/60 月）') !== null, '可按名称查找模板');

group('2. 新增自定义模板');
ok(saveTpl('本科室肺癌随访', [{ n: 2, u: 'm', note: '复查胸部CT' }, { n: 6, u: 'm', note: '复查胸部CT、标志物' }]) === true, '★ 保存成功');
ok(followupTemplates().length === 7, '可用模板增至 7', followupTemplates().length);
const mine = findTpl('本科室肺癌随访');
ok(!!mine, '可按名称找到自建模板', !!mine);
ok(mine.builtin === false, '★ 标记为自建（非内置）', mine.builtin);
ok(mine.items.length === 2, '含 2 次随访', mine.items.length);
ok(mine.items[0].n === 2 && mine.items[0].u === 'm', '间隔正确保留', mine.items[0]);
ok(mine.items[0].note === '复查胸部CT', '随访内容保留', mine.items[0].note);
ok(store['radiotherapy.tpls'] !== undefined, '★ 自建模板已写入本机存储');
ok((store['radiotherapy.tpls'] || '').indexOf('radiotherapy.v1') < 0, '与患者数据分开存储');

group('3. 同名覆盖内置模板');
ok(saveTpl('密集（1/3/6 月）', [{ n: 1, u: 'm' }, { n: 2, u: 'm' }, { n: 4, u: 'm' }, { n: 8, u: 'm' }]) === true, '覆盖内置模板成功');
const dense = findTpl('密集（1/3/6 月）');
ok(dense.items.length === 4, '★ 内置模板已被覆盖为 4 次', dense.items.length);
ok(dense.builtin === true, '仍是内置项（可恢复）', dense.builtin);
ok(followupTemplates().length === 7, '模板总数不变（是覆盖而非新增）', followupTemplates().length);

group('4. 删除模板');
delTpl('长期（3/6/12/24 月）');
ok(findTpl('长期（3/6/12/24 月）') === null, '★ 内置模板已删除');
ok(followupTemplates().length === 6, '可用模板减为 6', followupTemplates().length);
delTpl('本科室肺癌随访');
ok(findTpl('本科室肺癌随访') === null, '★ 自建模板已删除');
ok(followupTemplates().length === 5, '可用模板减为 5', followupTemplates().length);

group('5. 恢复内置');
resetTpls();
ok(followupTemplates().length === 6, '★ 恢复后回到 6 个内置模板', followupTemplates().length);
ok(findTpl('长期（3/6/12/24 月）') !== null, '被删的内置模板回来了');
ok(findTpl('密集（1/3/6 月）').items.length === 3, '被覆盖的内置模板恢复原样', findTpl('密集（1/3/6 月）').items.length);
ok(findTpl('本科室肺癌随访') === null, '自建模板已清除');
ok(Object.keys(tplOverride()).length === 0, '覆盖层已清空');

group('6. 应用更新后自建模板保留（关键）');
resetTpls();
saveTpl('本科室食管癌', [{ n: 3, u: 'm' }]);
delTpl('前列腺癌（3/6/12 月＋PSA）');
const ovBefore = JSON.stringify(tplOverride());
/* 模拟版本升级：内置层新增一个模板并改动另一个。
   先备份，测完还原，避免影响后续用例。 */
const BUILTIN_SNAPSHOT = JSON.parse(JSON.stringify(FOLLOWUP_TEMPLATES));
FOLLOWUP_TEMPLATES.push({ name: '新病种（升级新增）', items: [{ n: 6, u: 'm' }] });
FOLLOWUP_TEMPLATES.find(t => t.name.indexOf('标准') >= 0).items = [{ n: 1, u: 'm' }, { n: 4, u: 'm' }];
ok(findTpl('本科室食管癌') !== null, '★ 升级后自建模板仍存在', !!findTpl('本科室食管癌'));
ok(findTpl('前列腺癌（3/6/12 月＋PSA）') === null, '★ 删除内置的操作仍生效', findTpl('前列腺癌（3/6/12 月＋PSA）'));
ok(findTpl('新病种（升级新增）') !== null, '★ 新版内置模板自动可用', !!findTpl('新病种（升级新增）'));
ok(findTpl('标准（1/3/6/12 月）').items.length === 2, '新版对内置模板的改动生效', findTpl('标准（1/3/6/12 月）').items.length);
ok(JSON.stringify(tplOverride()) === ovBefore, '用户覆盖层未被升级影响');
/* 还原内置层（模拟升级结束） */
FOLLOWUP_TEMPLATES.length = 0;
BUILTIN_SNAPSHOT.forEach(t => FOLLOWUP_TEMPLATES.push(t));
resetTpls();
ok(FOLLOWUP_TEMPLATES.length === 6, '内置层已还原为 6 个（便于后续用例）', FOLLOWUP_TEMPLATES.length);

group('7. 输入的健壮性');
ok(saveTpl('', [{ n: 1, u: 'm' }]) === false, '★ 空名称拒绝保存');
ok(saveTpl('   ', [{ n: 1, u: 'm' }]) === false, '纯空格名称拒绝');
ok(saveTpl('空序列模板', []) === false, '★ 空序列拒绝保存');
ok(saveTpl('无效序列', [{ n: 0, u: 'm' }, { n: '', u: 'm' }]) === false, '★ 间隔全为 0/空 拒绝保存');
ok(saveTpl('部分有效', [{ n: 0, u: 'm' }, { n: 3, u: 'm' }]) === true, '含有效项时可保存（自动剔除无效项）');
ok(findTpl('部分有效').items.length === 1, '★ 无效项已被剔除', findTpl('部分有效').items.length);
ok(saveTpl('默认单位', [{ n: 5 }]) === true, '缺单位时默认按月');
ok(findTpl('默认单位').items[0].u === 'm', '默认单位为 m', findTpl('默认单位').items[0].u);
ok(saveTpl('去空格', [{ n: 3, u: 'm', note: '  复查  ' }]) === true, '可保存');
ok(tplItemsText(findTpl('部分有效').items) === '3 个月', '★ 摘要文案正确', tplItemsText(findTpl('部分有效').items));
resetTpls();

group('8. 管理面板渲染');
const pM = inState({ startDate: addDays(today, -100), fractions: '5', dosePerFraction: '2', completedAt: addDays(today, -60) });
saveTpl('我的模板 A', [{ n: 3, u: 'm', note: '复查A' }]);
view.pid = pM.id;
sheetTplManage(pM);
const mg = getEl('sheetBody').innerHTML;
ok(mg.indexOf('内置模板（') >= 0, '★ 分组显示「内置模板」');
ok(mg.indexOf('我自建的（1）') >= 0, '★ 分组显示「我自建的」');
ok(mg.indexOf('我的模板 A') >= 0, '列出自建模板名称');
ok(mg.indexOf('复查A') < 0 && mg.indexOf('3 个月') >= 0, '只显示间隔摘要（内容已在序列里）', true);
ok((mg.match(/data-act="tpl-use"/g) || []).length === FOLLOWUP_TEMPLATES.length + 1, '★ 每个模板都有「套用」按钮', (mg.match(/data-act="tpl-use"/g) || []).length);
ok((mg.match(/data-act="tpl-del"/g) || []).length === FOLLOWUP_TEMPLATES.length + 1, '★ 每个模板都有「删除」按钮');
ok(getEl('sheetFootInner').innerHTML.indexOf('恢复内置模板') >= 0, '★ 有改动时出现「恢复内置模板」');
ok(getEl('sheetFootInner').innerHTML.indexOf('tpl-back') >= 0, '有「返回编辑」');

group('9. 从管理面板删除');
confirmAnswer = false;
fire('tpl-del', { name: '我的模板 A' });
ok(findTpl('我的模板 A') !== null, '★ 取消确认时不删除', !!findTpl('我的模板 A'));
confirmAnswer = true;
fire('tpl-del', { name: '我的模板 A' });
ok(findTpl('我的模板 A') === null, '★ 确认后删除成功');
ok(getEl('sheetBody').innerHTML.indexOf('我的模板 A') < 0, '★ 面板已刷新，条目消失');

group('10. 从管理面板套用模板（患者详情页语境）');
saveTpl('套用测试', [{ n: 2, u: 'm', note: '首次' }, { n: 8, u: 'm', note: '第二次' }]);
const pUse = inState({ startDate: addDays(today, -90), fractions: '5', dosePerFraction: '2', completedAt: addDays(today, -50) });
view.page = 'patient'; view.pid = pUse.id;      /* 套用只在患者语境下生效（BUG-07） */
sheetTplManage(pUse);
fire('tpl-use', { name: '套用测试' });
const uEnd = treatmentEndOf(pUse);
ok(pendingFollowups(pUse).length === 2, '★ 套用后生成 2 次随访', pendingFollowups(pUse).length);
ok(followupTplBase(pUse) === uEnd, '★ 起算日为放疗结束日', { base: followupTplBase(pUse), end: uEnd });
const u1 = pendingFollowups(pUse).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
ok(u1.dueDate === addInterval(uEnd, 2, 'm'), '首次随访 = 放疗结束 + 2 个月', u1.dueDate);
ok(u1.note === '首次', '随访内容已带入', u1.note);
ok(getEl('sheetTitle').textContent.indexOf('随访模板') >= 0, '★ 套用后自动回到模板编辑页');

group('10b. 设置页语境下套用模板不落库（BUG-07）');
const pGuard = inState({ startDate: addDays(today, -90), fractions: '5', dosePerFraction: '2', completedAt: addDays(today, -50) });
view.page = 'settings'; view.pid = null;         /* 全局设置：没有患者上下文 */
sheetTplManage(pGuard);
fire('tpl-use', { name: '套用测试' });
ok((pGuard.followupPlans || []).length === 0, '★ 设置页套用不写入任何患者（不再静默改到上一位）', (pGuard.followupPlans || []).length);
ok(pendingFollowups(pGuard).length === 0, '★ 确认没有随访被排到患者身上');
view.page = 'patient'; view.pid = null;          /* 复位，避免影响后续用例 */

group('11. 删除内置模板后，患者已有随访不受影响');
resetTpls();
const pKeep = inState({ startDate: addDays(today, -90), fractions: '5', dosePerFraction: '2', completedAt: addDays(today, -50) });
applyTplToPatient(pKeep, { items: findTpl('肺癌（3/6/12/18/24/36/60 月）').items, base: treatmentEndOf(pKeep) });
const keepCnt = pendingFollowups(pKeep).length;
ok(keepCnt === 7, '先排入 7 次', keepCnt);
delTpl('肺癌（3/6/12/18/24/36/60 月）');
ok(pendingFollowups(pKeep).length === keepCnt, '★ 删除模板不影响患者已生成的随访', pendingFollowups(pKeep).length);
ok(findTpl('肺癌（3/6/12/18/24/36/60 月）') === null, '模板本身已删除');
resetTpls();

group('12. 重排时已完成不重复（回归）');
const pDup = inState({ startDate: addDays(today, -200), fractions: '5', dosePerFraction: '2', completedAt: addDays(today, -150) });
const dEnd = treatmentEndOf(pDup);
/* 用显式序列，不依赖内置模板（避免受其它用例影响） */
const STD4 = [{ n: 1, u: 'm' }, { n: 3, u: 'm' }, { n: 6, u: 'm' }, { n: 12, u: 'm' }];
applyTplToPatient(pDup, { items: STD4, base: dEnd });
ok(pendingFollowups(pDup).length === 4, '初次排入 4 次', pendingFollowups(pDup).length);
const firstD = pendingFollowups(pDup).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
markFollowupDone(pDup.id, firstD.id);
ok((pDup.followupPlans || []).filter(f => f.done).length === 1, '完成 1 次');
applyTplToPatient(pDup, { items: STD4, base: dEnd });
ok(pendingFollowups(pDup).length === 3, '★ 重排后待随访 3 次（已完成的未重复生成）', pendingFollowups(pDup).length);
ok((pDup.followupPlans || []).filter(f => f.done).length === 1, '已完成记录保留', (pDup.followupPlans || []).filter(f => f.done).length);

group('13. 设置页入口');
view.page = 'settings'; render();
const st = getEl('view').innerHTML;
ok(st.indexOf('tpl-settings') >= 0, '★ 设置页有「随访模板库」入口');
ok(st.indexOf('随访模板库') >= 0, '入口文案正确');
const m = st.match(/随访模板库<div class="sub2">([^<]*)/);
console.log('  入口副标题:', m ? m[1] : '(未匹配)');
ok(!!m && m[1].indexOf(String(followupTemplates().length)) >= 0, '副标题显示可用模板数量', m ? m[1] : null);

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
