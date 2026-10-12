"""GET /api/visits —— 每请求自增的访问计数。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_visit_service
from app.services.visit_service import VisitService

router = APIRouter(tags=["visits"])


@router.get("/visits")
async def visits(service: VisitService = Depends(get_visit_service)) -> dict[str, object]:
    result = service.record_visit()
    return {"visits": result.visits, "storage": result.storage, "cache": result.cache}
