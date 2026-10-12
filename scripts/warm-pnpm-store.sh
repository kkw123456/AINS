#!/usr/bin/env bash
# 预热**共用的 pnpm store** —— 每个含前端的容器都把它挂在 /workspace/.pnpm-store。
#
# 用法：bash scripts/warm-pnpm-store.sh
#
# 为什么需要它：pnpm 只肯用**和项目同一个文件系统**上的 store，所以镜像里预热一份
# 是没用的（那和项目不在一个盘，它直接无视配置、就地另开一个）。
# 而"就地另开一个"意味着每个新容器/每次发布都要联网装一遍前端依赖 ——
# 本机实测那一步会挂到 56 秒一次（日志里一段静默，然后突然出一堆行），
# 于是"建到能看"在 7 秒到 90 秒之间随机跳，最坏直接撞满就绪超时。
#
# 这个目录在**数据盘**上（和 workspace 同盘，硬链成立），预热一次之后就一直是热的。
# 每个项目的 `pnpm install` 于是变成同盘硬链：不联网，秒级。
#
# ⚠️ 这里的 deps 必须和 `seeds/frontend/*/package.json` 一致 —— 不一致不会报错，
#    只是那个包会被漏掉、退回联网。所以直接**从种子拷 package.json 来装**，别另抄一份。
set -euo pipefail
cd "$(dirname "$0")/.."

# 和 executor 的 config.ts 取同一个默认值。这里不 import TS，所以两边要一起改。
STORE_DIR="${WEBGEN_PNPM_STORE_DIR:-${WEBGEN_DATA_DIR:-/root/webgen-data}/pnpm-store}"

echo "=== 预热 pnpm store: $STORE_DIR ==="
mkdir -p "$STORE_DIR"
# 沙箱里是 uid 10001（见 ownership.ts），属主对不上的话 pnpm 写不进去，
# 会**静默**退回联网安装 —— 现象和"没预热"一模一样。
chown 10001:10001 "$STORE_DIR"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 要预热的 package.json 所在目录（相对仓库根）。**从种子直接拷**，别另抄一份 deps。
# S4 起后端 node 也是 TS 工程、也要 pnpm install，所以它也在列表里。
SEED_DIRS=(seeds/frontend/vue seeds/frontend/react seeds/backend/node)

for d in "${SEED_DIRS[@]}"; do
  [ -f "$d/package.json" ] || continue
  name="$(echo "$d" | tr '/' '-')"
  mkdir -p "$WORK/$name"
  cp "$d/package.json" "$WORK/$name/"
  [ -f "$d/pnpm-lock.yaml" ] && cp "$d/pnpm-lock.yaml" "$WORK/$name/"
  # ⚠️ pnpm 11 起依赖的安装脚本默认被拒（如 esbuild），放行规则写在 pnpm-workspace.yaml 的
  #    allowBuilds 里；不带上它，`pnpm install` 会因 ERR_PNPM_IGNORED_BUILDS 非零退出。
  [ -f "$d/pnpm-workspace.yaml" ] && cp "$d/pnpm-workspace.yaml" "$WORK/$name/"
done
chown -R 10001:10001 "$WORK"

# ★ store **挂成项目里的 .pnpm-store**（而不是用 --store-dir）：这样和运行时
#   容器的布局逐字一致，pnpm 不需要任何配置就会用它 —— 不依赖"配置项被不被认"。
#   （`--store-dir` 在跨设备时会被 pnpm 无视，这个坑踩过。）
for d in "${SEED_DIRS[@]}"; do
  [ -f "$d/package.json" ] || continue
  name="$(echo "$d" | tr '/' '-')"
  [ -d "$WORK/$name" ] || continue
  echo "  → $d"
  docker run --rm \
    -v "$WORK/$name:/app" \
    -v "$STORE_DIR:/app/.pnpm-store" \
    -w /app webgen/node:22 \
    bash -lc "pnpm install --reporter=silent && du -sh /app/.pnpm-store" \
    || echo "  ❌ $d 预热失败（不影响其他；那个框架的项目会退回联网安装）"
done

echo "=== 完成：$(du -sh "$STORE_DIR" | cut -f1) ==="
