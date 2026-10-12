"""访问量业务逻辑：按存储后端自增并返回当前计数。"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select

from app.cache.redis import Cache
from app.db.session import Database
from app.models.visit import Visit


@dataclass
class VisitResult:
    visits: int
    storage: str
    cache: str | None


class VisitService:
    def __init__(self, db: Database, cache: Cache | None = None) -> None:
        self._db = db
        self._cache = cache
        self._lock = threading.Lock()
        self._memory_count = 0

    @property
    def storage(self) -> str:
        return self._db.storage

    @property
    def cache_backend(self) -> str | None:
        return "redis" if self._cache is not None else None

    def record_visit(self) -> VisitResult:
        count = self._increment()
        if self._cache is not None:
            try:
                self._cache.set("visits", count)
            except Exception:  # noqa: BLE001 - 缓存失败不影响主流程
                pass
        return VisitResult(visits=count, storage=self.storage, cache=self.cache_backend)

    def _increment(self) -> int:
        if self._db.storage == "memory" or self._db.session_factory is None:
            with self._lock:
                self._memory_count += 1
                return self._memory_count

        session = self._db.session_factory()
        try:
            session.add(Visit(at=datetime.now(timezone.utc)))
            session.commit()
            total = session.scalar(select(func.count()).select_from(Visit))
            return int(total or 0)
        finally:
            session.close()
