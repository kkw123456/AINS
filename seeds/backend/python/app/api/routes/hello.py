"""GET /api/hello —— 一句中文问候。"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["hello"])


@router.get("/hello")
async def hello() -> dict[str, str]:
    return {"message": "你好，这里是 Python 后端", "backend": "python"}
