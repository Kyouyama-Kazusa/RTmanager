/* 仅用于回归测试的「假今天」注入器（不属于应用代码，也不部署）。
   用法：FAKE_TODAY=2026-10-07 node --require ./_fakedate.js qa-audit.js
   目的：扫描哪些断言依赖运行当天，避免在节假日/跨年/无数据年份等
   特定日期误报失败（2026-10-06 就因国庆假期暴露过一例）。 */
const target = process.env.FAKE_TODAY;
if (target) {
  const Real = Date;
  const fixed = new Real(target + 'T09:00:00').getTime();
  function FakeDate(...a) {
    if (!(this instanceof FakeDate)) return new Real(...a).toString();
    return a.length === 0 ? new Real(fixed) : new Real(...a);
  }
  FakeDate.prototype = Real.prototype;
  FakeDate.now = () => fixed;
  FakeDate.parse = Real.parse;
  FakeDate.UTC = Real.UTC;
  global.Date = FakeDate;
  process.stderr.write('[fakedate] today = ' + target + '\n');
}
