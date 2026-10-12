package com.webgen.app.controller;

import com.webgen.app.dto.VisitResponse;
import com.webgen.app.service.VisitService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 访客计数。**碰存储的活交给 service** —— controller 里不该出现文件 / SQL。
 *
 * ⚠️ 响应是**扁平**的 {@code {"visits": ..., "storage": ..., "cache": null}}，
 *    没有统一返回体外壳（平台契约，和 node / python 同形）。
 *    `storage` 字段直接把它写出来，省得靠猜数据层到底有没有生效。
 */
@RestController
@RequestMapping("/api")
public class VisitController {

    private final VisitService visits;

    public VisitController(VisitService visits) {
        this.visits = visits;
    }

    /**
     * 重启容器之后数字还接着涨，就是数据层在起作用；从 1 重来说明没注入 WEBGEN_DATA_DIR。
     */
    @GetMapping("/visits")
    public VisitResponse visits() {
        return visits.record();
    }
}
