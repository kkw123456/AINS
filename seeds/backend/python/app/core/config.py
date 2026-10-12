"""应用配置：pydantic-settings 在启动时读取环境变量并做校验。

字段名 -> 环境变量（pydantic-settings 默认大小写不敏感）：
  app_port         -> APP_PORT          监听端口（默认 3001，**不是** PORT）
  webgen_data_dir  -> WEBGEN_DATA_DIR   SQLite 数据目录（平台选了数据层才注入）
  database_url     -> DATABASE_URL      MySQL DSN，形如 mysql://user:pass@host:3306/db
  redis_url        -> REDIS_URL         Redis DSN，缺省则无缓存
  redis_key_prefix -> REDIS_KEY_PREFIX  Redis key 前缀（默认空）
  s3_endpoint      -> S3_ENDPOINT       MinIO/S3 端点，如 http://minio:9000；缺失即无对象存储
  s3_access_key    -> S3_ACCESS_KEY     MinIO access key
  s3_secret_key    -> S3_SECRET_KEY     MinIO secret key
  s3_bucket        -> S3_BUCKET         每项目一个 bucket，形如 p_<projectId>
  s3_region        -> S3_REGION         S3 region（默认 us-east-1）
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_port: int = 3001
    webgen_data_dir: str | None = None
    database_url: str | None = None
    redis_url: str | None = None
    redis_key_prefix: str = ""

    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = ""
    s3_region: str = "us-east-1"

    @property
    def storage_backend(self) -> str:
        """按优先级决定存储后端：mysql > sqlite > memory。"""
        if self.database_url:
            return "mysql"
        if self.webgen_data_dir:
            return "sqlite"
        return "memory"

    @property
    def sqlalchemy_url(self) -> str | None:
        """把裸 mysql:// DSN 规范化成 SQLAlchemy 能识别的 mysql+pymysql://。"""
        if not self.database_url:
            return None
        url = self.database_url
        if url.startswith("mysql://"):
            url = "mysql+pymysql://" + url[len("mysql://") :]
        elif url.startswith("mysql+mysqldb://"):
            url = "mysql+pymysql://" + url[len("mysql+mysqldb://") :]
        return url


@lru_cache
def get_settings() -> Settings:
    """进程级单例。测试里可先用 get_settings.cache_clear() 重置。"""
    return Settings()
