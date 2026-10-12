package com.webgen.app.repository;

/**
 * 访问计数的领域对象（不是对外 DTO —— 对外那个在 {@code dto/VisitResponse}）。
 *
 * 用 record 表达"一次记录后的结果"，不可变，映射到 DTO 时也不会被半路改掉。
 */
public record VisitCount(long visits, String storage) {
}
