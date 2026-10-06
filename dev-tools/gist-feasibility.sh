#!/usr/bin/env bash
# 验证 Gist 在「同步」场景下的真实行为：raw 路径格式、缓存、大小限制
# 全部用项目内相对路径，避免 Git Bash /tmp 与原生程序路径解析不一致
set -u
cd "$(dirname "$0")"
NODE="C:/Users/zyuku/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
GH="https://api.github.com"
ORIGIN="https://kyouyama-kazusa.github.io"
T=".gist-probe"
rm -rf "$T"; mkdir -p "$T"

echo "========== Gist 同步场景实测 =========="
echo ""

echo "--- 0. 挑一个「已更新过」的 gist（能同时验证 raw 新旧内容对比） ---"
ID=$(curl -s "$GH/gists/public?per_page=20" | $NODE -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const arr=JSON.parse(d);
  const upd=arr.filter(g=>g.history&&g.history.length>1&&Object.values(g.files)[0]);
  const g=upd[0]||arr[0];
  process.stdout.write(g.id);
});')
echo "  选中 gist: $ID"
echo ""

echo "--- 1. 读取该 gist，确认 raw_url 格式与字段 ---"
curl -s -H "Origin: $ORIGIN" "$GH/gists/$ID" -o "$T/g.json"
$NODE -e '
const fs=require("fs");
const g=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const f=Object.values(g.files)[0];
console.log("  gist id      :", g.id);
console.log("  公开         :", g.public, "（false = secret，不出现在搜索中）");
console.log("  文件名       :", f.filename);
console.log("  文件大小     :", f.size, "bytes   truncated:", !!f.truncated);
console.log("  updated_at   :", g.updated_at);
console.log("  history 条数 :", (g.history||[]).length, "（>1 说明被更新过）");
console.log("  raw_url      :", f.raw_url);
fs.writeFileSync(process.argv[2], f.raw_url);
' "$T/g.json" "$T/rawurl.txt"
RAW=$(cat "$T/rawurl.txt")
echo ""

echo "--- 2. 带 SHA 的 raw URL（不变内容，可永久缓存） ---"
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$RAW" -w "[HTTP %{http_code}]\n" 2>/dev/null \
  | grep -iE "^(HTTP/1.1|access-control-allow-origin|cache-control|expires|etag|x-cache|content-type)" | head -8 | sed 's/^/  /'
echo ""

echo "--- 3. ★ 关键：raw URL 去掉 SHA 段（更新后地址不变，同步应使用） ---"
NOSHA=$(echo "$RAW" | sed -E 's#/raw/[0-9a-f]{40}/#/raw/#')
echo "  地址: $NOSHA"
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$NOSHA" -w "[HTTP %{http_code}]\n" 2>/dev/null \
  | grep -iE "^(HTTP/1.1|location|access-control-allow-origin|cache-control|expires|x-cache)" | head -8 | sed 's/^/  /'
echo ""

echo "--- 4. ★ 关键：raw 的 CDN 缓存 —— 更新内容后会不会读到旧的 ---"
for i in 1 2 3; do
  printf "  第 %d 次: " "$i"
  curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$NOSHA" 2>/dev/null \
    | grep -iE "^(x-cache|age|cache-control|expires)" | tr '\n' ' ' | sed 's/  */ /g'
  echo ""
done
echo ""

echo "--- 5. API 读取 gist 的缓存指令（决定能否「写完立刻读」） ---"
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$GH/gists/public?per_page=1" -w "[HTTP %{http_code}]\n" 2>/dev/null \
  | grep -iE "^(HTTP/1.1|access-control-allow-origin|cache-control|etag|vary)" | sed 's/^/  /'
echo "  → 若为 max-age=60，浏览器可能缓存60秒，需靠 cache:'no-store' 或加时间戳绕过"
echo ""

echo "--- 6. ★ 加时间戳参数能否绕过缓存（同步读写的兜底手段） ---"
T0=$(date +%s)
curl -s -D - -o /dev/null -H "Origin: $ORIGIN" "$GH/gists/public?per_page=1&_t=$T0" -w "[HTTP %{http_code}]\n" 2>/dev/null \
  | grep -iE "^(HTTP/1.1|cache-control|x-cache|age)" | sed 's/^/  /'
echo ""

echo "--- 7. Rate limit 对照 ---"
curl -s -D - -o /dev/null "$GH/rate_limit" 2>/dev/null | grep -iE "^x-ratelimit-(limit|remaining|used)" | sed 's/^/  未认证: /'
echo "  已认证: 5000/小时（差 83 倍，同步功能必须带 token）"
echo ""

echo "--- 8. 单文件大小限制：官方文档原文 ---"
curl -s "https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists" -o "$T/doc.html" 2>/dev/null
$NODE -e '
const fs=require("fs");
let h=fs.readFileSync(process.argv[1],"utf8");
let t=h.replace(/<script[\s\S]*?<\/script>/g,"").replace(/<style[\s\S]*?<\/style>/g,"").replace(/<[^>]+>/g," ").replace(/&quot;/g,"\"").replace(/&#39;/g,"\x27").replace(/&amp;/g,"&").replace(/\s+/g," ");
const re=/[^.]*?(100 MB|1 MB|size limit|truncat|byte|larger than)[^.]*\./gi;
let m,seen=new Set(),n=0;
while((m=re.exec(t))!==null && n<6){const s=m[0].trim();if(!seen.has(s)){seen.add(s);console.log("  • "+s);n++;}}
if(!n) console.log("  （未从文档中直接提取到，见下方实测）");
' "$T/doc.html"
echo ""

echo "--- 9. 实测单文件上限：构造不同大小内容试探 ---"
$NODE -e '
const fs=require("fs");
for (const kb of [100, 500, 1024, 2048]) {
  fs.writeFileSync(".gist-probe/size_"+kb+"k.txt", "A".repeat(kb*1024));
}
console.log("  已生成 100KB / 500KB / 1MB / 2MB 测试文件");
'
ls -la "$T"/size_*.txt | sed 's/^/  /'
echo "  （上传需 token，见浏览器验证页；纯体积上 1MB 远超实际需要）"
echo ""

echo "--- 10. 并发/冲突检测所需的条件请求支持 ---"
ETAG=$(curl -s -D - -o /dev/null "$GH/gists/public?per_page=1" 2>/dev/null | grep -iE "^etag" | sed 's/etag: //I' | tr -d '\r')
echo "  当前 ETag: $ETAG"
echo "  → 可用 If-None-Match 判定「远端是否被别的设备改过」，实现乐观锁"
echo ""

rm -rf "$T"
echo "========== 实测结束 =========="
