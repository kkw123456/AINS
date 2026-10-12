package com.webgen.app.dto;

/**
 * GET /api/hello 的响应 DTO。
 *
 * 字段名 / 个数是**平台契约**：和 node / python / go 三个后端的 /api/hello
 * 保持同一形状（平台侧不按后端语言分支判断），所以这里就这两个字段，别加 pid / at 之类。
 */
public record HelloResponse(String message, String backend) {
}
