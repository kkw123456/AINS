import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { CacheKind } from '../config.js'
import type { VisitStore } from '../store/index.js'

/** 该接口不收任何参数；用 zod 显式校验，拒绝多余/异常的 query。 */
const visitsQuery = z.object({})

export interface VisitsDeps {
  store: VisitStore
  cache: CacheKind
}

/**
 * 访问计数。每次请求自增，返回：
 *   { visits: int, storage: "mysql"|"sqlite"|"memory", cache: "redis"|null }
 * 重启后数字是否接着涨，就是"数据层有没有起作用"的判据。
 */
export function visitsRoutes(deps: VisitsDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/api/visits', async (request, reply) => {
      visitsQuery.parse(request.query)
      const visits = await deps.store.hit()
      return reply.send({ visits, storage: deps.store.kind, cache: deps.cache })
    })
  }
}
