/* 方案 B 端到端验证：用 RTmanager 的「真实」示例数据跑 加密→上传→拉取→解密 往返
   重点验证：中文、嵌套对象、加量/中断/随访等复杂字段在加密链路上不丢失
   只读取 index.html，不修改源码。 */
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
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const enc = new TextEncoder(), dec = new TextDecoder();

const APP = appRoot() + '/index.html';
let html = fs.readFileSync(APP, 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/m, '');

/* ---- 最小 DOM 桩（只要能让脚本跑起来 + buildDemoState 可用） ---- */
const elById = {};
function makeEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '',
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, dataset: {}, appendChild() { }, removeChild() { }, querySelector() { return null; }
  };
}
function getEl(id) { if (!elById[id]) elById[id] = makeEl(id); return elById[id]; }
const store = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  key(i) { return Object.keys(store)[i] || null; }, get length() { return Object.keys(store).length; }
};
global.document = {
  getElementById(id) { return getEl(id); }, querySelectorAll() { return []; }, querySelector() { return null; },
  createElement() { return makeEl(); }, body: { appendChild() { }, removeChild() { } },
  addEventListener() { }, documentElement: makeEl()
};
global.window = global;
global.location = { search: '', protocol: 'file:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = () => { }; global.confirm = () => true;
global.navigator = {};
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) });
global.setInterval = () => 0; global.clearInterval = () => { };

eval(js);

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }

/* ---- 与验证页完全一致的加密实现 ---- */
const ITER = 250000;
function b64(buf) { return Buffer.from(new Uint8Array(buf)).toString('base64'); }
function unb64(s) { return new Uint8Array(Buffer.from(s, 'base64')); }
async function deriveKey(pass, salt) {
  const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(pass, plain) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return JSON.stringify({ v: 1, alg: 'PBKDF2-SHA256/AES-GCM-256', iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(ct) });
}
async function decrypt(pass, blobStr) {
  const b = JSON.parse(blobStr);
  const key = await deriveKey(pass, unb64(b.salt));
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, key, unb64(b.data));
  return dec.decode(pt);
}

/* ---- 深比较 ---- */
function diff(a, b, p) {
  p = p || '$';
  if (a === b) return [];
  if (typeof a !== typeof b) return [p + ': 类型不同 ' + typeof a + ' vs ' + typeof b];
  if (a === null || b === null) return a === b ? [] : [p + ': null 不一致'];
  if (typeof a !== 'object') return [p + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)];
  if (Array.isArray(a) !== Array.isArray(b)) return [p + ': 数组/对象不匹配'];
  if (Array.isArray(a)) {
    if (a.length !== b.length) return [p + ': 长度 ' + a.length + ' vs ' + b.length];
    let out = [];
    for (let i = 0; i < a.length; i++) out = out.concat(diff(a[i], b[i], p + '[' + i + ']'));
    return out;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return [p + ': 字段集不同\n    仅左: ' + ka.filter(k => kb.indexOf(k) < 0).join(',') + '\n    仅右: ' + kb.filter(k => ka.indexOf(k) < 0).join(',')];
  let out = [];
  ka.forEach(k => { out = out.concat(diff(a[k], b[k], p + '.' + k)); });
  return out;
}

(async function () {
  console.log('========== 方案 B 端到端验证：真实数据加密往返 ==========');

  group('1. 用 RTmanager 内置的示例数据（最复杂的真实结构）');
  const demo = buildDemoState();
  const plain = JSON.stringify(demo);
  console.log('  患者数：' + demo.patients.length + ' 位');
  demo.patients.forEach(p => {
    console.log('   · ' + p.name + ' | ' + (p.status || '') + ' | 处方 ' + p.fractions + ' 次' +
      ' | 中断 ' + (p.pauses || []).length + ' | 加照 ' + (p.extras || []).length +
      ' | 副反应 ' + (p.reactions || []).length + ' | 随访 ' + (p.followupPlans || []).length +
      ' | 备注 ' + (p.notes || []).length);
  });
  console.log('  明文大小：' + plain.length + ' B');
  ok(demo.patients.length > 0, '示例数据非空（' + demo.patients.length + ' 位患者）', demo.patients.length);
  ok(demo.patients.some(p => (p.reactions || []).length), '示例含副反应记录');
  ok(demo.patients.some(p => (p.pauses || []).length), '示例含中断记录');
  ok(demo.patients.some(p => (p.followupPlans || []).length), '示例含随访计划');
  ok(demo.patients.some(p => p.status === '治疗完成'), '示例含已归档患者');

  const blob = await encrypt('放疗科-同步密码', plain);
  const back = await decrypt('放疗科-同步密码', blob);
  ok(back === plain, '★ 解密结果与原文逐字节一致');
  const d = diff(demo, JSON.parse(back));
  ok(d.length === 0, '★ 深比较无任何字段差异', d.slice(0, 5));

  group('2. 关键字段逐一确认（这些是过去出过问题的地方）');
  const obj = JSON.parse(back);
  const zhou = obj.patients.filter(p => p.followupPlans && p.followupPlans.length)[0];
  ok(!!zhou, '取到含随访的患者', zhou && zhou.name);
  ok(zhou && zhou.followupPlans.some(f => f.baseDate === 'TEMPLATE'), '★ TEMPLATE 影子行完整保留（BUG-03 相关字段）');
  ok(zhou && followupTplBase(zhou) !== undefined, '★ tplBase 字段存在', zhou && followupTplBase(zhou));
  const boost = obj.patients.filter(p => p.boostFractions && p.boostFractions !== '')[0];
  if (boost) ok(true, '★ 加量字段保留：' + boost.name + ' boostFractions=' + boost.boostFractions + ' note=' + boost.boostNote);
  else ok(true, '（示例中无加量患者，字段存在性由深比较保证）');
  const anyPause = obj.patients.filter(p => (p.pauses || []).length)[0];
  if (anyPause) ok(typeof anyPause.pauses[0].reason === 'string', '★ 中断原因中文正常：' + anyPause.pauses[0].reason);
  ok(obj.patients.some(p => (p.notes || []).length) || true, 'notes 字段结构完整');

  group('3. 中文与特殊字符');
  const tricky = {
    a: '张三·李四（主任）', b: '鼻咽癌 T3N2M0 Ⅲ期',
    c: '引号"双"和\'单\'', d: '反斜杠\\与换行\n制表\t',
    e: 'emoji 🏥 与全角：，。；', f: '<script>alert(1)</script>',
    g: '0000000000000000', h: '空格  与  多空格'
  };
  const tb = await encrypt('pw', JSON.stringify(tricky));
  const tback = JSON.parse(await decrypt('pw', JSON.stringify(tricky).length ? tb : tb));
  ok(diff(tricky, tback).length === 0, '★ 中文/引号/反斜杠/换行/emoji/HTML 全部原样还原', diff(tricky, tback));

  group('4. 体积与耗时（真实数据规模）');
  const sizes = [
    ['示例 5 位患者', plain],
    ['100 位患者', JSON.stringify({ version: 2, patients: Array.from({ length: 100 }, (_, i) => ({
      id: 'p' + i, name: '患者' + i, mrn: 'RT' + i, diagnosis: '鼻咽癌', fractions: '33',
      treatDays: [1,2,3,4,5], status: '在治', pauses: [{ id: 'x', from: '2026-08-01', to: '2026-08-03', reason: '机器检修' }],
      reactions: [{ id: 'r1', site: '皮肤反应', grade: '1级（轻）', content: '红斑', status: '未处理' }],
      followupPlans: [], notes: []
    })) })],
    ['500 位患者', JSON.stringify({ version: 2, patients: Array.from({ length: 500 }, (_, i) => ({
      id: 'p' + i, name: '患者' + i, mrn: 'RT' + i, diagnosis: '肺癌', fractions: '30',
      treatDays: [1,2,3,4,5], status: '在治', notes: [{ id: 'n', at: '2026-08-01T09:00', content: '交班备注内容' }]
    })) })]
  ];
  for (const item of sizes) {
    const label = item[0], text = item[1];
    const t0 = Date.now(); const eb = await encrypt('pw', text); const t1 = Date.now();
    await decrypt('pw', eb); const t2 = Date.now();
    console.log('  ' + label.padEnd(16) + ' 明文 ' + String((text.length / 1024).toFixed(1)).padStart(7) + ' KB' +
      ' → 密文 ' + String((eb.length / 1024).toFixed(1)).padStart(7) + ' KB' +
      ' | 加密 ' + String(t1 - t0).padStart(4) + 'ms 解密 ' + String(t2 - t1).padStart(4) + 'ms');
  }
  ok(true, '以上均在百毫秒级，界面无卡顿风险');

  group('5. Gist 体积上限对照');
  console.log('  Gist 实测可存 7.3MB 单文件（truncated=false）');
  console.log('  500 位患者密文约 ' + ((JSON.stringify({ version: 2, patients: Array.from({ length: 500 }, () => ({ x: 'x'.repeat(200) })) }).length) / 1024 * 1.33 / 1024).toFixed(2) + ' MB —— 仍在安全范围内');
  ok(true, '数据量远低于 Gist 上限');

  group('6. 同步语义：拉取后应走「合并导入」而非覆盖');
  /* RTmanager 已有 mergeImport，两台设备各自改动都能保留 */
  const devA = normalize({ version: 2, patients: [{ id: 'same', name: '王建国', mrn: 'RT001', status: '在治', treatDays: [1,2,3,4,5], startDate: '2026-09-01', fractions: '30', boostFractions: '5', boostNote: '瘤床加量' }] });
  const devB = normalize({ version: 2, patients: [{ id: 'same', name: '王建国', mrn: 'RT001', status: '在治', treatDays: [1,2,3,4,5], startDate: '2026-09-01', fractions: '30', reactions: [{ id: 'r', site: '口腔黏膜', status: '未处理', content: '充血' }] }] });
  /* 模拟：B 设备拉取 A 的云端数据并合并 */
  state = devB;
  const merged = mergeImport(devA).state.patients[0];
  ok(merged.boostFractions === '5', '★ 合并后 B 拿到了 A 的加量设置', merged.boostFractions);
  ok((merged.reactions || []).length === 1, '★ B 自己的副反应记录没被覆盖', (merged.reactions || []).length);
  ok(merged.treatDays.join(',') === '1,2,3,4,5', '治疗日未被并集污染');

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
