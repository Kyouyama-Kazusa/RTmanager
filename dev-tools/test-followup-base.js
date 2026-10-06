/* 随访起算日与病种模板测试
   A. 起算日 = 放疗结束日（不是归档登记日）
   B. 乳腺癌 / 肺癌模板正确性
   C. 界面展示优化  */
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
global.alert = () => { }; global.confirm = () => true;
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
/* 模拟用户点选病种模板：生成模板行 + 计划（与 sheetFollowupTemplate.onSave 同一套底层） */
function applyTpl(p, tpl, base) {
  var items = tpl.items.map(i => ({ n: i.n, u: i.u, note: i.note }));
  p.followupPlans = buildFollowupPlans(items, base)
    .concat(buildFollowupPlans(items, base).map(f => { f.tplBase = base; f.baseDate = 'TEMPLATE'; return f; }));
}
function inState(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  return state.patients[0];
}
const today = todayStr();

console.log('========== 随访起算日与病种模板 ==========');

group('A1. 起算日 = 放疗结束日（而非归档登记日）');
/* 关键场景：放疗 8/1 结束，但医生 9/1 才点「完成治疗」归档。
   随访必须从 8/1（放疗结束）算起，而不是 9/1。 */
const p = inState({
  startDate: addDays(today, -70), fractions: '5', dosePerFraction: '2',
  status: '治疗完成', completedAt: addDays(today, -34)      /* 归档日比放疗结束日晚很多 */
});
const schedEnd = scheduleEnd(p);
console.log('  放疗开始', p.startDate, '· 排程结束', schedEnd, '· 归档登记日', p.completedAt);
ok(!!schedEnd, '能算出排程结束日', schedEnd);
ok(schedEnd !== dateOnly(p.completedAt), '★ 放疗结束日与归档登记日不同（场景成立）', { schedEnd, archived: p.completedAt });
ok(treatmentEndOf(p) === schedEnd, '★ treatmentEndOf 取放疗结束日，而非归档日', treatmentEndOf(p));
ok(treatmentEndOf(p) !== dateOnly(p.completedAt), '★ 确认没用归档日');

group('A2. 模板默认起算日 = 放疗结束日');
sheetFollowupTemplate(p);
const baseInput = getEl('sheetBody');
const baseVal = (baseInput.innerHTML.match(/name="base"[^>]*value="([^"]*)"/) || [])[1];
console.log('  模板表单里的起算日期:', baseVal);
ok(baseVal === schedEnd, '★ 起算日期预填为放疗结束日', { baseVal, schedEnd });
ok(baseInput.innerHTML.indexOf('按排程算出的最后治疗日') >= 0, '★ 并说明这是排程算出的最后治疗日');
ok(baseInput.innerHTML.indexOf('乳腺癌') >= 0, '模板列表含乳腺癌');
ok(baseInput.innerHTML.indexOf('肺癌') >= 0, '模板列表含肺癌');
ok(baseInput.innerHTML.indexOf('按本科室规程调整') >= 0, '★ 提示模板为参考、需按科室规程调整');

group('A3. 按模板排期 → 日期以放疗结束日为第 0 月');
const lungTpl = FOLLOWUP_TEMPLATES.find(t => t.name.indexOf('肺癌') >= 0);
applyTpl(p, lungTpl, schedEnd);
let plans = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
console.log('  生成的随访:', plans.map(f => f.dueDate + '(' + intervalText(f.offsetN, f.offsetUnit) + ')').join('  '));
ok(plans.length === 7, '肺癌模板生成 7 次随访', plans.length);
ok(plans[0].dueDate === addInterval(schedEnd, 3, 'm'), '★ 第 1 次 = 放疗结束 + 3 个月', plans[0].dueDate);
ok(plans[6].dueDate === addInterval(schedEnd, 60, 'm'), '★ 第 7 次 = 放疗结束 + 60 个月', plans[6].dueDate);
ok(plans[0].dueDate !== addInterval(dateOnly(p.completedAt), 3, 'm'), '★ 确实不是按归档日算的');
ok(followupTplBase(p) === schedEnd, '★ 模板记住了起算日', followupTplBase(p));
ok(followupBase(p) === schedEnd, 'followupBase 返回放疗结束日', followupBase(p));
ok(plans[0].note === '复查胸部CT、血常规、肝肾功能', '复查项目已随模板带入', plans[0].note);

/* 真实 UI 路径：模板已存在时，打开表单 → 保存，应沿用同一套行与起算日 */
cap(function () { sheetFollowupTemplate(p); }).onSave({ base: schedEnd });
const plans2 = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
ok(plans2.length === 7, '★ 经 UI 表单重新保存后仍为 7 次', plans2.length);
ok(plans2[0].dueDate === addInterval(schedEnd, 3, 'm'), '★ 经 UI 保存后日期仍以放疗结束日起算', plans2[0].dueDate);
ok(followupTplBase(p) === schedEnd, '经 UI 保存后起算日仍被记住', followupTplBase(p));

group('A4. 归档日改变不影响已排的随访');
const datesBefore = pendingFollowups(p).map(f => f.dueDate).join(',');
p.completedAt = addDays(today, -3);        /* 医生改了归档日 */
ok(pendingFollowups(p).map(f => f.dueDate).join(',') === datesBefore, '★ 随访日期不因归档日变化而漂移');
ok(treatmentEndOf(p) === schedEnd, '起算点仍为放疗结束日');
p.completedAt = addDays(today, -34);

group('A5. 完成一次后，下一次仍锚定放疗结束日');
const firstF = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
const secondDue = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[1].dueDate;
markFollowupDone(p.id, firstF.id);
ok(firstF.done === true, '第 1 次已标记完成', firstF.done);
ok(followupTplBase(p) === schedEnd, '★ 起算日未因完成而改变');
const secondNow = pendingFollowups(p).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
ok(secondNow.dueDate === secondDue, '★ 下一次日期不变（仍按放疗结束日起算）', { secondDue, now: secondNow.dueDate });
ok(secondNow.dueDate === addInterval(schedEnd, 6, 'm'), '第 2 次 = 放疗结束 + 6 个月', secondNow.dueDate);

group('A6. 已完成的随访被保留（重排不覆盖）');
const doneCntBefore = (p.followupPlans || []).filter(f => f.done).length;
cap(function () { sheetFollowupTemplate(p); }).onSave({ base: schedEnd });
const doneCntAfter = (p.followupPlans || []).filter(f => f.done).length;
ok(doneCntAfter === doneCntBefore && doneCntBefore === 1, '★ 重排后已完成记录仍保留', { before: doneCntBefore, after: doneCntAfter });
ok(pendingFollowups(p).length === 6, '待随访重新生成为 6 次', pendingFollowups(p).length);

group('A7. 无排程时退回归档日');
const pNoSched = inState({ startDate: '', fractions: '', status: '治疗完成', completedAt: addDays(today, -30) });
ok(treatmentEndOf(pNoSched) === dateOnly(pNoSched.completedAt), '★ 无排程时退回归档日', treatmentEndOf(pNoSched));
const pNothing = inState({ startDate: '', fractions: '', status: '治疗完成', completedAt: '' });
ok(treatmentEndOf(pNothing) === '', '两者都没有时返回空（不报错）', treatmentEndOf(pNothing));

group('A8. treatmentEndNote 文案');
const pNote = inState({ startDate: addDays(today, -30), fractions: '5', dosePerFraction: '2' });
const endN = scheduleEnd(pNote);
console.log('  放疗结束日', endN, '→', treatmentEndNote(pNote));
ok(treatmentEndNote(pNote).indexOf('放疗结束第') >= 0 || treatmentEndNote(pNote).indexOf('今天是放疗结束日') >= 0,
  '★ 给出相对放疗结束的天数说明', treatmentEndNote(pNote));
const pFuture = inState({ startDate: addDays(today, 10), fractions: '5', dosePerFraction: '2' });
ok(treatmentEndNote(pFuture).indexOf('还有') >= 0, '★ 未结束时提示「还有 N 天」', treatmentEndNote(pFuture));

group('B1. 乳腺癌模板内容');
const breast = FOLLOWUP_TEMPLATES.find(t => t.name.indexOf('乳腺癌') >= 0);
ok(!!breast, '存在乳腺癌模板');
ok(breast.items.length === 7, '7 次随访', breast.items.length);
ok(breast.name.indexOf('3/6/12/18/24/36/60') >= 0, '间隔为 3/6/12/18/24/36/60 月');
const bn = breast.items.map(i => i.n);
ok(JSON.stringify(bn) === JSON.stringify([3, 6, 12, 18, 24, 36, 60]), '★ 间隔数值正确且递增', bn);
ok(breast.items.every(i => i.u === 'm'), '单位均为月');
ok(breast.items.every(i => i.note && i.note.length > 0), '★ 每次都有复查项目说明');
ok(breast.items[0].note.indexOf('乳腺超声') >= 0, '首次随访含乳腺超声');
ok(breast.items.some(i => i.note.indexOf('钼靶') >= 0), '含钼靶检查');
ok(breast.items.some(i => i.note.indexOf('肿瘤标志物') >= 0), '含肿瘤标志物');

group('B2. 肺癌模板内容');
const lung = FOLLOWUP_TEMPLATES.find(t => t.name.indexOf('肺癌') >= 0);
ok(!!lung, '存在肺癌模板');
ok(lung.items.length === 7, '7 次随访', lung.items.length);
ok(JSON.stringify(lung.items.map(i => i.n)) === JSON.stringify([3, 6, 12, 18, 24, 36, 60]), '★ 间隔与乳腺癌一致的随访节奏');
ok(lung.items.every(i => i.note.indexOf('胸部CT') >= 0), '★ 每次均含胸部CT（肺癌随访核心）', lung.items.map(i => i.note));
ok(lung.items.some(i => i.note.indexOf('颅脑MRI') >= 0), '含颅脑MRI（肺癌易脑转移）');
ok(lung.items.some(i => i.note.indexOf('肿瘤标志物') >= 0), '含肿瘤标志物');

group('B3. 原有模板未被破坏');
ok(FOLLOWUP_TEMPLATES.length === 6, '★ 共 6 个模板', FOLLOWUP_TEMPLATES.length);
ok(FOLLOWUP_TEMPLATES.some(t => t.name.indexOf('标准') >= 0), '保留「标准」模板');
ok(FOLLOWUP_TEMPLATES.some(t => t.name.indexOf('密集') >= 0), '保留「密集」模板');
ok(FOLLOWUP_TEMPLATES.some(t => t.name.indexOf('长期') >= 0), '保留「长期」模板');
ok(FOLLOWUP_TEMPLATES.some(t => t.name.indexOf('前列腺癌') >= 0), '保留「前列腺癌」模板');
ok(FOLLOWUP_TEMPLATES.every(t => t.items.every(i => i.n > 0 && ['d', 'w', 'm', 'y'].indexOf(i.u) >= 0)), '所有模板的间隔与单位合法');

group('B4. 病种模板可一键套用并可再编辑');
const pBreast = inState({
  startDate: addDays(today, -100), fractions: '25', dosePerFraction: '2',
  status: '治疗完成', completedAt: addDays(today, -60)
});
const bEnd = scheduleEnd(pBreast);
applyTpl(pBreast, breast, bEnd);
ok(pendingFollowups(pBreast).length === 7, '套用乳腺癌模板生成 7 次', pendingFollowups(pBreast).length);
ok(followupTplBase(pBreast) === bEnd, '起算日为放疗结束日');
const b1 = pendingFollowups(pBreast).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
console.log('  乳腺癌首访:', b1.dueDate, '·', b1.note);
ok(b1.dueDate === addInterval(bEnd, 3, 'm'), '首访 = 放疗结束 + 3 个月', b1.dueDate);
ok(b1.note === '复查乳腺超声、血常规、肝肾功能', '首访内容已带入', b1.note);
/* 逐行修改仍可用 */
cap(function () { sheetFollowup(pBreast, b1); }).onSave({ baseDate: bEnd, offsetN: '2', offsetUnit: 'm', dueDate: addInterval(bEnd, 2, 'm'), note: '改为放疗后 2 个月复查' });
ok(b1.offsetN === 2 && b1.dueDate === addInterval(bEnd, 2, 'm'), '★ 单项可改为 2 个月', b1.dueDate);

group('C1. 界面展示优化');
const pShow = inState({
  startDate: addDays(today, -100), fractions: '25', dosePerFraction: '2',
  status: '治疗完成', completedAt: addDays(today, -60)
});
const sEnd = scheduleEnd(pShow);
applyTpl(pShow, breast, sEnd);
view.page = 'patient'; view.pid = pShow.id;
render();
const page = getEl('view').innerHTML;
ok(page.indexOf('起算：放疗结束日') >= 0, '★ 显示起算说明「放疗结束日」');
ok(page.indexOf(dateOnly(sEnd)) >= 0, '显示具体起算日期');
ok(page.indexOf('已随访 0/7 次') >= 0, '★ 显示随访进度 0/7', true);
ok(page.indexOf('下一次随访') >= 0, '显示下一次随访卡片');
ok(/还有 \d+ 天|逾期 \d+ 天|今日到期/.test(page), '★ 显示距下次随访的天数倒计时');
ok(page.indexOf('放疗后 3 个月') >= 0, '★ 显示相对放疗结束的间隔', true);
ok(page.indexOf('设定随访模板（按病种）') >= 0 || page.indexOf('修改随访模板') >= 0, '入口按钮文案正确');

group('C2. 完成治疗后可直接设模板');
const pNew = inState({ startDate: addDays(today, -40), fractions: '10', dosePerFraction: '2', status: '在治' });
const nEnd = scheduleEnd(pNew);
cap(function () { completePatient(pNew); }).onSave({ doneDate: '' });
ok(pNew.status === '治疗完成', '已归档');
ok(dateOnly(pNew.completedAt) === nEnd, '★ 完成日期默认取排程的最后治疗日', { got: pNew.completedAt, want: nEnd });
const cBody = getEl('sheetBody').innerHTML;
ok(cBody.indexOf('随访日期一律以「放疗结束日」') >= 0 || cBody.indexOf('放疗结束日') >= 0, '表单里说明了随访起算规则');

group('C3. 示例数据');
state = buildDemoState();
console.log('  示例患者随访：');
state.patients.forEach(pp => {
  const pr = followupProgress(pp);
  const nx = pendingFollowups(pp).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  console.log('   ·', pp.name, '|', pr.total ? ('随访 ' + pr.done + '/' + pr.total) : '无随访',
    '| 起算', followupBase(pp) || '-', '| 下次', nx ? nx.dueDate : '-');
});
const zhou = state.patients.find(x => x.name === '周敏');
ok(!!zhou, '★ 示例含乳腺癌患者「周敏」', !!zhou);
ok(zhou && zhou.followupPlans.filter(f => f.baseDate !== 'TEMPLATE').length === 7, '乳腺癌患者有 7 次随访', zhou ? zhou.followupPlans.filter(f => f.baseDate !== 'TEMPLATE').length : 0);
ok(zhou && followupTplBase(zhou) === treatmentEndOf(zhou), '★ 乳腺癌患者随访以放疗结束日起算', zhou ? { tplBase: followupTplBase(zhou), tEnd: treatmentEndOf(zhou) } : null);
const chen = state.patients.find(x => x.name === '陈美华');
ok(chen && followupTplBase(chen) === treatmentEndOf(chen), '直肠癌患者随访也以放疗结束日起算', chen ? { tplBase: followupTplBase(chen), tEnd: treatmentEndOf(chen) } : null);

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
