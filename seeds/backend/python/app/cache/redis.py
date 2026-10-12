"""Redis 缓存封装。

没有 REDIS_URL -> 返回 None（cache=None）。
有 REDIS_URL 且 redis 库可用 -> 返回带 key 前缀的客户端（cache="redis"）。
redis 库缺失 / 连不上 -> 记警告并退回 None，**不让启动崩掉**（容器启动不联网）。
"""

from __future__ import annotations

from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger

logger = get_logger("app.cache")


class Cache:
    """很薄的 Redis 包装：统一 key 前缀。"""

    def __init__(self, client: Any, prefix: str) -> None:
        self._client = client
        self._prefix = prefix

    def key(self, name: str) -> str:
        return f"{self._prefix}{name}"

    def get(self, name: str) -> str | None:
        return self._client.get(self.key(name))

    def set(self, name: str, value: Any, ex: int | None = None) -> None:
        self._client.set(self.key(name), value, ex=ex)

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:  # pragma: no cover - 关闭失败无所谓
            pass


def build_cache(settings: Settings) -> Cache | None:
    if not settings.redis_url:
        return None

    try:
        import redis  # 延迟导入：镜像没装也不影响其他路径
    except ImportError:
        logger.warning("redis library not installed; cache disabled")
        return None

    client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        client.ping()
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis unreachable; cache disabled", extra={"err": str(exc)})
        return None

    logger.info("redis configured", extra={"prefix": settings.redis_key_prefix})
    return Cache(client, settings.redis_key_prefix)
