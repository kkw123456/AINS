package com.webgen.app.service;

import com.webgen.app.dto.VisitResponse;
import com.webgen.app.mapper.VisitMapper;
import com.webgen.app.repository.VisitRepository;
import org.springframework.stereotype.Service;

/**
 * 访问计数业务逻辑。**这就是「数据层」这一层在骨架里的样子** ——
 * controller 只负责协议，真正碰存储的是 repository，这里负责把它们串起来。
 *
 * service 依赖的是 {@link VisitRepository} **接口**，因此对"文件还是内存"一无所知。
 */
@Service
public class VisitService {

    private final VisitRepository repository;
    private final VisitMapper mapper;

    public VisitService(VisitRepository repository, VisitMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    /** 记一次访问，返回对外的 DTO。 */
    public VisitResponse record() {
        return mapper.toResponse(repository.record());
    }
}
