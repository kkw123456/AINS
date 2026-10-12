package com.webgen.app.repository;

/**
 * 访问计数仓储（**接口**）。service 只依赖它，不知道底下是文件还是内存 ——
 * 换存储（将来接 MySQL / Redis）只加一个实现 + 改一行装配，业务层零改动。
 *
 * 实现见 {@link FileVisitRepository}（有 WEBGEN_DATA_DIR）与
 * {@link MemoryVisitRepository}（内存态）。
 */
public interface VisitRepository {

    /** 记一次访问，返回新的累计值与当前存储类型。 */
    VisitCount record();
}
