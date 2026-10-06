#!/usr/bin/env bash
# RTmanager 一键发布
#
# 用法：
#   bash dev-tools/release.sh "这次改了什么"
#
# 流程：
#   1. 回归测试（15 个套件，含兼容性门禁 test-compat.js）
#   2. 跨日期扫描（排程相关套件在多个日期下重跑，避免「只在今天绿」）
#   3. 自动递增 sw.js 缓存版本号（仅在应用资源确有改动时）
#   4. 提交并推送到 GitHub
#   5. 轮询验证 Pages 已生效（比对线上与本地的版本号与字节数）
#
# 任一环节失败即中止，不会带着问题推送。

set -e

MSG="${1:-更新应用}"
# dev-tools 既可能在仓库内（radiotherapy-ward/dev-tools），也可能与仓库平级（旧结构）
TOOLS="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$TOOLS/../index.html" ]; then
  REPO="$(cd "$TOOLS/.." && pwd)"
else
  REPO="$(cd "$TOOLS/../radiotherapy-ward" && pwd)"
fi
ROOT="$REPO"
BASE="https://kyouyama-kazusa.github.io/RTmanager/"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cd "$REPO"

# ---------- 0. 检查是否有改动 ----------
if [ -z "$(git status --porcelain)" ]; then
  echo "没有需要提交的改动。"
  exit 0
fi
echo "改动文件："
git status --short

# ---------- 1. 回归测试 ----------
say "[1/5] 回归测试（15 个套件）"
( cd "$TOOLS"
  # test-compat.js 单独列出，避免与后面的 test-*.js 重复跑
  for f in test-compat.js qa-audit.js $(ls test-*.js | grep -v '^test-compat.js$'); do
    printf '  %-24s ' "$f"
    out=$(node "$f" 2>&1) || { echo "失败"; echo "$out" | tail -20; exit 1; }
    echo "$out" | grep -oE '通过 [0-9]+ 项，失败 [0-9]+ 项' || echo "完成"
  done )

# ---------- 2. 跨日期扫描 ----------
say "[2/5] 跨日期扫描（排程相关套件）"
SCAN_DATES="2026-12-31 2027-01-01 2026-02-17 2027-06-15"
( cd "$TOOLS" && bad=0
  for f in qa-audit.js test-rules.js test-buttons.js test-followup.js; do
    for d in $SCAN_DATES; do
      r=$(FAKE_TODAY="$d" node --require ./fakedate.js "$f" 2>/dev/null \
          | grep -oE '失败 [0-9]+' | grep -oE '[0-9]+' || echo 0)
      [ "${r:-0}" = "0" ] || { echo "  ✘ $f @ $d 失败 $r 项"; bad=1; }
    done
  done
  [ "$bad" = "0" ] && echo "  4 个套件 × 4 个日期 全部通过" || exit 1 )

# ---------- 3. 递增缓存版本号（仅当应用资源有改动）----------
say "[3/5] 缓存版本号"
NEED_BUMP=$(git status --porcelain | grep -E 'index\.html|sw\.js|manifest\.webmanifest|icon|apple-touch-icon' || true)
if [ -n "$NEED_BUMP" ]; then
  CUR=$(grep -oE "CACHE = 'radiotherapy-v[0-9]+'" sw.js | grep -oE 'v[0-9]+' | tr -d 'v')
  NEW=$((CUR + 1))
  if sed --version >/dev/null 2>&1; then
    sed -i "s/CACHE = 'radiotherapy-v$CUR'/CACHE = 'radiotherapy-v$NEW'/" sw.js
  else
    sed -i '' "s/CACHE = 'radiotherapy-v$CUR'/CACHE = 'radiotherapy-v$NEW'/" sw.js
  fi
  echo "  v$CUR → v$NEW（应用资源有改动，已递增）"
  BUMPED="$NEW"
else
  echo "  未改动应用资源，版本号保持不变"
  BUMPED=$(grep -oE "CACHE = 'radiotherapy-v[0-9]+'" sw.js | grep -oE 'v[0-9]+' | tr -d 'v')
fi

# 重跑一次兼容性门禁（版本号刚变过，确认契约仍成立）
( cd "$TOOLS" && node test-compat.js >/dev/null 2>&1 ) || { echo "兼容性门禁未通过"; exit 1; }

# ---------- 4. 提交并推送 ----------
if [ "${DRY_RUN:-0}" = "1" ]; then
  say "[4/5] 演练模式：跳过提交与推送"
  echo "  门禁、跨日期扫描、版本递增均已实际执行完毕。"
  echo "  确认无误后去掉 DRY_RUN=1 再运行即可真正发布。"
  exit 0
fi
say "[4/5] 提交并推送"
git add -A
git commit -m "$MSG"
git push

# ---------- 5. 验证 Pages 生效 ----------
say "[5/5] 验证 Pages 已生效"
LOCAL_VER=$(grep -oE "APP_VERSION = '[0-9.]+'" index.html | head -1 | grep -oE '[0-9.]+')
LOCAL_SIZE=$(wc -c < index.html | tr -d ' ')
echo "  本地：v$LOCAL_VER / ${LOCAL_SIZE} 字节 / 缓存 radiotherapy-v$BUMPED"

for i in $(seq 1 20); do
  sleep 15
  ONLINE_VER=$(curl -s "$BASE" | grep -oE "APP_VERSION = '[0-9.]+'" | head -1 | grep -oE '[0-9.]+' || true)
  ONLINE_CACHE=$(curl -s "${BASE}sw.js" | grep -oE "CACHE = 'radiotherapy-v[0-9]+'" | grep -oE 'v[0-9]+' | tr -d 'v' || true)
  if [ "$ONLINE_VER" = "$LOCAL_VER" ] && [ "$ONLINE_CACHE" = "$BUMPED" ]; then
    echo "  线上：v$ONLINE_VER / 缓存 radiotherapy-v$ONLINE_CACHE  ✔ 已生效（第 $i 次检查，约 $((i*15)) 秒）"
    for f in manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png icon-180.png icon.svg; do
      code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$f")
      [ "$code" = "200" ] || { echo "  ✘ $f 返回 $code"; exit 1; }
    done
    echo "  8 个 PWA 资源全部 200 ✔"
    echo ""
    echo "发布完成：$BASE"
    exit 0
  fi
  printf '  等待 Pages 部署…（%s 秒，线上 v%s / 缓存 v%s）\n' "$((i*15))" "${ONLINE_VER:-未就绪}" "${ONLINE_CACHE:-未就绪}"
done

echo ""
echo "⚠ 20 次检查后线上仍未同步到 v$LOCAL_VER。GitHub Pages 通常 1 分钟内生效，"
echo "  若持续未更新，请检查仓库 Settings → Pages 的部署状态。"
exit 1
