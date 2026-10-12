package com.webgen.app.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 应用配置。集中读环境变量，别让业务代码到处 `System.getenv`。
 *
 * 字段 → 环境变量：
 *   dataDir → WEBGEN_DATA_DIR（在 application.yml 里 `webgen.data-dir: ${WEBGEN_DATA_DIR:}` 映射进来）
 *             平台选了「数据层」才会注入；为空即退回内存态。
 *
 * ⚠️ 端口不走这里 —— 它是 `server.port`（application.yml 里 `${APP_PORT:3001}`），
 *    和 node/python/go 三个后端保持"听 APP_PORT 不听 PORT"的同一条约定。
 */
@ConfigurationProperties(prefix = "webgen")
public class AppProperties {

    /** 数据目录。空字符串 = 没注入 WEBGEN_DATA_DIR = 内存态（重启归零）。 */
    private String dataDir = "";

    public String getDataDir() {
        return dataDir;
    }

    public void setDataDir(String dataDir) {
        this.dataDir = dataDir;
    }
}
