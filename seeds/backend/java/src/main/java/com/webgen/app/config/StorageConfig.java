package com.webgen.app.config;

import com.webgen.app.repository.FileVisitRepository;
import com.webgen.app.repository.MemoryVisitRepository;
import com.webgen.app.repository.VisitRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.nio.file.Path;

/**
 * 数据层装配：**按配置挑一个 {@link VisitRepository} 实现**，
 * 业务层（service）只依赖接口，永远不知道自己连的是文件还是内存。
 *
 * 决策：有 WEBGEN_DATA_DIR → {@link FileVisitRepository}（storage="file"）；
 *       否则 → {@link MemoryVisitRepository}（storage="memory"）。
 *
 * ⚠️ 为什么这里没有 MySQL / Redis 分支：本模板**只能用 pom 里那四个 starter**，
 *    没有 JDBC / Redis 驱动，连不了库。等依赖能预热了，这里加一个分支即可，
 *    service / controller 一行都不用动 —— 这正是分层的意义。
 */
@Configuration
public class StorageConfig {

    private static final Logger log = LoggerFactory.getLogger(StorageConfig.class);

    @Bean
    public VisitRepository visitRepository(AppProperties props) {
        String dir = props.getDataDir();
        if (dir != null && !dir.isBlank()) {
            log.info("数据层：file（WEBGEN_DATA_DIR={}）", dir);
            return new FileVisitRepository(Path.of(dir));
        }
        log.info("数据层：memory（未注入 WEBGEN_DATA_DIR，重启归零）");
        return new MemoryVisitRepository();
    }
}
