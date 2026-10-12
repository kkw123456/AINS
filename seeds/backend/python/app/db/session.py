"""数据库会话/引擎：按配置选择 mysql、sqlite 或内存。

优先级：DATABASE_URL (mysql) > WEBGEN_DATA_DIR (sqlite) > 内存。
容器启动不联网，这里不会去下载任何驱动。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.logging import get_logger
from app.models import visit  # noqa: F401  确保 Visit 注册进 metadata
from app.models.base import Base

logger = get_logger("app.db")


class Database:
    """封装 engine / session 工厂 / 后端类型。"""

    def __init__(
        self,
        storage: str,
        engine: Engine | None = None,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.storage = storage
        self.engine = engine
        self.session_factory = session_factory

    @classmethod
    def from_settings(cls, settings: Settings) -> "Database":
        if settings.database_url:
            engine = create_engine(
                settings.sqlalchemy_url or settings.database_url,
                pool_pre_ping=True,
                pool_recycle=1800,
                future=True,
            )
            factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
            logger.info("database configured", extra={"storage": "mysql"})
            return cls("mysql", engine, factory)

        if settings.webgen_data_dir:
            data_dir = Path(settings.webgen_data_dir)
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = data_dir / "app.db"
            engine = create_engine(
                f"sqlite:///{db_path}",
                connect_args={"check_same_thread": False},
                future=True,
            )
            factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
            logger.info(
                "database configured",
                extra={"storage": "sqlite", "path": str(db_path)},
            )
            return cls("sqlite", engine, factory)

        logger.info("database configured", extra={"storage": "memory"})
        return cls("memory", None, None)

    def init(self) -> None:
        """建表。sqlite/mysql 都直接 create_all（alembic 只对 mysql 有额外意义）。"""
        if self.engine is not None:
            Base.metadata.create_all(self.engine)

    def dispose(self) -> None:
        if self.engine is not None:
            self.engine.dispose()
