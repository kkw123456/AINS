package com.webgen.app.repository;

import java.util.concurrent.atomic.AtomicLong;

/**
 * 内存实现：没注入 WEBGEN_DATA_DIR 时用。重启归零 —— 那正是"没持久化"的样子。
 *
 * ⚠️ **不要**给它加 @Component / @Repository：它和 {@link FileVisitRepository}
 *    是二选一，由 {@code config/StorageConfig} 按配置实例化成**唯一**的 VisitRepository Bean。
 *    两个都注册成 Bean 会让按类型注入变成 NoUniqueBeanDefinitionException。
 */
public class MemoryVisitRepository implements VisitRepository {

    private final AtomicLong counter = new AtomicLong();

    @Override
    public VisitCount record() {
        return new VisitCount(counter.incrementAndGet(), "memory");
    }
}
