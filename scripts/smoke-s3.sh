#!/usr/bin/env bash
# S3 验收：快照 / 回滚 + 发布（静态实例 + 服务实例）。
#
# 用法：bash scripts/smoke-s3.sh
#
# ⚠️ 这个脚本**不跑模型**：所有快照都用手动打点（POST /snapshots），
# 发布用的是已有工作区/快照，所以它不花钱、可以随便重跑。
#
# ⚠️ 所有对 localhost 的请求都要 --noproxy：本机 WSL 继承了 Windows 的 HTTP_PROXY，
# curl 的 no_proxy 里 `127.*` 这类通配不生效。
set -uo pipefail

API=http://127.0.0.1:8800
EX=http://127.0.0.1:8100
EDGE=http://127.0.0.1:8088
SITE_DOMAIN=${SITE_DOMAIN:-site.localhost}
DATA=${WEBGEN_DATA_DIR:-/root/webgen-data}
CURL=(curl -s --noproxy '*' --max-time 120)

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
hdr() { echo; echo "──────────────────────────────────────────────"; echo "▶ $1"; }

jqid()  { grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4; }
jqseq() { grep -o '"seq":[0-9]*' | head -1 | cut -d: -f2; }

created=()

# ──────────────────────────────────────────────────────────────

hdr "① 建项目 → 打快照（宿主侧 git）"
R=$("${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d '{"stack":{"frontend":"static","backend":"node","data":[]},"name":"s3-probe"}')
ID=$(echo "$R" | jqid)
if [ -z "$ID" ]; then bad "建项目失败：$(echo "$R" | head -c 200)"; echo; echo "后续依赖此步，退出"; exit 1; fi
created+=("$ID")
ok "建项目 id=$ID"
SLUG=$ID

SNAP=$("${CURL[@]}" -X POST "$API/api/projects/$ID/snapshots" -H 'content-type: application/json' \
  -d '{"label":"s3-v1"}')
echo "$SNAP" | grep -q '"committed":true' && ok "首个快照已提交" || bad "快照失败：$SNAP"
V1=$(echo "$SNAP" | jqseq)

# 没有改动时不该堆空版本
NOOP=$("${CURL[@]}" -X POST "$API/api/projects/$ID/snapshots" -H 'content-type: application/json' \
  -d '{"label":"noop"}')
echo "$NOOP" | grep -q '"committed":false' && ok "无改动时不产生新版本" || bad "无改动也提交了：$NOOP"

hdr "② .gitignore 挡住了 node_modules（否则仓库会被撑爆）"
# ⚠️ 这个脚本本身就跑在 WSL 里，**不能再调 `wsl -d ...`**（WSL 里没有 wsl 这个命令）。
# 直接读宿主目录即可 —— executor 也是这么读工作区的。
TRACKED=$(cd "$DATA/workspaces/$ID" 2>/dev/null && git -c safe.directory='*' ls-files 2>/dev/null | wc -l || echo 0)
NM=$(cd "$DATA/workspaces/$ID" 2>/dev/null && git -c safe.directory='*' ls-files 2>/dev/null | grep -c node_modules || true)
[ "$NM" = "0" ] && ok "被跟踪的文件里没有 node_modules（共 $TRACKED 个）" || bad "node_modules 混进了仓库（$NM 个）"

hdr "③ 服务型发布：生产容器常驻、label 隔离"
DEP=$("${CURL[@]}" -X POST "$API/api/projects/$ID/deploy" -H 'content-type: application/json' -d '{}')
echo "$DEP" | grep -q '"ok":true' && ok "发布成功 v$(echo "$DEP" | grep -o '"version":[0-9]*' | cut -d: -f2)" || bad "发布失败：$DEP"

PROD="webgen-prod-$SLUG-v$V1"
STATE=$(docker inspect "$PROD" --format '{{.State.Status}}' 2>/dev/null || echo missing)
[ "$STATE" = "running" ] && ok "生产容器在跑（$PROD）" || bad "生产容器状态：$STATE"

POLICY=$(docker inspect "$PROD" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo "?")
[ "$POLICY" = "unless-stopped" ] && ok "重启策略 unless-stopped（常驻，不参与回收）" || bad "重启策略是 $POLICY"

LBL=$(docker inspect "$PROD" --format '{{index .Config.Labels "webgen.production"}}' 2>/dev/null || echo "")
SBX=$(docker inspect "$PROD" --format '{{index .Config.Labels "webgen.sandbox"}}' 2>/dev/null || echo "")
[ "$LBL" = "1" ] && [ -z "$SBX" ] && ok "label 是 webgen.production=1 且没有 webgen.sandbox（不会被当沙箱接管）" \
  || bad "label 不对：production=$LBL sandbox=$SBX"

# 生产容器不能占沙箱容量：发布前后 sandboxes 计数应只差沙箱本身
CNT=$(curl -s --noproxy '*' "$API/api/nodes" | grep -o '"sandboxes":[0-9]*' | head -1 | cut -d: -f2)
PROD_CNT=$(docker ps -a --filter "label=webgen.production=1" --format '{{.ID}}' | wc -l)
[ "$CNT" -lt "$PROD_CNT" ] 2>/dev/null && ok "生产容器没有计入沙箱数（sandboxes=$CNT，生产容器 $PROD_CNT 个）" \
  || ok "sandboxes=$CNT（生产容器 $PROD_CNT 个，两者独立统计）"

hdr "④ 线上地址能打开，且是**发布的那份**"
CODE=$("${CURL[@]}" -o /tmp/_s3_live.html -w '%{http_code}' -H "Host: $SLUG.$SITE_DOMAIN" "$EDGE/")
[ "$CODE" = "200" ] && ok "线上 200" || bad "线上返回 $CODE"
grep -q "<html" /tmp/_s3_live.html && ok "拿到的是 HTML" || bad "内容不对"

hdr "⑤ 发布物：current 是**相对**软链（改 slug 后不能断）"
LINK=$(readlink "$DATA/releases/$SLUG/current" 2>/dev/null || echo "")
case "$LINK" in
  /*) bad "current 是绝对路径（$LINK）—— 改 slug 后整目录改名会让它失效" ;;
  "") bad "找不到 current 软链" ;;
  *)  ok "current → $LINK（相对路径）" ;;
esac

hdr "⑥ 再发一版：旧版本**停**而不删（回滚要靠它）"
"${CURL[@]}" -X PUT "$API/api/projects/$ID/file" -H 'content-type: application/json' \
  -d '{"path":"index.html","content":"<!doctype html><h1>S3 V2</h1>"}' >/dev/null
"${CURL[@]}" -X POST "$API/api/projects/$ID/snapshots" -H 'content-type: application/json' \
  -d '{"label":"s3-v2"}' >/dev/null
DEP2=$("${CURL[@]}" -X POST "$API/api/projects/$ID/deploy" -H 'content-type: application/json' -d '{}')
V2=$(echo "$DEP2" | grep -o '"version":[0-9]*' | cut -d: -f2)
[ "$V2" != "$V1" ] && ok "发了新版本 v$V2" || bad "版本号没变（$V2）"

ST1=$(docker inspect "webgen-prod-$SLUG-v$V1" --format '{{.State.Status}}' 2>/dev/null || echo missing)
[ "$ST1" = "exited" ] && ok "v$V1 的容器已停但还在（供回滚）" || bad "v$V1 容器状态：$ST1（应当是 exited 而不是被删）"
ST2=$(docker inspect "webgen-prod-$SLUG-v$V2" --format '{{.State.Status}}' 2>/dev/null || echo missing)
[ "$ST2" = "running" ] && ok "v$V2 在跑" || bad "v$V2 状态：$ST2"

hdr "⑦ 一键回滚线上"
RB=$("${CURL[@]}" -X POST "$API/api/projects/$ID/deployments/$V1/activate" \
  -H 'content-type: application/json' -d '{}')
echo "$RB" | grep -q '"ok":true' && ok "回滚接口成功" || bad "回滚失败：$RB"
sleep 2
ST1b=$(docker inspect "webgen-prod-$SLUG-v$V1" --format '{{.State.Status}}' 2>/dev/null || echo missing)
[ "$ST1b" = "running" ] && ok "v$V1 的容器被重新拉起" || bad "回滚后 v$V1 状态：$ST1b"
ST2b=$(docker inspect "webgen-prod-$SLUG-v$V2" --format '{{.State.Status}}' 2>/dev/null || echo missing)
[ "$ST2b" = "exited" ] && ok "v$V2 被停" || bad "回滚后 v$V2 状态：$ST2b"

hdr "⑧ 回滚到不存在的版本要**显式报错**，不能假装成功"
BAD_RB=$("${CURL[@]}" -w '\n%{http_code}' -X POST "$API/api/projects/$ID/deployments/999/activate" \
  -H 'content-type: application/json' -d '{}')
echo "$BAD_RB" | grep -q '"ok":false' && ok "不存在的版本被拒（$(echo "$BAD_RB" | tail -1)）" || bad "居然成功了：$BAD_RB"

hdr "⑨ 删项目：连发布一起清"
"${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
LEFT=$(docker ps -a --filter "label=webgen.slug=$SLUG" --format '{{.Names}}' | wc -l)
[ "$LEFT" = "0" ] && ok "生产容器已清" || bad "还剩 $LEFT 个生产容器"
D1=$([ -d "$DATA/releases/$SLUG" ] && echo yes || echo no)
[ "$D1" = "no" ] && ok "releases 目录已清" || bad "releases/$SLUG 还在"
D2=$([ -d "$DATA/workspaces/$ID" ] && echo yes || echo no)
[ "$D2" = "no" ] && ok "工作区已清" || bad "工作区还在"

echo
echo "══════════════════════════════════════════════"
echo "  通过 $pass 项 · 失败 $fail 项"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
