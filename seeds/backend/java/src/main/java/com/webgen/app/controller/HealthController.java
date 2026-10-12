package com.webgen.app.controller;

import com.webgen.app.common.ApiResponse;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 健康检查。平台的编辑器 / 预览 / 生产三处都拿它判"容器到底起没起来"，
 * 所以这条**必须轻**（不碰数据库、不调外部服务）—— 一慢就把健康检查拖成超时，
 * 然后容器看着是活的却被判死。
 *
 * 两条路径是**故意分开**的：
 *   /health     ← nginx 直接转过来的那条（`location = /health`），对外就是它。
 *                 返回**纯文本** ok，和 node / python / go 三个后端**逐字一致** ——
 *                 平台侧不必按后端语言分支判断。
 *   /api/health ← 走 /api/ 那一跳的富信息版，给人看的，用统一返回体 {@link ApiResponse}。
 *
 * ⚠️ 少了 /health 这一条，容器起得来、日志也干净，但健康检查永远不过 ——
 *    因为 nginx 转到的是后端根本没有的路径。（这个坑踩过一次。）
 */
@RestController
public class HealthController {

    /** 对外那条。别改成 JSON —— 四个后端要保持同一个形状 */
    @GetMapping(value = "/health", produces = MediaType.TEXT_PLAIN_VALUE)
    public String health() {
        return "ok";
    }

    @GetMapping("/api/health")
    public ApiResponse<Map<String, Object>> healthDetail() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "UP");
        body.put("service", "backend");
        body.put("time", Instant.now().toString());
        return ApiResponse.ok(body);
    }
}
