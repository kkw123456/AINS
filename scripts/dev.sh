#!/usr/bin/env bash
# 同时起 executor 与 orchestrator，输出带前缀，Ctrl-C 一起停。
#
# ⚠️ 别用 `cd X && (A) & (B) &` 这种写法——`&` 会把整个 `cd X && (A)` 一起后台化，
# B 就会跑到调用者的当前目录去（踩过：orchestrator 在别的仓库里找不到自己）。
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'trap - INT TERM; kill 0' INT TERM

# 默认 `start`（tsx，不 watch）；要热重载就传 dev
CMD="${1:-start}"

pnpm --filter @webgen/executor "$CMD" 2>&1 | sed 's/^/[exec] /' &
pnpm --filter @webgen/orchestrator "$CMD" 2>&1 | sed 's/^/[orch] /' &
# 前端。Vite 只有 watch 一种模式，`start` 和 `dev` 都指向 `vite`（见 apps/web/package.json）。
pnpm --filter @webgen/web "$CMD" 2>&1 | sed 's/^/[web]  /' &

wait
