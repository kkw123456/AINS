import type { Logger } from 'pino'
import type { AppConfig, StorageKind } from '../config.js'

/**
 * 访问计数的统一接口。三种后端（mysql / sqlite / memory）都收敛到它 ——
 * 路由只认这个接口，不关心底下是哪个驱动。
 */
export interface VisitStore {
  readonly kind: StorageKind
  /** 自增一次并返回**新的**计数（每来一次 /api/visits 调用一次） */
  hit(): Promise<number>
  /** 幂等关闭底层连接（memory 是 no-op）。优雅退出时调用。 */
  close(): Promise<void>
}

/**
 * 按 config.storage 选实现。
 *
 * **动态 import**：只有真正用到的驱动才会被加载 —— 没配 MySQL 就不加载 mysql2、
 * 没配数据目录就不碰 node:sqlite。这样内存态启动最轻，也不会因为某个驱动
 * 在当前 Node 上不可用而连带把整个服务拖垮。
 */
export async function createStore(config: AppConfig, logger: Logger): Promise<VisitStore> {
  if (config.storage === 'mysql') {
    const { createMysqlStore } = await import('./mysql.js')
    return createMysqlStore(config, logger)
  }
  if (config.storage === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite.js')
    return createSqliteStore(config, logger)
  }
  const { createMemoryStore } = await import('./memory.js')
  return createMemoryStore()
}
