"""依赖注入：从 app.state 里取启动时建好的单例。"""

from __future__ import annotations

from fastapi import Request

from app.cache.redis import Cache
from app.core.config import Settings
from app.services.visit_service import VisitService
from app.storage.minio import ObjectStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_visit_service(request: Request) -> VisitService:
    return request.app.state.visit_service


def get_cache(request: Request) -> Cache | None:
    return request.app.state.cache


def get_object_store(request: Request) -> ObjectStore | None:
    return request.app.state.object_store
