import { buildApp } from './app.js'
import { createRedis } from './cache/redis.js'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createStore } from './store/index.js'
import { createObjectStore } from './store/object-store.js'

/**
 * 进程入口：loadConfig → 建 store/cache/app → listen → 挂优雅退出。
 *
 * ⚠️ 监听 **APP_PORT**（默认 3001），**不是 PORT**。组合项目里 nginx 占对外的 8080，
 * 后端听的是容器内的内部口；两个都用 PORT 会和 nginx 抢同一个端口。
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config)

  const store = await createStore(config, logger)
  const cache = createRedis(config, logger)

  // 缓存是旁路：连不上只告警、不拦启动（真正的主流程是 store）
  if (cache) {
    try {
      await cache.ping()
      logger.info('Redis 已连接')
    } catch (err) {
      logger.warn({ err }, 'Redis 不可达，缓存降级为旁路')
    }
  }

  // 对象存储也是旁路：配了就尽力确保 bucket 就绪，连不上只告警、服务照起。
  // 用限时探针：别让一个不可达的 MinIO 把启动拖死（超时就走人，后续请求再各自重试）。
  const objectStore = createObjectStore(config, logger)
  if (objectStore.kind === 'minio') {
    try {
      await Promise.race([
        objectStore.ensureBucket(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
      logger.info({ bucket: objectStore.bucket }, 'MinIO 已连接，bucket 就绪')
    } catch (err) {
      logger.warn({ err }, 'MinIO 不可达，对象存储降级为 storage="none"')
    }
  }

  const app = buildApp({ config, logger, store, cache: config.cache, objectStore })

  try {
    await app.listen({ host: '0.0.0.0', port: config.APP_PORT })
    logger.info(
      { port: config.APP_PORT, storage: store.kind, cache: config.cache, objectStore: objectStore.kind },
      '后端已启动',
    )
  } catch (err) {
    logger.error({ err }, '服务启动失败')
    await store.close().catch(() => {})
    if (cache) await cache.quit().catch(() => {})
    process.exit(1)
  }

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, '收到退出信号，开始优雅退出')
    try {
      await app.close()
      await store.close()
      if (cache) await cache.quit()
      logger.info('优雅退出完成')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, '退出过程中出错')
      process.exit(1)
    }
  }

  process.on('SIGTERM', (): void => void shutdown('SIGTERM'))
  process.on('SIGINT', (): void => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  // 配置错误 / store 初始化失败都会走到这里 —— 直接非零退出，把原因打到 stderr
  console.error(err)
  process.exit(1)
})
