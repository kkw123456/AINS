#!/usr/bin/env bash
# 构建沙箱镜像。镜像名 = template.json 里的 image 字段。
set -euo pipefail
cd "$(dirname "$0")/.."

# ⚠️ 构建上下文是**各自的子目录**，不是 sandbox/images —— 这是刻意的。
# Docker 的层缓存按「父层 + 指令原文」命中，而 COPY 的路径属于指令原文：
# 把上下文改成上一级、路径加个语言前缀，会让 npm/pip/mvn 那些**要联网装依赖**的层
# 整层失效重建。实测踩过：java 那次重跑 Maven 预热卡在下载上十几分钟没动。
# **所以别为了共用文件去动上下文**；要共用的东西要么装进镜像，要么放进项目工作区。
docker build -t webgen/node:22     sandbox/images/node
docker build -t webgen/python:3.12 sandbox/images/python
docker build -t webgen/go:1.25     sandbox/images/go
docker build -t webgen/java:21     sandbox/images/java

# ─────────────────────────────────────────────────────────────
# ★ 预热「组合镜像」的层
#
# 项目镜像是按组合（前端×后端）当场生成的，而**每个组合的第一次构建约 10~16 秒**
# （Docker 要提交那些 COPY 层），之后同样的组合只要 ~0.4 秒 —— 层缓存是按
# 「父层 + 指令原文」命中的，与 tag 无关，所以不同项目也能复用。
#
# 那 10~16 秒是**一次性**的，但它落在"建第一个用这个组合的项目"那一刻，
# 而 DESIGN §4.1 那条标准是「建到能看 15 秒」。所以在这里先跑一遍：
# 用假的项目 id 把 8 种组合都建一次，把层缓存垫上，然后把那 8 个一次性镜像删掉
# （**删镜像不会删层缓存**）。之后真实项目永远是 0.4 秒。
#
# ⚠️ 加了新的后端/前端之后，这里的循环要跟着扩 —— 否则新组合要等第一个用户来付那 10~16 秒。
echo
echo "=== 预热组合镜像的层（8 种：4 后端 × 有/无前端）==="
WARM_CTX=$(mktemp -d)
for be in node python go java; do
  for fe in null vue; do
    # ⚠️ `null` 不能加引号、`vue` 必须加 —— 所以这里得分开拼，别图省事一把引号括起来
    if [ "$fe" = "null" ]; then FE_JSON=null; else FE_JSON="\"$fe\""; fi
    name="warm-$be-${fe/null/none}"
    if pnpm -s tsx scripts/recipe-preview.mts "{\"backend\":\"$be\",\"frontend\":$FE_JSON}" > "$WARM_CTX/Dockerfile" 2>/dev/null \
       && docker build -q -t "webgen-warm/$name" "$WARM_CTX" >/dev/null 2>&1; then
      echo "  ✅ $name"
    else
      echo "  ❌ $name（跳过，不影响其他组合）"
    fi
  done
done
rm -rf "$WARM_CTX"
# 只删一次性镜像，层缓存留着
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^webgen-warm/' | xargs -r docker rmi -f >/dev/null 2>&1 || true

echo
echo "=== webgen 镜像 ==="
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep '^webgen/' || true

# ★ 前端依赖的"离网"热缓存。必须在 node 镜像之后跑（它要 `docker run webgen/node:22`）。
# 没有它，每个含前端的项目/每次发布都要联网装一遍 pnpm 依赖 —— 本机实测能挂到 56 秒一次。
# 详见 scripts/warm-pnpm-store.sh 的文件头。
echo
bash scripts/warm-pnpm-store.sh
