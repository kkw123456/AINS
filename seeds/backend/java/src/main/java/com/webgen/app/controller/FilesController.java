package com.webgen.app.controller;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 对象存储（MinIO / S3）契约接口。
 *
 * ⚠️ **Java 暂不支持 MinIO**：镜像里没有 S3 客户端（本机 Maven 增量依赖拉不下来，见项目 README），
 *    所以这里**如实**返回 {@code storage:"none"}，而不是假装能存。响应形状和
 *    node / python / go 的 /api/files 一致 —— 平台侧不按语言分支。
 *
 * 等镜像预热能扩展之后，把这里换成真正的 MinIO 客户端即可。
 */
@RestController
@RequestMapping("/api")
public class FilesController {

    @GetMapping("/files")
    public Map<String, Object> list() {
        return Map.of(
                "backend", "java",
                "storage", "none",
                "bucket", "",
                "objects", List.of());
    }

    @PostMapping("/files")
    public Map<String, Object> upload() {
        return Map.of(
                "backend", "java",
                "storage", "none",
                "bucket", "",
                "key", "");
    }
}
