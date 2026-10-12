#!/usr/bin/env bash
# S1 验收：一句话 → 生成 → 自动修到构建通过 → 预览能打开。
#
# 用法：bash scripts/smoke-s1.sh "需求描述"
set -uo pipefail

API=http://127.0.0.1:8800
EDGE=http://127.0.0.1:8088
C=(curl -s --noproxy '*' --max-time 120)

PROMPT=${1:-"做一个个人主页：标题写「你好，webgen」，下面列出你的三个技能，右下角显示当前时间（每秒刷新）。只用原生 HTML/CSS/JS，别引入任何依赖。"}

echo "需求：$PROMPT"
echo

echo "=== 1. 建项目并起生成 ==="
R=$("${C[@]}" -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d "$(printf '{"stack":{"frontend":"static","backend":"node","data":[]},"name":"s1-demo","prompt":%s}' \
        "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")")
ID=$(echo "$R" | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ID" ]; then echo "建项目失败：$R"; exit 1; fi
echo "项目 $ID"
echo "$R" | head -c 300
echo

echo "=== 2. 看事件流（节选）==="
# 轮询而不是订阅 SSE：脚本里更好收尾
DEADLINE=$((SECONDS + 600))
LAST_STATUS=""
while [ $SECONDS -lt $DEADLINE ]; do
  S=$("${C[@]}" "$API/api/projects/$ID/agent")
  RUNNING=$(echo "$S" | grep -o '"running":[a-z]*' | head -1 | cut -d: -f2)
  if [ "$RUNNING" = "false" ] && [ "$LAST_STATUS" != "seen" ]; then
    LAST_STATUS=seen
    break
  fi
  printf '.'
  sleep 5
done
echo

echo "=== 3. 事件摘要 ==="
"${C[@]}" "$API/api/projects/$ID/agent" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
evs=d["events"]
tools=[e for e in evs if e["type"]=="tool"]
verifies=[e for e in evs if e["type"]=="verify"]
done=[e for e in evs if e["type"]=="done"]
print(f"  事件 {len(evs)} 条 · 工具调用 {len(tools)} 次 · verify {len(verifies)} 次")
for v in verifies:
    print(f"  verify#{v['attempt']}  {'通过' if v['ok'] else '失败'}  {v['detail'][:120]}")
for t in tools[:8]:
    print(f"  · {t['name']}  {t['detail'][:70]}")
if done:
    e=done[-1]
    print(f"  收尾 ok={e['ok']} 成本=${e['costUsd']:.4f} 轮次={e['turns']} 耗时={e['durationMs']/1000:.1f}s")
print("--- 助手回复 ---")
for m in d["messages"]:
    print(f"[{m['role']}] {m['content'][:600]}")
'
echo

echo "=== 4. 预览能不能打开 ==="
CODE=$(curl -s --noproxy '*' --max-time 15 -o /tmp/s1.html -w '%{http_code}' -H "Host: p-$ID.localhost" "$EDGE/")
echo "HTTP $CODE"
grep -o "你好，webgen" /tmp/s1.html && echo "  ✅ 页面里有需求里指定的文案" || echo "  ⚠️  没找到指定文案（可能被模型改写）"
echo "--- 页面开头 ---"
head -c 400 /tmp/s1.html
echo
echo "项目 id = $ID（要清理：curl -X DELETE $API/api/projects/$ID）"
