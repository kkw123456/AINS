"""应用入口：uvicorn app.main:app。

监听端口由 uvicorn 命令行决定（平台用 $APP_PORT），这里不碰 PORT。
启动时按配置连好 db / cache，并挂上统一错误处理。
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import files, health, hello, visits
from app.cache.redis import build_cache
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import get_logger, setup_logging
from app.db.session import Database
from app.services.visit_service import VisitService
from app.storage.minio import build_object_store

setup_logging()
logger = get_logger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()

    db = Database.from_settings(settings)
    db.init()

    cache = build_cache(settings)
    service = VisitService(db=db, cache=cache)

    object_store = build_object_store(settings)

    app.state.settings = settings
    app.state.db = db
    app.state.cache = cache
    app.state.visit_service = service
    app.state.object_store = object_store

    logger.info(
        "startup complete",
        extra={
            "storage": db.storage,
            "cache": service.cache_backend,
            "object_storage": "minio" if object_store is not None else "none",
        },
    )
    try:
        yield
    finally:
        db.dispose()
        if cache is not None:
            cache.close()
        logger.info("shutdown complete")


def create_app() -> FastAPI:
    app = FastAPI(title="webgen backend", version="1.0.0", lifespan=lifespan)
    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(hello.router, prefix="/api")
    app.include_router(visits.router, prefix="/api")
    app.include_router(files.router, prefix="/api")
    return app


app = create_app()
