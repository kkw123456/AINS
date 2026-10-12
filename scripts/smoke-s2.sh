#!/usr/bin/env bash
# S2 验收（接口层）：对照 docs/DESIGN.md §9 里前端要用、但 S1 之前没有的那几个接口。
#
# 用法：
#   bash scripts/smoke-s2.sh              # 只跑不花钱的检查
#   bash scripts/smoke-s2.sh --mutex      # 额外验「生成中拒绝写文件」(§14 C3)
#                                         # ⚠️ 这一步会真起一轮生成，花模型钱
#
# 浏览器那一层的验收（三栏、SSE、预览、diff）没法脚本化，
# 见 README「S2 验收」一节的手工步骤。
#
# ⚠️ 所有对 localhost 的请求都要 --noproxy：本机 WSL 继承了 Windows 的 HTTP_PROXY，
# curl 的 no_proxy 里 `127.*` 这种通配不生效，不绕开会拿到代理返回的页面。
set -uo pipefail

API=http://127.0.0.1:8800
CURL=(curl -s --noproxy '*' --max-time 60)
MUTEX=0
[ "${1:-}" = "--mutex" ] && MUTEX=1

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
hdr() { echo; echo "──────────────────────────────────────────────"; echo "▶ $1"; }

jqid() { grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4; }

# ──────────────────────────────────────────────────────────────

hdr "① 建一个探针项目（不带 prompt，不起生成、不花钱）"
PROJ=$("${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d '{"stack":{"frontend":"static","backend":"node","data":[]},"name":"s2-smoke"}')
ID=$(echo "$PROJ" | jqid)
# ⚠️ 注意是 $API/api/projects —— 直接写 $API/projects 会漏掉 /api 前缀，
# 拿到的是一堆 Fastify 默认 404（"Route GET:/projects/... not found"），排查起来很误导。
if [ -n "$ID" ]; then ok "建项目 id=$ID"; else
  bad "建项目失败：$PROJ"; echo; echo "后续依赖此步，退出"; exit 1
fi

hdr "② 项目列表带 updatedAt（首页卡片要的「最近改动时间」）"
LIST=$("${CURL[@]}" "$API/api/projects")
echo "$LIST" | grep -q '"updatedAt":"' && ok "列表里有 updatedAt" || bad "列表里没有 updatedAt"

hdr "③ 项目详情带完整 spec（前端要靠 artifactDir 切两个根）"
DETAIL=$("${CURL[@]}" "$API/api/projects/$ID")
echo "$DETAIL" | grep -q '"spec":{' && ok "详情里有 spec" || bad "详情里没有 spec"
echo "$DETAIL" | grep -q '"runCommand"' && ok "spec 是完整的（含 runCommand）" || bad "spec 被裁剪过"

hdr "④ 本轮 diff 接口（没跑过生成 → 空数组，且不是错误）"
DIFF=$("${CURL[@]}" "$API/api/projects/$ID/diff")
echo "$DIFF" | grep -q '"ok":true' && ok "diff 返回 ok" || bad "diff 失败：$DIFF"
echo "$DIFF" | grep -q '"files":\[\]' && ok "未跑过生成时是空数组（不是报错）" || bad "空状态不对：$DIFF"

hdr "⑤ files 的 dir 参数（源码 / 构建产物两个根）"
ROOT=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$API/api/projects/$ID/files")
[ "$ROOT" = "200" ] && ok "不带 dir 返回 200" || bad "不带 dir 返回 $ROOT"
NOPE=$("${CURL[@]}" "$API/api/projects/$ID/files?dir=does-not-exist")
echo "$NOPE" | grep -q '"ok":false' && ok "不存在的 dir 显式报错（不是空列表）" || bad "不存在的 dir：$NOPE"

hdr "⑥ 导出 zip（工作区）"
CT=$("${CURL[@]}" -o /tmp/_s2.zip -w '%{content_type}' "$API/api/projects/$ID/export?scope=workspace")
case "$CT" in
  application/zip*) ok "content-type 是 zip" ;;
  *) bad "content-type 是 $CT" ;;
esac
# zip 的魔数：PK\x03\x04
if [ "$(head -c 2 /tmp/_s2.zip)" = "PK" ]; then ok "是合法的 zip（PK 魔数）"; else bad "不是 zip"; fi
if command -v python3 >/dev/null 2>&1; then
  ENTRIES=$(python3 -c 'import zipfile,sys; print(len(zipfile.ZipFile("/tmp/_s2.zip").infolist()))' 2>/dev/null || echo 0)
  [ "$ENTRIES" -gt 0 ] && ok "zip 里有 $ENTRIES 个文件" || bad "zip 是空的"
  # node_modules 绝不能进包（§5.3：一个装过依赖的工作区几万个文件）
  if python3 -c 'import zipfile,sys; names=zipfile.ZipFile("/tmp/_s2.zip").namelist(); sys.exit(1 if any("node_modules" in n for n in names) else 0)'; then
    ok "zip 里没有 node_modules"
  else
    bad "zip 里混进了 node_modules"
  fi
else
  echo "  ⚠️  没有 python3，跳过 zip 内部检查"
fi

hdr "⑦ 导出「构建产物」：一期所有模板都是服务型，必须显式说明（不是 500）"
ART=$("${CURL[@]}" -w '\n%{http_code}' "$API/api/projects/$ID/export?scope=artifacts")
ART_CODE=$(echo "$ART" | tail -1)
echo "$ART" | grep -q '没有独立的构建产物目录' \
  && ok "给的是「服务型没有构建产物」这句人话（HTTP $ART_CODE）" \
  || bad "artifacts 的报错不对：$ART"

if [ "$MUTEX" = "1" ]; then
  hdr "⑧ 写入互斥（§14 C3）：生成中 PUT 必须 409"
  printf '{"text":"just say ok, do not change any file"}' > /tmp/_s2_msg.json
  printf '{"path":"index.html","content":"x"}' > /tmp/_s2_put.json
  "${CURL[@]}" -X POST "$API/api/projects/$ID/messages" -H 'content-type: application/json' \
    --data-binary @/tmp/_s2_msg.json >/dev/null
  CODE=$("${CURL[@]}" -o /tmp/_s2_resp.json -w '%{http_code}' -X PUT "$API/api/projects/$ID/file" \
    -H 'content-type: application/json' --data-binary @/tmp/_s2_put.json)
  [ "$CODE" = "409" ] && ok "生成中写入被拒（409）" || bad "生成中写入返回了 $CODE，期望 409：$(cat /tmp/_s2_resp.json)"
  echo "  …等这一轮跑完"
  for _ in $(seq 1 80); do
    "${CURL[@]}" "$API/api/projects/$ID/agent" | grep -q '"running":false' && break
    sleep 5
  done
  CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X PUT "$API/api/projects/$ID/file" \
    -H 'content-type: application/json' --data-binary @/tmp/_s2_put.json)
  [ "$CODE" = "200" ] && ok "跑完之后写入恢复（200）" || bad "跑完之后写入返回 $CODE，期望 200"
  echo "  （这一轮真跑了生成，会花模型钱）"
else
  hdr "⑧ 写入互斥 —— 已跳过"
  echo "  ⚠️  要验它得真起一轮生成（花模型钱），加 --mutex 才跑"
fi

hdr "清理"
"${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
ok "已删除探针项目"

echo
echo "══════════════════════════════════════════════"
echo "  通过 $pass 项 · 失败 $fail 项"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
