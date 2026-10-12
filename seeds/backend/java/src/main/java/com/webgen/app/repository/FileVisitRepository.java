package com.webgen.app.repository;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 文件实现：注入 WEBGEN_DATA_DIR 时用（storage="file"）。
 *
 * ★ 为什么它能"持久"：工作区是 **bind mount 到宿主的**，所以 ${WEBGEN_DATA_DIR}/visits.txt
 *   在容器删除 / 重建之后还在 —— 这是这个目录唯一的含义。
 *
 * ⚠️ 这里是**普通文件，不是 SQLite**（node / python 用的是真 SQLite）。
 *    JDBC 的 SQLite 驱动要进 Maven 依赖，而改依赖就必须重建镜像里那层 Maven 预热
 *    （联网下上百 MB，实测会卡死），所以这一轮不动它。要换真 SQLite：在 pom.xml 加
 *    `org.xerial:sqlite-jdbc` 并同步改 sandbox/images/java/warm/pom.xml，再重建镜像。
 *
 * ⚠️ **不要**加 @Component / @Repository —— 由 config/StorageConfig 装配（见那里的说明）。
 */
public class FileVisitRepository implements VisitRepository {

    private static final String FILE_NAME = "visits.txt";

    private final Path file;

    public FileVisitRepository(Path dataDir) {
        try {
            Files.createDirectories(dataDir);
        } catch (IOException e) {
            throw new IllegalStateException("建不出数据目录：" + dataDir, e);
        }
        this.file = dataDir.resolve(FILE_NAME);
    }

    /**
     * 读-改-写整段必须原子，否则并发下会丢计数。单进程用 synchronized 就够，不必上文件锁。
     *
     * 读写失败**不吞**：抛出去由全局异常处理转成 500。静默退回内存会让"数据层失效"
     * 变成"数字从 1 开始"，没人查得出来 —— 宁可报错可见。
     */
    @Override
    public synchronized VisitCount record() {
        long next = 1;
        try {
            if (Files.exists(file)) {
                String raw = Files.readString(file, StandardCharsets.UTF_8).trim();
                if (!raw.isEmpty()) {
                    next = Long.parseLong(raw) + 1;
                }
            }
            Files.writeString(file, Long.toString(next), StandardCharsets.UTF_8);
        } catch (IOException | NumberFormatException e) {
            throw new IllegalStateException("读写访问计数失败：" + file, e);
        }
        return new VisitCount(next, "file");
    }
}
