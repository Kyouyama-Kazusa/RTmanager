/* 数据兼容性测试：验证旧版本数据能否无损迁移到当前格式 */
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

console.log('========== 一、v0.1 老数据 → 当前格式 无损迁移 ==========');
console.log('');

/* 完全按 v0.1（首版）的真实结构构造：status 含「暂停」「随访中」、
   用 sessions 记录治疗、用 plannedStartDate 表示开始日期、含中药 herbs 字段 */
const V1_DATA = {
  version: 1,
  updatedAt: '2026-09-20T10:00:00.000Z',
  patients: [
    {
      id: 'old1', mrn: 'M1001', name: '王建国', sex: '男', age: '58',
      diagnosis: '鼻咽癌 T3N2M0', purpose: '根治性', technique: 'IMRT', physician: '李医生',
      simDate: '2026-09-01', position: '头颈肩面罩', planStatus: '已通过',
      totalDose: '70', fractions: '33', dosePerFraction: '2.12',
      plannedStartDate: '2026-09-07',          /* 旧字段名 */
      status: '在治',
      sessions: [                              /* 旧的治疗记录方式 */
        { id: 's1', date: '2026-09-07', fraction: '1', dose: '2.12', machine: '1号机', note: '' },
        { id: 's2', date: '2026-09-08', fraction: '2', dose: '2.12', machine: '1号机', note: '' },
        { id: 's3', date: '2026-09-09', fraction: '3', dose: '2.12', machine: '1号机', note: '' }
      ],
      herbs: [{ id: 'h1', at: '2026-09-07T09:00', content: '桃红四物汤加减 7剂' }],  /* 旧字段 */
      pauses: [{ id: 'pa1', from: '2026-09-15', to: '2026-09-16', reason: '机器故障' }],
      reactions: [
        { id: 'r1', site: '口腔黏膜炎', grade: '2级（中）', foundAt: '2026-09-12T09:00', content: '口腔黏膜糜烂',
          status: '已处理待复查', nextCheckAt: '2026-09-20', plan: '漱口液', planAt: '2026-09-12T10:00',
          followups: [{ id: 'f1', at: '2026-09-18T10:00', content: '较前好转' }] },
        { id: 'r2', site: '皮肤反应', grade: '1级（轻）', foundAt: '2026-09-10T15:00', content: '皮肤红斑',
          status: '未处理', followups: [] }
      ],
      notes: [{ id: 'n1', at: '2026-09-11T08:00', content: '今日换药' }],
      doneDates: [], treatDays: [1, 2, 3, 4, 5], extras: [], followupPlans: []
    },
    {
      id: 'old2', mrn: 'M1002', name: '李秀兰', sex: '女', age: '63',
      diagnosis: '右肺腺癌', purpose: '根治性', technique: 'SBRT', physician: '',
      totalDose: '48', fractions: '4', dosePerFraction: '12',
      plannedStartDate: '2026-09-20',
      status: '暂停',                          /* ★ v0.1 独有状态 */
      sessions: [{ id: 's4', date: '2026-09-20', fraction: '1', dose: '12' }],
      pauses: [{ id: 'pa2', from: '2026-09-25', to: '2026-09-28', reason: '骨髓抑制' }],
      reactions: [], notes: [],
      treatDays: [1, 3, 5], extras: [], followupPlans: []
    },
    {
      id: 'old3', mrn: 'M1003', name: '陈美华', sex: '女', age: '52',
      diagnosis: '直肠癌术后', purpose: '术后辅助', technique: 'IMRT',
      totalDose: '50.4', fractions: '28', dosePerFraction: '1.8',
      plannedStartDate: '2026-07-01',
      status: '随访中',                        /* ★ v0.1 独有状态 */
      sessions: [], reactions: [], notes: [], pauses: [], extras: [],
      followupPlans: [{ id: 'fp1', dueDate: '2026-10-15', note: '复查盆腔MRI', done: false }]
    },
    {
      id: 'old4', mrn: 'M1004', name: '刘国强', sex: '男', age: '67',
      diagnosis: '前列腺癌', totalDose: '76', fractions: '38', dosePerFraction: '2',
      plannedStartDate: '2026-08-01',
      status: '失访',
      sessions: [], reactions: [], notes: [], pauses: [], extras: [], followupPlans: []
    }
  ]
};

store['radiotherapy.v1'] = JSON.stringify(V1_DATA);

/* --- 执行加载 --- */
load();

console.log('迁移后患者数:', state.patients.length);
ok(state.patients.length === 4, '4 位患者全部保留（无丢失）', state.patients.length);
ok(!loadError, '未触发读取错误保护');

const w = state.patients[0], l = state.patients[1], c = state.patients[2], g = state.patients[3];
ok(!!w && !!l && !!c && !!g, '四位患者都取到了');
ok([w, l, c, g].map(p => p.name).join(',') === '王建国,李秀兰,陈美华,刘国强', '姓名与顺序完全一致');

console.log('');
console.log('--- 1. 旧字段 plannedStartDate → startDate ---');
ok(w.startDate === '2026-09-07', '王建国 开始日期正确迁移', w.startDate);
ok(l.startDate === '2026-09-20', '李秀兰 开始日期正确迁移', l.startDate);
ok(g.startDate === '2026-08-01', '刘国强 开始日期正确迁移', g.startDate);

console.log('');
console.log('--- 2. 旧 sessions → doneDates（治疗进度不丢）---');
ok(w.doneDates.length === 3, '王建国 3 次治疗记录保留', w.doneDates.length);
ok(w.doneDates.indexOf('2026-09-07') >= 0 && w.doneDates.indexOf('2026-09-09') >= 0, '日期内容正确', w.doneDates);
ok(l.doneDates.length === 1, '李秀兰 1 次治疗记录保留', l.doneDates.length);
console.log('  王建国 治疗进度:', doneCount(w) + '/' + w.fractions, '· 累计剂量', accumulatedDose(w).toFixed(2), 'Gy');
/* 注意（2026-10-06 修复）：原先断言「累计剂量 > 0」。v0.5.0 起完成次数改为按日期推算，
   若运行当天早于疗程开始日（王建国为 2026-09-07），则一次都未完成、累计剂量为 0 ——
   这是正确行为，不是缺陷。改为断言与完成次数口径一致，任何日期运行都成立。 */
ok(accumulatedDose(w) === doneCount(w) * (parseFloat(w.dosePerFraction) || 0),
  '累计剂量与完成次数口径一致（按日期推算）', { 剂量: accumulatedDose(w), 完成次数: doneCount(w) });

console.log('');
console.log('--- 3. 状态迁移（关键：暂停/随访中 不能丢）---');
ok(w.status === '在治', '「在治」保持不变', w.status);
ok(l.status === '在治', '「暂停」→「在治」（暂停信息由 pauses 区间承载）', l.status);
ok(l.pauses.length === 1 && l.pauses[0].reason === '骨髓抑制', '李秀兰 的暂停原因完整保留', l.pauses);
ok(c.status === '治疗完成', '「随访中」→「治疗完成」（语义等价，随访计划保留）', c.status);
ok(c.followupPlans.length === 1 && c.followupPlans[0].note === '复查盆腔MRI', '陈美华 的随访计划保留');
ok(g.status === '失访', '「失访」保持不变', g.status);

console.log('');
console.log('--- 4. 副反应闭环完整保留 ---');
ok(w.reactions.length === 2, '王建国 2 条副反应保留', w.reactions.length);
const r1 = w.reactions.find(r => r.id === 'r1');
ok(r1.status === '已处理待复查', '副反应状态保留', r1.status);
ok(r1.grade === '2级（中）', 'CTCAE 分级保留', r1.grade);
ok(r1.plan === '漱口液' && r1.planAt === '2026-09-12T10:00', '处理内容与时间保留');
ok(r1.followups.length === 1 && r1.followups[0].content === '较前好转', '追踪记录保留');
ok(r1.nextCheckAt === '2026-09-20', '计划复查日期保留');

console.log('');
console.log('--- 5. 其他字段 ---');
ok(w.diagnosis === '鼻咽癌 T3N2M0', '诊断保留');
ok(w.physician === '李医生', '主管医生保留');
ok(w.totalDose === '70' && w.fractions === '33' && w.dosePerFraction === '2.12', '处方剂量三要素保留');
ok(w.notes.length === 1 && w.notes[0].content === '今日换药', '其他记录保留');
ok(l.treatDays.join(',') === '1,3,5', '个别患者的治疗日设置保留（SBRT 隔日）', l.treatDays);
ok(state.version === SCHEMA_VERSION, '数据版本已升级为 ' + SCHEMA_VERSION, state.version);

console.log('');
console.log('--- 6. 迁移前自动备份 ---');
const bks = backupKeys();
console.log('  备份 key:', bks.join(', ') || '(无)');
ok(bks.length === 1, '已自动生成 1 份更新前备份', bks.length);
const bkRaw = store[bks[0]];
ok(!!bkRaw, '备份内容存在');
ok(JSON.parse(bkRaw).version === 1, '备份保留的是原始 v1 格式（可回退）', JSON.parse(bkRaw).version);
ok(JSON.parse(bkRaw).patients.length === 4, '备份中 4 位患者完整');

console.log('');
console.log('--- 7. 迁移后再保存、再读取（幂等，不重复备份）---');
state.patients[0].notes.push({ id: 'n2', at: '2026-10-05T08:00', content: '新增记录' });
ok(save() === true, '保存成功');
load();
ok(state.patients.length === 4, '重新读取仍是 4 位患者', state.patients.length);
ok(state.patients[0].notes.length === 2, '新增的记录被持久化');
ok(backupKeys().length === 1, '已是新格式，不再重复备份', backupKeys().length);
ok(state.patients[0].doneDates.length === 3, '二次读取后治疗记录仍为 3 次');

console.log('');
console.log('--- 8. 多次更新场景：v1 → 当前 → 再加载 ---');
ok(state.patients[1].status === '在治' && state.patients[1].pauses.length === 1, '李秀兰 二次加载后状态与暂停均正确');

console.log('');
console.log('--- 9. 治疗疗程 courses：老患者补空数组，时间轴自动合成放疗事件 ---');
/* v0.13 新增 p.courses（手术/化疗/放疗）。老数据完全没有这个字段，
   迁移后必须是空数组（不能是 undefined），且时间轴要能从既有放疗排程
   自动派生事件 —— 老患者零迁移即可看到时间轴。 */
ok(Array.isArray(w.courses), '★ 老患者 courses 被补为空数组（不是 undefined）', typeof w.courses);
ok(w.courses.length === 0, '★ 老患者 courses 初始为空', w.courses.length);
const wTl = treatmentTimeline(w);
ok(wTl.length > 0, '★ 纯放疗老患者时间轴非空（由 computeSchedule 自动派生）', wTl.length);
ok(wTl.every(e => e.kind === 'radio'), '★ 派生事件全部为放疗', wTl.map(e => e.kind).join(','));
ok(JSON.stringify(wTl.map(e => e.date)) === JSON.stringify(computeSchedule(w).map(e => e.date)),
  '★ 派生事件日期与 computeSchedule 逐项一致（放疗排程唯一真相）');
/* 幂等：二次加载后 courses 仍为空数组，不被写成别的东西 */
load();
ok(Array.isArray(state.patients[0].courses) && state.patients[0].courses.length === 0,
  '★ 二次加载后 courses 仍为空数组（幂等）', state.patients[0].courses);

console.log('');
console.log('========== 二、数据损坏时的保护 ==========');
console.log('');
console.log('--- 场景：本机数据被破坏（无法解析）---');
store['radiotherapy.v1'] = '{这不是合法的JSON!!!';
load();
ok(loadError === true, '检测到读取异常，已置保护标记');
ok(rawSnapshot === '{这不是合法的JSON!!!', '原始内容被完整留存供抢救', rawSnapshot && rawSnapshot.slice(0, 12));
ok(state.patients.length === 0, '内存中状态为空（未误用损坏数据）');
const saved = save();
ok(saved === false, '★ 保护生效：读取异常时 save() 拒绝写入（不会覆盖原数据）');
ok(store['radiotherapy.v1'] === '{这不是合法的JSON!!!', '★ 本机原始数据未被覆盖', store['radiotherapy.v1']);

console.log('');
console.log('--- 场景：结构异常（patients 不是数组）---');
store['radiotherapy.v1'] = JSON.stringify({ version: 2, patients: 'oops' });
load();
ok(loadError === true, '结构异常也被识别为读取失败');
ok(save() === false, '同样拒绝写入');

console.log('');
console.log('--- 场景：空数据（首次使用）不算错误 ---');
delete store['radiotherapy.v1'];
load();
ok(loadError === false, '无数据时不报错（正常首次使用）');
ok(state.patients.length === 0, '患者列表为空');
ok(save() === true, '可以正常写入');

console.log('');
console.log('--- 场景：单个患者数据异常不影响其他患者 ---');
store['radiotherapy.v1'] = JSON.stringify({
  version: 2, patients: [null, { id: 'good', name: '正常患者', status: '在治' }, undefined, 'bad']
});
load();
ok(loadError === false, '个别条目异常不触发全局保护');
ok(state.patients.length === 1, '跳过异常条目，保留 1 位正常患者', state.patients.length);
ok(state.patients[0].name === '正常患者', '正常患者数据完好');

console.log('');
console.log('--- 场景：未来版本的数据（比当前格式新）---');
store['radiotherapy.v1'] = JSON.stringify({
  version: 99, patients: [{ id: 'f1', name: '未来患者', status: '在治', someNewField: 'x' }]
});
load();
ok(!loadError, '更高版本数据不报错');
ok(state.patients.length === 1, '患者保留');
ok(state.patients[0].name === '未来患者', '未知字段被安全忽略，不影响读取');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
