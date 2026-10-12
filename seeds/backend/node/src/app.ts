import Fastify, { LogController } from 'fastify'
import type { FastifyInstance, RawServerDefault } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from 'pino'
import type { AppConfig, CacheKind } from './config.js'
import type { VisitStore } from './store/index.js'
import type { ObjectStore } from './store/object-store.js'
import { registerErrorHandler } from './plugins/error-handler.js'
import { registerRequestLogger } from './plugins/request-logger.js'
import { filesRoutes } from './routes/files.js'
import { healthRoutes } from './routes/health.js'
import { helloRoutes } from './routes/hello.js'
import { visitsRoutes } from './routes/visits.js'

/**
 * 带 **pino Logger** 的 Fastify 实例类型。
 *
 * 默认的 `FastifyInstance` 用的是 `FastifyBaseLogger`，而这两个在泛型里是**不变的** ——
 * 直接用默认类型，插件/路由的签名就会和真实实例对不上（TS2345）。
 * 统一用这个别名，全工程一处定义。
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>

export interface AppDeps {
  config: AppConfig
  logger: Logger
  store: VisitStore
  cache: CacheKind
  objectStore: ObjectStore
}

/**
 * 组装 Fastify 实例：注入 logger、挂全局插件、注册路由。
 *
 * 与进程生命周期解耦（不在这里 listen）—— 入口 server.ts 负责 listen 与优雅退出，
 * 测试则用 `app.inject()` 直接打请求，无需真实端口。
 */
export function buildApp(deps: AppDeps): AppInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    // 关掉 Fastify 自带的请求日志，改用我们自己的 request-logger（免得每个请求打两遍）。
    // 顶层 `disableRequestLogging` 已废弃，用 LogController 显式表达。
    logController: new LogController({ disableRequestLogging: true }),
    // 反向代理在 nginx 后面，信任它带来的 X-Forwarded-*
    trustProxy: true,
  })

  registerErrorHandler(app)
  registerRequestLogger(app)

  app.register(healthRoutes())
  app.register(helloRoutes())
  app.register(visitsRoutes({ store: deps.store, cache: deps.cache }))
  app.register(filesRoutes({ store: deps.objectStore }))

  return app
}
