#!/usr/bin/env bash
# 一键更新并推送到 GitHub Pages
#
# 用法：
#   bash dev-tools/push.sh "这次改了什么"
#
# 它会自动：
#   1. 递增 sw.js 里的缓存版本号（radiotherapy-v4 → v5），避免客户端停留在旧版本
#   2. 提交全部改动
#   3. 推送到 GitHub（Pages 会自动重新部署，约 1 分钟生效）

set -e

# dev-tools 既可能在仓库内，也可能与仓库平级（旧结构）
TOOLS="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$TOOLS/../index.html" ]; then
  REPO="$(cd "$TOOLS/.." && pwd)"
else
  REPO="$(cd "$TOOLS/../radiotherapy-ward" && pwd)"
fi
MSG="${1:-更新应用}"

cd "$REPO"

# ---------- 检查是否有改动 ----------
if [ -z "$(git status --porcelain)" ]; then
  echo "没有需要提交的改动。"
  exit 0
fi

echo "改动文件："
git status --short
echo ""

# ---------- 自动递增缓存版本号 ----------
CUR=$(grep -oE "CACHE = 'radiotherapy-v[0-9]+'" sw.js | grep -oE 'v[0-9]+' | tr -d 'v')
NEW=$((CUR + 1))
if [ "$NEW" -gt "$CUR" ]; then
  # 兼容 macOS(BSD) 与 Linux(GNU) 两种 sed
  if sed --version >/dev/null 2>&1; then
    sed -i "s/CACHE = 'radiotherapy-v$CUR'/CACHE = 'radiotherapy-v$NEW'/" sw.js
  else
    sed -i '' "s/CACHE = 'radiotherapy-v$CUR'/CACHE = 'radiotherapy-v$NEW'/" sw.js
  fi
  echo "缓存版本：v$CUR → v$NEW"
else
  echo "警告：未能识别当前缓存版本号，请手动检查 sw.js"
fi

# ---------- 提交并推送 ----------
git add -A
git commit -m "$MSG"
git push

echo ""
echo "已推送。GitHub Pages 约 1 分钟后更新："
echo "  https://kyouyama-kazusa.github.io/RTmanager/"
