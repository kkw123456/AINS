package com.webgen.app.controller;

import com.webgen.app.dto.HelloResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 示例接口 —— 前端种子里那页调的就是它，用来证明"前端产物 → nginx → 后端"这条链是通的。
 *
 * ⚠️ 响应是**扁平的** {@code {"message": ..., "backend": "java"}}，**没有**统一返回体外壳。
 *    这是平台契约：node / python / go 的 /api/hello 都长这样，平台侧不按语言分支。
 *    统一返回体（ApiResponse）留给"生成出来的业务接口"，不套在这三条契约接口上。
 *
 * 生成出来的项目里，这个类可以直接删 / 改：它只是骨架，不是业务。
 */
@RestController
@RequestMapping("/api")
public class HelloController {

    @GetMapping("/hello")
    public HelloResponse hello(@RequestParam(defaultValue = "世界") String name) {
        return new HelloResponse("你好，" + name + "！", "java");
    }
}
