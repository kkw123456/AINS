#!/usr/bin/env bash
# S1 验收的「自动修复」那半条：刻意用一个起不来的模板，
# 看 verify 第一次失败之后，日志有没有被喂回模型、模型有没有修好。
set -uo pipefail

API=http://127.0.0.1:8800
EDGE=http://127.0.0.1:8088
C=(curl -s --noproxy '*' --max-time 120)

echo "=== 用 broken-fixture 建项目（这个模板故意启动即崩）==="
R=$("${C[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d '{"template":"broken-fixture","name":"repair-demo","prompt":"这个应用现在启动就崩。请让它变成一个能访问的页面：根路径返回一段 HTML，标题写 FIXED。"}')
ID=$(echo "$R" | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ID" ]; then echo "建项目失败：$R"; exit 1; fi
echo "项目 $ID"
echo

echo "=== 等生成跑完 ==="
DEADLINE=$((SECONDS + 900))
while [ $SECONDS -lt $DEADLINE ]; do
  R2=$("${C[@]}" "$API/api/projects/$ID/agent")
  case "$R2" in *'"running":false'*) break ;; esac
  printf '.'
  sleep 5
done
echo

python3 "$(dirname "$0")/show-agent.py" "$ID"

echo
echo "=== 预览 ==="
CODE=$(curl -s --noproxy '*' --max-time 15 -o /tmp/repair.html -w '%{http_code}' -H "Host: p-$ID.localhost" "$EDGE/")
echo "HTTP $CODE"
grep -o "FIXED" /tmp/repair.html && echo "  ✅ 修好了" || echo "  ❌ 没修好"
echo "项目 id = $ID"
