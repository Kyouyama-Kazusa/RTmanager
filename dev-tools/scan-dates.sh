#!/usr/bin/env bash
# 跨日期回归扫描：找出「只在今天绿、换个日期就红」的断言
#
# 用法：
#   bash scan-dates.sh                 # 默认扫描排程相关套件
#   bash scan-dates.sh qa-audit.js     # 只扫指定套件
#
# 注意：必须显式用 bash 执行。zsh 下 `for d in $dates` 不做单词分割，
#       日期不会被遍历，扫描会静默变成「只跑一次」而假绿（踩过这个坑）。

set -u
TOOLS="$(cd "$(dirname "$0")" && pwd)"
cd "$TOOLS"

DATES="2026-01-01 2026-02-17 2026-02-28 2026-05-01 2026-06-19 2026-09-25 2026-10-01 2026-10-06 \
2026-10-10 2026-12-31 2027-01-01 2027-02-06 2027-06-15 2028-02-29"

if [ $# -gt 0 ]; then
  SUITES="$*"
else
  SUITES="qa-audit.js test-rules.js test-buttons.js test-followup.js test-followup-base.js \
test-boost-stop.js test-migration.js test-merge.js test-tpl-manage.js test-caltodo-verify.js \
test-settings-sync.js test-autosync.js"
fi

bad=0
for f in $SUITES; do
  [ -f "$f" ] || continue
  for d in $DATES; do
    out=$(FAKE_TODAY="$d" node --require ./fakedate.js "$f" 2>&1)
    r=$(printf '%s' "$out" | grep -oE '通过 [0-9]+ 项，失败 [0-9]+ 项' || true)
    n=$(printf '%s' "$r" | grep -oE '失败 [0-9]+' | grep -oE '[0-9]+' || true)
    if [ -z "$r" ]; then
      echo "  ⚠ $f @ $d —— 无结果输出（脚本可能异常退出）"
      printf '%s\n' "$out" | tail -3 | sed 's/^/       /'
      bad=1
    elif [ "${n:-0}" != "0" ]; then
      echo "  ✘ $f @ $d —— $r"
      printf '%s\n' "$out" | grep '✘' | sed 's/^/       /'
      bad=1
    fi
  done
done

if [ "$bad" = "0" ]; then
  n_suites=0; for f in $SUITES; do [ -f "$f" ] && n_suites=$((n_suites+1)); done
  n_dates=0; for d in $DATES; do n_dates=$((n_dates+1)); done
  echo "✔ 全部通过（$n_suites 个套件 × $n_dates 个日期 = $((n_suites*n_dates)) 次运行）"
else
  echo ""
  echo "存在跨日期失败，见上方清单。"
  exit 1
fi
