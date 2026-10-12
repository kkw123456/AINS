"""冒烟测试。

镜像 webgen/python:3.12 里**没有 httpx / pytest**，所以这里不依赖 TestClient，
直接调用路由函数与 service，用标准库断言。

直接跑：
    PYTHONPATH=/app python tests/test_health.py
也兼容 pytest（如果环境里装了的话）。
"""

from __future__ import annotations

import asyncio
import tempfile

from app.api.routes.health import health
from app.api.routes.hello import hello
from app.core.config import Settings
from app.db.session import Database
from app.services.visit_service import VisitService


def test_health_plain_text_ok() -> None:
    resp = asyncio.run(health())
    assert resp.status_code == 200
    assert resp.body == b"ok"
    assert resp.media_type == "text/plain"


def test_hello() -> None:
    data = asyncio.run(hello())
    assert data["backend"] == "python"
    assert isinstance(data["message"], str) and data["message"]


def test_visits_memory_increments() -> None:
    settings = Settings(app_port=3001, database_url=None, webgen_data_dir=None)
    db = Database.from_settings(settings)
    db.init()
    try:
        svc = VisitService(db=db)
        first = svc.record_visit()
        second = svc.record_visit()
        assert first.storage == "memory"
        assert first.cache is None
        assert second.visits == first.visits + 1
    finally:
        db.dispose()


def test_visits_sqlite_persists_across_restart() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        settings = Settings(webgen_data_dir=tmp, database_url=None)

        db = Database.from_settings(settings)
        db.init()
        svc = VisitService(db=db)
        first = svc.record_visit()
        second = svc.record_visit()
        assert first.storage == "sqlite"
        assert second.visits == first.visits + 1
        db.dispose()

        # 模拟重启：重新建 engine 读同一份 app.db
        db2 = Database.from_settings(settings)
        db2.init()
        svc2 = VisitService(db=db2)
        third = svc2.record_visit()
        assert third.visits == second.visits + 1
        db2.dispose()


def _run_all() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"\n{len(tests)} passed")


if __name__ == "__main__":
    _run_all()
