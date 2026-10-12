"""统一错误体：任何异常都返回 {"error": {"code", "message"}}。"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

logger = get_logger("app.errors")


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = f"http_{exc.status_code}"
        message = exc.detail if isinstance(exc.detail, str) else "请求处理失败"
        return _error_response(exc.status_code, code, message)

    @app.exception_handler(RequestValidationError)
    async def _validation_exc(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _error_response(422, "validation_error", "请求参数校验失败")

    @app.exception_handler(Exception)
    async def _unhandled_exc(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error")
        return _error_response(500, "internal_error", "服务器内部错误")
