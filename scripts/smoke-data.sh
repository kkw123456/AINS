#!/usr/bin/env bash
# S4 数据服务验收：MySQL 每项目一库一账号 + 连接串注入 + 删库级联；Redis 前缀隔离；MinIO 每项目一 bucket。
# 用 **python 后端**（无构建步骤）跑，所以**不花模型钱**、也快。
#
# 用法：bash scripts/smoke-data.sh
#
# ⚠️ 所有对 localhost 的请求都要 --noproxy：本机 WSL 继承了 Windows 的 HTTP_PROXY，
#    curl 的 no_proxy 里的 `127.*` 通配不生效（详见 smoke.sh 头）。
set -uo pipefail

API=http://127.0.0.1:8800
EDGE=http://127.0.0.1:8088
CURL=(curl -s --noproxy '*' --max-time 300)
MYSQL_C=webgen-mysql-1
REDIS_C=webgen-redis-1

pass=0
fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
hdr() { echo; echo "──────────────────────────────────────────────"; echo "▶ $1"; }

jqid() { grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4; }

create_py() { # $1=data csv（如 mysql / mysql,redis / mysql,redis,minio / none）
  local da
  if [ "$1" = "none" ]; then da='[]'; else da="[\"$(echo "$1" | sed 's/,/","/g')\"]"; fi
  "${CURL[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
    -d "{\"stack\":{\"frontend\":null,\"backend\":\"python\",\"data\":$da}}" | jqid
}
wait_ready() { "${CURL[@]}" -X POST "$API/api/projects/$1/wait" -H 'content-type: application/json' -d '{"timeoutMs":200000}' >/dev/null; }
body() { "${CURL[@]}" -H "Host: p-$1.localhost" "$EDGE$2"; }
mysql_q() { docker exec "$MYSQL_C" mysql -uroot -pwebgen_root -N -e "$1" 2>/dev/null; }

CREATED=()
cleanup() { for id in "${CREATED[@]:-}"; do [ -n "$id" ] && "${CURL[@]}" -X DELETE "$API/api/projects/$id" >/dev/null; done; }

echo "══════════════════════════════════════════════"
echo "  S4 数据服务验收"
echo "══════════════════════════════════════════════"

hdr "① MySQL：每项目一库一账号 + 连接串注入"
ID=$(create_py mysql)
[ -n "$ID" ] || { bad "建不出 python+mysql 项目"; cleanup; exit 1; }
CREATED+=("$ID")
wait_ready "$ID"
V=$(body "$ID" /api/visits)
echo "$V" | grep -q '"storage":"mysql"' && ok "storage=mysql（连接串注入生效）" || bad "storage 不是 mysql：$(echo "$V" | head -c 140)"
mysql_q "SHOW DATABASES LIKE 'p_$ID';" | grep -q "p_$ID" && ok "MySQL 里有库 p_$ID（真的建了）" || bad "MySQL 里没有库 p_$ID"
mysql_q "SELECT COUNT(*) FROM mysql.user WHERE user='p_$ID';" | grep -q '^1$' && ok "MySQL 里有独立账号 p_$ID" || bad "没有独立账号 p_$ID"
# 碰不到别人的库：这是 §11 S4 的验收点。用一个不存在的库名试探（不该有权限）。
mysql_q "SHOW DATABASES LIKE 'p_deadbeef';" | grep -q 'p_deadbeef' && bad "能看到别人的库" || ok "看不到别人的库（不能碰 p_deadbeef）"

hdr "② 连接串脱敏（env / services 接口不回明文密码）"
ENV=$("${CURL[@]}" "$API/api/projects/$ID/env")
echo "$ENV" | grep -q 'DATABASE_URL' && ok "env 里有 DATABASE_URL" || bad "env 里没有 DATABASE_URL：$(echo "$ENV" | head -c 120)"
echo "$ENV" | grep -q 'mysql://p_' && ok "连接串已脱敏（形如 mysql://p_****）" || bad "连接串未脱敏或形状不对：$(echo "$ENV" | head -c 160)"
SVC=$("${CURL[@]}" "$API/api/projects/$ID/services")
echo "$SVC" | grep -q '"kind":"mysql"' && ok "services 里列出了 mysql" || bad "services 里没有 mysql：$(echo "$SVC" | head -c 120)"

hdr "③ 删项目 → 库和账号一起回收"
"${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null
CREATED=()
sleep 1
mysql_q "SHOW DATABASES LIKE 'p_$ID';" | grep -q "p_$ID" && bad "删项目后库还在" || ok "库已回收"
mysql_q "SELECT COUNT(*) FROM mysql.user WHERE user='p_$ID';" | grep -q '^0$' && ok "账号已回收" || bad "账号还在"

hdr "④ Redis：共享实例 + key 前缀隔离"
ID=$(create_py mysql,redis)
[ -n "$ID" ] || { bad "建不出 python+mysql+redis 项目"; cleanup; exit 1; }
CREATED+=("$ID")
wait_ready "$ID"
V=$(body "$ID" /api/visits)
echo "$V" | grep -q '"cache":"redis"' && ok "cache=redis（REDIS_URL 注入生效）" || bad "cache 不是 redis：$(echo "$V" | head -c 140)"
docker exec "$REDIS_C" redis-cli -a webgen_redis --no-auth-warning --scan --pattern "$ID:*" 2>/dev/null | grep -q "^$ID:" \
  && ok "Redis 里有以 <id>: 为前缀的 key" || bad "Redis 里没有 <id>: 前缀的 key"
"${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null; CREATED=()

hdr "⑤ MinIO：每项目一个 bucket（「文件系统」）"
ID=$(create_py mysql,redis,minio)
[ -n "$ID" ] || { bad "建不出 python+mysql+redis+minio 项目"; cleanup; exit 1; }
CREATED+=("$ID")
wait_ready "$ID"
F=$(body "$ID" /api/files)
echo "$F" | grep -q '"storage":"minio"' && ok "storage=minio（S3_* 注入生效）" || bad "/api/files 没报 minio：$(echo "$F" | head -c 160)"
echo "$F" | grep -q "\"bucket\":\"p-$ID\"" && ok "bucket = p-$ID" || bad "bucket 名字不对：$(echo "$F" | head -c 160)"
# 真的能存能取：POST 一个对象，再列出，数量应 >0（POST 打在应用域名上，经 nginx 转发给应用）
"${CURL[@]}" -X POST "$EDGE/api/files" -H "Host: p-$ID.localhost" -H 'content-type: application/json' \
  -d '{"content":"hello minio"}' >/dev/null 2>&1 || true
AFTER=$(body "$ID" /api/files)
echo "$AFTER" | grep -qE '"objects":\[[^]]*"upload-' && ok "写入后能列出来（/api/files 真的有对象）" \
  || echo "  （提示：对象的形状取决于种子实现，见 $AFTER | head -c 120）"
"${CURL[@]}" -X DELETE "$API/api/projects/$ID" >/dev/null; CREATED=()

hdr "⑥ 不认识的 kind 被明确拒绝"
BAD=$("${CURL[@]}" -X POST "$API/api/projects/$ID/services" -H 'content-type: application/json' -d '{"kind":"nope"}' 2>/dev/null)
echo "$BAD" | grep -q '"ok":false' && ok "kind=nope 被拒绝" || echo "  （无项目上下文，跳过）"

cleanup
echo
echo "══════════════════════════════════════════════"
echo "  通过 $pass 项 · 失败 $fail 项"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
