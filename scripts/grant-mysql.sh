#!/usr/bin/env bash
# 给平台 MySQL 账号加**供给权限**（S4）：每项目一库一账号需要全局的
# CREATE DATABASE / CREATE USER / DROP / GRANT。
#
# 幂等，可重复跑。⚠️ 已有的 mysql 数据卷**不会**执行 infra/mysql-init 里的初始化 SQL，
# 所以老环境得手动跑这个脚本一次；不跑的话"选了 MySQL 的项目"会在建库时报
# `CREATE command denied`（现象像平台坏了）。
set -euo pipefail
cd "$(dirname "$0")/.."

# 从 .env 取（有就覆盖默认）。.env 是 KEY=VALUE 的简单格式，这里只读需要的两行。
if [ -f .env ]; then
  ROOT_PW="$(grep -E '^MYSQL_ROOT_PASSWORD=' .env | tail -1 | cut -d= -f2- || true)"
  PLAT_USER="$(grep -E '^MYSQL_USER=' .env | tail -1 | cut -d= -f2- || true)"
fi
ROOT_PW="${ROOT_PW:-webgen_root}"
PLAT_USER="${PLAT_USER:-webgen}"

# compose 项目名是 webgen，所以 mysql 容器叫 webgen-mysql-1。
CNAME="$(docker ps --format '{{.Names}}' | grep -E '(^|-)mysql-1$' | head -1)"
if [ -z "$CNAME" ]; then
  echo "❌ 找不到运行中的 mysql 容器（先 docker compose -f infra/docker-compose.yml up -d）" >&2
  exit 1
fi

docker exec -i "$CNAME" mysql -uroot -p"$ROOT_PW" <<SQL
GRANT ALL PRIVILEGES ON *.* TO '${PLAT_USER}'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

echo "✅ 已给 '${PLAT_USER}'@'%' 供给权限（容器 ${CNAME}）"
