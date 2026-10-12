# Node 后端（webgen 组合项目）

组合项目工作区里 `backend/` 的那一份：**TypeScript + Fastify 5** 的分层工程。

它**不伺服前端静态文件** —— 那是容器里 nginx 的活（配置由平台生成到
`../deploy/nginx.conf`）。这里只有 API 路由，别往这儿加静态托管，否则前端那一路会被绕过、
`try_files` 的 SPA 兜底也会失效。

## 接口契约

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/health` | `200`，**纯文本** `ok` |
| GET | `/api/hello` | `200`，`{"message":"<中文问候>","backend":"node"}` |
| GET | `/api/visits` | `200`，`{"visits":<int>,"storage":"<mysql\|sqlite\|memory>","cache":"redis"\|null}` |
| GET | `/api/files` | `200`，`{"backend":"node","storage":"minio"\|"none","bucket":"...","objects":[...]}` |
| POST | `/api/files` | `200`，`{"backend":"node","storage":"minio"\|"none","bucket":"...","key":"..."}` |

错误一律是统一体：`{"error":{"code":"...","message":"..."}}`。

## 目录

```
src/
  config.ts               # 读 + 校验环境变量（zod），推导 storage / cache / objectStore
  logger.ts               # pino，stdout 直接是 JSON 行
  app.ts                  # 组装 Fastify 实例（注入 logger、挂插件与路由）
  server.ts               # 入口：loadConfig → listen → 优雅退出（SIGTERM/SIGINT）
  plugins/
    error-handler.ts      # 统一错误体
    request-logger.ts     # 结构化访问日志
  routes/
    health.ts  hello.ts  visits.ts  files.ts   # 各自用 zod 校验输入
  store/
    index.ts              # 按配置动态选实现，暴露统一接口 { kind, hit(), close() }
    mysql.ts              # mysql2/promise，连接池 + 单行 upsert
    sqlite.ts             # Node 22 内置 node:sqlite
    memory.ts             # 进程内计数
    object-store.ts       # MinIO（S3 兼容）客户端；无 S3_* 时返回空实现（kind="none"）
  cache/
    redis.ts              # 可选 ioredis；无 REDIS_URL 时返回 null
tests/health.test.ts      # vitest，用 app.inject() 覆盖 /health 与 /api/hello
tests/files.test.ts       # vitest，覆盖 /api/files 的"无 S3"降级契约
```

## 环境变量

见 `.env.example`。要点：

- **`APP_PORT`**（默认 `3001`）—— 容器内**内部**端口。对外那个口归 nginx（组合项目里是 8080），
  所以后端听 `APP_PORT`，**绝不是 `PORT`**（两个都用会跟 nginx 抢端口）。
- **存储选择（启动时决定，优先级从上到下）**：
  1. `DATABASE_URL`（`mysql://user:pass@host:3306/db`）→ **MySQL**（`storage="mysql"`）
  2. 否则 `WEBGEN_DATA_DIR`（目录）→ **SQLite**，库落 `${WEBGEN_DATA_DIR}/app.db`（`storage="sqlite"`）
  3. 都没有 → **内存**（`storage="memory"`，重启归零）
- **`REDIS_URL`**（可选）→ 配了就 `cache="redis"`，用 ioredis；否则 `cache=null`。
  所有 key 统一加 `REDIS_KEY_PREFIX` 前缀。
- **对象存储（「文件系统」，可选）**：平台按项目注入一整套 `S3_ENDPOINT` /
  `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET`（`p-<projectId>`，连字符）/ `S3_REGION`。
  配全了 → `/api/files` 用 MinIO，`storage="minio"`；**没配 `S3_ENDPOINT`** →
  `storage="none"`、优雅降级（不报错）。只配一半（有 endpoint 缺 key/bucket）是坏配置，
  启动期报错退出。连不上 MinIO 时记 warning、`storage` 报 `"none"`，服务照常起。
- `LOG_LEVEL` —— 日志级别（`info` / `debug` / `silent` …）。

配置在启动时用 zod 校验，坏值会**报错退出**，不会带着错误配置进入服务状态。

## 本地怎么跑

```bash
pnpm install
pnpm build          # tsc → dist/
pnpm start          # node dist/server.js（读上面的环境变量）

# 开发时热跑（可选）
pnpm exec tsx watch src/server.ts

# 自检
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
```

> ⚠️ **`pnpm-workspace.yaml` 里放行了 `esbuild` 的构建脚本**，这不是可有可无的：
> pnpm 11 起依赖的安装脚本**默认被拒**，碰到 esbuild 会直接 `ERR_PNPM_IGNORED_BUILDS`
> 让 `pnpm install` 非零退出 —— 而平台的构建脚本是 `set -e` 下的 `pnpm install && pnpm build`，
> install 一失败整个容器就起不来。pnpm 11 也已不再读 `package.json` 里的 `pnpm` 字段，
> 这些设置的新家就是 `pnpm-workspace.yaml`。

## 设计取舍

- **ESM + NodeNext**：相对 import 一律带 `.js` 后缀（`import { loadConfig } from './config.js'`），
  这是 TypeScript `NodeNext` 解析 ESM 的硬要求。
- **驱动动态 import**：没配 MySQL 就不加载 mysql2、没配数据目录就不碰 `node:sqlite`，
  内存态启动最轻，也不会被某个用不上的驱动的可用性拖累。
- **容器启动不联网**：依赖在**构建期** `pnpm install` 装好，运行期不再下载。
