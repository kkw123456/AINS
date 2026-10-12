#!/usr/bin/env bash
# S0 验收脚本：对照 docs/DESIGN.md §11 的 S0 八条验收标准。
#
# 用法：bash scripts/smoke.sh
#
# ⚠️ 所有对 localhost 的请求都要 --noproxy：本机 WSL 继承了 Windows 的
# HTTP_PROXY(127.0.0.1:7890)，而 curl 的 no_proxy 里的 `127.*` 这种通配是不生效的，
# 不绕开就会拿到代理返回的页面（排查时被骗过一次）。
set -uo pipefail

API=http://127.0.0.1:8800
EDGE=http://127.0.0.1:8088
CURL=(curl -s --noproxy '*' --max-time 120)

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
hdr() { echo; echo "──────────────────────────────────────────────"; echo "▶ $1"; }

jqid() { grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4; }

create() { # $1=组合 JSON（stack 对象） $2=name
  "${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
    -d "{\"stack\":$1,\"name\":\"$2\"}"
}

# S4：老模板（node-web / fastapi…）收敛成了组合预设，脚本一律按组合建。
STACK_NODE='{"frontend":"static","backend":"node","data":[]}'
STACK_PY='{"frontend":"static","backend":"python","data":[]}'

wait_ready() { # $1=id
  "${CURL[@]}" -X POST "$API/api/projects/$1/wait" -H 'content-type: application/json' \
    -d '{"timeoutMs":90000}'
}

preview() { # $1=id  -> http code
  "${CURL[@]}" -o /tmp/_pv.html -w '%{http_code}' -H "Host: p-$1.localhost" "$EDGE/"
}

preview_retry() { # $1=id $2=重试次数(默认 20，每次 0.5s)
  local n=${2:-20} i=1 code=000
  while [ "$i" -le "$n" ]; do
    code=$(preview "$1")
    [ "$code" = "200" ] && { echo 200; return; }
    sleep 0.5
    i=$((i + 1))
  done
  echo "$code"
}

# 删完之后等路由**真的**从表里消失。Traefik 摘路由是异步的，
# 删完立刻探会拿到 502（路由还在但容器没了），那是时序不是故障。
preview_gone() { # $1=id $2=重试次数(默认 20，每次 0.5s)
  local n=${2:-20} i=1 code=000
  while [ "$i" -le "$n" ]; do
    code=$(preview "$1")
    case "$code" in
      404|000) echo "$code"; return ;;
    esac
    sleep 0.5
    i=$((i + 1))
  done
  echo "$code"
}

# ──────────────────────────────────────────────────────────────

hdr "① 建项目 → 沙箱里跑起来"
t0=$(date +%s)
NODE_JSON=$(create "$STACK_NODE" "smoke-node")
NODE_ID=$(echo "$NODE_JSON" | jqid)
if [ -n "$NODE_ID" ]; then ok "建项目成功 id=$NODE_ID"; else
  bad "建项目失败：$NODE_JSON"; echo; echo "后续依赖此步，退出"; exit 1
fi
"${CURL[@]}" -X POST "$API/api/projects/$NODE_ID/wait" \
  -H 'content-type: application/json' -d '{"timeoutMs":90000}' >/dev/null
t1=$(date +%s)
ok "沙箱就绪，耗时 $((t1 - t0)) 秒"

hdr "② 浏览器打开 p-<id>.localhost 能看到页面"
CODE=$(preview_retry "$NODE_ID" 6)
if [ "$CODE" = "200" ]; then ok "预览返回 200"; else bad "预览返回 $CODE"; fi

hdr "③ 建到能看 15 秒内（含预热）"
if [ $((t1 - t0)) -lt 15 ]; then ok "总耗时 $((t1 - t0))s < 15s"; else
  echo "  ⚠️  总耗时 $((t1 - t0))s ≥ 15s（首次建容器会慢一些）"
fi

hdr "④ 沙箱停止状态下仍能列出/读取工作区文件"
"${CURL[@]}" -X POST "$API/api/projects/$NODE_ID/editor/stop" >/dev/null
# 停掉编辑容器后，只剩预览容器（S3 拆分：编辑容器 `d-<id>`、预览容器 `p-<id>`）
STILL=$(docker ps -a --filter "name=webgen-sbx-$NODE_ID" --format '{{.Names}}' | wc -l)
[ "$STILL" = "0" ] && ok "编辑容器已删除" || bad "编辑容器仍在：$STILL 个"
FILES=$("${CURL[@]}" "$API/api/projects/$NODE_ID/files")
echo "$FILES" | grep -q '"path":"backend"' && ok "文件树可列（含 backend/ 目录）" || bad "列文件失败"
CONTENT=$("${CURL[@]}" "$API/api/projects/$NODE_ID/file?path=backend/package.json")
echo "$CONTENT" | grep -q 'fastify' && ok "文件内容可读（backend/package.json）" || bad "读文件失败"

# ★ S3 拆分的核心性质（§1.3「编辑容器不能当运行容器」）：
# 编辑容器停掉**不该**影响用户看到的那份 —— 预览是另一个容器。
[ "$(preview "$NODE_ID")" = "200" ] && ok "编辑容器停了，预览仍然可访问（编辑/运行两个平面分开了）" \
  || bad "预览跟着编辑容器一起挂了（$(preview "$NODE_ID")）—— 说明两者还是同一个容器"
# 而编辑容器自己的地址应该断了
DEV_CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -H "Host: d-$NODE_ID.localhost" "$EDGE/")
[ "$DEV_CODE" = "404" ] || [ "$DEV_CODE" = "000" ] && ok "编辑容器自己的地址（d-<id>）已断" \
  || bad "编辑容器的地址还通着（$DEV_CODE）"

hdr "⑤ DELETE 后容器 / 挂载 / 路由都回收干净"
DEL=$("${CURL[@]}" -X DELETE "$API/api/projects/$NODE_ID")
echo "$DEL" | grep -q '"ok":true' && ok "删除接口返回成功" || bad "删除失败：$DEL"
[ ! -d "/root/webgen-data/workspaces/$NODE_ID" ] && ok "工作区已移除" || bad "工作区还在"
GONE=$(preview_gone "$NODE_ID")
case "$GONE" in
  404|000) ok "路由已回收" ;;
  *) bad "路由还在（$GONE）" ;;
esac
# 预览容器也要一起没（S3 拆分后它是独立的 `webgen-prev-*`，不是编辑容器）
PREV_LEFT=$(docker ps -a --filter "name=webgen-prev-$NODE_ID" --format '{{.Names}}' | wc -l)
[ "$PREV_LEFT" = "0" ] && ok "预览容器已回收" || bad "预览容器还在：$PREV_LEFT 个"

hdr "⑥ 至少两套语言的组合跑通（node + python）"
PY_JSON=$(create "$STACK_PY" "smoke-py")
PY_ID=$(echo "$PY_JSON" | jqid)
if [ -n "$PY_ID" ]; then
  "${CURL[@]}" -X POST "$API/api/projects/$PY_ID/wait" \
    -H 'content-type: application/json' -d '{"timeoutMs":90000}' >/dev/null
  [ "$(preview_retry "$PY_ID")" = "200" ] && ok "python 组合：预览 200" || bad "python 预览失败"
else
  bad "python 建项目失败：$PY_JSON"
fi

hdr "⑦ 沙箱创建走了 scheduler（节点注册 + 单节点也走同一条路径）"
NODES=$("${CURL[@]}" "$API/api/nodes")
echo "$NODES" | grep -q '"online":true' && ok "节点已注册且在线" || bad "节点未注册"
echo "$NODES" | grep -q 'webgen/node:22' && ok "节点上报了已拉镜像" || bad "镜像清单缺失"

hdr "⑧ 资源上限生效"
MEM_JSON=$(create "$STACK_NODE" "smoke-mem")
MEM_ID=$(echo "$MEM_JSON" | jqid)
if [ -n "$MEM_ID" ]; then
  "${CURL[@]}" -X POST "$API/api/projects/$MEM_ID/wait" \
    -H 'content-type: application/json' -d '{"timeoutMs":90000}' >/dev/null
  CB=$(docker ps --filter "name=webgen-sbx-$MEM_ID" --format '{{.ID}}')
  MEM=$(docker inspect "$CB" --format '{{.HostConfig.Memory}}' 2>/dev/null)
  # 组合里 node 后端写的是 memoryMb=768（见 recipe.ts 的 specFor）
  if [ "$MEM" = "805306368" ]; then ok "内存上限按组合生效（768MB）"; else
    bad "内存上限是 $MEM，期望 805306368（768MB）"
  fi

  HOG=$("${CURL[@]}" "$API/api/projects/$MEM_ID" | grep -o '"sandboxId":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$HOG" ]; then
    # ⚠️ 必须 fill(1) 真的把页写进去。只 alloc 不写的话，glibc calloc 走 mmap
    # 拿到的是内核零页，RSS 根本不涨 —— 会误判成"限额没生效"（在这上面来回错了三次）。
    # ⚠️ 分配量要**超过**组合给 node 的 768MB（原来是 600MB，那是给 512MB 限额的；限额提到
    # 768MB 之后 600MB 就不越限了，测试会假绿）。
    RES=$(curl -s --noproxy '*' --max-time 60 -X POST \
      "http://127.0.0.1:8100/sandboxes/$HOG/exec" -H 'content-type: application/json' \
      -d '{"cmd":["node","-e","const b=Buffer.alloc(1200*1024*1024);b.fill(1)"],"timeoutMs":30000}')
    echo "$RES" | grep -qE '"code":137' \
      && ok "越限分配被 cgroup OOM 干掉（code 137）" \
      || bad "内存限额似乎没生效：$RES"

    # 平台得能把这个失败认出来 —— 认不出就等于没做上限（§2.4）
    docker inspect "webgen-sbx-$MEM_ID" --format '{{.State.OOMKilled}}' 2>/dev/null | grep -q true \
      && ok "容器被标记 OOMKilled（平台可据此报「内存超限」）" \
      || bad "容器没有 OOMKilled 标记，平台识别不出超限"
  else
    bad "拿不到 sandboxId"
  fi
else
  # ⚠️ 这个 else **必须有**。以前没有它，于是"建不出项目"时整段**静默跳过**——
  # 而少三项检查在计数上看起来跟"通过"一样，全绿是假的。
  # 实测就是因为撞了 MAX_SERVICE_PROJECTS（服务型项目数上限），这一段的三个检查
  # 无声消失，我一度以为是全对的。测试里"跳过"和"通过"绝不能长得一样。
  bad "建不出用于验资源上限的项目（多半是撞了 MAX_SERVICE_PROJECTS=5）：$(echo "$MEM_JSON" | head -c 160)"
fi

hdr "清理"
# ⚠️ 只删本脚本建的项目。这里曾经是 `GET /api/projects` 拿到**全部** id 再逐个删，
# 等于跑一次 smoke 就把平台上所有项目清空 —— 本机实测把手工建的 s1-demo /
# repair-demo 一起删掉了。建过的 id 都列在下面，别再改成"全删"。
for id in "${PY_ID:-}" "${MEM_ID:-}"; do
  [ -n "$id" ] || continue
  "${CURL[@]}" -X DELETE "$API/api/projects/$id" >/dev/null
done
ok "已清理本轮建的项目"

echo
echo "══════════════════════════════════════════════"
echo "  通过 $pass 项 · 失败 $fail 项"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
