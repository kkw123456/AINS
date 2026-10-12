"""GET/POST /api/files —— 对象存储（MinIO）的「文件系统」接口。

没有配对象存储（无 S3_ENDPOINT）时优雅降级：storage="none"、bucket=""、objects=[]。
连不上 MinIO 时同样降级为 none 并记 warning，**不返回 5xx**。
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel

from app.api.deps import get_object_store
from app.core.logging import get_logger
from app.storage.minio import ObjectStore

router = APIRouter(tags=["files"])
logger = get_logger("app.files")

BACKEND = "python"


class FileCreate(BaseModel):
    """POST 的可选请求体：都缺省时自动生成 key 与内容。"""

    key: str | None = None
    content: str | None = None


@router.get("/files")
async def list_files(
    store: ObjectStore | None = Depends(get_object_store),
) -> dict[str, object]:
    if store is None:
        return {"backend": BACKEND, "storage": "none", "bucket": "", "objects": []}

    try:
        objects = store.list_objects()
    except Exception as exc:  # noqa: BLE001 - 运行期连不上也降级，不崩
        logger.warning("minio list failed; degrading to none", extra={"err": str(exc)})
        return {"backend": BACKEND, "storage": "none", "bucket": "", "objects": []}

    return {
        "backend": BACKEND,
        "storage": "minio",
        "bucket": store.bucket,
        "objects": objects,
    }


@router.post("/files")
async def create_file(
    payload: FileCreate | None = Body(default=None),
    store: ObjectStore | None = Depends(get_object_store),
) -> dict[str, object]:
    if store is None:
        return {"backend": BACKEND, "storage": "none", "bucket": "", "key": ""}

    payload = payload or FileCreate()
    key = payload.key or f"upload-{int(time.time())}-{uuid.uuid4().hex[:6]}.txt"
    data = (payload.content or "hello from webgen python backend\n").encode("utf-8")

    try:
        store.put_object(key, data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("minio put failed; degrading to none", extra={"err": str(exc)})
        return {"backend": BACKEND, "storage": "none", "bucket": "", "key": ""}

    return {
        "backend": BACKEND,
        "storage": "minio",
        "bucket": store.bucket,
        "key": key,
    }
