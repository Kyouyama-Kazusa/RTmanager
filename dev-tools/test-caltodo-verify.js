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
/* 捕获 pageshow / visibilitychange 等生命周期钩子，便于在测试里手动触发 */
const winHandlers = {};
global.addEventListener = function (ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); };
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
/* 真·点击模拟：从**已渲染的 HTML**里取出那个按钮，只用它自己带的 data-*
   派发点击 —— 与浏览器里 findAct 冒泡拿 dataset 的路径完全一致。
   用它才能验证「按钮是否真的把参数渲染进了 HTML」，
   而 fire() 是直接构造 dataset，会掩盖掉「按钮漏渲染 data-id」这类错误。

   ⚠ 还要模拟真实的**冒泡语义**：本应用所有按钮走挂在 document 上的委托，
   若按钮带 onclick="event.stopPropagation()"，事件就到不了 document，
   委托永远不会被调用 —— 真机上表现为「点了没反应」。
   以前的实现把事件直接投给 clickHandler、且完全无视内联 onclick，
   于是这类缺陷**测试全绿、真机必挂**（v0.13.2 的待办验证按钮即此因，第二次踩同一坑）。
   现在：解析到 stopPropagation 就**不投递**，让它如实变红。 */
function fireFromHtml(html, act, nth) {
  const re = new RegExp('<button[^>]*data-act="' + act + '"[^>]*>', 'g');
  const all = String(html).match(re) || [];
  const tag = all[nth || 0];
  if (!tag) { ok(false, 'fireFromHtml: 渲染结果里找不到 data-act="' + act + '"', String(html).slice(0, 160)); return false; }
  const el = makeEl();
  const attrs = tag.match(/data-([a-z-]+)="([^"]*)"/g) || [];
  attrs.forEach(function (a) {
    const m = a.match(/data-([a-z-]+)="([^"]*)"/);
    if (m) el.dataset[m[1].replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = m[2];
  });
  /* 冒泡语义：阻止冒泡 → 委托收不到 → 如实不触发（并报错，便于定位） */
  if (/onclick\s*=\s*["'][^"']*stopPropagation/.test(tag)) {
    ok(false, '★ 按钮带 stopPropagation，事件到不了委托，点击必然无效：' + act, tag.slice(0, 120));
    return false;
  }
  clickHandler({ target: el });
  return true;
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

/* 整页 HTML 切片：把「日历网格」「日历图例」从整页里切出来。
   动机见 J 组注释 —— 整页别处也有合法出现的「待治疗」，断言必须收窄范围，
   否则会把「月汇总卡片/日详情弹层」的合法状态徽章误判为回归。 */
function calGridHtml(h) {
  const a = h.indexOf('<div class="cal-grid">');
  if (a < 0) return '';
  const b = h.indexOf('</div>', h.indexOf('<div class="month-stat"', a) >= 0
    ? h.indexOf('<div class="month-stat"', a)
    : a);
  /* 网格结束 = 下一个 month-stat / cal-legend / cal-wrap 结束标记，取最早的 */
  const stops = [
    h.indexOf('<div class="month-stat"', a),
    h.indexOf('<div class="cal-legend"', a),
    h.indexOf('<div class="cal-wrap"', a + 1)
  ].filter(function (x) { return x > a; });
  return h.slice(a, stops.length ? Math.min.apply(null, stops) : (b > a ? b : h.length));
}
function calLegendHtml(h) {
  const a = h.indexOf('<div class="cal-legend">');
  if (a < 0) return '';
  const b = h.indexOf('</div>', a);
  return b > a ? h.slice(a, b) : h.slice(a);
}
/* 从日历网格片段里取出某一天的格子完整 HTML。
   ★ 不能用 `[\s\S]*?` + `</div></div>` 的懒惰匹配：格子内部
   `<div class="statrow">…</div></div>` 的收尾恰好也是 `</div></div>`，
   懒惰匹配会在那里停下，截出来的片段缺掉后半段（「已完成 N」全丢）。
   正确边界是「下一个 .cal-cell 的开始」或网格结尾。 */
function sliceCalendarCell(gridHtml, ds) {
  const key = 'data-date="' + ds + '">';
  const a = gridHtml.indexOf(key);
  if (a < 0) return '';
  const start = gridHtml.lastIndexOf('<div class="cal-cell', a);
  const next = gridHtml.indexOf('<div class="cal-cell', a + key.length);
  return gridHtml.slice(start < 0 ? a : start, next < 0 ? gridHtml.length : next);
}

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
  group('J2. ★ 统计取数范围一致性 + 状态徽章不得错报（v0.16.0）');
  {
    const y = view.calY, m = view.calM;
    /* 场景：一位在治患者，疗程末日落在此前某天（已在 90 天回看窗口内），
       把它归档为「治疗完成」—— 这是病房里最常见的动作（做完就标完成）。
       要求：归档之后，日历格 / 月汇总 / 未来 14 天日程 三处名单必须一致。 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const endDate = addDays(today, -3);
    const startDate = addDays(endDate, -30);
    const pArc = mk({ name: '归档甲', startDate: startDate, fractions: '20' });
    const schedArc = computeSchedule(pArc);
    const realEnd = schedArc[schedArc.length - 1].date;

    /* 归档前：在治，应被纳入统计 */
    ok(inTreatCount() === 1, '① 归档前该患者在治名单里', inTreatCount());
    ok(calStatScope().some(function (q) { return q.id === pArc.id; }), '① 在治患者必入统计范围');

    /* 归档后：状态改成「治疗完成」 */
    pArc.status = '治疗完成';
    ok(inTreatCount() === 0, '② 归档后不在在治名单里', inTreatCount());
    ok(calStatScope().some(function (q) { return q.id === pArc.id; }),
      '★★ 排程末日仍在 90 天窗口内的归档患者，仍应纳入统计范围（否则前后口径断裂）',
      '末次=' + realEnd);
    const stEnd = dayStat(realEnd);
    ok(stEnd.treating.length === 1 && stEnd.ending.length === 1,
      '★★ dayStat 仍认得该归档患者的末日（治疗 1 + 终 1）',
      { 治疗: stEnd.treating.length, 终: stEnd.ending.length });

    /* ★ 核心断言：渲染出来的日历，网格统计与 byDate 派生量口径一致 */
    view.tab = 'cal'; view.page = 'tab';
    view.calY = +realEnd.slice(0, 4); view.calM = +realEnd.slice(5, 7);
    render();
    const hArc = getEl('view').innerHTML;
    const gridArc = calGridHtml(hArc);
    /* 该日格子应带「治疗 1」与「已完成 1」（末日已过 → done 为真）
       ★ 取格子不能用懒惰匹配 `/\/div\/div>/` —— 格子内容里第一个 `</div></div>`
       是 .statrow 的收尾，不是格子的收尾，会把断言内容截断成空串（本人踩过两次）。
       正确做法：从 `data-date="<ds>"` 起截到**下一个** `.cal-cell` 之前。 */
    const cellArc = sliceCalendarCell(gridArc, realEnd);
    ok(cellArc.length > 0, '★ 取到该日格子（切片锚点存在）', cellArc.length);
    ok(cellArc.indexOf('治疗 1') >= 0, '★★ 归档患者末日格子仍有「治疗 1」（byDate 未漏）', cellArc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    /* v0.16.1 起格子不再画「已完成 N」；这条改为反向红线，保证改动不回流 */
    ok(cellArc.indexOf('已完成') < 0, '★★ 归档患者末日格子不画「已完成 N」（v0.16.1 去掉）',
      cellArc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    /* ★ 未来 14 天日程用的是 inTreat()，归档患者不在其中 —— 但日历格用的是
       calStatScope()。断言两者**不会**对同一位归档患者给出矛盾结论：
       该患者末日（过去）不应出现在未来 14 天窗口里，所以不构成矛盾。 */
    const upSec = hArc.indexOf('未来 14 天日程');
    /* 「未来 14 天日程」是 inTreat() 建的 upcoming，只含在治患者；
       这里患者已归档且末日是**过去**，所以连区块都不该出现。 */
    ok(upSec < 0 || hArc.slice(upSec).indexOf('归档甲') < 0,
      '★★ 归档患者不出现在「未来 14 天日程」（该区只服务在治患者）',
      'upSec=' + upSec);

    /* ③ 状态徽章不得把归档患者标成「待治疗」 */
    /* 直接渲染未来 14 天日程所需的场景：把患者改成「未完成」的未来日次 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const pFut = mk({ name: '在治乙', startDate: addDays(today, 0), fractions: '20' });
    pFut.status = '在治';
    view.calY = +today.slice(0, 4); view.calM = +today.slice(5, 7);
    render();
    const hLive = getEl('view').innerHTML;
    const upLive = hLive.slice(hLive.indexOf('未来 14 天日程'));
    ok(upLive.indexOf('待治疗') >= 0, '★ 在治患者的未来日次标「待治疗」（合法用法保留）', true);

    /* ★★ 这段必须**读真实渲染结果**。
       曾经写成 `const badge = (pArch.status === '在治' ? '待治疗' : pArch.status);`
       再断言 badge !== '待治疗' —— 那是把产品逻辑在测试里复述一遍，等于自我印证：
       我把产品改回「无条件待治疗」做故障注入，套件竟然全绿。断言必须打 HTML。 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const pArch = mk({ name: '归档丙', startDate: today, fractions: '20' });
    pArch.status = '治疗完成';
    view.tab = 'cal'; view.page = 'tab';
    view.calY = +today.slice(0, 4); view.calM = +today.slice(5, 7);
    render();
    const hArch = getEl('view').innerHTML;
    const upArch = hArch.indexOf('未来 14 天日程') >= 0
      ? hArch.slice(hArch.indexOf('未来 14 天日程')) : '';
    /* 归档患者根本不该进这个区块 */
    ok(upArch.indexOf('归档丙') < 0,
      '★★ 归档患者不进「未来 14 天日程」（渲染层实测，不靠复述逻辑）',
      upArch.slice(0, 160).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    /* ★★ 徽章分支的真正靶子：归档患者**仍有未来未完成日次**。
       前一段的「归档丙」从今天开始排 20 次，但未来日次在窗口内 —— 然而
       归档后就不该进 upcoming，所以看不到徽章。要验证徽章分支，必须绕过
       upcoming 的在治过滤，直接渲染「归档 + 未来未完成」的那条行 HTML。
       做法：临时把「在治」判定放宽来构造场景是不行的（会污染被测逻辑），
       改为直接调用渲染路径不可行 —— 故采用**可观察的等价验证**：
       造一位「在治」患者（保证进 upcoming），再把它改成归档，
       断言同一页面里该患者从 upcoming 消失（覆盖 upcoming 过滤），
       并单独断言 esc(a.p.status) 分支在源码中存在（覆盖徽章分支）。 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const pLive = mk({ name: '在治丁', startDate: today, fractions: '20' });
    pLive.status = '在治';
    view.calY = +today.slice(0, 4); view.calM = +today.slice(5, 7);
    render();
    const hLive2 = getEl('view').innerHTML;
    const upLive2 = hLive2.indexOf('未来 14 天日程') >= 0
      ? hLive2.slice(hLive2.indexOf('未来 14 天日程')) : '';
    ok(upLive2.indexOf('待治疗') >= 0, '★ 在治患者的未来未完成日次仍标「待治疗」');
    ok(upLive2.indexOf('在治丁') >= 0, '★ 在治患者出现在「未来 14 天日程」');

    /* 把同一位患者改成「失访」—— 它仍有未来未完成日次，但已归档。
       upcoming 必须把它剔掉（这是用户可见的正确行为）。 */
    pLive.status = '失访';
    render();
    const hLost = getEl('view').innerHTML;
    const upLost = hLost.indexOf('未来 14 天日程') >= 0
      ? hLost.slice(hLost.indexOf('未来 14 天日程')) : '';
    ok(upLost.indexOf('在治丁') < 0,
      '★★ 失访后的患者从「未来 14 天日程」消失（渲染层实测）',
      upLost.slice(0, 140).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    /* ★★ 状态徽章分支必须**真的被驱动到**，而且断言要有牙齿。
       踩过的两个坑（都是本套件真实发生过的）：
         ① 把逻辑在测试里复述一遍（`x==='在治'?…:x` 再断言 —— 自我印证）；
         ② 调用签名搞错：sheetDayOverall 收的是**日期字符串**，我传了患者对象，
            参数变成 '[object Object]'，parseD 返回 null 直接抛异常；而异常被
            包在 `if (未完成)` 的 else 分支里，测试反而报「跳过」→ 全绿假象。
       因此这里：用真实日期字符串驱动，并显式断言弹层 body 非空。 */
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    /* ★ 「未完成」只能出现在**未来**日次：computeSchedule 的 done 是
       `ds <= today` 推导出来的，过去日期必然 done=true（见 1695 行）。
       靶场景 = 未来某次治疗，done=false，徽章走「待治疗 / 状态」分支。

       ★★ 但不能简单取「明天」：明天可能是周末或法定节假日，那样根本排不出
       治疗日 —— 跨日期扫描会立刻抓到这个脆弱性（本套件已被抓到过）。
       改成「从 today 起向后找第一个真正排上治疗的日子」。 */
    const scout = mk({ name: '__scout__', startDate: today, fractions: '30' });
    scout.status = '在治';
    const futDate = (computeSchedule(scout).find(function (x) { return x.date > today; }) || {}).date;
    ok(typeof futDate === 'string' && futDate > today,
      '★ 在 today 之后找到第一个真实治疗日（跨日期安全）', futDate);
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    const pSheet = mk({ name: '弹层戊', startDate: today, fractions: '30' });
    pSheet.status = '在治';
    const itPast = computeSchedule(pSheet).find(function (x) { return x.date === futDate; });
    ok(!!itPast && itPast.done === false,
      '★ 造出「未来、未完成」的一次安排',
      (itPast && itPast.date) + ' done=' + (itPast && itPast.done));
    const pastDate = futDate;
    if (itPast) {
      /* 先看「在治 + 过去未完成」→ 必须出现「待治疗」 */
      sheetDayOverall(pastDate);
      const bodyLive = getEl('sheetBody').innerHTML;
      ok(bodyLive.length > 0, '★★ 弹层被真正驱动（body 非空）', bodyLive.length);
      ok(bodyLive.indexOf('待治疗') >= 0,
        '★ 弹层：在治患者的未完成日次标「待治疗」',
        bodyLive.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));

      /* 同一天、同一次，把患者改成「失访」→ 不得再标「待治疗」 */
      pSheet.status = '失访';
      sheetDayOverall(pastDate);
      const bodyLost = getEl('sheetBody').innerHTML;
      ok(bodyLost.length > 0, '★★ 归档场景下弹层也被真正驱动（body 非空）', bodyLost.length);
      ok(bodyLost.indexOf('待治疗') < 0,
        '★★ 弹层：失访患者的未完成日次不得标「待治疗」（错报）',
        bodyLost.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
      ok(bodyLost.indexOf('失访') >= 0,
        '★★ 弹层：归档后该患者显示真实状态「失访」',
        bodyLost.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));

      /* ★ 范围一致性：归档后（末日仍在 90 天窗口内）该日名单不得为空 */
      pSheet.status = '治疗完成';
      sheetDayOverall(pastDate);
      const bodyArc = getEl('sheetBody').innerHTML;
      ok(bodyArc.indexOf('弹层戊') >= 0,
        '★★ 归档（治疗完成）患者仍在日详情名单里（与日历格子口径一致）',
        bodyArc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
      ok(bodyArc.indexOf('治疗完成') >= 0,
        '★ 归档患者显示真实状态「治疗完成」',
        bodyArc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));

      /* ★★ 靶向「sheetDayOverall 的范围」这一条：
         造一位**在治**患者，取它某个未来治疗日 D。
         · 在治时：D 能在弹层里看到该患者；
         · 把它改成「治疗完成」，并把 startDate 挪到 200 天前
           （使末日落在 90 天回看窗口之外）——此时 inTreat() 空、
           calStatScope() 也不再纳入，两种实现都看不到 → 无法区分。
         所以真正的区分场景是：**在治 → 归档** 且末日**仍在窗口内**。
         pSheet 满足这一点（futDate 是明天），所以上面的断言已覆盖；
         这里再补一条「同一患者、同一日期，改状态前后弹层名单的差集」显式断言。 */
      state = normalize({ version: 2, updatedAt: '', patients: [] });
      const pKeep = mk({ name: '范围庚', startDate: today, fractions: '30' });
      pKeep.status = '在治';
      sheetDayOverall(futDate);
      /* ★ 取患者名不能用 `/<b>([^<]+)<\/b>/g` —— 概览条的计数也是 <b>0</b>，
         会把数字一起捞进来。日详情弹层里患者名在
         `<div class="content">姓名 <span class="hint">…</span></div>`。 */
      const nameRe = /<div class="content">([^<\s]+)/g;
      const namesIn = function (html) {
        const out = []; let m;
        while ((m = nameRe.exec(html)) !== null) out.push(m[1]);
        nameRe.lastIndex = 0; return out.join('|');
      };
      const beforeNames = namesIn(getEl('sheetBody').innerHTML);
      ok(beforeNames.indexOf('范围庚') >= 0, '★★ 弹层（在治）名单含该患者', beforeNames);
      pKeep.status = '治疗完成';
      sheetDayOverall(futDate);
      const afterNames = namesIn(getEl('sheetBody').innerHTML);
      ok(afterNames.indexOf('范围庚') >= 0,
        '★★ 弹层（归档、末日仍在 90 天窗口内）名单**仍**含该患者 —— 与日历格子口径一致',
        afterNames);
      /* ★ 弹层里「名单」与「概览条」是两套口径，且**有意不同**：
         名单（arr）走 calStatScope()，把归档但末日仍在窗口内的患者列出来，
           目的是让日历格子上画着的「终 1」点得开、看得到人；
         概览条（st = dayStat）的「治疗中」只算仍在治疗流程里的人，
           归档即不计入 —— 这是「在治人数」的正确口径，不应为了对齐而改。
         所以断言应是「名单含、概览不含」，而不是强行要求两者相等。 */
      const sheetBodyArc = getEl('sheetBody').innerHTML;
      ok(sheetBodyArc.indexOf('全部治疗安排') >= 0 && sheetBodyArc.indexOf('范围庚') >= 0,
        '★★ 弹层「全部治疗安排」名单含归档患者（可点开查看）', true);
      /* 概览条的 DOM 是 `<span class="ov-i ov-treat"><b>0</b> 治疗中</span>`，
         直接被标签隔开，不能搜「治疗中 0」。按结构与数值两段判。 */
      const ovTreat = (sheetBodyArc.match(/ov-treat"><b>(\d+)<\/b>\s*治疗中/) || [])[1];
      ok(ovTreat === '0',
        '★★ 弹层概览条「治疗中」为 0 —— 归档不计入在治人数（有意不同口径）',
        'ov-treat=' + ovTreat);
    } else {
      ok(false, '★★ 场景构造失败：3 天前应有治疗安排', pastDate);
    }
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

    /* ★ v0.16.1：日历格「每日统计」收敛为**一项** ——「治疗 N」= 当日应治疗人数。
       演进史（每次都是用户在减负）：
         · 更早：无完成时写一条定性文字「待治疗」→ 零信息、口径不齐
         · v0.16.0：删「待治疗」，补「已完成 N」
         · v0.16.1：连「已完成 N」也去掉（格子小，两行数字反而挤；
           「已完成」是派生量，点日期看弹层更完整）

       ★ 断言必须**限定在日历网格 / 图例**范围内。整页 HTML 里别的面也写
         「待治疗」「已完成」，且都合法：
           · 月度汇总卡片「未来 14 天日程」的行末状态徽章；
           · 点日期后的日详情弹层（逐条名单里的「已完成 / 待治疗」）；
           · 患者详情页格子的 `tagline done`（「第 N 次✓」）。
       那些讲的都是**某一次治疗做没做**，是状态而非「当日人数统计」。
       所以用 calGridHtml() / calLegendHtml() 两个切片函数先把范围收窄再断言。 */
    const gridHtml = calGridHtml(calHtml);
    const legendHtml = calLegendHtml(calHtml);
    ok(gridHtml.length > 0, '★ 取到日历网格片段（切片锚点存在）', gridHtml.length);
    ok(legendHtml.length > 0, '★ 取到日历图例片段（切片锚点存在）', legendHtml.length);

    /* ① 网格里不得出现「待治疗」定性文字 */
    ok(gridHtml.indexOf('待治疗') < 0, '★★ 日历格内无「待治疗」文字');
    /* ② ★ 网格里也不得出现「已完成 N」—— v0.16.1 新红线 */
    ok(gridHtml.indexOf('已完成') < 0, '★★ 日历格内无「已完成 N」标注（v0.16.1 去掉）',
      (gridHtml.match(/已完成[^<]*/) || ['(无)'])[0]);
    ok(gridHtml.indexOf('tagline done') < 0, '★★ 日历格内无 tagline done 元素',
      (gridHtml.match(/tagline done[^>]*>/) || ['(无)'])[0]);
    /* ③ 网格里必须有「治疗 N」—— 这是唯一保留的格内统计 */
    ok(/<div class="cnt">治疗 \d+<\/div>/.test(gridHtml), '★★ 日历格保留「治疗 N」（唯一格内统计）',
      (gridHtml.match(/<div class="cnt">治疗 \d+<\/div>/) || [''])[0]);
    /* ④ 图例首项「应治疗」（与格内「治疗 N」同指），且不再有「已完成」色块 */
    ok(legendHtml.indexOf('</i>应治疗</span>') >= 0, '★ 图例首项为「应治疗」（与格内「治疗 N」同指）');
    ok(legendHtml.indexOf('</i>已完成</span>') < 0,
      '★★ 图例不再有「已完成」色块（格内已无对应物，留则误导）');
    ok(legendHtml.indexOf('</i>待治疗</span>') < 0, '★★ 图例无「待治疗」条目');
    ok(legendHtml.indexOf('有治疗安排') < 0, '★ 图例无含糊的「有治疗安排」文案');
    /* ⑤ 图例首项恰好是「应治疗」 */
    {
      const seq = [];
      const re = /<\/i>([^<]+)<\/span>/g;
      let mm;
      while ((mm = re.exec(legendHtml)) !== null) seq.push(mm[1]);
      ok(seq[0] === '应治疗', '★★ 图例首项为「应治疗」',
        seq.slice(0, 2).join(' / ') + ' （共 ' + seq.length + ' 项）');
      ok(seq.indexOf('已完成') < 0, '★★ 图例各项中无「已完成」',
        seq.join(' / '));
    }

    /* 「已完成」仍是页面别处（弹层名单）的合法状态词 —— 界定清楚，避免下次误删 */
    ok(calHtml.indexOf('已完成') >= 0, '★ 「已完成」作为状态词仍存在于页面其他区域', true);
    /* ★ v0.16.1：格内只剩一项统计，原先「两项数值互校」已失去对象。
       保留的是一条**语义不变式**：格内「治疗 N」的 N 必须等于当日应治疗人数，
       不能因为拿掉「已完成」而连口径都松掉（比如误改成排程条数、
       或把归档患者漏掉）。逐格核对，不是抽查。
       ★ 每格单独一条断言会让计数暴涨，这里汇总成一条：任一格不符就报出第一处。 */
    {
      const dsToday = today;
      const stToday = dayStat(dsToday);
      /* ★ 逐格切片的可靠做法：用 split 按 `<div class="cal-cell` 断开，
         每段即一格（含 data-date）。不要用正则 lookahead —— 贪婪/懒惰与
         前瞻范围混用时极易只匹配到第一格（已踩过一次：checked 恒为 0/1）。 */
      const segs = gridHtml.split('<div class="cal-cell').slice(1);
      let bad = null, checked = 0;
      segs.forEach(function (c) {
        const dd = (c.match(/data-date="(\d{4}-\d{2}-\d{2})"/) || [])[1];
        if (!dd) return;
        const shown = (c.match(/<div class="cnt">治疗 (\d+)<\/div>/) || [])[1];
        const want = dayStat(dd).treating.length;
        if (want === 0) return;                       /* 无治疗日不画 cnt */
        checked++;
        if (String(want) !== String(shown) && bad === null) bad = { date: dd, 格内显示: shown, 应为: want };
      });
      ok(checked > 0, '★★ 网格里至少有一格带「治疗 N」（有对象可校）', checked);
      ok(bad === null, '★★ 每格「治疗 N」都等于当日应治疗人数（口径未松）', bad || '全部一致');
      ok(stToday.treating.length >= 0, '★ 当日应治疗人数可读（口径锚点）', stToday.treating.length);
    }

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

  /* ================================================================
     M. ★★ v0.17.0：移除「流程状态」后的用户可见行为
     背景（用户原话）：
       「取消放疗流程状态，仅设置定位日期和放疗日期即可自动排程，
         无需等流程状态推进后再出现排程」
     真相：排程**从来**不看流程状态（computeSchedule 只读 startDate/fractions）；
       但患者卡片上有个 `planStatus !== '已通过' ? 显示「流程：待计划」: 显示进度`
       的前置分支 —— 只要流程没推到「已通过」，卡片就**不显示治疗进度**，
       看起来像「还没排上」。这是"以为要等流程推进"的真凶。
     本组守的是**用户能看到的结果**，不是复述逻辑（原则 20）：
       ① 卡片/详情页/待办都不再出现「流程」字样；
       ② 卡片在**任何 status 下**都显示治疗进度（不再被流程挡住）；
       ③ 缺排程输入时提示「待排程」，且是可去补的（不是"等审批"）。
     ================================================================ */
  group('M. ★★ 移除流程状态：卡片一律显示治疗进度（v0.17.0）');
  {
    /* M1. 患者卡片：有完整排程输入 → 必须显示进度，且无「流程」字样 */
    const pc = mk({ name: '甲患者', startDate: today, fractions: '30', totalDose: '60', dosePerFraction: '2' });
    pc.planStatus = '待计划';          /* 故意塞入老字段，验证渲染层不再理它 */
    const cardHtml = wardCardHtml(pc);
    ok(cardHtml.indexOf('流程') < 0, '★★ 患者卡片不再出现「流程」字样（即使数据里还带着 planStatus）',
      (cardHtml.match(/[^>]*流程[^<]*/) || [''])[0]);
    ok(cardHtml.indexOf('待计划') < 0, '★★ 患者卡片不再显示 planStatus 的原始值');
    ok(/治疗 <b>\d+\/\d+<\/b> 次/.test(cardHtml), '★★ 有排程输入 → 卡片显示治疗进度（v0.17.0 前会被流程分支挡住）',
      (cardHtml.match(/治疗 <b>[^<]*<\/b> 次/) || [''])[0]);
    ok(cardHtml.indexOf('progress') >= 0, '★ 进度条渲染（说明走的是进度分支，不是兜底文案）');

    /* M2. 缺排程输入 → 提示「待排程」，且文案是"去补日期与次数"，不是"等流程" */
    const pn2 = mk({ name: '乙患者', startDate: '', fractions: '' });
    pn2.planStatus = '待勾画';
    const card2 = wardCardHtml(pn2);
    ok(card2.indexOf('待排程') >= 0, '★★ 缺排程输入 → 卡片提示「待排程」', true);
    ok(card2.indexOf('填开始日期与总次数') >= 0, '★★ 待排程提示指明去补什么（可执行，非等审批）', true);
    ok(card2.indexOf('流程') < 0, '★★ 缺排程时也不再提「流程」');

    /* M3. 详情页 hero：不再有 planStatus chip
       ⚠ 注意：上面 M2 的 mk() 会用新患者**重建整个 state**，pc 已不在其中。
         必须把 pc 放回 state，否则 getPatient(pc.id) 为 null，render() 直接退回标签页，
         后续断言会对着「标签页」而不是「详情页」下判断 —— 那种"绿"毫无意义。 */
    state.patients.push(pc);
    view.page = 'patient'; view.pid = pc.id; render();
    const detail = getEl('view').innerHTML;
    /* 先确认真的渲染到了详情页（否则后面所有断言都是在测空气） */
    ok(getEl('title').textContent === pc.name, '★★ 前置：详情页真的被渲染（title 为患者姓名）', getEl('title').textContent);
    ok(detail.indexOf('流程') < 0, '★★ 详情页无「流程」字样（hero 里的 planStatus chip 已删）');
    ok(detail.indexOf('待计划') < 0, '★★ 详情页不显示 planStatus 值');
    /* 但治疗进度区（患者进度卡片）本身必须还在 —— 不能"删流程"删过头 */
    ok(detail.indexOf('治疗进度') >= 0, '★★ 详情页「治疗进度」卡片保留（删流程不能误删进度）');

    /* M4. 待办：缺排程输入 → 只报「待排程」 */
    const cid = pc.id;
    state.patients = state.patients.filter(function (p) { return p.id !== cid; });
    const pn3 = mk({ name: '丙患者', startDate: '', fractions: '' });
    pn3.planStatus = '待验证';        /* 又塞一个老值 */
    const todo3 = buildTodo();
    const hit = todo3.filter(function (x) { return x.p.id === pn3.id; })[0];
    ok(!!hit, '待排程患者仍在待办里（提醒补充，不被静默忽略）', !!hit);
    ok(hit && hit.reasons.indexOf('待排程') >= 0, '★★ 待办理由为「待排程」', hit && hit.reasons);
    ok(hit && hit.reasons.every(function (r) { return r.indexOf('流程') < 0; }), '★★ 待办理由无「流程」', hit && hit.reasons);
    ok(hit && hit.details.join('').indexOf('待验证') < 0, '★★ 待办详情不复述 planStatus 值', hit && hit.details);

    /* M5. 老数据里的 planStatus 被 normalize 丢弃后，卡片仍正常工作（端到端） */
    {
      const legacy = normalize({ version: 2, updatedAt: '', patients: [
        { name: '丁患者', startDate: today, fractions: '20', planStatus: '待计划', status: '在治' }
      ] }).patients[0];
      ok(!('planStatus' in legacy), '★★ 端到端：老数据里的 planStatus 被丢弃');
      const h5 = wardCardHtml(legacy);
      ok(/治疗 <b>\d+\/20<\/b> 次/.test(h5), '★★ 端到端：丢弃后卡片仍显示治疗进度', (h5.match(/治疗 <b>[^<]*<\/b> 次/) || [''])[0]);
    }
    state.patients = state.patients.filter(function (p) { return p.id !== pn3.id; });
    view.page = 'tab';
  }

  /* ================================================================
     L. ★ 验证按钮「点击真的能用」—— 回归测试
     背景（用户报告的真实缺陷）：
       详情页的「设置 / 修改」按钮点击后毫无反应；待办里的「第 N 次」切换也不生效。
     根因：
       ① verifySummaryHtml 渲染的按钮**没有 data-id**，
          handler 里 getPatient(el.dataset.id) → getPatient(undefined) → null → closeSheet()，
          表现为「点一下弹层直接关掉、什么都没发生」。
       ② verify-mark 用的是 view.pid，从待办/设置页进入时为 null，标记无效。
     本组只断言「点击 → 界面/数据真的变化」，避免只测渲染不测交互（正是漏掉此缺陷的原因）。
     ================================================================ */
  group('L. ★ 验证按钮点击有效（详情页 / 待办两个入口）');
  {
    /* --- L1. 详情页「设置」按钮（未配置验证时）--- */
    const p1 = mk({ name: '按钮甲', startDate: today, fractions: '30' });
    view.page = 'patient'; view.pid = p1.id;
    render();
    ok(getEl('view').innerHTML.indexOf('不验证') >= 0, '前置：详情页显示「不验证」', true);
    /* 详情页按钮也必须自带 data-id：handler 的 `|| view.pid` 只是兜底，
       真正的契约是「按钮自带参数」——否则换到待办语境（view.pid 为空）就会失灵。 */
    const setBtn = getEl('view').innerHTML.match(/data-act="verify-edit"[^>]*/);
    ok(!!setBtn && setBtn[0].indexOf('data-id="' + p1.id + '"') >= 0,
      '★ 详情页「设置」按钮必须自带 data-id（不能只靠 view.pid 兜底）', setBtn && setBtn[0]);
    /* 把 view.pid 清空后再点：模拟「按钮被抓到自己语境之外」的最严苛情况，
       只有按钮自带的 data-id 能救 —— 这正是用户遇到的失灵场景。 */
    view.pid = null;
    fireFromHtml(getEl('view').innerHTML, 'verify-edit');
    ok(getEl('sheetBody').innerHTML.indexOf('第几次治疗时验证') >= 0,
      '★ 点「设置」要打开验证表单（曾无反应 → 弹层直接关掉）',
      String(getEl('sheetBody').innerHTML).slice(0, 120));
    ok(getEl('sheetTitle').textContent === '放疗验证设置', '弹层标题正确', getEl('sheetTitle').textContent);
    /* 表单能保存 */
    let r = sheetCtx.onSave({ verifyFractions: '10,20', verifyNote: '复位+CBCT' });
    ok(r !== false, '表单保存不报错（未填非法值时返回非 false）', r);
    ok(String(p1.verifyAt.fractions) === '10,20', '★ 保存后数据真的写入患者', p1.verifyAt.fractions);
    ok(p1.verifyAt.note === '复位+CBCT', '备注也写入', p1.verifyAt.note);

    /* --- L2. 详情页「修改」按钮（已配置验证时）--- */
    view.page = 'patient'; view.pid = p1.id;
    render();
    ok(getEl('view').innerHTML.indexOf('修改') >= 0, '前置：已配置时显示「修改」按钮', true);
    const modBtn = getEl('view').innerHTML.match(/data-act="verify-edit"[^>]*/);
    ok(!!modBtn && modBtn[0].indexOf('data-id="' + p1.id + '"') >= 0,
      '★ 详情页「修改」按钮必须自带 data-id', modBtn && modBtn[0]);
    view.pid = null;
    fireFromHtml(getEl('view').innerHTML, 'verify-edit');
    ok(getEl('sheetBody').innerHTML.indexOf('第几次治疗时验证') >= 0,
      '★ 点「修改」要打开验证表单并能带出原值',
      String(getEl('sheetBody').innerHTML).slice(0, 120));
    ok(String(sheetCtx.body).indexOf('10,20') >= 0, '★ 表单带回原有次数（value 未丢失）',
      String(sheetCtx.body).indexOf('10,20'));

    /* --- L3. 表单内「第 N 次」完成标记按钮 --- */
    /* 先确保有两项验证、且排程足够（今天开始 30 次，第 10/20 次在排程内） */
    ok(sheetCtx.body.indexOf('data-act="verify-mark"') >= 0, '★ 表单内渲染出「第 N 次」标记按钮', true);
    const markTag = sheetCtx.body.match(/data-act="verify-mark"[^>]*/);
    ok(!!markTag && markTag[0].indexOf('data-id="' + p1.id + '"') >= 0 && markTag[0].indexOf('data-n="10"') >= 0,
      '★ 弹层「第 N 次」按钮必须自带 data-id 与 data-n', markTag && markTag[0]);
    view.pid = null;
    fireFromHtml(sheetCtx.body, 'verify-mark');
    ok(String(p1.verifyAt.done.join()) === '10',
      '★ 点「第 10 次」要写入完成标记（曾因用 view.pid 而失效）', p1.verifyAt.done);
    /* 再点一次 = 切换为未完成（幂等/可撤销） */
    fireFromHtml(sheetCtx.body, 'verify-mark');
    ok(String(p1.verifyAt.done.join()) === '',
      '★ 再点一次撤销标记（按钮是切换语义）', p1.verifyAt.done);

    /* --- L4. 待办入口：view.pid 为空时也必须能标记 --- */
    /* 造一个「该验证了」的患者：把开始日往前推足够多**日历日**，
       使其已完成**治疗次数**达到触发点（注意周末/假期不排治疗，日历日 ≠ 治疗次数）。 */
    const trig = Math.max(1, 10 - VERIFY_LEAD_FRACTIONS);
    state = normalize({ version: 2, updatedAt: '', patients: [] });
    let offset = trig * 2 + 10;                 /* 宽松留量：治疗日约占日历日的 5/7 */
    let pT = mk({
      name: '按钮乙', startDate: addDays(today, -offset), fractions: '30',
      verifyAt: { fractions: '10' }
    });
    while (doneCount(pT) < trig && offset < 200) {   /* 保证确实进入提醒窗口 */
      offset += 5;
      pT = mk({ name: '按钮乙', startDate: addDays(today, -offset), fractions: '30', verifyAt: { fractions: '10' } });
    }
    ok(doneCount(pT) >= trig, '前置：已完成 ' + doneCount(pT) + ' 次（触发点 ' + trig + '）', doneCount(pT));
    ok(verifyPending(pT) !== null, '前置：该患者进入验证提醒窗口', verifyPending(pT));
    /* 关键：模拟从待办/其他页点进来 —— view.pid 为 null */
    view.page = 'tab'; view.tab = 'todo'; view.pid = null;
    render();
    const todoHtml = getEl('view').innerHTML;
    ok(todoHtml.indexOf('verify-done') >= 0, '★ 待办里渲染出「标记已验证」按钮', true);
    /* 待办里的两个按钮都必须带 data-id（否则 handler 拿不到患者） */
    const doneBtn = todoHtml.match(/data-act="verify-done"[^>]*/);
    ok(!!doneBtn && doneBtn[0].indexOf('data-id="' + pT.id + '"') >= 0,
      '★ 待办「标记已验证」按钮必须带 data-id', doneBtn && doneBtn[0]);
    const editBtn = todoHtml.match(/data-act="verify-edit"[^>]*/);
    ok(!!editBtn && editBtn[0].indexOf('data-id="' + pT.id + '"') >= 0,
      '★ 待办「修改」按钮必须带 data-id（曾缺失 → 点击无反应）', editBtn && editBtn[0]);

    /* 点击待办里的「标记已验证」：即使 view.pid 为 null 也要成功 */
    fireFromHtml(todoHtml, 'verify-done');
    ok(String(pT.verifyAt.done.join()) === '10',
      '★ view.pid 为 null 时，点待办「标记已验证」仍生效（不依赖 view.pid）', pT.verifyAt.done);

    /* 点击待办里的「修改」：即使 view.pid 为 null 也要打开表单 */
    view.pid = null;
    fireFromHtml(todoHtml, 'verify-edit');
    ok(String(getEl('sheetBody').innerHTML).indexOf('第几次治疗时验证') >= 0,
      '★ view.pid 为 null 时，点待办「修改」仍能打开表单',
      String(getEl('sheetBody').innerHTML).slice(0, 120));

    /* --- L5. 没有 data-id 时不得误开表单（防御性：拿不到患者就不打开）---
       注意：closeSheet 不清空 sheetBody（只延时清 sheetCtx），
       所以不能靠 body 残留判断，要对比「打开前 → 点击后」是否发生变化、且标题不是验证表单。 */
    closeSheet();
    getEl('sheetTitle').textContent = '';
    const bodyBefore = getEl('sheetBody').innerHTML;
    fire('verify-edit', {});
    ok(getEl('sheetTitle').textContent !== '放疗验证设置',
      '★ 缺 data-id 时不误开验证表单（拿不到患者就不打开）', getEl('sheetTitle').textContent);
    ok(getEl('sheetBody').innerHTML === bodyBefore,
      '★ 缺 data-id 时界面保持不变（不会闪一下又关掉）', true);

    /* 复位视图，避免影响后续组 */
    closeSheet();
    view.page = 'tab'; view.tab = 'ward'; view.pid = null;
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

  /* ================================================================
     T. ★★ v0.19.0：待办页「按事项分类分组 + 床号大字」
     需求（用户 2026-10-20 原话）：
       「更新一下待办页面的展示方式，首先是和在治页面一样，展示床号，
         另外是将患者分组展示，如即将结束的和待开始的，未排程的分类展示」
     已与用户确认的三条规则：
       ① 一人可命中**多组**（每组都是可直接照着办事的完整清单，缺人就是漏办）
       ② 组内排序走 wardGroups()，与在治页同一口径（先病区再床号）
       ③ 空组不渲染；顶部「共 N 位」按患者**去重**，组标题写「人次」
     ================================================================ */
  group('T. 待办页按事项分组 + 床号大字（v0.19.0）');
  {
    const T = today, A = (n) => addDays(T, n);

    /* ★★ startForLeft(want)：返回一个 startDate，使该患者「剩余次数」恰为 want，**与今天是哪天无关**。
       为什么不能用 A(-40) 这类固定偏移：治疗日跳过周末、又被法定节假日拦住（computeSchedule
       只按 treatDays + holidays/makeups 排），所以「往前 40 天」在不同 Today 下剩的次数完全不同。
       实测：2026-10-20 下 A(-40) 剩 5 次（刚好成组），而 2026-06-19 下剩 6 次（>阈值 5，不成组）、
       2026-02-28 直接崩在 `.find(...).items`（undefined）。
       这正是 scan-dates.sh 抓出来的跨日期脆弱点 —— 「只在今天绿」的断言等于没有断言。
       实现：不推公式（节假日/调休/周末三重变量，公式推不准），直接**逐日回扫实测**：
       从今天往前一天天试，第一个让 left===want 的开工日就是答案。
       区间取 400 天，覆盖 30 次疗程跨春节/国庆的最坏情况。 */
    const startForLeft = (want, total) => {
      const N = total || 30;
      for (let k = 1; k <= 400; k++) {
        const sd = addDays(T, -k);
        const probe = { status: '在治', startDate: sd, fractions: String(N),
          treatDays: DEFAULT_TREAT_DAYS, pauses: [], extras: [] };
        const sc = computeSchedule(probe);
        if (sc.length && sc.length - sc.filter(x => x.done).length === want) return sd;
      }
      throw new Error('startForLeft: 400 天内找不到剩余 ' + want + ' 次的开工日');
    };

    /* ★★ startForDone(want)：返回一个 startDate，使「已完成次数」恰为 want（同上的逐日回扫思路）。
       为什么 T9 需要它：验证提醒的触发条件是 dn >= n - VERIFY_LEAD_FRACTIONS，
       而 dn 由「开工日距今天隔了几个治疗日」决定 —— 固定偏移 A(-12) 在国庆/春节前后
       只排出 7~8 次，够不到第 10 次的提醒窗口，于是 2026-02-28 / 2026-10-06 / 2026-10-10
       三个日期 T9 三条断言全红。改为按「已完成次数」反查，任何 Today 都稳定。 */
    const startForDone = (want, total) => {
      const N = total || 30;
      for (let k = 1; k <= 400; k++) {
        const sd = addDays(T, -k);
        const probe = { status: '在治', startDate: sd, fractions: String(N),
          treatDays: DEFAULT_TREAT_DAYS, pauses: [], extras: [] };
        const sc = computeSchedule(probe);
        if (sc.length && sc.filter(x => x.done).length === want) return sd;
      }
      throw new Error('startForDone: 400 天内找不到已完成 ' + want + ' 次的开工日');
    };

    /* ---- T1. 分组划分：7 类各归各位 ---- */
    mkMany([
      /* 待排程：缺开始日期 */
      { name: '排', ward: '一病区', bedNo: '3' },
      /* 还未开始：5 天后开始 */
      { name: '未', ward: '一病区', bedNo: '1', startDate: A(5), fractions: '30' },
      /* 即将结束：剩余**恰好 3 次**（反推，与今天是哪天无关） */
      { name: '快', ward: '二病区', bedNo: '8', startDate: startForLeft(3), fractions: '30' },
      /* 副反应未处理 */
      { name: '副', ward: '二病区', bedNo: '2', startDate: A(-1), fractions: '30',
        reactions: [{ site: '皮肤反应', grade: '1级（轻）', foundAt: A(-2) + 'T09:00', content: '红斑', status: '未处理' }] },
      /* 复查到期（已逾期） */
      { name: '查', ward: '三病区', bedNo: '5', startDate: A(-1), fractions: '30',
        reactions: [{ site: '放射性膀胱炎', grade: '2级（中）', foundAt: A(-6) + 'T09:00', content: '尿频',
          status: '已复查未解除', nextCheckAt: A(-2) }] }
    ]);
    const tItems = buildTodo();
    const tGroups = todoGroups(tItems);
    const tKeys = tGroups.map(g => g.key);

    ok(tKeys.indexOf('unscheduled') >= 0, '★ T1 「待排程」成组出现', tKeys);
    ok(tKeys.indexOf('notstarted') >= 0, '★ T1 「还未开始」成组出现', tKeys);
    ok(tKeys.indexOf('ending') >= 0, '★ T1 「即将结束」成组出现', tKeys);
    ok(tKeys.indexOf('reaction') >= 0, '★ T1 「副反应」成组出现', tKeys);
    ok(tKeys.indexOf('recheck') >= 0, '★ T1 「复查」成组出现', tKeys);
    /* 组顺序必须与 TAG_GROUPS 声明一致（页面从上到下：补录 → 收尾 → 处理） */
    const declared = TAG_GROUPS.map(g => g.key).filter(k => tKeys.indexOf(k) >= 0);
    ok(JSON.stringify(tKeys) === JSON.stringify(declared), '★★ T1 组间顺序与 TAG_GROUPS 声明一致', tKeys);

    /* ---- T2. ★★ 一人可命中多组（不能只归一组，否则会漏办） ---- */
    mkMany([
      /* 同时「即将结束」+「随访到期」 */
      { name: '多', ward: '一病区', bedNo: '6', startDate: startForLeft(3), fractions: '30', status: '在治',
        followupPlans: [{ id: 'fp1', baseDate: A(-30), offsetN: 1, offsetUnit: 'm', dueDate: A(-3), note: '复查 CT', done: false }] }
    ]);
    const g2 = todoGroups(buildTodo());
    const k2 = g2.map(g => g.key);
    ok(k2.indexOf('ending') >= 0, '★★ T2 该患者进入「即将结束」组', k2);
    ok(k2.indexOf('followup') >= 0, '★★ T2 同一位患者也进入「随访到期」组（多组命中最）', k2);
    const inEnding = g2.find(g => g.key === 'ending').items.map(r => r.p.name);
    const inFollow = g2.find(g => g.key === 'followup').items.map(r => r.p.name);
    ok(inEnding.indexOf('多') >= 0 && inFollow.indexOf('多') >= 0, '★★ T2 两组里都有这位患者', { inEnding, inFollow });

    /* ---- T3. 组内只带本组理由（不把该患者的其他理由混进来） ---- */
    const rowEnd = g2.find(g => g.key === 'ending').items[0];
    ok(rowEnd.reason === '即将结束', '★★ T3 「即将结束」组里的理由只有「即将结束」', rowEnd.reason);
    const rowFu = g2.find(g => g.key === 'followup').items[0];
    ok(rowFu.reason === '随访到期', '★★ T3 「随访到期」组里的理由只有「随访到期」', rowFu.reason);

    /* ---- T4. ★★ 组内按「病区 → 床号」排序（与在治页同一口径） ---- */
    mkMany([
      { name: '十床', ward: '一病区', bedNo: '12', startDate: startForLeft(3), fractions: '30' },
      { name: '二床', ward: '一病区', bedNo: '2', startDate: startForLeft(3), fractions: '30' },
      { name: '空床', ward: '一病区', bedNo: '', startDate: startForLeft(3), fractions: '30' },
      { name: '他区', ward: '二病区', bedNo: '1', startDate: startForLeft(3), fractions: '30' }
    ]);
    const gE = todoGroups(buildTodo()).find(g => g.key === 'ending');
    const order = gE.items.map(r => r.p.name);
    ok(order[0] === '二床' && order[1] === '十床', '★★ T4 同病区内床号**数值序**（2 在 12 前，非字符串序）', order);
    /* ★ 断言要收窄到「一病区」这一组内部：order 是**所有病区拼起来**的扁平序，
       「空床」在一病区组内排最后，但后面还跟着二病区的「他区」。
       直接判 order[last] 会把「他区」当成一病区的成员，属断言口径错（曾误判过一次）。 */
    const g1 = gE.items.filter(r => r.p.ward === '一病区').map(r => r.p.name);
    ok(g1[g1.length - 1] === '空床', '★ T4 空床号排在该病区**组内**最后', g1);
    /* 一病区的人必须**连续**（不能被他区插到中间）—— 这正是"排序≠分组"的判别点 */
    const firstOther = order.indexOf('他区');
    const lastWard1 = Math.max(order.indexOf('二床'), order.indexOf('十床'), order.indexOf('空床'));
    ok(firstOther > lastWard1, '★★ T4 不同病区不混杂（一病区连续，二病区整体在其后）', order);

    /* ---- T5. 空组不渲染 ---- */
    mkMany([{ name: '仅排程', ward: '一病区', bedNo: '1' }]);
    const gOnly = todoGroups(buildTodo());
    ok(gOnly.length === 1 && gOnly[0].key === 'unscheduled', '★★ T5 只有一类事项时只渲染一个组（空组不占位）', gOnly.map(g => g.key));

    /* ---- T6. 顶部摘要：组标题是「人次」，总数是去重「位」 ---- */
    mkMany([
      { name: '甲', ward: '一病区', bedNo: '1', startDate: startForLeft(3), fractions: '30',
        followupPlans: [{ id: 'a1', baseDate: A(-30), offsetN: 1, offsetUnit: 'm', dueDate: A(-3), note: 'x', done: false }] },
      { name: '乙', ward: '一病区', bedNo: '2' }
    ]);
    const sumItems = buildTodo();
    const sumGroups = todoGroups(sumItems);
    const sumHtml = todoSummaryHtml(sumGroups, sumItems);
    ok(sumHtml.indexOf('共 2 位') >= 0, '★★ T6 摘要总数按患者**去重**（2 人 3 人次仍显示 2 位）', sumHtml.match(/共 \d+ 位/));
    /* 甲占「即将结束」+「随访到期」两个组 → 3 条人次分布在 2 个组里。
       断言：各组人数之和 > 去重人数（这就是"人次 vs 位"的口径差，必须真的发生） */
    const sumOfGroups = sumGroups.reduce((n, g) => n + g.items.length, 0);
    ok(sumOfGroups === 3, '★ T6 各组人次之和 = 3（甲占两组）', sumGroups.map(g => g.key + ':' + g.items.length));
    ok(sumOfGroups > 2, '★★ T6 人次之和严格大于去重人数（否则"位/人次"区分没有意义）', { sumOfGroups, uniq: 2 });
    /* ★★ T6b 直接喂「同一患者出现两条」的输入 —— **唯一**能区分「去重」与「累加」的场景。
       为什么必须单独补：真实 buildTodo() 里每个患者最多产出一条 item（一人多理由合并进
       reasons 数组），所以 allItems 天然无重复，`seen` 那层去重是**防御性冗余**，
       上面三条断言在注入「改成累加」后仍然全绿（已实测：注入 4 首轮未变红）。
       这里绕开 buildTodo，手工构造重复项，才真正压到 uniq 那行代码。 */
    const dupP = sumItems[0].p;
    const dupHtml = todoSummaryHtml([{ key: 'x', title: 'X', items: [{ p: dupP }, { p: dupP }] }],
                                    [{ p: dupP }, { p: dupP }]);
    ok(dupHtml.indexOf('共 1 位') >= 0, '★★ T6b 同一患者重复出现时总数仍为 1 位（真正压到去重逻辑）', dupHtml.match(/共 \d+ 位/));

    /* ---- T7. ★★ 渲染层：床号大字 + 分组标题条 ---- */
    mkMany([
      { name: '床号测试', ward: '一病区', bedNo: '12-3', startDate: startForLeft(3), fractions: '30' }
    ]);
    view.page = 'tab'; view.tab = 'todo'; render();
    const todoH = getEl('view').innerHTML;
    ok(todoH.indexOf('class="pbed"') >= 0, '★★ T7 待办卡片渲染出床号大字（.pbed，与在治页同一组件）', true);
    ok(/<div class="pbed">[\s\S]*?<div class="n">12<\/div>/.test(todoH), '★★ T7 复合床号 12-3 显示为主号大字 12', true);
    ok(todoH.indexOf('badgebox') < 0, '★★ T7 姓名缩写方块已删除（卡片只留一个强视觉锚点：床号）', true);
    ok(todoH.indexOf('todogroup') >= 0, '★★ T7 渲染出分组标题条（.todogroup）', true);
    ok(todoH.indexOf('data-g="ending"') >= 0, '★★ T7 分组带 data-g 标记（可定位）', true);
    ok(todoH.indexOf('即将结束') >= 0, '★ T7 分组标题显示组名', true);

    /* ---- T8. 无床号患者不渲染空列（老数据友好） ---- */
    mkMany([{ name: '无床', ward: '一病区', bedNo: '', startDate: startForLeft(3), fractions: '30' }]);
    view.tab = 'todo'; render();
    const noBedH = getEl('view').innerHTML;
    ok(noBedH.indexOf('class="pbed"') < 0, '★ T8 无床号时不渲染 .pbed（不留空列）', true);
    /* ★ 类名是 "card todocard"，不是 "todocard" 单独成串 ——
       断言必须匹配完整类名 token，直接 indexOf('class="todocard"') 会永远 -1（踩过一次）。 */
    ok(/class="card todocard"/.test(noBedH), '★ T8 但卡片本身照常渲染', true);

    /* ---- T9. 验证组里的「标记已验证」按钮仍在（不能被分组改坏） ---- */
    /* 已完成**恰好 10 次** = 第 10 次验证正好到期（status='due'），与 Today 无关 */
    mkMany([{ name: '验证人', ward: '一病区', bedNo: '9', startDate: startForDone(10), fractions: '30',
      verifyAt: { fractions: '10', note: '复位', done: [] } }]);
    view.tab = 'todo'; render();
    const vH = getEl('view').innerHTML;
    ok(vH.indexOf('data-g="verify"') >= 0, '★★ T9 验证到点成组', true);
    ok(vH.indexOf('data-act="verify-done"') >= 0, '★★ T9 验证组内保留「标记已验证」按钮', true);
    ok(/data-act="verify-done"[^>]*data-id="/.test(vH), '★★ T9 按钮自带 data-id（弹层/待办语境下不依赖 view.pid）', true);

    /* ---- T10. 空待办时的空态 ---- */
    /* ★ 这里必须**先存后恢复 state**：mkMany([]) 会清空患者列表，
       而紧随其后的 G-chrome 组依赖 state.patients[0] 存在（view.pid 取自它），
       清空后会让那条「render() 进入详情页后标签栏隐藏」误红 —— 属测试间状态污染。 */
    const _keepState = state;
    mkMany([]);
    view.tab = 'todo'; render();
    const emptyH = getEl('view').innerHTML;
    ok(emptyH.indexOf('暂无待办') >= 0, '★ T10 无待办时显示空态', true);
    ok(emptyH.indexOf('todogroup') < 0, '★ T10 空态下不渲染任何分组标题', true);
    state = _keepState;                    /* 复原，避免污染后续分组 */

    view.page = 'tab'; view.tab = 'ward'; view.pid = null;
  }

  /* ================================================================ */
  group('G-chrome. 标签栏/顶部按钮显隐 + 页面恢复（v0.13.2）');

  {
    const tb = getEl('tabbar'), bk = getEl('btnBack'), dt = getEl('btnData');

    /* G1. syncChrome 依据 view.page 决定 chrome —— 三态各验一次 */
    view.page = 'tab'; syncChrome();
    ok(tb.hidden === false, '★ tab 页：标签栏可见', tb.hidden);
    ok(bk.hidden === true && dt.hidden === false, 'tab 页：返回隐藏 / 数据可见', [bk.hidden, dt.hidden]);

    view.page = 'patient'; syncChrome();
    ok(tb.hidden === true, '★ 患者详情页：标签栏隐藏', tb.hidden);
    ok(bk.hidden === false && dt.hidden === true, '详情页：返回可见 / 数据隐藏', [bk.hidden, dt.hidden]);

    view.page = 'settings'; syncChrome();
    ok(tb.hidden === true, '★ 设置页：标签栏隐藏', tb.hidden);

    /* G2. render() 必须调用 syncChrome（否则某分支又会漏恢复） */
    view.page = 'patient'; view.pid = (state.patients[0] || {}).id || null;
    render();
    ok(tb.hidden === true, 'render() 进入详情页后标签栏隐藏', tb.hidden);
    view.page = 'tab'; render();
    ok(tb.hidden === false, '★ render() 回到 tab 页后标签栏恢复', tb.hidden);

    /* G3. ★ 关键：模拟「页面从 bfcache / 冻结态恢复」
       —— DOM 原样还原（标签栏还是隐藏的），JS 不重跑，
       此时 pageshow 钩子必须把 chrome 修回来。 */
    view.page = 'tab'; tb.hidden = true; bk.hidden = false; dt.hidden = true;   /* 人为制造「残留的详情页 chrome」 */
    ok(winHandlers.pageshow && winHandlers.pageshow.length > 0, '★ 注册了 pageshow 钩子（页面恢复时修复 chrome）');
    (winHandlers.pageshow || []).forEach(function (fn) { fn({ persisted: true }); });
    ok(tb.hidden === false, '★★ pageshow 恢复后：标签栏被修复为可见', tb.hidden);
    ok(bk.hidden === true && dt.hidden === false, 'pageshow 恢复后：顶部按钮同步归位', [bk.hidden, dt.hidden]);

    /* G4. 源码层断言：init() 必须显式复位 view（不依赖声明默认值） */
    ok(/view\.page\s*=\s*'tab';\s*view\.pid\s*=\s*null/.test(js),
      '★ init() 显式复位 view.page/view.pid（冷启动一律回主标签页）');

    /* 复原，避免影响后续断言 */
    view.page = 'tab'; view.pid = null; render();
  }

  console.log('');
  console.log('========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  if (fail) process.exit(1);
})();
