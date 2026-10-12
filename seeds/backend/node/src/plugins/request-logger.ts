import type { AppInstance } from '../app.js'

/**
 * 访问日志：每条请求记一条**结构化**的开始 + 一条完成（含耗时、状态码）。
 *
 * 同样直接挂到根实例（理由见 error-handler.ts）。
 * 配合 app.ts 里的 `logController.disableRequestLogging` —— 关掉 Fastify 自带的那两条，
 * 免得每个请求打两遍、日志翻倍。
 */
export function registerRequestLogger(app: AppInstance): void {
  app.addHook('onRequest', async (request) => {
    request.log.info({ method: request.method, url: request.url }, '请求开始')
  })

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      '请求完成',
    )
  })
}
