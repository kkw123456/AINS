package com.webgen.app.mapper;

import com.webgen.app.dto.VisitResponse;
import com.webgen.app.repository.VisitCount;
import org.springframework.stereotype.Component;

/**
 * 领域对象 → DTO 的**手写映射**（不引 mapstruct —— 依赖固定，且这点映射不值得生成器）。
 *
 * 映射集中在一处：以后 VisitCount 加字段、或 VisitResponse 要改名，只改这里，
 * 不会散落在 service / controller 各处。
 */
@Component
public class VisitMapper {

    /** cache 恒为 null：本模板没有 Redis 驱动（见 VisitResponse 的说明）。 */
    public VisitResponse toResponse(VisitCount count) {
        return new VisitResponse(count.visits(), count.storage(), null);
    }
}
