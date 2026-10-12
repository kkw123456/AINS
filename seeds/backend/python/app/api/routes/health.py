"""GET /health —— 纯文本 ok，给 nginx / 编排探活用。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_class=PlainTextResponse)
async def health() -> PlainTextResponse:
    return PlainTextResponse("ok")
