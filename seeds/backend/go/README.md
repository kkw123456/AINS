# Go 后端（企业级分层骨架）

组合项目里的 Go 后端。**chi + zap + sqlx + go-sql-driver/mysql + go-redis/v9 + minio-go/v7**，分层工程结构，
启动校验配置、结构化日志、统一错误体、优雅退出。

> ⚠️ 它**不伺服前端静态文件** —— 那是容器里 nginx 的活（见工作区根的 `deploy/nginx.conf`）。
> 这里只有 API 路由。端口听 **`APP_PORT`**（内部端口，默认 3001），**绝不**听 `PORT`（对外的 8080 归 nginx）。

## 目录结构

```
go.mod / go.sum            模块定义（module app）+ 依赖锁定
.env.example               环境变量示例
cmd/server/main.go         入口：装配依赖 → 起服务 → 优雅退出
internal/config/config.go  读环境变量 + 启动校验（端口、DSN、Redis URL）
internal/logger/logger.go  zap 结构化日志
internal/httpserver/
  server.go                http.Server 封装 + 优雅关闭
  router.go                chi 路由装配
  middleware.go            请求日志 + panic recover（统一错误体）
internal/handler/
  health.go                GET /health
  hello.go                 GET /api/hello
  visits.go                GET /api/visits
  files.go                 GET/POST /api/files（对象存储）
  response.go              JSON / 统一错误体写出
internal/service/visit.go  访问计数业务逻辑
internal/store/
  store.go                 存储接口 + 工厂
  mysql_store.go           MySQL（sqlx + go-sql-driver）
  file_store.go            文件（${WEBGEN_DATA_DIR}/visits.txt）
  memory_store.go          进程内计数
internal/cache/redis.go    Redis 缓存（go-redis/v9）
internal/files/objectstore.go  MinIO 对象存储（minio-go/v7，可选）
```

## 接口

| 方法 | 路径          | 响应                                                     |
| ---- | ------------- | -------------------------------------------------------- |
| GET  | `/health`     | `200`，纯文本 `ok`                                        |
| GET  | `/api/hello`  | `200`，`{"message":"<一句中文问候>","backend":"go"}`      |
| GET  | `/api/visits` | `200`，`{"visits":<int>,"storage":"...","cache":...}`（每请求自增） |
| GET  | `/api/files`  | `200`，`{"backend":"go","storage":"minio"\|"none","bucket":"...","objects":[...]}` |
| POST | `/api/files`  | `200`，`{"backend":"go","storage":"minio"\|"none","bucket":"...","key":"..."}` |

`/api/files`：没配 `S3_*` → `storage="none"`、`bucket=""`、`objects=[]`（`POST` 的 `key=""`）。
配了 S3 但连不上 → 记 warning 并同样降级为 `"none"`，**接口照常 200**。`POST` 会写一个
`upload-<纳秒时间戳>.txt` 的对象并回 `key`；`GET` 确保 bucket 存在后列出最多 20 个对象名。

错误统一为 `{"error":{"code":"...","message":"..."}}`（404 / 405 / 500 兜底也走它）。

## 配置（启动时读环境变量）

| 变量               | 说明                                                          | 默认         |
| ------------------ | ------------------------------------------------------------- | ------------ |
| `APP_PORT`         | 监听端口（内部）                                              | `3001`       |
| `APP_ENV`          | `development` 时用可读日志，否则 JSON                         | `production` |
| `LOG_LEVEL`        | `debug` / `info` / `warn` / `error`                           | `info`       |
| `DATABASE_URL`     | `mysql://user:pass@host:3306/db` → MySQL，`storage="mysql"`   | 空           |
| `WEBGEN_DATA_DIR`  | 文件存储目录 → `storage="file"`                              | 空           |
| `REDIS_URL`        | Redis 连接串 → `cache="redis"`                               | 空           |
| `REDIS_KEY_PREFIX` | Redis key 前缀（按项目隔离）                                  | 空           |
| `S3_ENDPOINT`      | MinIO/S3 端点（如 `http://minio:9000`）→ `/api/files` 报 `minio` | 空        |
| `S3_ACCESS_KEY`    | MinIO access key                                             | 空           |
| `S3_SECRET_KEY`    | MinIO secret key                                             | 空           |
| `S3_BUCKET`        | 每项目一个 bucket，形如 `p_<projectId>`                       | 空           |
| `S3_REGION`        | S3 region                                                    | `us-east-1`  |

**存储解析顺序**：`DATABASE_URL` → MySQL；否则 `WEBGEN_DATA_DIR` → 文件；都没有 → 内存。
**Redis**：有 `REDIS_URL` 即 `cache="redis"`，否则响应里 `cache` 为 `null`。
**MinIO**：有 `S3_ENDPOINT` 即 `/api/files` 报 `storage="minio"`，否则 `"none"`（可选旁路，
连不上只降级不崩，跟 Redis 同一档）。

`storage` 的取值：`mysql` / `file` / `memory`。工作区是 bind mount 到宿主的，所以
`WEBGEN_DATA_DIR` 下的东西在容器删除/重建后仍在 —— 这是「数据层」那个选择的含义。

## 构建与运行

```bash
# 构建（入口在 cmd/server）
go build -o /tmp/app ./cmd/server

# 运行
APP_PORT=3001 /tmp/app
```

## 依赖

版本与镜像预热层（`sandbox/images/go/warm`）钉死一致，`go build` 可离线命中缓存：

```
github.com/go-chi/chi/v5        v5.3.2
github.com/go-sql-driver/mysql  v1.10.1
github.com/jmoiron/sqlx         v1.4.0
github.com/minio/minio-go/v7    v7.3.0   # 别升版本，镜像只预热了这一版
github.com/redis/go-redis/v9    v9.7.3   # 更新的 v9 要 go 1.26，本地工具链会拒
go.uber.org/zap                 v1.28.0
```

## 测试

```bash
go vet ./...
go test ./...
```
