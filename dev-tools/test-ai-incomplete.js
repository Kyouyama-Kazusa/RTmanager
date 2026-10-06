/* AI 识别不完整时的处理测试：部分填充 + 缺项提示 + 人工补充 */
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

/* 模拟表单：从界面 HTML 提取 name，并允许注入覆盖值 */
let sheetInputs = [];
function buildSheetInputs(htmlStr, overrides) {
  const names = [...new Set([...String(htmlStr || '').matchAll(/name="([^"]+)"/g)].map(m => m[1]))];
  sheetInputs = names.map(n => {
    let v = '';
    const m = n.match(/^ai_(\d+)_(\w+)$/);
    if (m) {
      const idx = +m[1], key = m[2];
      if (window.__sheetCommitted && window.__sheetCommitted[idx]) v = window.__sheetCommitted[idx][key] || '';
      else if (aiDraft.patients[idx]) v = aiDraft.patients[idx][key] || '';
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, n)) v = overrides[n];
    return { name: n, value: v, type: 'text', checked: false };
  });
  return names;
}

global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
let clickHandler = null;
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll(sel) { return sel === '#sheetBody [name]' ? sheetInputs : []; },
  querySelector() { return null; },
  createElement() { return makeEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; }, documentElement: makeEl()
};
global.window = global;
window.__sheetCommitted = null;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
let confirmAnswer = true, confirmMsgs = [], alertMsgs = [];
global.alert = (m) => { alertMsgs.push(String(m || '')); };
global.confirm = (m) => { confirmMsgs.push(String(m || '')); return confirmAnswer; };
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
/* 打开复核界面并准备好表单桩 */
function openReview(patients) {
  aiDraft = { images: [], patients: patients };
  openAiReview();
  buildSheetInputs(getEl('sheetBody').innerHTML, window.__sheetCommitted ? null : null);
}
/* 模拟用户填写某些字段后提交 */
function commitWith(overrides) {
  buildSheetInputs(getEl('sheetBody').innerHTML, overrides);
  fire('ai-commit');
}

console.log('========== AI 识别不完整处理测试 ==========');

group('1. 保留部分识别的条目（关键修复）');
/* 有诊断与剂量、但没识别出姓名 —— 旧版会被整个丢弃 */
let rows = normalizeAiPatients({ patients: [
  { diagnosis: '肺癌', totalDose: '60', fractions: '30' },
  { name: '张三', diagnosis: '鼻咽癌', startDate: '2026-10-08', fractions: '33' }
] });
ok(rows.length === 2, '★ 缺姓名但有其他信息的条目被保留（旧版会丢弃）', rows.length);
ok(rows[0].diagnosis === '肺癌', '保留的条目信息完整带入', rows[0].diagnosis);
ok(rows[0].name === '', '姓名留空待人工补充', rows[0].name);
ok(rows[1].name === '张三', '正常的条目不受影响');

group('2. 完全空白的条目仍丢弃');
rows = normalizeAiPatients({ patients: [{}, { name: '', diagnosis: '' }, null, 'str', 123] });
ok(rows.length === 0, '★ 完全空白/非对象条目被丢弃', rows.length);
rows = normalizeAiPatients({ patients: [{}, { age: '58' }] });
ok(rows.length === 1, '只要有一个字段有值就保留', rows.length);
ok(rows[0].age === '58', '保留了年龄字段', rows[0].age);

group('3. 缺失统计（aiMissingOf）');
const full = { name: '李四', startDate: '2026-10-08', fractions: '30', diagnosis: '食管癌', totalDose: '60', dosePerFraction: '2' };
let m = aiMissingOf(full);
ok(m.count === 0, '信息完整时无缺失', m.count);
ok(!m.blocking && !m.needCare, '既不阻断也不需特别关注');
ok(m.all.length === 0, '缺失清单为空');

m = aiMissingOf({ name: '王五' });
console.log('  只有姓名时缺失:', JSON.stringify(m.all));
ok(m.blocking === false, '有姓名 → 不阻断导入');
ok(m.needCare === true, '★ 缺开始日期/总次数 → 标记为排程必需', m.schedule);
ok(m.schedule.indexOf('开始日期') >= 0 && m.schedule.indexOf('总次数') >= 0, '正确识别排程必需项', m.schedule);
ok(m.suggest.indexOf('诊断') >= 0, '诊断归入建议补充', m.suggest);

m = aiMissingOf({ diagnosis: '肺癌' });
ok(m.blocking === true, '★ 缺姓名 → 阻断导入', m.blocking);
ok(m.required.indexOf('姓名') >= 0, '缺失清单含姓名', m.required);

group('4. 字段分级与标签');
ok(AI_FIELD_LEVEL.name === 'required', '姓名 = 必填', AI_FIELD_LEVEL.name);
ok(AI_FIELD_LEVEL.startDate === 'schedule', '开始日期 = 排程必需');
ok(AI_FIELD_LEVEL.fractions === 'schedule', '总次数 = 排程必需');
ok(AI_FIELD_LEVEL.diagnosis === 'suggest', '诊断 = 建议');
ok(AI_FIELD_LEVEL.mrn === undefined, '住院号不参与标记（避免满屏待补）');
ok(AI_FIELD_LABEL.fractions === '总次数', '字段中文名正确', AI_FIELD_LABEL.fractions);
ok(AI_LEVEL_TAG.required === '待补·必填', '标记文案正确');
const lblEmpty = aiLabelHtml({ name: '' }, 'name', '姓名');
ok(lblEmpty.indexOf('待补·必填') >= 0, '★ 空字段的标签带「待补·必填」', lblEmpty);
const lblFull = aiLabelHtml({ name: '张三' }, 'name', '姓名');
ok(lblFull.indexOf('待补') < 0, '★ 已填字段的标签无标记', lblFull);
const lblSched = aiLabelHtml({ startDate: '' }, 'startDate');
ok(lblSched.indexOf('待补·排程必需') >= 0, '★ 排程字段带「待补·排程必需」', lblSched);

group('5. 提示词：要求不得跳过信息不全的患者');
const prompt = defaultAiPrompt();
ok(prompt.indexOf('每一位患者都必须输出一条记录') >= 0, '★ 提示词要求每位患者都要输出');
ok(prompt.indexOf('绝对不要因为信息不全而跳过') >= 0, '★ 明确禁止因信息不全跳过');
ok(prompt.indexOf('不要编造') >= 0, '仍禁止编造', true);

group('6. 复核界面：缺失标注与汇总');
openReview(normalizeAiPatients({ patients: [
  { name: '完整患者', diagnosis: '肺癌', startDate: '2026-10-08', fractions: '30', totalDose: '60', dosePerFraction: '2' },
  { name: '缺排程患者', diagnosis: '食管癌' },
  { diagnosis: '乳腺癌', totalDose: '50' }
] }));
let body = getEl('sheetBody').innerHTML;
console.log('  汇总行含:', body.slice(body.indexOf('本批'), body.indexOf('本批') + 110).replace(/\s+/g, ' '));
ok(body.indexOf('AI 识别结果<b>不完整</b>') >= 0, '★ 顶部提示识别结果不完整');
ok(body.indexOf('共待补 <b>') >= 0, '★ 显示待补总项数');
ok(body.indexOf('缺姓名（无法导入）') >= 0, '★ 汇总里点明有缺姓名的');
ok(body.indexOf('信息完整') >= 0, '★ 完整条目标注「信息完整」');
ok(body.indexOf('待补 ') >= 0, '★ 不完整条目标注「待补 N 项」');
ok(body.indexOf('缺姓名') >= 0, '★ 缺姓名的条目标注「缺姓名」');
ok(body.indexOf('待补充：') >= 0, '★ 每条下方列出待补充项目');
ok(body.indexOf('待补·必填') >= 0, '★ 姓名字段带待补·必填标记');
ok(body.indexOf('待补·排程必需') >= 0, '★ 开始日期/总次数字段带排程必需标记');
/* 按钮固定在弹层底部操作区，不在内容区 */
const foot = getEl('sheetFootInner').innerHTML;
ok(foot.indexOf('手动补一位') >= 0, '★ 有「手动补一位」入口', foot.slice(0, 100));
ok(foot.indexOf('确认导入 3 位') >= 0, '按钮显示 3 位', foot.slice(0, 140));
/* 已识别字段确实已填入 */
ok(body.indexOf('value="完整患者"') >= 0, '★ 已识别的姓名已填入');
ok(body.indexOf('value="肺癌"') >= 0 || body.indexOf('>肺癌</textarea>') >= 0, '★ 已识别的诊断已填入');
ok(body.indexOf('value="60"') >= 0, '★ 已识别的总剂量已填入');

group('7. 汇总提示：全部完整时不显示警告');
openReview(normalizeAiPatients({ patients: [
  { name: '甲', diagnosis: '肺癌', startDate: '2026-10-08', fractions: '30', totalDose: '60', dosePerFraction: '2' },
  { name: '乙', diagnosis: '食管癌', startDate: '2026-10-08', fractions: '28', totalDose: '50.4', dosePerFraction: '1.8' }
] }));
body = getEl('sheetBody').innerHTML;
ok(body.indexOf('关键信息均已识别到') >= 0, '★ 全部完整时给绿色提示');
ok(body.indexOf('识别结果<b>不完整</b>') < 0, '不出现不完整警告');

group('8. 手动补一位');
openReview(normalizeAiPatients({ patients: [{ name: '甲', startDate: '2026-10-08', fractions: '30' }] }));
buildSheetInputs(getEl('sheetBody').innerHTML, { ai_0_diagnosis: '已填诊断' });
fire('ai-add-row');
ok(aiDraft.patients.length === 2, '★ 新增一条记录', aiDraft.patients.length);
ok(aiDraft.patients[1].name === '', '新记录为空', aiDraft.patients[1].name);
ok(aiDraft.patients[0].diagnosis === '已填诊断', '★ 新增前已保留用户已填内容（不丢编辑）', aiDraft.patients[0].diagnosis);

group('9. 移除条目时保留已填内容');
openReview(normalizeAiPatients({ patients: [{ name: '甲' }, { name: '乙' }] }));
buildSheetInputs(getEl('sheetBody').innerHTML, { ai_0_diagnosis: '甲的诊断', ai_0_mrn: 'M001' });
confirmAnswer = true;
fire('ai-drop', { i: '1' });          /* 移除第 2 条 */
ok(aiDraft.patients.length === 1, '剩 1 条', aiDraft.patients.length);
ok(aiDraft.patients[0].diagnosis === '甲的诊断', '★ 移除后第 1 条的编辑未丢失', aiDraft.patients[0].diagnosis);
ok(aiDraft.patients[0].mrn === 'M001', '★ 住院号编辑也未丢失', aiDraft.patients[0].mrn);

group('10. 提交时预检并提示（缺姓名被跳过 / 缺排程可先导入）');
state = normalize({ version: 2, updatedAt: '', patients: [] });
openReview(normalizeAiPatients({ patients: [
  { name: '甲', diagnosis: '肺癌', startDate: '2026-10-08', fractions: '30', totalDose: '60', dosePerFraction: '2' },
  { name: '乙', diagnosis: '食管癌' },              /* 缺排程信息 */
  { diagnosis: '乳腺癌' }                            /* 缺姓名 */
] }));
confirmMsgs = []; alertMsgs = [];
confirmAnswer = true;
commitWith({});
ok(confirmMsgs.length === 1, '★ 提交前弹确认', confirmMsgs.length);
console.log('  确认文案:', confirmMsgs[0].replace(/\n+/g, ' | '));
ok(confirmMsgs[0].indexOf('1 条缺少姓名') >= 0, '★ 提示有 1 条缺姓名将被跳过', true);
ok(confirmMsgs[0].indexOf('1 条缺少') >= 0 && confirmMsgs[0].indexOf('无法自动生成治疗日历') >= 0, '★ 提示有缺排程信息的', true);
ok(state.patients.length === 2, '★ 导入 2 位（完整 + 缺排程），跳过缺姓名的', state.patients.length);
const yi = state.patients.find(x => x.name === '乙');
ok(!!yi, '缺排程信息的患者也已导入（先建档）', !!yi);
ok(yi.diagnosis === '食管癌', '其已有信息保留', yi.diagnosis);
ok(yi.status === '在治', '状态为在治');
ok(computeSchedule(yi).length === 0, '因缺排程信息，暂无治疗日历');

group('11. 导入后缺排程信息的患者进「待办」提醒补充');
const todo = buildTodo();
const yiTodo = todo.filter(x => x.p.id === yi.id)[0];
console.log('  该患者待办:', yiTodo ? JSON.stringify(yiTodo.reasons) : '(无)');
ok(!!yiTodo, '★ 出现在待办中', !!yiTodo);
ok(yiTodo && yiTodo.reasons.indexOf('待排程') >= 0, '★ 提示「待排程」', yiTodo ? yiTodo.reasons : null);
ok(yiTodo && String(yiTodo.details.join()).indexOf('自动生成治疗日历') >= 0, '详情说明补充什么', yiTodo ? yiTodo.details : null);

group('12. 人工在复核界面补上姓名后即可正常导入');
state = normalize({ version: 2, updatedAt: '', patients: [] });
openReview(normalizeAiPatients({ patients: [{ diagnosis: '乳腺癌', totalDose: '50', fractions: '25', startDate: '2026-10-08', dosePerFraction: '2' }] }));
ok(aiDraft.patients[0].name === '', '初始无姓名');
confirmMsgs = [];
commitWith({ ai_0_name: '补填的患者' });
ok(confirmMsgs.length === 0, '★ 补上姓名后无需额外确认', confirmMsgs);
ok(state.patients.length === 1, '★ 成功导入', state.patients.length);
ok(state.patients[0].name === '补填的患者', '姓名已写入', state.patients[0].name);
ok(computeSchedule(state.patients[0]).length === 25, '★ 信息补全后已能自动排程', computeSchedule(state.patients[0]).length);

group('13. 取消确认则不导入');
state = normalize({ version: 2, updatedAt: '', patients: [] });
openReview(normalizeAiPatients({ patients: [{ name: '丙', diagnosis: '肺癌' }] }));
confirmAnswer = false;
commitWith({});
ok(state.patients.length === 0, '★ 取消后未导入', state.patients.length);
confirmAnswer = true;

group('14. 全部完整时提交无需确认');
state = normalize({ version: 2, updatedAt: '', patients: [] });
openReview(normalizeAiPatients({ patients: [
  { name: '完整甲', diagnosis: '肺癌', startDate: '2026-10-08', fractions: '30', totalDose: '60', dosePerFraction: '2' }
] }));
confirmMsgs = [];
commitWith({});
ok(confirmMsgs.length === 0, '★ 信息完整时直接导入，不弹确认', confirmMsgs);
ok(state.patients.length === 1, '导入成功', state.patients.length);

group('15. 边界与兼容');
ok(normalizeAiPatients(null).length === 0, 'null 安全');
ok(normalizeAiPatients({ patients: 'oops' }).length === 0, '结构异常安全');
ok(normalizeAiPatients([{ name: '数组形式' }]).length === 1, '顶层数组兼容');
ok(normalizeAiPatients({ name: '单对象' }).length === 1, '单对象兼容');
ok(aiMissingOf({}).blocking === true, '空对象 → 缺姓名');
ok(aiMissingOf({ name: 'x' }).blocking === false, '有姓名 → 不阻断');
/* 枚举映射与不完整共存 */
const mix = normalizeAiPatients({ patients: [{ diagnosis: '鼻咽癌', sex: '男性', technique: '调强适形放疗' }] });
ok(mix.length === 1, '缺姓名条目保留');
ok(mix[0].sex === '男', '枚举仍被正确映射', mix[0].sex);
ok(mix[0].technique === 'IMRT', '技术枚举映射正常', mix[0].technique);
ok(aiMissingOf(mix[0]).blocking === true, '仍标记为缺姓名');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
