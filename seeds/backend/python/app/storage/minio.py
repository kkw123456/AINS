"""MinIO（对象存储 / 「文件系统」）封装。

没有 S3_ENDPOINT -> 返回 None（storage=none）。
有 S3_ENDPOINT 且 minio 库可用 -> 建客户端、探活并确保 bucket 存在 -> ObjectStore。
minio 库缺失 / 连不上 -> 记 warning 并退回 None，**不让启动崩掉**（容器启动可能不联网）。

平台通过环境变量注入连接信息（共享实例 + 平台凭证，每项目一个 bucket `p_<id>`）：
  S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET / S3_REGION
"""

from __future__ import annotations

import io
from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger

logger = get_logger("app.storage")

# 列对象时的上限，避免 bucket 大了把响应撑爆。
MAX_OBJECTS = 100


class ObjectStore:
    """很薄的 MinIO 包装：确保 bucket、列对象、写对象。"""

    def __init__(self, client: Any, bucket: str, region: str = "us-east-1") -> None:
        self._client = client
        self.bucket = bucket
        self._region = region or "us-east-1"

    def ensure_bucket(self) -> None:
        """幂等建 bucket：不存在才建。

        ⚠️ 平台注入的 bucket 名是 `p_<projectId>`（**含下划线**）。minio-py 的
        `make_bucket` 会做**严格**名字校验（只认小写字母、数字、点、连字符），
        不认下划线而直接抛 ValueError；但 MinIO 服务端本身接受下划线。
        所以这里绕过客户端的严格校验，直接发底层 `PUT /<bucket>`（S3 建桶语义，幂等）。
        `bucket_exists` 走的是**宽松**正则，认得下划线，可以正常用于探测。
        """
        if self._client.bucket_exists(self.bucket):
            return
        body = None
        if self._region != "us-east-1":
            body = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<LocationConstraint>{self._region}</LocationConstraint>"
                "</CreateBucketConfiguration>"
            ).encode()
        self._client._url_open(
            "PUT", self._region, bucket_name=self.bucket, body=body
        )

    def list_objects(self, limit: int = MAX_OBJECTS) -> list[str]:
        self.ensure_bucket()
        names: list[str] = []
        for obj in self._client.list_objects(self.bucket, recursive=True):
            names.append(obj.object_name)
            if len(names) >= limit:
                break
        return names

    def put_object(
        self, key: str, data: bytes, content_type: str = "text/plain"
    ) -> None:
        self.ensure_bucket()
        self._client.put_object(
            self.bucket,
            key,
            io.BytesIO(data),
            length=len(data),
            content_type=content_type,
        )


def build_object_store(settings: Settings) -> ObjectStore | None:
    if not settings.s3_endpoint:
        return None

    try:
        from minio import Minio  # 延迟导入：镜像没装也不影响其他路径
    except ImportError:
        logger.warning("minio library not installed; object storage disabled")
        return None

    # Minio() 的 endpoint 要 host:port（不带 scheme），secure 由 scheme 决定。
    endpoint = settings.s3_endpoint.strip()
    secure = endpoint.lower().startswith("https")
    if "://" in endpoint:
        endpoint = endpoint.split("://", 1)[1]
    endpoint = endpoint.rstrip("/")

    client = Minio(
        endpoint,
        access_key=settings.s3_access_key or None,
        secret_key=settings.s3_secret_key or None,
        region=settings.s3_region or "us-east-1",
        secure=secure,
    )

    store = ObjectStore(client, settings.s3_bucket, settings.s3_region)
    try:
        # 探活 + 确保 bucket：连不上 / 凭证不对时在这里抛出，退回 none。
        store.ensure_bucket()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "minio unreachable; object storage disabled",
            extra={"err": str(exc), "endpoint": endpoint},
        )
        return None

    logger.info("minio configured", extra={"bucket": settings.s3_bucket})
    return store
