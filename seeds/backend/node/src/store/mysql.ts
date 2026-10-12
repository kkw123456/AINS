import { createPool, type Pool } from 'mysql2/promise'
import type { Logger } from 'pino'
import type { AppConfig } from '../config.js'
import type { VisitStore } from './index.js'

/**
 * MySQL 存储（mysql2/promise，连接池）。
 *
 * 连接串形如 `mysql://user:pass@host:3306/db`，由平台在供给数据服务后注入。
 * 计数同样是**单行 upsert**：`INSERT ... ON DUPLICATE KEY UPDATE n = n + 1`。
 */
export async function createMysqlStore(config: AppConfig, logger: Logger): Promise<VisitStore> {
  const pool: Pool = createPool(config.DATABASE_URL as string)

  // 启动即验证连接可用 + 建表；这一步失败就让整个进程起不来（配置/网络问题要早暴露）。
  await pool.query(
    'CREATE TABLE IF NOT EXISTS visits (id INT PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0)',
  )
  logger.info('已启用 MySQL 存储')

  return {
    kind: 'mysql',
    async hit() {
      await pool.query('INSERT INTO visits (id, n) VALUES (1, 1) ON DUPLICATE KEY UPDATE n = n + 1')
      const [rows] = await pool.query('SELECT n FROM visits WHERE id = 1')
      // BIGINT 默认以字符串返回，统一转成 number 再给响应
      const row = (rows as Array<{ n: number | string }>)[0]
      return Number(row?.n ?? 0)
    },
    async close() {
      await pool.end()
    },
  }
}
