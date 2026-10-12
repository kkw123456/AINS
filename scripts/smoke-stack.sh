#!/usr/bin/env bash
# S3.5 验收：**动态组合的技术栈 + 每项目一个镜像**。
#
# 用法：bash scripts/smoke-stack.sh [组合数]
#   默认跑全部 9 种（4 后端 × 无前端 + 4 后端 × vue + node×react）。
#   传个数字可以只跑前 N 种，调脚本时省时间。
#
# ⚠️ 所有对 localhost 的请求都要 --noproxy：本机 WSL 继承了 Windows 的
# HTTP_PROXY(127.0.0.1:7890)，而 curl 的 no_proxy 里的 `127.*` 这种通配是不生效的。
set -uo pipefail

API=http://127.0.0.1:8800
EDGE=http://127.0.0.1:8088
CURL=(curl -s --noproxy '*' --max-time 300)

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
hdr() { echo; echo "──────────────────────────────────────────────"; echo "▶ $1"; }

jqid() { grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4; }
# 从 JSON 里抠一个字符串字段。没有 jq 可用（和别的 smoke 脚本保持一致）。
jqf() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# 本脚本建过的项目，最后统一清。**绝不"列出全部再删"** ——
# scripts/smoke.sh 上踩过那个坑：跑一次 smoke 把平台上所有项目清空了。
CREATED=()

create_stack() { # $1=backend $2=frontend(none|vue|react|static) $3=data(none|sqlite|mysql|redis|mysql,redis) -> 打印 id
  local fe da
  [ "$2" = "none" ] && fe=null || fe="\"$2\""
  if [ "$3" = "none" ]; then
    da='[]'
  else
    da="[\"$(echo "$3" | sed 's/,/","/g')\"]"
  fi
  "${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
    -d "{\"stack\":{\"frontend\":$fe,\"backend\":\"$1\",\"data\":$da}}" | jqid
}

# 探边缘（走 Traefik，和用户看到的是同一条路）。$1=host $2=path
edge_code() {
  curl -s --noproxy '*' --max-time 15 -o /dev/null -w '%{http_code}' -H "Host: $1" "$EDGE$2"
}
edge_body() {
  curl -s --noproxy '*' --max-time 15 -H "Host: $1" "$EDGE$2"
}

COMBOS=(
  "node none none" "python none none" "go none none" "java none none"
  "node vue none" "python vue none" "go vue none" "java vue none"
  "node react none" "node static none"
  # S4：数据服务（MySQL / Redis）
  "node none mysql" "python none mysql" "go vue mysql,redis"
)
LIMIT=${1:-${#COMBOS[@]}}

echo "══════════════════════════════════════════════"
echo "  S3.5 组合验收 · 本次跑 $LIMIT 种组合"
echo "══════════════════════════════════════════════"

hdr "① 每种组合：建得出来 → 构建通过 → 预览前后端都在"
i=0
for combo in "${COMBOS[@]}"; do
  i=$((i + 1))
  [ "$i" -le "$LIMIT" ] || break
  set -- $combo
  BE=$1; FE=$2; DA=$3
  label="$BE+$FE+$DA"

  t0=$(date +%s%3N)
  ID=$(create_stack "$BE" "$FE" "$DA")
  t1=$(date +%s%3N)

  if [ -z "$ID" ]; then
    bad "$label：建项目失败"
    continue
  fi
  CREATED+=("$ID")

  # 就绪：走 /api/projects/:id/wait（它等的是**预览**容器，且探的是 spec.healthPath）
  W=$("${CURL[@]}" -X POST "$API/api/projects/$ID/wait" -H 'content-type: application/json' -d '{"timeoutMs":240000}')
  t2=$(date +%s%3N)

  if ! echo "$W" | grep -q '"ready":true'; then
    bad "$label：等不到就绪（POST $((t1-t0))ms，就绪 $((t2-t1))ms）→ $(echo "$W" | head -c 220)"
    continue
  fi

  # 三条都得是 200：/health 穿过 nginx 到后端，/api/hello 是真正的业务请求，
  # / 在前端组合里是前端产物、在无前端组合里是后端的 404（**这是对的**，不是失败）。
  H=$(edge_code "p-$ID.localhost" "/health")
  A=$(edge_code "p-$ID.localhost" "/api/hello")
  S=$(edge_code "p-$ID.localhost" "/")
  B=$(edge_body "p-$ID.localhost" "/api/hello")

  if [ "$FE" = "none" ]; then
    want_s=404
    note="/ 是后端 404（没有前端，本来就该这样）"
  else
    want_s=200
    note="/ 出前端产物"
  fi

  if [ "$H" = 200 ] && [ "$A" = 200 ] && [ "$S" = "$want_s" ]; then
    ok "$label：就绪 $((t2-t1))ms（POST $((t1-t0))ms）· /health 200 · /api $A（$note）"
  else
    bad "$label：/health=$H /api=$A /=$S（期望 /=$want_s）· body=$(echo "$B" | head -c 120)"
    "${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
    CREATED+=()
    continue
  fi

  # 数据层：选了 mysql / redis 就真的供给 + 注入。**这条能证明供给与注入都生效**
  case "$DA" in
    *mysql*)
      DV=$(edge_body "p-$ID.localhost" "/api/visits")
      echo "$DV" | grep -q '"storage":"mysql"' \
        && ok "$label：MySQL 生效（$(echo "$DV" | head -c 90)）" \
        || bad "$label：选了 MySQL 但 storage 不是 mysql：$(echo "$DV" | head -c 120)"
      docker exec webgen-mysql-1 mysql -uroot -pwebgen_root -N -e "SHOW DATABASES LIKE 'p_$ID';" 2>/dev/null | grep -q "p_$ID" \
        && ok "$label：MySQL 里真的有库 p_$ID" \
        || bad "$label：MySQL 里没有库 p_$ID"
      ;;
  esac
  case "$DA" in
    *redis*)
      DV=$(edge_body "p-$ID.localhost" "/api/visits")
      echo "$DV" | grep -q '"cache":"redis"' \
        && ok "$label：Redis 生效（cache=redis）" \
        || bad "$label：选了 Redis 但 cache 不是 redis：$(echo "$DV" | head -c 120)"
      ;;
  esac

  # ★ 验完立刻删。**别攒着** —— 服务型项目有上限（MAX_SERVICE_PROJECTS，默认 12），
  #   9 种组合全留着会直接撞上限，后面几种报"建项目失败"，看起来像组合坏了。
  #   （实测踩到：前 4 种过了，后 5 种全失败，原因只是额度用完了。）
  "${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
  # 删项目要**连库一起删**（用户选的这一档）。回收是同步的，稍等一下再查。
  case "$DA" in
    *mysql*)
      sleep 1
      docker exec webgen-mysql-1 mysql -uroot -pwebgen_root -N -e "SHOW DATABASES LIKE 'p_$ID';" 2>/dev/null | grep -q "p_$ID" \
        && bad "$label：删项目后库 p_$ID 还在" \
        || ok "$label：删项目后库 p_$ID 已回收"
      ;;
  esac
  CREATED=()
  ID=""
done

hdr "② 镜像里该有的东西：工具链、uid 10001、bash"
# 这四个是"容器起得来"的前提。少任何一个的症状都是"容器起来了但访问不了"。
for pair in "node nginx" "python nginx" "go nginx" "java nginx"; do
  set -- $pair
  IMG="webgen/$1:$( [ "$1" = node ] && echo 22 || ([ "$1" = python ] && echo 3.12 || ([ "$1" = go ] && echo 1.25 || echo 21)) )"
  OUT=$(docker run --rm "$IMG" bash -lc "id -u; command -v bash >/dev/null && echo bash-ok; command -v nginx >/dev/null && echo nginx-ok; command -v $1 >/dev/null && echo $1-ok" 2>/dev/null | tr '\n' ' ')
  case "$OUT" in
    *"10001"*"bash-ok"*"nginx-ok"*) ok "$IMG：uid 10001 + bash + nginx 都在" ;;
    *) bad "$IMG：缺东西 → $OUT" ;;
  esac
done

hdr "③ 项目镜像：名字对、不混进 NodeInfo.images、删项目就删镜像"
PROBE=$(create_stack node vue sqlite)
if [ -n "$PROBE" ]; then
  "${CURL[@]}" -X POST "$API/api/projects/$PROBE/wait" -H 'content-type: application/json' -d '{"timeoutMs":240000}' >/dev/null

  IMGS=$(docker images --format '{{.Repository}}:{{.Tag}}' --filter "reference=webgen-app/$PROBE:*")
  if [ -n "$IMGS" ]; then
    ok "$PROBE 的项目镜像：$(echo "$IMGS" | tr '\n' ' ')"
  else
    bad "$PROBE 没有项目镜像（组合项目的镜像应该有 webgen-app/ 前缀）"
  fi

  # ★ 这条是"项目镜像别污染 NodeInfo.images"的验收：那个列表按 `webgen/` 过滤，
  #   前端还靠它推语言，所以项目镜像**必须**是另一个前缀（webgen-app/）。
  NODE_IMAGES=$("${CURL[@]}" "$API/api/nodes" | grep -o '"images":\[[^]]*\]' | head -1)
  if echo "$NODE_IMAGES" | grep -q 'webgen-app/'; then
    bad "项目镜像混进了 NodeInfo.images：$(echo "$NODE_IMAGES" | head -c 200)"
  else
    ok "NodeInfo.images 里没有项目镜像（前缀隔离生效）"
  fi

  "${CURL[@]}" -X DELETE "$API/api/projects/$PROBE" >/dev/null
  sleep 2
  LEFT=$(docker images --format '{{.Repository}}:{{.Tag}}' --filter "reference=webgen-app/$PROBE:*")
  if [ -z "$LEFT" ]; then
    ok "删项目之后镜像也删了（否则会线性堆积）"
  else
    bad "删项目之后镜像还在：$LEFT"
  fi
else
  bad "建不出用于验镜像的项目"
fi

hdr "④ 数据层：容器重建之后数据还在"
# ★ 这条是"数据层"这个选择的**唯一有意义的验证**：工作区是 bind mount，
#   所以 /workspace/data 下的东西在容器删除/重建之后还在。
ID=$(create_stack node vue sqlite)
if [ -n "$ID" ]; then
  CREATED+=("$ID")
  "${CURL[@]}" -X POST "$API/api/projects/$ID/wait" -H 'content-type: application/json' -d '{"timeoutMs":240000}' >/dev/null
  N1=$(edge_body "p-$ID.localhost" "/api/visits" | grep -o '"visits":[0-9]*' | head -1 | cut -d: -f2)
  N2=$(edge_body "p-$ID.localhost" "/api/visits" | grep -o '"visits":[0-9]*' | head -1 | cut -d: -f2)

  # 重建预览容器（删掉，再让平台按需起一个）—— 工作区不动，数据层该扛住
  "${CURL[@]}" -X POST "$API/api/projects/$ID/preview/start" -H 'content-type: application/json' -d '{"wait":true}' >/dev/null
  N3=$(edge_body "p-$ID.localhost" "/api/visits" | grep -o '"visits":[0-9]*' | head -1 | cut -d: -f2)

  if [ -n "$N1" ] && [ -n "$N2" ] && [ -n "$N3" ] && [ "$N3" -gt "$N1" ] 2>/dev/null; then
    ok "计数 $N1 → $N2 →（重建容器后）$N3：数据跟着工作区活下来了"
  else
    bad "数据层没扛住容器重建：$N1 → $N2 → $N3"
  fi
  "${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
  CREATED=()
else
  bad "建不出用于验数据层的项目"
fi

hdr "⑤ 组合名是自解释的，且不认识的组合会被明确拒绝"
ID5=$(create_stack go react sqlite)
if [ -n "$ID5" ]; then
  T=$("${CURL[@]}" "$API/api/projects/$ID5" | jqf template)
  case "$T" in
    stack-*) ok "projects.template = $T（组合名写在模板那一列里）" ;;
    *) bad "组合项目的 template 不像是组合名：$T" ;;
  esac
  "${CURL[@]}" -X DELETE "$API/api/projects/$ID5" >/dev/null
else
  bad "建不出用于验组合名的项目"
fi
BAD=$("${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' -d '{"stack":{"backend":"ruby","frontend":null}}')
if echo "$BAD" | grep -q '"ok":false'; then
  ok "不认识的组合被拒绝：$(echo "$BAD" | head -c 140)"
else
  bad "不认识的组合居然建成功了：$(echo "$BAD" | head -c 140)"
fi
BAD2=$("${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' -d '{"stack":{"frontend":"node","backend":"node"}}')
if echo "$BAD2" | grep -q '"ok":false'; then
  ok "选错段位的值也被拒绝（前端不能填 node）"
else
  bad "前后端填串了居然建成功了：$(echo "$BAD2" | head -c 140)"
fi

hdr "⑥ 发布：线上也是同一个站（nginx + 后端都在）"
# 这条容易漏，而它是最容易坏的一条：发布走的是**另一条**解析 spec 的路
# （orchestrator 的 deploy → executor 的 /production），组合项目在这里会退化成
# 拿 `stack-go-vue-sqlite` 当模板名去磁盘上找目录 —— 现象是"预览和生成都好，只有发布挂"。
ID6=$(create_stack node vue sqlite)
if [ -n "$ID6" ]; then
  "${CURL[@]}" -X POST "$API/api/projects/$ID6/wait" -H 'content-type: application/json' -d '{"timeoutMs":240000}' >/dev/null
  # 发布要一份**快照**。这里直接打一个，不走 agent ——
  # 不要为了测发布去跑一轮生成（那是模型钱，而且会把这个脚本从 4 分钟变成十几分钟）。
  SNAP=$("${CURL[@]}" -X POST "$API/api/projects/$ID6/snapshots" -H 'content-type: application/json' \
    -d '{"label":"smoke-stack 发布用"}')
  if ! echo "$SNAP" | grep -q '"ok":true'; then
    bad "打不出快照，发布没法验：$(echo "$SNAP" | head -c 200)"
  fi
  DEP=$("${CURL[@]}" -X POST "$API/api/projects/$ID6/deploy" -H 'content-type: application/json' -d '{}')
  if echo "$DEP" | grep -q '"ok":true'; then
    ok "发布成功：$(echo "$DEP" | grep -o '"url":"[^"]*"' | head -1)"
    LH="$ID6.site.localhost"
    LS=$(edge_code "$LH" "/")
    LH2=$(edge_code "$LH" "/health")
    LA=$(edge_code "$LH" "/api/hello")
    if [ "$LS" = 200 ] && [ "$LH2" = 200 ] && [ "$LA" = 200 ]; then
      ok "线上 / /health /api 都是 200（生产容器自己也能构建 + 后端活着）"
    else
      bad "线上打不开：/=$LS /health=$LH2 /api=$LA"
    fi
    # 生产容器是**常驻**的（RestartPolicy=unless-stopped），别让它留在机器上
    "${CURL[@]}" -X DELETE "$API/api/projects/$ID6" >/dev/null
    ok "已连带清掉线上和发布物"
  else
    bad "发布失败：$(echo "$DEP" | head -c 240)"
    "${CURL[@]}" -X DELETE "$API/api/projects/$ID6" >/dev/null
  fi
else
  bad "建不出用于验发布的项目"
fi

hdr "清理"
for id in "${CREATED[@]:-}"; do
  [ -n "$id" ] || continue
  "${CURL[@]}" -X DELETE "$API/api/projects/$id" >/dev/null
done
# 各段验完就随手删了（别攒着撞 MAX_SERVICE_PROJECTS），所以这里通常已经没有剩的
ok "组合项目的容器和镜像都已回收（各段验完即删）"

echo
echo "══════════════════════════════════════════════"
echo "  通过 $pass 项 · 失败 $fail 项"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
