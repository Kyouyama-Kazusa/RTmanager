/* 性能与容量探针：在治患者规模增长时的渲染开销与存储占用 */
const fs = require('fs');
const path = require('path');
/* 应用目录探测：dev-tools 既可能在仓库内，也可能与仓库平级（旧结构）。两种都能跑。 */
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
  return { id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, onclick: null, dataset: {}, parentElement: null,
    appendChild() { }, removeChild() { }, click() { }, remove() { }, focus() { }, querySelector() { return null; } };
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
global.document = { getElementById: getEl, querySelectorAll: () => [], querySelector: () => null,
  createElement: () => makeEl(), body: { appendChild() { }, removeChild() { } }, addEventListener() { }, documentElement: makeEl() };
global.window = global; global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => cb && cb();
global.alert = () => { }; global.confirm = () => true; global.navigator = {};
global.URL.createObjectURL = () => 'x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { }; global.FileReader = function () { };
global.AbortController = function () { this.signal = {}; this.abort = () => { }; };
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
global.setInterval = () => 0; global.clearInterval = () => { };
eval(js); bind();

function build(n) {
  const P = [];
  for (let i = 0; i < n; i++) {
    P.push({
      id: 'p' + i, name: '患者' + i, mrn: 'RT' + i, sex: '男', age: '55', status: '在治',
      diagnosis: '鼻咽癌 T3N2M0 III期', purpose: '根治性', technique: 'IMRT', physician: '李医生',
      planStatus: '已通过', totalDose: '70', fractions: '33', dosePerFraction: '2.12',
      startDate: addDays(todayStr(), -20), treatDays: [1, 2, 3, 4, 5], pauses: [], extras: [],
      doneDates: [], reactions: [], followupPlans: [], notes: []
    });
  }
  return normalize({ version: 2, updatedAt: '', patients: P });
}

console.log('患者数 | 在治页(ms) | 总日历(ms) | 待办(ms) | 单次 JSON(KB)');
[20, 50, 100, 200].forEach(function (n) {
  state = build(n);
  view.page = 'tab';
  view.tab = 'ward'; const t1 = Date.now(); for (let k = 0; k < 5; k++) render(); const ward = (Date.now() - t1) / 5;
  view.tab = 'cal'; const t2 = Date.now(); for (let k = 0; k < 5; k++) render(); const cal = (Date.now() - t2) / 5;
  view.tab = 'todo'; const t3 = Date.now(); for (let k = 0; k < 5; k++) render(); const todo = (Date.now() - t3) / 5;
  const kb = (JSON.stringify(state).length / 1024).toFixed(1);
  console.log(String(n).padStart(5) + '  | ' + ward.toFixed(1).padStart(9) + '  | ' + cal.toFixed(1).padStart(9) + '  | ' + todo.toFixed(1).padStart(7) + '  | ' + kb.padStart(11));
});

// 每日快照 + 备份的累积占用
Object.keys(store).forEach(k => delete store[k]);
state = build(100);
const one = JSON.stringify(state).length;
console.log('\n100 位患者单份数据 ' + (one / 1024).toFixed(1) + ' KB');
console.log('每日快照最多 7 份 → ' + (one * 7 / 1024).toFixed(1) + ' KB');
console.log('更新前备份最多 3 份 → ' + (one * 3 / 1024).toFixed(1) + ' KB');
console.log('合计额外占用 ≈ ' + (one * 10 / 1024).toFixed(1) + ' KB（不含主数据）');

// computeSchedule 调用次数统计
let calls = 0;
const orig = computeSchedule;
state = build(100); view.tab = 'todo';
const t = Date.now(); render();
console.log('\n100 位患者单次 render(待办页) 耗时 ' + (Date.now() - t) + ' ms');
