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

function stubEl() {
  const e = {
    innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { add() { }, remove() { }, toggle() { } }, addEventListener() { }, onclick: null,
    dataset: {}, parentElement: null, appendChild() { }, click() { }
  };
  e.remove = function () { };
  return e;
}
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
global.document = {
  getElementById() { return stubEl(); }, querySelectorAll() { return []; },
  createElement() { return stubEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener() { }, documentElement: stubEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = () => { };
global.alert = () => { }; global.confirm = () => true;
global.navigator = {}; global.URL = { createObjectURL() { return 'x'; }, revokeObjectURL() { } };
global.Blob = function () { };

eval(js);

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* 辅助：造一个患者 */
function P(o) {
  return normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: 'X', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] }).patients[0];
}

console.log('========== 场景：两台设备各自录数据后合并 ==========');
console.log('');
console.log('--- 设备A：有患者 张三、李四（李四有 1 条副反应）---');
const A = normalize({
  version: 2, updatedAt: '', patients: [
    { id: 'pA1', name: '张三', mrn: 'M001', diagnosis: '鼻咽癌', totalDose: '70', fractions: '33', dosePerFraction: '2.12', startDate: '2026-10-08', status: '在治', doneDates: ['2026-10-08', '2026-10-09'] },
    {
      id: 'pA2', name: '李四', mrn: 'M002', diagnosis: '肺癌', totalDose: '60', fractions: '30', dosePerFraction: '2', startDate: '2026-10-08', status: '在治',
      reactions: [{ id: 'rA1', site: '皮肤反应', grade: '1级（轻）', foundAt: '2026-10-10T09:00', content: '皮肤红斑', status: '未处理', followups: [] }]
    }
  ]
});
console.log('  A 患者:', A.patients.map(p => p.name).join('、'));

console.log('');
console.log('--- 设备B：有患者 李四（原患者，多了一条追踪）、王五（新患者）---');
const B = normalize({
  version: 2, updatedAt: '', patients: [
    {
      id: 'pA2', name: '李四', mrn: 'M002', diagnosis: '肺癌', totalDose: '60', fractions: '30', dosePerFraction: '2', startDate: '2026-10-08', status: '在治',
      doneDates: ['2026-10-08', '2026-10-09', '2026-10-10'],
      reactions: [{ id: 'rA1', site: '皮肤反应', grade: '1级（轻）', foundAt: '2026-10-10T09:00', content: '皮肤红斑', status: '已处理待复查', plan: '外用保护剂', followups: [{ id: 'fB1', at: '2026-10-11T10:00', content: '复查好转' }] }]
    },
    { id: 'pB1', name: '王五', mrn: 'M003', diagnosis: '食管癌', totalDose: '50.4', fractions: '28', dosePerFraction: '1.8', startDate: '2026-10-12', status: '在治' }
  ]
});
console.log('  B 患者:', B.patients.map(p => p.name).join('、'));

console.log('');
console.log('--- 在设备A上执行「合并导入 B 的备份」---');
state = A;
const r = mergeImport(B);
state = r.state;

console.log('  结果:', '新增', r.added, '位 / 合并', r.merged, '位');
console.log('  合并后患者:', state.patients.map(p => p.name).join('、'));

ok(state.patients.length === 3, '患者总数为 3（张三 + 李四 + 王五）', state.patients.length);
ok(state.patients.map(p => p.name).join(',') === '张三,李四,王五', '顺序正确，无重复');
ok(r.added === 1, '新增 1 位（王五）', r.added);
ok(r.merged === 1, '合并 1 位（李四）', r.merged);

console.log('');
console.log('--- 验证合并不丢数据 ---');
const zs = state.patients.find(p => p.name === '张三');
const ls = state.patients.find(p => p.name === '李四');
const ww = state.patients.find(p => p.name === '王五');

ok(!!zs, '张三 保留');
ok(zs.doneDates.length === 2, '张三 的已完成记录保留（2 次）', zs.doneDates.length);
ok(!!ww, '王五 新增成功');
ok(ww.diagnosis === '食管癌', '王五 数据完整', ww.diagnosis);

ok(ls.doneDates.length === 3, '李四 的 doneDates 取并集（3 次）', ls.doneDates.length);
ok(ls.reactions.length === 1, '李四 的副反应未重复（1 条）', ls.reactions.length);
ok(ls.reactions[0].followups.length === 1, '李四 副反应的追踪记录已并入（1 条）', ls.reactions[0].followups.length);
ok(ls.reactions[0].plan === '外用保护剂', '李四 副反应的处理内容已补上', ls.reactions[0].plan);
ok(ls.reactions[0].status === '已处理待复查', '李四 副反应状态取更新的那份', ls.reactions[0].status);

console.log('');
console.log('--- 验证幂等性（重复合并同一备份不应产生重复）---');
const r2 = mergeImport(B);
state = r2.state;
ok(state.patients.length === 3, '重复合并后患者数仍为 3', state.patients.length);
ok(state.patients.find(p => p.name === '李四').reactions.length === 1, '李四 副反应仍为 1 条（幂等）');
ok(state.patients.find(p => p.name === '李四').reactions[0].followups.length === 1, '追踪记录未重复（幂等）');

console.log('');
console.log('--- 验证：不因导入而覆盖本机更完整的数据 ---');
const C = normalize({ version: 2, updatedAt: '', patients: [{ id: 'pC1', name: '赵六', mrn: 'M009', diagnosis: '宫颈癌', physician: '王医生', totalDose: '45', fractions: '25', dosePerFraction: '1.8', status: '治疗完成', completedAt: '2026-09-30' }] });
const D = normalize({ version: 2, updatedAt: '', patients: [{ id: 'pC1', name: '赵六', mrn: 'M009', diagnosis: '宫颈癌', status: '在治' }] });
state = C;
const r3 = mergeImport(D);
state = r3.state;
const zl = state.patients[0];
ok(zl.status === '治疗完成', '「治疗完成」不被备份中的「在治」覆盖', zl.status);
ok(zl.completedAt === '2026-09-30', '完成日期保留');
ok(zl.physician === '王医生', '本机已有的主管医生保留');
ok(zl.totalDose === '45', '本机已有的剂量保留');

console.log('');
console.log('--- 覆盖导入行为 ---');
state = A;
state = B;   /* 覆盖 */
ok(state.patients.length === 2, '覆盖后只剩备份中的 2 位', state.patients.length);
ok(!state.patients.find(p => p.name === '张三'), '覆盖后 张三 被移除（符合覆盖语义）');

console.log('');
console.log('--- 合并：不同 mrn 同名患者视为两人 ---');
const E = normalize({ version: 2, updatedAt: '', patients: [{ id: 'pE1', name: '孙七', mrn: 'M100', diagnosis: 'A', status: '在治' }] });
const F = normalize({ version: 2, updatedAt: '', patients: [{ id: 'pF1', name: '孙七', mrn: 'M200', diagnosis: 'B', status: '在治' }] });
state = E;
const r4 = mergeImport(F);
state = r4.state;
ok(state.patients.length === 2, '同名不同住院号 → 保留为两人', state.patients.length);

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
