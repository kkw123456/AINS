package com.webgen.app;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 契约测试：覆盖平台依赖的三条接口里最要紧的行为。
 *
 * 跑在**没注入 WEBGEN_DATA_DIR** 的环境下，所以 storage 应是 "memory"，
 * 正好也把"内存退路"这条分支覆盖了。
 */
@SpringBootTest
@AutoConfigureMockMvc
class AppEndpointsTest {

    @Autowired
    private MockMvc mvc;

    /** 对外健康检查：必须是 200 + 纯文本 ok（四个后端逐字一致）。 */
    @Test
    void health_returns_plain_ok() throws Exception {
        mvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(content().string("ok"));
    }

    /** /api/hello：扁平 JSON，backend 必须是 "java"，message 是中文问候。 */
    @Test
    void hello_returns_flat_json() throws Exception {
        mvc.perform(get("/api/hello"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.backend").value("java"))
                .andExpect(jsonPath("$.message", containsString("你好")));
    }

    /** /api/visits：visits 自增、storage 是 storage 取值之一、cache 恒为 null。 */
    @Test
    void visits_reports_storage_and_null_cache() throws Exception {
        mvc.perform(get("/api/visits"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.visits").isNumber())
                .andExpect(jsonPath("$.storage").value("memory"))
                .andExpect(jsonPath("$.cache").value(nullValue()));
    }
}
