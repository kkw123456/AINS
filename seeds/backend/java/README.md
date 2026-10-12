# Java 后端种子（Spring Boot 3.5 / Java 21）

组合项目的 **后端片段**。平台把本目录**整目录**拷到工作区的 `backend/`，然后：

```bash
cd /workspace/backend
mvn -q package -DskipTests          # 产出 target/app.jar
java -jar target/app.jar --server.port=$APP_PORT
```

对外只暴露 nginx 的口；后端听 **`APP_PORT`**（容器内，默认 3001），**不是 `PORT`**。

## ⚠️ 依赖是固定死的：只许用它已有的四个

```xml
spring-boot-starter-web        # MVC / Jackson / 内嵌 Tomcat
spring-boot-starter-validation # @Valid
spring-boot-starter-actuator   # /actuator/health
spring-boot-starter-test       # 测试（test scope）
```

镜像 `webgen/java:21` 的 `/opt/m2` 是**照这四样**预热的，沙箱里构建纯命中本地缓存、**不联网**。
**加任何新依赖（mybatis-plus / mysql-connector / mapstruct / redis …）都会让首次构建去联网、
撞 verify 超时卡死。** 要加依赖必须同步改 `sandbox/images/java/warm/pom.xml` 并**重建镜像**
（那是个慢操作）。在那之前，数据层只能降级（见下）。

## 数据层（刻意的退路）

| 条件 | storage | 行为 |
| --- | --- | --- |
| 注入了 `WEBGEN_DATA_DIR` | `file` | 计数落 `${WEBGEN_DATA_DIR}/visits.txt`，容器重建后不丢 |
| 没注入 | `memory` | 进程内计数，重启归零 |

`cache` 恒为 `null` —— 没有 Redis 驱动。连不了 MySQL。

## 目录结构（企业级分层）

```
src/main/java/com/webgen/app/
  Application.java          入口（@SpringBootApplication + @ConfigurationPropertiesScan）
  config/                   配置类：AppProperties（读 webgen.*）、StorageConfig（装配仓储）、WebConfig（访问日志）
  controller/               HealthController / HelloController / VisitController（只做协议，不写业务）
  service/                  VisitService（业务逻辑）
  dto/                      HelloResponse / VisitResponse（对外响应，别泄漏领域对象）
  mapper/                   VisitMapper（领域对象 ↔ DTO，手写，不引 mapstruct）
  repository/               VisitRepository 接口 + FileVisitRepository / MemoryVisitRepository
  common/                   ApiResponse（成功壳）/ ErrorResponse（错误壳）/ BizException / GlobalExceptionHandler
src/main/resources/
  application.yml           server.port=${APP_PORT:3001}、优雅停机、actuator 只开 health/info
  logback-spring.xml        结构化日志（时间戳 + 级别 + 线程 + logger）
```

分层方向：`controller → service → repository`，映射经 `mapper`，异常收敛到 `common`。
`service` 只依赖 `VisitRepository` 接口，换存储不用动业务代码。

## HTTP 契约（平台依赖，别改形状）

| 路径 | 响应 |
| --- | --- |
| `GET /health` | `200`，**纯文本** `ok`（和 node/python/go 逐字一致） |
| `GET /api/hello` | `200`，扁平 JSON `{"message":"你好，世界！","backend":"java"}` |
| `GET /api/visits` | `200`，扁平 JSON `{"visits":1,"storage":"memory","cache":null}` |
| 出错 | `{"error":{"code":40000,"message":"..."}}`（HTTP 状态码按业务 code 前三位映射） |

> 前三条**不套统一返回体外壳**，是为了和其余三个后端同形（平台侧不按语言分支）。
> `ApiResponse` 这个成功壳留给 agent 后续生成的业务接口。

## 本地跑

```bash
mvn -q package -DskipTests
APP_PORT=3001 java -jar target/app.jar
# 有数据层：
mkdir -p /tmp/data && WEBGEN_DATA_DIR=/tmp/data APP_PORT=3001 java -jar target/app.jar
```

跑测试：`mvn test`（覆盖 /health、/api/hello、/api/visits 三条契约）。
