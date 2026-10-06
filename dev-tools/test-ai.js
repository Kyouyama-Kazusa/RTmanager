/* AI 识别导入测试：数据清洗、API 调用、错误处理、复核导入全流程 */
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
    accept: '', files: null, multiple: false, attrs: {},
    classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() { }, contains() { return false; } },
    addEventListener() { }, onclick: null, onchange: null, dataset: {}, parentElement: null,
    appendChild() { }, removeChild() { }, click() { }, remove() { },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }
  };
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
/* 模拟表单输入元素：sheetValues() 依赖 querySelectorAll('#sheetBody [name]') */
let sheetInputs = [];
function buildSheetInputs(html, overrides) {
  const names = [...new Set([...String(html).matchAll(/name="([^"]+)"/g)].map(m => m[1]))];
  sheetInputs = names.map(n => {
    let v = '';
    const m = n.match(/^ai_(\d+)_(\w+)$/);
    if (m && aiDraft.patients[+m[1]]) v = aiDraft.patients[+m[1]][m[2]] || '';
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, n)) v = overrides[n];
    return { name: n, value: v, type: 'text', checked: false };
  });
  return names;
}
let clickHandler = null;
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
global.setInterval = () => 0; global.clearInterval = () => { };

/* 可编程的 fetch 桩 */
let fetchPlan = null;
global.fetch = function (url, opts) {
  const plan = fetchPlan || { status: 200, body: '{}' };
  if (plan.reject) return Promise.reject(plan.reject);
  const resp = {
    ok: plan.status >= 200 && plan.status < 300,
    status: plan.status,
    text: () => Promise.resolve(plan.body)
  };
  global.__lastReq = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };
  return Promise.resolve(resp);
};

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
function aiReply(obj) {
  return JSON.stringify({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });
}

console.log('========== AI 识别导入测试 ==========');

group('1. JSON 提取（模型输出容错）');
ok(JSON.stringify(extractJson('{"patients":[]}')) === '{"patients":[]}', '标准 JSON');
ok(extractJson('```json\n{"a":1}\n```').a === 1, 'strip markdown 代码块');
ok(extractJson('```\n{"a":2}\n```').a === 2, '无语言标记的代码块');
ok(extractJson('好的，结果如下：\n{"a":3}\n以上。').a === 3, '★ 前后带话术也能提取');
ok(extractJson('{"b":"含}括号"}').b === '含}括号', '嵌套括号');
ok(extractJson('完全不是JSON') === null, '无 JSON 返回 null');
ok(extractJson('') === null, '空串返回 null');
ok(extractJson(null) === null, 'null 输入安全');

group('2. 枚举值模糊映射（关键：避免 AI 说法被清空）');
ok(matchEnum('调强适形放疗', TECHNIQUES, 'technique') === 'IMRT', '「调强适形放疗」→ IMRT', matchEnum('调强适形放疗', TECHNIQUES, 'technique'));
ok(matchEnum('容积旋转调强', TECHNIQUES, 'technique') === 'VMAT', '★「容积旋转调强」→ VMAT（长键优先，不被「调强」抢）', matchEnum('容积旋转调强', TECHNIQUES, 'technique'));
ok(matchEnum('立体定向放疗', TECHNIQUES, 'technique') === 'SBRT', '「立体定向放疗」→ SBRT');
ok(matchEnum('三维适形', TECHNIQUES, 'technique') === '3D-CRT', '「三维适形」→ 3D-CRT');
ok(matchEnum('螺旋断层调强', TECHNIQUES, 'technique') === 'TOMO', '「螺旋断层调强」→ TOMO', matchEnum('螺旋断层调强', TECHNIQUES, 'technique'));
ok(matchEnum('术后辅助放疗', PURPOSES, 'purpose') === '术后辅助', '「术后辅助放疗」→ 术后辅助');
ok(matchEnum('根治', PURPOSES, 'purpose') === '根治性', '「根治」→ 根治性');
ok(matchEnum('姑息减症', PURPOSES, 'purpose') === '姑息性', '★「姑息减症」→ 姑息性', matchEnum('姑息减症', PURPOSES, 'purpose'));
ok(matchEnum('男性', SEXES, 'sex') === '男', '「男性」→ 男');
ok(matchEnum('M', SEXES, 'sex') === '男', '「M」→ 男');
ok(matchEnum('已批准', PLAN_STATUSES, 'planStatus') === '已通过', '「已批准」→ 已通过');
ok(matchEnum('IMRT', TECHNIQUES, 'technique') === 'IMRT', '精确值直接通过');
ok(matchEnum('某种没听过的技术', TECHNIQUES, 'technique') === '', '★ 无法判断 → 空串（宁可让用户选，不写错值）');
ok(matchEnum('', TECHNIQUES, 'technique') === '', '空值返回空串');
ok(matchEnum(null, TECHNIQUES, 'technique') === '', 'null 安全');

group('3. 患者数据清洗');
const raw1 = {
  patients: [
    { name: '张三', mrn: 'M001', sex: '男性', age: '58岁', diagnosis: '鼻咽癌 T3N2M0 III期', purpose: '根治', technique: '调强适形放疗', physician: '李医生', planStatus: '已批准', totalDose: '70Gy', fractions: '33次', dosePerFraction: '2.12Gy', simDate: '2026/09/01', startDate: '2026年9月7日', position: '头颈肩面罩' },
    { name: '', mrn: '', sex: '男' },
    { name: '李四', mrn: '', sex: '女性', age: 'abc', purpose: '不存在的目的' }
  ]
};
const p1 = normalizeAiPatients(raw1);
ok(p1.length === 3, '★ 缺姓名的条目被保留（改：不再丢弃，交人工补充）', p1.length);
ok(p1[1].name === '' && p1[1].sex === '男', '★ 缺姓名条目其余信息保留', { name: p1[1].name, sex: p1[1].sex });
const a = p1[0];
ok(a.sex === '男', '性别「男性」已映射', a.sex);
ok(a.age === '58', '年龄「58岁」→「58」', a.age);
ok(a.purpose === '根治性', '目的「根治」已映射', a.purpose);
ok(a.technique === 'IMRT', '技术「调强适形放疗」已映射', a.technique);
ok(a.planStatus === '已通过', '流程「已批准」已映射', a.planStatus);
ok(a.totalDose === '70', '剂量「70Gy」→「70」', a.totalDose);
ok(a.fractions === '33', '次数「33次」→「33」', a.fractions);
ok(a.dosePerFraction === '2.12', '单次「2.12Gy」→「2.12」', a.dosePerFraction);
ok(a.simDate === '2026-09-01', '★ 日期「2026/09/01」→「2026-09-01」', a.simDate);
ok(a.startDate === '2026-09-07', '★ 日期「2026年9月7日」→「2026-09-07」', a.startDate);
const b = p1[2];
ok(b.name === '李四', '第三条保留');
ok(b.age === '', '非法年龄清空', b.age);
ok(b.purpose === '', '不存在的枚举值清空', b.purpose);

group('4. 其他返回结构兼容');
ok(normalizeAiPatients([{ name: '王五' }]).length === 1, '顶层数组也能识别');
ok(normalizeAiPatients({ name: '赵六' }).length === 1, '单个对象也能识别');
ok(normalizeAiPatients(null).length === 0, 'null 安全');
ok(normalizeAiPatients({ patients: 'oops' }).length === 0, '结构异常返回空数组');
ok(normalizeAiPatients({ patients: [null, 'str', 1] }).length === 0, '跳过非对象条目');

group('5. 连接测试');
fetchPlan = { status: 200, body: aiReply('正常') };
let testDone = false;
(async function () {
  await new Promise(r => setTimeout(r, 0));
})();

group('6. API 调用与请求构造');
function withFetch(plan, fn) {
  fetchPlan = plan;
  return fn();
}
/* 用 Promise 链同步化断言 */
(async function () {
  await withFetch({ status: 200, body: aiReply({ patients: [{ name: '真机测试' }] }) }, async () => {
    const cfg = { baseUrl: 'https://api.test/chat/completions', apiKey: 'sk-test', model: 'm1', prompt: '' };
    const out = await aiChat(cfg, '文字内容', { model: 'm1' });
    const req = global.__lastReq;
    ok(req.url === 'https://api.test/chat/completions', '请求发往配置的地址', req.url);
    ok(req.opts.headers['Authorization'] === 'Bearer sk-test', '★ 带上 Bearer 鉴权头');
    ok(req.opts.method === 'POST', '使用 POST');
    ok(req.body.model === 'm1', '请求里带上模型名');
    ok(req.body.temperature === 0.1, '低温度保证输出稳定', req.body.temperature);
    ok(req.body.messages.length === 2, 'system + user 两条消息');
    ok(req.body.messages[0].role === 'system', '第一条是 system 提示词');
    ok(req.body.messages[0].content.indexOf('只输出 JSON') >= 0, '提示词包含 JSON 约束');
    ok(req.body.messages[0].content.indexOf('根治性') >= 0, '★ 提示词包含枚举值约束');
    ok(typeof req.body.messages[1].content === 'string', '纯文字时 content 为字符串');
    ok(out === JSON.stringify({ patients: [{ name: '真机测试' }] }), '返回模型内容');
  });

  group('7. 多模态（图片）请求构造');
  await withFetch({ status: 200, body: aiReply({ patients: [] }) }, async () => {
    const cfg = { baseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk', model: 'text-m', visionModel: 'vision-m', prompt: '' };
    const content = [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }];
    await aiChat(cfg, content, { model: 'vision-m' });
    const req = global.__lastReq;
    ok(req.body.model === 'vision-m', '★ 有图时用图片模型');
    ok(Array.isArray(req.body.messages[1].content), '★ 有图时 content 为内容块数组');
    ok(req.body.messages[1].content[0].type === 'text', '第一块是文字');
    ok(req.body.messages[1].content[1].type === 'image_url', '第二块是图片');
    ok(req.body.messages[1].content[1].image_url.url.indexOf('data:image/') === 0, '图片以 base64 dataURL 传入');
  });

  group('8. 错误处理');
  await withFetch({ status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }) }, async () => {
    let err = null;
    try { await aiChat({ baseUrl: 'https://x', apiKey: 'bad', model: 'm' }, 'hi'); } catch (e) { err = e; }
    ok(!!err, '401 抛错');
    ok(err && err.message.indexOf('401') >= 0, '错误信息含状态码', err && err.message);
    ok(err && err.message.indexOf('Invalid API key') >= 0, '★ 透传服务商的错误说明', err && err.message);
  });

  await withFetch({ status: 200, body: '这不是JSON' }, async () => {
    let err = null;
    try { await aiChat({ baseUrl: 'https://x', model: 'm' }, 'hi'); } catch (e) { err = e; }
    ok(err && err.message.indexOf('不是合法 JSON') >= 0, '响应非 JSON 时报错清晰', err && err.message);
  });

  await withFetch({ status: 200, body: '{"foo":1}' }, async () => {
    let err = null;
    try { await aiChat({ baseUrl: 'https://x', model: 'm' }, 'hi'); } catch (e) { err = e; }
    ok(err && err.message.indexOf('返回结构异常') >= 0, '缺 choices 时报错清晰', err && err.message);
  });

  await withFetch({ reject: new TypeError('Failed to fetch') }, async () => {
    let err = null;
    try { await aiChat({ baseUrl: 'https://x', model: 'm' }, 'hi'); } catch (e) { err = e; }
    ok(err && err.message.indexOf('网络请求失败') >= 0, '★ 网络/CORS 失败给出可操作提示', err && err.message);
    ok(err && err.message.indexOf('CORS') >= 0, '提示里点名 CORS 可能性');
  });

  group('9. 配置读写与就绪判断');
  ok(aiReady() === false, '初始未配置');
  ok(aiConfig().provider === 'zhipu', '默认服务商为智谱');
  setAiConfig({ provider: 'deepseek', baseUrl: 'https://a', apiKey: 'k', model: 'm', visionModel: '', prompt: '' });
  ok(aiReady() === true, '填了地址与模型后视为已配置');
  ok(aiConfig().apiKey === 'k', '配置已持久化');
  ok(store['radiotherapy.ai'] !== undefined, '配置存在本机 localStorage');
  ok(store['radiotherapy.ai'].indexOf('radiotherapy.v1') < 0, '★ AI 配置与患者数据分开存储');
  setAiConfig({ provider: 'x', baseUrl: '', apiKey: '', model: '', visionModel: '', prompt: '' });
  ok(aiReady() === false, '清空后回到未配置');

  group('10. 完整流程：识别 → 复核 → 导入');
  state = normalize({ version: 2, updatedAt: '', patients: [] });
  setAiConfig({ provider: 'zhipu', baseUrl: 'https://api.test/v1/chat', apiKey: 'sk', model: 'm', visionModel: 'vm', prompt: '' });

  /* 未配置时点 AI 导入 → 引导去设置 */
  setAiConfig({ provider: 'zhipu', baseUrl: '', apiKey: '', model: '', visionModel: '', prompt: '' });
  fire('ai-import');
  ok(getEl('sheetTitle').textContent.indexOf('尚未配置') >= 0 || getEl('sheetBody').innerHTML.indexOf('需要先填写') >= 0, '未配置时给出引导');
  ok(getEl('sheetFootInner').innerHTML.indexOf('ai-open-config') >= 0, '引导含「去设置」按钮');

  /* 配置好后打开导入界面 */
  setAiConfig({ provider: 'zhipu', baseUrl: 'https://api.test/v1/chat', apiKey: 'sk', model: 'm', visionModel: 'vm', prompt: '' });
  fire('ai-import');
  const impBody = getEl('sheetBody').innerHTML;
  ok(impBody.indexOf('aiText') >= 0, '有文字输入区');
  ok(impBody.indexOf('ai-pick') >= 0, '有选择图片按钮');
  ok(impBody.indexOf('ai-pick-camera') >= 0, '有拍照按钮');

  /* 模拟：识别返回两位患者 */
  fetchPlan = { status: 200, body: aiReply({ patients: [
    { name: '识别甲', mrn: 'A1', sex: '男性', diagnosis: '肺癌', purpose: '根治', technique: '调强', totalDose: '60Gy', fractions: '30', dosePerFraction: '2', startDate: '2026/10/08' },
    { name: '识别乙', mrn: 'A2', sex: '女', diagnosis: '食管癌', purpose: '术后辅助', technique: 'VMAT', totalDose: '50.4', fractions: '28', dosePerFraction: '1.8', startDate: '2026-10-08' }
  ] }) };
  aiDraft = { images: [], patients: [] };
  /* onSave 返回 false 保持弹层打开，异步完成后自动打开复核 */
  const impSheet = sheetCtx;
  impSheet.onSave({ aiText: '两位患者的病历文本…' });

  await new Promise(r => setTimeout(r, 30));

  ok(aiDraft.patients.length === 2, '★ 识别出 2 位患者', aiDraft.patients.length);
  ok(getEl('sheetBody').innerHTML.indexOf('复核') >= 0 || getEl('sheetBody').innerHTML.indexOf('第 1 位') >= 0, '★ 自动进入复核界面');
  const revBody = getEl('sheetBody').innerHTML;
  ok(revBody.indexOf('请逐项核对') >= 0, '★ 复核界面有核对提示');
  ok(revBody.indexOf('ai_0_name') >= 0 && revBody.indexOf('ai_1_name') >= 0, '两位患者字段都在');
  ok(revBody.indexOf('识别甲') >= 0, '识别结果已填入');
  ok(getEl('sheetFootInner').innerHTML.indexOf('确认导入 2 位') >= 0, '底部显示导入数量', getEl('sheetFootInner').innerHTML.slice(0, 80));

  /* 模拟人工复核：改一个字段、清空另一个的姓名 */
  buildSheetInputs(getEl('sheetBody').innerHTML, { ai_0_name: '改正后甲', ai_1_name: '' });
  fire('ai-commit');

  ok(state.patients.length === 1, '★ 只导入有姓名的（2 条中 1 条姓名为空被跳过）', state.patients.length);
  ok(state.patients[0].name === '改正后甲', '★ 导入的是人工修改后的值', state.patients[0].name);
  ok(state.patients[0].technique === 'IMRT', '映射后的技术随导入保留', state.patients[0].technique);
  ok(state.patients[0].startDate === '2026-10-08', '★ 归一化后的日期随导入保留', state.patients[0].startDate);
  ok(computeSchedule(state.patients[0]).length === 30, '★ 导入后自动排程生效（30 次）', computeSchedule(state.patients[0]).length);
  ok(state.patients[0].status === '在治', '默认状态为在治');
  ok(store['radiotherapy.v1'] !== undefined, '★ 导入结果已写入本机存储');

  group('11. 复核界面移除单条');
  aiDraft = { images: [], patients: normalizeAiPatients({ patients: [{ name: '甲' }, { name: '乙' }] }) };
  openAiReview();
  ok(aiDraft.patients.length === 2, '初始 2 条');
  fire('ai-drop', { i: '0' });
  ok(aiDraft.patients.length === 1, '★ 移除一条生效', aiDraft.patients.length);
  ok(getEl('sheetBody').innerHTML.indexOf('甲') < 0, '被移除的条目已从界面消失');
  confirmAnswer = true;
  fire('ai-drop', { i: '0' });
  ok(aiDraft.patients.length === 0, '移除全部后清空');

  group('12. 安全与边界');
  ok(AI_PROVIDERS.length === 7, '预设 7 个服务商', AI_PROVIDERS.length);
  ok(AI_PROVIDERS.every(p => p.key && p.name), '预设项字段完整');
  const ollama = AI_PROVIDERS.find(p => p.key === 'ollama');
  ok(ollama.url.indexOf('localhost') >= 0, '★ 提供本地模型选项（数据不出本机）');
  const zhipu = AI_PROVIDERS.find(p => p.key === 'zhipu');
  ok(!!zhipu.vision, '智谱预设含图片模型');
  const ds = AI_PROVIDERS.find(p => p.key === 'deepseek');
  ok(ds.vision === '', 'DeepSeek 标记为不支持图片');
  ok(defaultAiPrompt().indexOf(String(new Date().getFullYear())) >= 0, '提示词含当前年份（用于推断无年份日期）');
  ok(AI_FIELDS.length === 15, '覆盖 15 个患者字段', AI_FIELDS.length);

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
