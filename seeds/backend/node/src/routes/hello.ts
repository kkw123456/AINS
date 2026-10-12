import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

/** 可选 query：`?name=张三`。用 zod 校验，坏值会被全局错误处理器转成 400。 */
const helloQuery = z.object({
  name: z.string().min(1).max(50).optional(),
})

/**
 * 返回一句中文问候（+ 后端标识）。契约字段固定为 `message` / `backend`。
 */
export function helloRoutes(): FastifyPluginAsync {
  return async (app) => {
    app.get('/api/hello', async (request, reply) => {
      const { name } = helloQuery.parse(request.query)
      const message = name
        ? `你好，${name}！来自 Node 后端的问候。`
        : '你好，来自 Node 后端的问候！'
      return reply.send({ message, backend: 'node' })
    })
  }
}
