import type { FastifyPluginAsync } from 'fastify'

/**
 * 健康检查。**必须返回纯文本 `ok`**（不是 JSON）——
 * 容器的就绪探针与 nginx 的上游健康判断都按这个约定匹配。
 */
export function healthRoutes(): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async (_request, reply) => {
      reply.type('text/plain; charset=utf-8').send('ok')
    })
  }
}
