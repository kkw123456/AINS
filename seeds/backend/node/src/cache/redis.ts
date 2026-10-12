import { Redis } from 'ioredis'
import type { Logger } from 'pino'
import type { AppConfig } from '../config.js'

/**
 * 可选 Redis 客户端。
 *
 * - 没有 REDIS_URL → 返回 **null**（/api/visits 的 cache 字段随之是 null）。
 * - 有 REDIS_URL → 建一个 ioredis 客户端；所有 key 统一加 `REDIS_KEY_PREFIX` 前缀
 *   （多项目共用一个实例时靠它隔离，别让两个项目的 key 撞在一起）。
 *
 * `lazyConnect`：不在构造时就连，等第一条命令再连 —— 这样即使 Redis 不可达，
 * 后端也能正常起来（缓存是**旁路**，不该拖垮主流程）。
 */
export function createRedis(config: AppConfig, logger: Logger): Redis | null {
  if (!config.REDIS_URL) return null

  const client = new Redis(config.REDIS_URL, {
    keyPrefix: config.REDIS_KEY_PREFIX,
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
  })
  client.on('error', (err: Error) => {
    logger.warn({ err }, 'Redis 连接异常（缓存旁路，不影响主流程）')
  })
  return client
}
