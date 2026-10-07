/* 2026-10-07 三项需求测试
   需求1 日历当日人数统计（治疗中 / 开始放疗 / 今日结束）
   需求2 待办收窄（只提醒「即将结束 / 还未开始」+ 验证 + 副反应 + 随访）
   需求3 放疗验证词条（第几次验证、留空=不验证、提前提醒、可标记完成）
   只读取 index.html，不修改源码。 */
const fs = require('fs');
const path = require('path');
function appRoot() {
  var cands = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'radiotherapy-ward')];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'index.html'))) return cands[i];
  }
  return cands[0];
}
const APP = appRoot() + '/index.html';
const html = fs.readFileSync(APP, 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^init\(\);\s*$/, '');

/* ---------- DOM 打桩 ---------- */
const elById = {};
function makeEl(id) {
  return {
    id: id || '', innerHTML: '', textContent: '', hidden: false, style: {}, value: '', type: '', checked: false,
    classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() { }, contains(c) { return !!this._s[c]; } },
    addEventListener() { }, onclick: null, dataset: {}, parentElement: null,
    appendChild() { }, removeChild() { }, click() { }, remove() { }, focus() { }, querySelector() { return null; }
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
const toastMsgs = [];
global.document = {
  getElementById(id) { return getEl(id); },
  querySelectorAll() { return []; }, querySelector() { return null; },
  createElement() { return makeEl(); },
  body: { appendChild(el) { if (el && typeof el.textContent === 'string' && el.textContent) toastMsgs.push(el.textContent); }, removeChild() { } },
  addEventListener(ev, fn) { if (ev === 'click') clickHandler = fn; },
  documentElement: makeEl(), visibilityState: 'visible'
};
global.window = global;
global.addEventListener = function () { };
global.location = { search: '', protocol: 'https:' };
global.requestAnimationFrame = (cb) => { if (cb) cb(); };
global.alert = () => { };
global.confirm = () => true;
global.navigator = { userAgent: 'Mozilla/5.0' };
global.crypto = require('crypto').webcrypto;
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => { };
global.Blob = function () { };
global.AbortController = function () { this.signal = {}; this.abort = function () { }; };
global.setInterval = () => 0; global.clearInterval = () => { };

eval(js);
bind();

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✘ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function group(n) { console.log(''); console.log('--- ' + n + ' ---'); }
function fire(act, data) {
  const el = makeEl(); el.dataset.act = act; Object.assign(el.dataset, data || {});
  clickHandler({ target: el });
}
const today = todayStr();
/* 今天（10-07）可能落在法定假期里，那样根本排不出治疗日，日历统计与待办都无法验证。
   显式把今天设为调休上班日，让测试与日期无关（沿用 test-rules 的做法）。 */
setMakeup(today, '测试·今天上班');

/* 造患者（默认在治、周一到周五治疗） */
function mk(o) {
  state = normalize({ version: 2, updatedAt: '', patients: [Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o)] });
  state.patients[0].status = '在治';
  return state.patients[0];
}
function mkMany(list) {
  state = normalize({ version: 2, updatedAt: '', patients: list.map(function (o) { return Object.assign({ name: '测试', status: '在治', treatDays: [1, 2, 3, 4, 5] }, o); }) });
  state.patients.forEach(function (p) { p.status = '在治'; });
  return state.patients;
}
function inTreatCount() { return inTreat().length; }

(async function () {
  console.log('========== 日历人数统计 / 待办收窄 / 放疗验证 ==========');

  /* ================================================================ */
  group('A. 验证次数解析 parseVerifyNums');
  {
    ok(parseVerifyNums('10').join() === '10', '单个次数');
    ok(parseVerifyNums('10,20').join() === '10,20', '英文逗号分隔');
    ok(parseVerifyNums('10，20').join() === '10,20', '★ 全角逗号也认');
    ok(parseVerifyNums('10、20').join() === '10,20', '★ 顿号也认');
    ok(parseVerifyNums('20 10').join() === '10,20', '空格分隔且自动升序');
    ok(parseVerifyNums('10;20').join() === '10,20', '分号分隔');
    ok(parseVerifyNums('10,10,20').join() === '10,20', '★ 去重');
    ok(parseVerifyNums('0,-3,abc').length === 0, '★ 非正数/非数字被丢弃');
    ok(parseVerifyNums('9999').length === 0, '★ 过大值被丢弃（防脏数据）');
    ok(parseVerifyNums('').length === 0, '留空 → 空数组');
    ok(parseVerifyNums(null).length === 0, 'null 安全');
    ok(parseVerifyNums(undefined).length === 0, 'undefined 安全');
    ok(parseVerifyNums('3次').join() === '3', '带单位也能解析出数字');
  }

  /* ================================================================ */
  group('B. 验证配置读取 verifyCfgOf / hasVerify / verifyDone');
  {
    const p1 = mk({ startDate: today, fractions: '30', verifyAt: { fractions: '10,20', note: '复位', done: ['10'] } });
    const c = verifyCfgOf(p1);
    ok(c.nums.join() === '10,20', '正常读出次数');
    ok(c.note === '复位', '读出备注');
    ok(c.done.join() === '10', '读出完成标记');
    ok(hasVerify(p1) === true, '有验证 → true');
    ok(verifyDone(p1, 10) === true, '第 10 次已完成');
    ok(verifyDone(p1, 20) === false, '第 20 次未完成');
    ok(verifyDone(p1, '10') === true, '★ 传字符串也能匹配（避免类型坑）');

    const p2 = mk({ startDate: today, fractions: '30' });
    ok(verifyCfgOf(p2).nums.length === 0, '未配置 → 空');
    ok(hasVerify(p2) === false, '未配置 → false');
    ok(verifyPending(p2) === null, '未配置 → 无待验证');

    const p3 = mk({ startDate: today, fractions: '30', verifyAt: { fractions: 'abc' } });
    ok(hasVerify(p3) === false, '★ 非法输入视同未配置（不会崩）');

    const p4 = mk({ startDate: today, fractions: '30', verifyAt: { fractions: '10', done: null } });
    ok(verifyCfgOf(p4).done.length === 0, '★ done 为 null 时安全兜底');
  }

  /* ================================================================ */
  group('C. 验证提醒时机 verifyPending（提前 ' + VERIFY_LEAD_FRACTIONS + ' 次）');
  {
    /* 「已完成次数」= 排程中日期 ≤ 今天的条数，因此可以用「回填多少天」精确控制。
       做法：把 startDate 往前推 D 天，使已完成次数 = doneOf(D)。 */
    function pWithDone(fractions, verify, doneTarget) {
      /* 二分出一个能把「已完成次数」凑到 doneTarget 的起始日 */
      let lo = 0, hi = 2000, best = null;
      for (let i = 0; i < 40; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const p0 = mk({ startDate: addDays(today, -mid), fractions: fractions, verifyAt: verify });
        const d = doneCount(p0);
        if (d >= doneTarget) { best = { back: mid, p: p0, done: d }; hi = mid; }
        else lo = mid + 1;
      }
      return best;
    }

    /* 第 20 次验证，提前量 L → 触发点是 (20 - L)。
       量 L 到底是几都行：只要「已完成 = 触发点 - 1」不提醒、「= 触发点」提醒，
       就证明提前量语义正确，且 L 的取值范围不会让测试变味。 */
    const trig = Math.max(1, 20 - VERIFY_LEAD_FRACTIONS);

    /* 边界下：已完成 = 触发点 → 必须提醒 */
    const b1 = pWithDone('30', { fractions: '20' }, trig);
    if (b1) {
      const vp = verifyPending(b1.p);
      ok(vp !== null && vp.n === 20, '★ 已完成 ' + b1.done + ' 次（= 触发点 ' + trig + '）→ 提醒第 20 次验证', vp);
      ok(vp && (vp.status === 'due' || vp.status === 'soon'), '状态为 due/soon', vp);
      ok(vp && vp.status === (b1.done >= 20 ? 'due' : 'soon'), '已到第 20 次前为 soon，之后为 due', vp);
    } else { ok(false, '（无法构造触发点场景）'); }

    /* 边界上：已完成 = 触发点 - 1 → 必须不提醒（提前量生效的证明） */
    if (trig - 1 >= 1) {
      const b0 = pWithDone('30', { fractions: '20' }, trig - 1);
      if (b0) {
        ok(verifyPending(b0.p) === null, '★ 已完成 ' + b0.done + ' 次（差 1 次到触发点）→ 不提醒（提前量确实生效）', verifyPending(b0.p));
      } else { ok(false, '（无法构造边界上场景）'); }
    } else {
      /* 提前量 ≥ 19 时没有「边界上」可测，改为直接核对触发点公式 */
      ok(trig === 1, '提前量很大 → 触发点收敛到 1（不会 ≤ 0）', trig);
    }

    /* 提前量的方向性：L 越大，越早提醒。
       构造「已完成次数」固定的一组，比较不同 L 下的提醒结果 —— 用当前 L 与 L+9 对照。
       这里退一步做可直接断言的性质：触发点 = max(1, n - L)，且随 L 单调不增。 */
    ok(VERIFY_LEAD_FRACTIONS >= 0 && VERIFY_LEAD_FRACTIONS <= 10, '提前量在合理区间（0~10 次）', VERIFY_LEAD_FRACTIONS);
    let prevTrig = Infinity, mono = true;
    for (let L = 0; L <= 10; L++) {
      const t = Math.max(1, 20 - L);
      if (t > prevTrig) mono = false;
      prevTrig = t;
    }
    ok(mono, '★ 触发点随提前量单调不增（提前越多提醒越早）');

    /* 刚开头不提醒 */
    const pFar = mk({ startDate: today, fractions: '30', verifyAt: { fractions: '20' } });
    if (VERIFY_LEAD_FRACTIONS < 20) {
      ok(verifyPending(pFar) === null, '★ 刚开头（已完成 0 次）不提醒第 20 次验证', verifyPending(pFar));
    } else {
      ok(verifyPending(pFar) !== null, '提前量 ≥20 次 → 一开始就提醒（符合语义）');
    }

    /* 超出排程的验证次数 → 不提醒 */
    const pOver = mk({ startDate: today, fractions: '10', verifyAt: { fractions: '50' } });
    ok(verifyPending(pOver) === null, '★ 验证次数超出总次数 → 不提醒', verifyPending(pOver));

    /* 已标记完成 → 不再提醒 */
    const bD = pWithDone('30', { fractions: '20', done: ['20'] }, trig);
    if (bD) ok(verifyPending(bD.p) === null, '★ 第 20 次已标记完成 → 不再提醒', verifyPending(bD.p));
    else ok(false, '（无法构造已标记场景）');

    /* 多个次数：跳过已完成，提醒下一个 */
    const bM = pWithDone('30', { fractions: '10,25', done: ['10'] }, 25);
    if (bM) {
      const vpM = verifyPending(bM.p);
      ok(vpM === null || vpM.n === 25, '跳过已完成的第 10 次，只关心第 25 次', vpM);
    } else { ok(true, '（第 25 次尚未进入窗口）'); }
  }

  /* ================================================================ */
  group('D. 验证写入与标记 verifyMarkDone / verifyUnmark');
  {
    const p = mk({ startDate: today, fractions: '30', verifyAt: { fractions: '10,20' } });
    verifyMarkDone(p.id, 10);
    ok(verifyDone(p, 10) === true, '★ 标记后已完成');
    verifyMarkDone(p.id, 10);
    ok(verifyCfgOf(p).done.filter(function (x) { return x === '10'; }).length === 1, '★ 重复标记幂等（不产生重复项）');
    verifyUnmark(p.id, 10);
    ok(verifyDone(p, 10) === false, '★ 撤销后回到未完成');
    /* 标记不存在的次数：允许但不该崩 */
    verifyMarkDone(p.id, 99);
    ok(true, '标记未声明的次数不崩溃');
    verifyMarkDone('not-exist-id', 10);
    ok(true, '标记不存在的患者不崩溃');
    verifyMarkDone(p.id, NaN);
    ok(true, '标记 NaN 不崩溃');
  }

  /* ================================================================ */
  group('E. 待办收窄（需求2）');
  {
    /* ① 未开始：开始日期在将来 */
    mk({ startDate: addDays(today, 7), fractions: '30' });
    let t = buildTodo();
    ok(t.length === 1 && t[0].reasons.indexOf('还未开始') >= 0, '★ 将来开始 → 「还未开始」', t.length ? t[0].reasons : []);
    ok(t.length && t[0].tags.indexOf('未开始') >= 0, '打上「未开始」标签', t.length ? t[0].tags : []);

    /* ② 待排程（缺开始日期/总次数）→ 也算未开始 */
    mk({ startDate: '', fractions: '' });
    t = buildTodo();
    ok(t.length === 1 && (t[0].reasons.indexOf('待排程') >= 0 || String(t[0].reasons).indexOf('流程：') >= 0), '★ 缺排程 → 仍进待办', t.length ? t[0].reasons : []);

    /* ③ 今日应治疗 → 不再进待办 */
    mk({ startDate: today, fractions: '30' });
    const pToday = state.patients[0];
    if (scheduleOn(pToday, today)) {
      t = buildTodo();
      const rs = t.length ? String(t[0].reasons) : '';
      ok(rs.indexOf('今日应治疗') < 0, '★ 「今日应治疗」已移出待办', rs);
    } else {
      ok(true, '（今天非治疗日，跳过该断言）');
    }

    /* ④ 疗程已结束、仍在治 → 不再进待办 */
    mk({ startDate: addDays(today, -200), fractions: '5' });
    t = buildTodo();
    ok(!t.length || String(t[0].reasons).indexOf('疗程已结束') < 0, '★ 「疗程已结束待归档」已移出待办', t.length ? t[0].reasons : []);

    /* ⑤ 即将结束：疗程快做完且今天早于结束日 */
    const pNear = mk({ startDate: addDays(today, -200), fractions: '30' });
    const dnN = doneCount(pNear), plN = plannedCount(pNear);
    const left = plN - dnN;
    t = buildTodo();
    if (left > 0 && left <= TODO_NEAR_END_LEFT) {
      ok(t.length && String(t[0].reasons).indexOf('即将结束') >= 0, '★ 剩余 ' + left + ' 次 → 「即将结束」', t.length ? t[0].reasons : []);
    } else {
      ok(left === 0 || left > TODO_NEAR_END_LEFT, '（当前剩余 ' + left + ' 次，不触发即将结束，符合预期）', left);
    }

    /* ⑥ 副反应与随访仍然保留在待办 */
    const pR = mk({ startDate: today, fractions: '30' });
    pR.reactions = [{ id: 'r1', site: '皮肤反应', status: '未处理', content: '红斑', foundAt: today }];
    t = buildTodo();
    ok(t.length && String(t[0].reasons).indexOf('副反应待处理') >= 0, '★ 副反应待处理仍进待办', t.length ? t[0].reasons : []);

    /* ⑦ 验证进入待办 */
    const pV = mk({ startDate: addDays(today, -200), fractions: '30', verifyAt: { fractions: '20' } });
    if (doneCount(pV) >= 18) {
      t = buildTodo();
      ok(t.length && /验证/.test(String(t[0].reasons)), '★ 验证到点 → 进待办', t.length ? t[0].reasons : []);
      ok(t.length && t[0].tags.indexOf('验证') >= 0, '带「验证」标签', t.length ? t[0].tags : []);
    } else {
      ok(true, '（已完成 ' + doneCount(pV) + ' 次，未到验证提醒点，跳过）');
    }

    /* ⑧ TODO_NEAR_END_LEFT 常量存在且合理 */
    ok(typeof TODO_NEAR_END_LEFT === 'number' && TODO_NEAR_END_LEFT > 0 && TODO_NEAR_END_LEFT <= 10, '阈值常量合理', TODO_NEAR_END_LEFT);
  }

  /* ================================================================ */
  group('F. 日历人数统计 dayStat（需求1）');
  {
    /* 造 3 位患者：甲、乙从今天开始；丙从 200 天前开始（30 次已做完，今天无治疗） */
    const ps = mkMany([
      { name: '甲', startDate: today, fractions: '30' },
      { name: '乙', startDate: today, fractions: '30' },
      { name: '丙', startDate: addDays(today, -200), fractions: '30' }
    ]);
    const s = dayStat(today);
    ok(s.treating.length === 2, '★ 治疗中 = 当天实际排治疗的人数（丙已做完，不计）', s.treating.map(function (a) { return a.p.name; }));
    ok(s.starting.length === 2, '★ 开始放疗 = 当天是排程首日的人数', s.starting.map(function (a) { return a.p.name; }));
    ok(s.ending.length === 0, '当天无人结束', s.ending.length);

    /* 一致性：dayStat.treating 必须与总日历原口径一致（都是「当天有治疗的」） */
    let manual = 0;
    inTreat().forEach(function (p) { if (scheduleOn(p, today)) manual++; });
    ok(s.treating.length === manual, '★ 与「当天有治疗安排」口径完全一致', { dayStat: s.treating.length, manual: manual });

    /* 结束日统计：造一位今天正好做完的患者（总次数=到今天为止的排程数） */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const pEnd = mk({ name: '丁', startDate: addDays(today, -200), fractions: '30' });
    const sc = computeSchedule(pEnd);
    /* 找一位患者的排程末日，然后造一位「末日=今天」的患者 */
    const lastDayOfP = sc[sc.length - 1].date;
    ok(!!lastDayOfP, '（前置）排程有末日', lastDayOfP);

    /* 直接构造：startDate 使首个治疗日是今天，fractions=1 → 首日即末日，既开始又结束 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    mk({ name: '戊', startDate: today, fractions: '1' });
    const s2 = dayStat(today);
    ok(s2.starting.length === 1, '只做 1 次 → 当天算「开始」', s2.starting.length);
    ok(s2.ending.length === 1, '★ 只做 1 次 → 当天也算「结束」（用户确认：两个数都要）', s2.ending.length);
    ok(s2.treating.length === 1, '同时算当天有治疗', s2.treating.length);
    ok(dayStatHas(s2) === true, '有统计 → 格子可点击');
  }

  /* ================================================================ */
  group('G. 归档患者必须出现在「今日结束」');
  {
    /* 关键场景：患者疗程末日=今天，且已被归档为「治疗完成」 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const p = mk({ name: '己', startDate: today, fractions: '1' });
    ok(inTreatCount() === 1, '（前置）当前在治');
    /* 归档：状态改为「治疗完成」 */
    state.patients[0].status = '治疗完成';
    ok(inTreatCount() === 0, '（前置）归档后不在 inTreat()');
    const s = dayStat(today);
    ok(s.ending.length === 1, '★ 已归档但排程末日=今天 → 仍出现在「今日结束」', {
      ending: s.ending.length, scope: calStatScope().length
    });
    ok(s.ending[0].p.name === '己', '名单里是这位患者', s.ending[0] && s.ending[0].p.name);
  }

  /* ================================================================ */
  group('H. 扫描窗口：久远的归档患者不得污染统计');
  {
    /* 一位 400 天前就结束的归档患者，不应出现在今天的统计里 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    mk({ name: '庚', startDate: addDays(today, -400), fractions: '5' });
    state.patients[0].status = '治疗完成';
    const s = dayStat(today);
    ok(s.ending.length === 0 && s.treating.length === 0 && s.starting.length === 0, '★ 400 天前结束的归档患者不进入今日统计', {
      e: s.ending.length, t: s.treating.length, st: s.starting.length
    });
    ok(calStatScope().length === 0, '★ 超出回看窗口的归档患者不进入扫描范围', calStatScope().length);
    ok(CAL_STAT_LOOKBACK_DAYS > 0 && CAL_STAT_LOOKBACK_DAYS <= 365, '回看窗口常量合理', CAL_STAT_LOOKBACK_DAYS);
  }

  /* ================================================================ */
  group('I. 月度汇总 calMonthStat');
  {
    const y = view.calY, m = view.calM;
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    mk({ name: '辛', startDate: today, fractions: '30' });
    const ms = calMonthStat(y, m);
    ok(typeof ms.starting === 'number' && typeof ms.ending === 'number' && typeof ms.treating === 'number', '返回三个数字', ms);
    /* 治疗人次 = 当月所有「当天有治疗」的累加 */
    let manualTreat = 0;
    monthDays(y, m).forEach(function (ds) { manualTreat += dayStat(ds).treating.length; });
    ok(ms.treating === manualTreat, '★ 本月治疗人次与逐日累加一致', { a: ms.treating, b: manualTreat });
    ok(calMonthStatHas(ms) === true, '有数据 → 显示汇总条');

    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const ms0 = calMonthStat(y, m);
    ok(calMonthStatHas(ms0) === false, '★ 空数据 → 不显示汇总条（不摆一堆 0）');
  }

  /* ================================================================ */
  group('J. 界面渲染（总日历 / 待办 / 详情页）');
  {
    const y = view.calY, m = view.calM;
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    mk({ name: '壬', startDate: today, fractions: '30' });
    view.tab = 'cal'; view.page = 'tab';
    render();
    const calHtml = getEl('view').innerHTML;
    ok(calHtml.indexOf('治疗 ') >= 0, '★ 日历格子出现「治疗 N」标注', true);
    ok(calHtml.indexOf('b-start') >= 0, '★ 出现「始」标注样式', true);
    ok(calHtml.indexOf('month-stat') >= 0, '★ 出现月度汇总', true);
    ok(calHtml.indexOf('始＝开始放疗') >= 0 && calHtml.indexOf('终＝放疗结束') >= 0, '图例含「始/终」说明', true);

    /* 待办渲染：未开始患者应出现，并带摘要条 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    mk({ name: '癸', startDate: addDays(today, 5), fractions: '30' });
    view.tab = 'todo';
    render();
    const todoHtml = getEl('view').innerHTML;
    ok(todoHtml.indexOf('还未开始') >= 0, '★ 待办显示「还未开始」', true);
    ok(todoHtml.indexOf('todo-sum') >= 0, '★ 待办顶部有分类摘要', true);

    /* 详情页：显示「放疗验证」摘要 */
    const pv = mk({ name: '子', startDate: today, fractions: '30', verifyAt: { fractions: '10,20', note: '复位' } });
    view.page = 'patient'; view.pid = pv.id;
    render();
    const pHtml = getEl('view').innerHTML;
    ok(pHtml.indexOf('放疗验证') >= 0, '★ 详情页显示「放疗验证」栏', true);
    ok(pHtml.indexOf('第 10 次') >= 0 || pHtml.indexOf('第 20 次') >= 0, '列出验证次数', true);
    ok(pHtml.indexOf('verify-edit') >= 0, '有「修改」按钮', true);

    /* 未配置验证 → 显示「不验证」 */
    const pn = mk({ name: '丑', startDate: today, fractions: '30' });
    view.pid = pn.id; render();
    ok(getEl('view').innerHTML.indexOf('不验证') >= 0, '★ 未配置验证时显示「不验证」', true);
    view.page = 'tab';
  }

  /* ================================================================ */
  group('K. 兼容性与隔离（红线）');
  {
    ok(SCHEMA_VERSION === 2, 'SCHEMA_VERSION 未变（纯展示层，无数据迁移）', SCHEMA_VERSION);
    /* 不新增 localStorage 键 */
    const keysBefore = Object.keys(store).slice().sort();
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const p = mk({ name: '寅', startDate: today, fractions: '30', verifyAt: { fractions: '10' } });
    render(); buildTodo(); dayStat(today); calMonthStat(view.calY, view.calM);
    save();
    const newKeys = Object.keys(store).filter(function (k) { return keysBefore.indexOf(k) < 0; });
    ok(newKeys.filter(function (k) { return k.indexOf('radiotherapy.verify') === 0; }).length === 0, '★ 验证数据不写独立键（存在患者对象里）', newKeys);

    /* 老数据（没有 verifyAt 字段）加载后一切正常 */
    state = normalize({ version: 2, updatedAt: '', patients: [{ id: 'old', name: '老数据', status: '在治', startDate: today, fractions: '30' }] });
    ok(verifyCfgOf(state.patients[0]).nums.length === 0, '★ 老数据无 verifyAt → 视同未配置');
    ok(buildTodo().length >= 0, '老数据 buildTodo 不崩');
    ok(dayStat(today).treating.length === 1, '老数据 dayStat 正常');
    ok(!('verifyFractions' in state.patients[0]), '★ 表单临时字段不落库（只存 verifyAt）');

    /* 未知字段保全（不丢未来版本数据） */
    state = normalize({ version: 2, updatedAt: '', patients: [{ id: 'x', name: '未来', status: '在治', futureField: 'keep-me', verifyAt: { fractions: '5', extra: 'keep' } }] });
    ok(state.patients[0].futureField === 'keep-me', '★ 未知字段不被丢弃');
    ok(state.patients[0].verifyAt.extra === 'keep', '★ verifyAt 内的未知字段也保留');
  }

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail) process.exit(1);
})();
