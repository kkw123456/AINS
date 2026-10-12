package com.webgen.app.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * WebMvc 配置。目前只挂了**一条访问日志拦截器**：
 * 每个请求打一行 `方法 路径 -> 状态码 (耗时ms)`，方便排"到底是 nginx 还是后端"。
 *
 * 结构化日志靠 logback（见 logback-spring.xml）带时间戳 / 级别，
 * **不引任何新依赖** —— 本模板依赖是固定的那四个 starter。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private static final Logger log = LoggerFactory.getLogger(WebConfig.class);

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            private static final String START = "webgen.req.start";

            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
                request.setAttribute(START, System.nanoTime());
                return true;
            }

            @Override
            public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                        Object handler, Exception ex) {
                Object start = request.getAttribute(START);
                long ms = start instanceof Long s ? (System.nanoTime() - s) / 1_000_000 : -1;
                log.info("{} {} -> {} ({}ms)", request.getMethod(), request.getRequestURI(),
                        response.getStatus(), ms);
            }
        });
    }
}
