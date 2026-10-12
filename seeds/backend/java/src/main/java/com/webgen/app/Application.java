package com.webgen.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * 组合出来的项目的 Java 后端入口（Spring Boot 3.5 / Java 21，企业级分层骨架）。
 *
 * 分层约定（agent 改代码时按这个走）：
 *   controller → 只做参数校验与协议转换，不写业务
 *   service    → 业务逻辑，事务边界在这层
 *   repository → 数据存取（接口 + 实现），SQL / 文件读写只在这层
 *   dto        → 对外的请求 / 响应对象，**不要直接暴露领域对象**
 *   mapper     → 领域对象 ↔ DTO 的手写映射（不引 mapstruct）
 *   common     → 统一返回体 / 业务异常 / 全局异常处理
 *   config     → 配置类（配置属性、Bean 装配、WebMvc）
 *
 * ⚠️ 它**不伺服前端静态文件** —— 那是本容器里 nginx 的活（见工作区根的 nginx.conf）。
 *
 * ⚠️ 依赖**只有** pom.xml 里那四个 starter（镜像 /opt/m2 是照这四样预热的）。
 *    加任何新依赖都会让沙箱里第一次构建去联网、撞 verify 超时 —— 别加。
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
