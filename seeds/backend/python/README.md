# Python 后端（FastAPI）

webgen 组合项目的后端种子，落到工作区 `backend/`。**不伺服前端静态文件** —— 那是容器里
nginx 的活。这里只有 API。

## 启动

```bash
export APP_PORT=3001
uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT
```

> 监听 `APP_PORT`（默认 3001），**绝不**监听 `PORT` —— 那是 nginx 的 8080，两个都用会抢端口。

运行期不 `pip install`：依赖已预热在镜像 `webgen/python:3.12`（fastapi / uvicorn /
sqlalchemy / pydantic-settings / alembic / pymysql / minio）。`redis` / `minio` 为可选，
缺失或连不上时对应功能自动关闭。

## 接口

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/health` | 纯文本 `ok` |
| GET | `/api/hello` | `{"message":"...","backend":"python"}` |
| GET | `/api/visits` | `{"visits":<int>,"storage":"<mysql\|sqlite\|memory>","cache":"<redis\|null>"}` |
| GET | `/api/files` | `{"backend":"python","storage":"<minio\|none>","bucket":"<...>","objects":[<对象名...>]}` |
| POST | `/api/files` | `{"backend":"python","storage":"<minio\|none>","bucket":"<...>","key":"<写入的对象名>"}` |

统一错误体：`{"error":{"code":"...","message":"..."}}`。

## 存储（按环境变量择一）

| 条件 | 后端 | 说明 |
| --- | --- | --- |
| 有 `DATABASE_URL` | mysql | `mysql://user:pass@host:3306/db`，自动补 `+pymysql` |
| 有 `WEBGEN_DATA_DIR` | sqlite | 落 `${WEBGEN_DATA_DIR}/app.db`，重启不丢 |
| 都没有 | memory | 进程内计数，重启归零 |

Redis 见 `REDIS_URL` / `REDIS_KEY_PREFIX`。

对象存储（MinIO / 「文件系统」）见 `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` /
`S3_BUCKET` / `S3_REGION`。没配 `S3_ENDPOINT` 即 `storage=none`（优雅降级，不崩）；
配了则幂等建 `S3_BUCKET` 并读写对象。

## 目录

```
app/
  main.py                 # app = FastAPI(...) + lifespan
  core/{config,logging,errors}.py
  api/deps.py  api/routes/{health,hello,visits,files}.py
  services/visit_service.py
  db/session.py
  models/{base,visit}.py
  cache/redis.py
  storage/minio.py
alembic/                  # 初始迁移（仅 mysql 路径使用）
tests/test_health.py
```

## 迁移（仅 MySQL 需要）

启动时会 `create_all` 建表，所以 sqlite/内存路径无需 alembic。MySQL 想走版本化迁移时：

```bash
export DATABASE_URL=mysql://user:pass@host:3306/db
alembic upgrade head
```

## 测试

```bash
PYTHONPATH=/app python tests/test_health.py
```
