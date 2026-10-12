import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import type { AppConfig } from '../config.js'
import type { VisitStore } from './index.js'

/**
 * SQLite 存储 —— 用 Node 22 内置的 `node:sqlite`，**零外部依赖**。
 *
 * 落 `${WEBGEN_DATA_DIR}/app.db`。那个目录是 **bind mount 到宿主的**，
 * 所以容器删除/重建之后数据还在 —— 这正是"持久化"在这个平台上的全部含义。
 *
 * 计数用**单行 upsert**：id 固定为 1，插入时 n=1，冲突时 n=n+1。
 * 比"每次 INSERT 一行再 COUNT(*)"更省空间、也不会随时间无限长表。
 */
export function createSqliteStore(config: AppConfig, logger: Logger): VisitStore {
  const dir = config.WEBGEN_DATA_DIR as string
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'app.db')

  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)')

  const bump = db.prepare(
    'INSERT INTO visits (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = visits.n + 1',
  )
  const read = db.prepare('SELECT n FROM visits WHERE id = 1')

  logger.info({ dbPath }, '已启用 SQLite 存储')

  return {
    kind: 'sqlite',
    async hit() {
      bump.run()
      const row = read.get() as { n: number } | undefined
      return row?.n ?? 0
    },
    async close() {
      db.close()
    },
  }
}
