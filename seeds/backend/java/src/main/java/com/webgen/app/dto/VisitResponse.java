package com.webgen.app.dto;

/**
 * GET /api/visits 的响应 DTO。
 *
 * 字段名 / 个数是**平台契约**（node / python 同形）：`visits` / `storage` / `cache`。
 *   visits  —— 累计访问次数（每请求自增）
 *   storage —— "file"（注入了 WEBGEN_DATA_DIR）或 "memory"
 *   cache   —— **恒为 null**：本模板没有 Redis 驱动，先占住这个字段位，
 *              等依赖能预热了再接真缓存，前端契约不用改。
 */
public record VisitResponse(long visits, String storage, Integer cache) {
}
