#!/usr/bin/env bash
# RTmanager 项目资产包打包
#
# 用法：
#   bash dev-tools/pack-asset.sh            # 校验 + 打包
#   SKIP_TESTS=1 bash dev-tools/pack-asset.sh   # 跳过回归校验（不建议）
#
# 用途：
#   发布流程的**第二步**。release.sh 把代码推到 GitHub 之后，用本脚本把
#   当前的完整工作区打成资产包，供上传到项目网盘。
#
#   ⚠ 本脚本**不负责上传**。网盘上传需要 MCP 工具签发的临时凭证
#     （confirm_key / task_id / x-cos-security-token），纯 bash 拿不到，
#     必须由智能体调用 tdrive.file_upload → curl PUT → file_upload_complete
#     三步完成。本脚本只把包**备好**并对齐命名。
#
# 打包规则（与 2026-10-08 首次上传的包保持一致）：
#   - 顶层带 RTmanager/ 目录（解压不散落）
#   - 含 radiotherapy-ward/.git（保留完整提交历史，接手者可 git log）
#   - 排除：旧资产包自身、*.pyc、__pycache__、.DS_Store
#   - 文件名：RTmanager-v<版本>-<日期>.zip，如 RTmanager-v0.13.2-2026-10-08.zip
#
#   ★ 为什么文件名带版本号（2026-10-08 用户要求）：
#     纯日期命名（RTmanager-2026-10-08.zip）在「同一天发两次」时必然撞车 ——
#     要么覆盖旧包、要么被网盘自动改成 "(1)"，两种都很糟：前者丢历史，
#     后者名字里出现空格和括号，后续脚本引用还要转义。
#     带上版本号后，同一天发多个版本天然不同名；版本号相同还撞车说明是重复发布，
#     这时候再加 -2 后缀提醒一下（正常不该发生）。
#
# 产出：/workspace/RTmanager-v<版本>-<日期>.zip（用户工作区可见）

set -e

TOOLS="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$TOOLS/../index.html" ]; then
  REPO="$(cd "$TOOLS/.." && pwd)"          # git 根 = radiotherapy-ward
else
  REPO="$(cd "$TOOLS/../radiotherapy-ward" && pwd)"
fi
ROOT="$(cd "$REPO/.." && pwd)"             # 工作区根 = RTmanager
STAGE="/tmp/rt-asset-stage"
OUT_DIR="/workspace"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cd "$REPO"

# ---------- 0. 前置检查 ----------
say "[1/4] 前置检查"

if [ -n "$(git status --porcelain)" ]; then
  echo "  ⚠ 仓库有未提交改动："
  git status --short | sed 's/^/    /'
  echo "  建议先跑 release.sh 发布，再打包，避免资产包与线上版本不一致。"
else
  echo "  ✔ 仓库干净"
fi

VER=$(grep -oE "APP_VERSION = '[0-9.]+'" index.html | head -1 | grep -oE '[0-9.]+')
CACHE=$(grep -oE "CACHE = 'radiotherapy-v[0-9]+'" sw.js | grep -oE 'v[0-9]+' | tr -d 'v')
COMMIT=$(git log --oneline -1)
echo "  版本：v$VER / 缓存 radiotherapy-v$CACHE"
echo "  提交：$COMMIT"

# ---------- 1. 回归校验 ----------
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  say "[2/4] 回归校验：已跳过（SKIP_TESTS=1）"
else
  say "[2/4] 回归校验（防止把坏版本打进资产包）"
  ( cd "$TOOLS"
    TOTAL=0; FAILED=0
    for f in test-compat.js qa-audit.js $(ls test-*.js | grep -v '^test-compat.js$'); do
      out=$(node "$f" 2>&1) || { echo "  ✘ $f 执行失败"; echo "$out" | tail -20; exit 1; }
      p=$(echo "$out" | grep -oE '通过 [0-9]+' | grep -oE '[0-9]+' | tail -1)
      x=$(echo "$out" | grep -oE '失败 [0-9]+' | grep -oE '[0-9]+' | tail -1)
      TOTAL=$((TOTAL + ${p:-0}))
      FAILED=$((FAILED + ${x:-0}))
    done
    echo "  断言合计 $TOTAL 项，失败 $FAILED 项"
    [ "$FAILED" = "0" ] || exit 1 )
fi

# ---------- 2. 打包 ----------
say "[3/4] 打包"

DATE=$(date +%F)
NAME="RTmanager-v$VER-$DATE.zip"
# 版本号 + 日期仍重名，说明同一版本在同一天重复打包（正常不该发生）。
# 加序号而不是覆盖，避免悄悄抹掉已上传的同名包。
n=1
while [ -e "$OUT_DIR/$NAME" ]; do
  n=$((n + 1))
  NAME="RTmanager-v$VER-$DATE-$n.zip"
done

rm -rf "$STAGE"
mkdir -p "$STAGE/RTmanager"

# 复制工作区（排除旧资产包、缓存产物）
(
  cd "$ROOT"
  for item in * .workbuddy; do
    case "$item" in
      *.zip) continue ;;                 # 旧资产包不进新包，避免体积翻倍
      __pycache__|*.pyc) continue ;;
      .DS_Store) continue ;;
    esac
    [ -e "$item" ] || continue
    cp -a "$item" "$STAGE/RTmanager/"
  done
)

( cd "$STAGE" && zip -rq "$OUT_DIR/$NAME" RTmanager )

SIZE=$(stat -c%s "$OUT_DIR/$NAME" 2>/dev/null || stat -f%z "$OUT_DIR/$NAME")
# unzip -l 末行形如 "  4357773                     428 files"，取 files 前的数字
COUNT=$(unzip -l "$OUT_DIR/$NAME" | tail -1 | grep -oE '[0-9]+ files' | grep -oE '[0-9]+')
SHA=$(sha256sum "$OUT_DIR/$NAME" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUT_DIR/$NAME" | cut -d' ' -f1)

echo "  文件：$OUT_DIR/$NAME"
echo "  大小：$SIZE 字节"
echo "  条目：$COUNT"
echo "  SHA256：$SHA"

# ---------- 3. 完整性快检 ----------
say "[4/4] 完整性快检"
CHECK_FAIL=0
for f in "RTmanager/radiotherapy-ward/index.html" "RTmanager/radiotherapy-ward/sw.js" "RTmanager/HANDOVER.md"; do
  if unzip -l "$OUT_DIR/$NAME" | grep -qF "$f"; then
    echo "  ✔ $f"
  else
    echo "  ✘ 缺少 $f"
    CHECK_FAIL=1
  fi
done
if unzip -l "$OUT_DIR/$NAME" | grep -q "RTmanager/radiotherapy-ward/.git/HEAD"; then
  echo "  ✔ .git 历史已包含"
else
  echo "  ✘ 未包含 .git 历史"
  CHECK_FAIL=1
fi
[ "$CHECK_FAIL" = "0" ] || { echo "资产包不完整，请排查。"; exit 1; }

rm -rf "$STAGE"

say "打包完成 —— 下一步：上传到项目网盘"
cat <<EOF
  资产包已备好：$OUT_DIR/$NAME

  ⚠ 上传必须由智能体调用 MCP 工具完成（脚本无签名能力）：
     1. tdrive.file_upload      → 传 dir_id=项目网盘根、file_name=$NAME、file_size=$SIZE
                                  建议 conflict_strategy=rename
     2. curl -sSL -X PUT -H ... -T "$OUT_DIR/$NAME" "<返回的 URL>"
        ※ 凭证含 & 和 ; ，务必写进 curl 配置文件（header = "..."）执行，
          不要直接拼在命令行里，否则会被 shell 转义破坏 → 403 / InvalidAccessKeyId
     3. tdrive.file_upload_complete → 回填 confirm_key 与 task_id 落库

  项目网盘根目录 dir_id：awpKWAQQgNgW
EOF
