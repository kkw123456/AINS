import { randomBytes } from 'node:crypto'
import { pool } from '@webgen/db'
import type { DepKind } from '@webgen/shared'
import { encryptSecret, decryptSecret } from './secrets.ts'
import * as store from './store.ts'

/**
 * 依赖服务的**供给**（S4，§6/§7.1）：共享 MySQL 每项目一库 + 独立账号；共享 Redis 按前缀隔离。
 *
 * 结果都落到两处：
 *  - `project_services`：一行一个服务（可见性/元数据）
 *  - `project_env`（**加密**）：`DATABASE_URL` / `REDIS_URL` / `REDIS_KEY_PREFIX`
 *     —— 这些再经 `sandboxSource()` 注入容器的 `spec.env`。
 */

const PREFIX = 'p_'
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 项目级库名 / 账号名，都是 `p_<id>`（id 是 8 位 hex，`assertSafeId` 已保证安全）。 */
export function dbNameFor(projectId: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(projectId)) throw new Error(`项目 id 不安全：${projectId}`)
  return `${PREFIX}${projectId}`
}

function randomPassword(len = 24): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += BASE62[bytes[i]! % BASE62.length]
  return out
}

async function envValue(projectId: string, key: string): Promise<string | null> {
  const rows = await store.listProjectEnv(projectId)
  const hit = rows.find((r) => r.key === key)
  if (!hit) return null
  const { decryptSecret } = await import('./secrets.ts')
  try {
    return decryptSecret(hit.valueEncrypted)
  } catch {
    return null
  }
}

async function putEnv(projectId: string, key: string, value: string): Promise<void> {
  await store.upsertProjectEnv({
    projectId,
    key,
    valueEncrypted: encryptSecret(value),
    scope: 'runtime',
  })
}

/**
 * 确保这个项目有 MySQL 库 + 账号 + 连接串。**幂等**：已经供给过就直接返回旧的连接串
 * （不重新生成密码 —— 那会让已经在跑的容器连不上）。
 */
export async function ensureMysql(
  projectId: string,
): Promise<{ databaseUrl: string; created: boolean }> {
  const existing = await envValue(projectId, 'DATABASE_URL')
  if (existing) return { databaseUrl: existing, created: false }

  const name = dbNameFor(projectId)
  const password = randomPassword()
  const p = pool()

  // ⚠️ 库名/账号名是我们自己拼的（p_<hex>），不是用户输入，所以直接内插是安全的；
  //    密码走参数化（p.escape）避免引号问题。
  await p.query(
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  )
  // 账号可能已存在（上次供给到一半）：先 DROP 再建，保证密码与我们记录的一致。
  await p.query(`DROP USER IF EXISTS '${name}'@'%'`)
  await p.query(`CREATE USER '${name}'@'%' IDENTIFIED BY ${p.escape(password)}`)
  await p.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'%'`)
  await p.query(`FLUSH PRIVILEGES`)

  const databaseUrl = `mysql://${name}:${password}@mysql:3306/${name}`
  await putEnv(projectId, 'DATABASE_URL', databaseUrl)
  await store.insertProjectService({ projectId, kind: 'mysql', dbName: name, roleName: name })
  return { databaseUrl, created: true }
}

/** 删项目时把库和账号一起删掉（用户选了「一起删掉」）。幂等。 */
export async function dropMysql(projectId: string): Promise<void> {
  const name = dbNameFor(projectId)
  const p = pool()
  await p.query(`DROP DATABASE IF EXISTS \`${name}\``)
  await p.query(`DROP USER IF EXISTS '${name}'@'%'`)
  await p.query(`FLUSH PRIVILEGES`)
}

function redisUrl(): string {
  const host = process.env.REDIS_HOST?.trim() || 'redis'
  const port = process.env.REDIS_PORT?.trim() || '6379'
  const password = process.env.REDIS_PASSWORD?.trim()
  const auth = password ? `:${encodeURIComponent(password)}@` : ''
  return `redis://${auth}${host}:${port}/0`
}

/**
 * 确保这个项目能用 Redis。**没有项目级资源**（共享实例 + key 前缀隔离），
 * 只是把 `REDIS_URL` + `REDIS_KEY_PREFIX=<id>:` 写进 env、在 services 里留一行。
 */
export async function ensureRedis(projectId: string): Promise<{ created: boolean }> {
  const existing = await envValue(projectId, 'REDIS_URL')
  if (existing) return { created: false }
  await putEnv(projectId, 'REDIS_URL', redisUrl())
  await putEnv(projectId, 'REDIS_KEY_PREFIX', `${projectId}:`)
  await store.insertProjectService({ projectId, kind: 'redis' })
  return { created: true }
}

/** 按 `stack.data` / `deps` 供给该项目需要的所有依赖服务。返回 provisioning 摘要。 */
function s3Endpoint(): string {
  const host = process.env.MINIO_HOST?.trim() || 'minio'
  const port = process.env.MINIO_PORT?.trim() || '9000'
  return `http://${host}:${port}`
}

/**
 * 确保这个项目能用 MinIO（对象存储 / 「文件系统」）。
 *
 * **没有项目级凭证**（共享实例 + 平台凭证），每项目一个 bucket；bucket 由**应用自己按需创建**
 * （幂等），平台只注入 `S3_*` 并留一行 service。
 * ⚠️ 凭证共享 ⇒ 隔离是**约定**（各写各的 bucket），不是强制 —— 和 Redis 前缀隔离同一档。
 * ⚠️ **bucket 名不能用下划线**（S3 / MinIO 的命名规则：小写字母/数字/连字符/点），
 *    所以这里用 `p-<id>`，而不是 MySQL 库名那个 `p_<id>`。用下划线会被 MinIO 直接拒。
 */
export async function ensureMinio(projectId: string): Promise<{ created: boolean }> {
  const existing = await envValue(projectId, 'S3_ENDPOINT')
  if (existing) return { created: false }
  await putEnv(projectId, 'S3_ENDPOINT', s3Endpoint())
  await putEnv(projectId, 'S3_ACCESS_KEY', process.env.MINIO_ROOT_USER?.trim() || 'webgen_minio')
  await putEnv(projectId, 'S3_SECRET_KEY', process.env.MINIO_ROOT_PASSWORD?.trim() || 'webgen_minio_pass')
  await putEnv(projectId, 'S3_BUCKET', `p-${projectId}`)
  await putEnv(projectId, 'S3_REGION', process.env.MINIO_REGION?.trim() || 'us-east-1')
  await store.insertProjectService({ projectId, kind: 'minio' })
  return { created: true }
}

export async function provisionDeps(
  projectId: string,
  deps: DepKind[],
): Promise<{ mysql?: string; redis?: boolean; minio?: boolean }> {
  const out: { mysql?: string; redis?: boolean; minio?: boolean } = {}
  if (deps.includes('mysql')) out.mysql = (await ensureMysql(projectId)).databaseUrl
  if (deps.includes('redis')) out.redis = (await ensureRedis(projectId)).created
  if (deps.includes('minio')) out.minio = (await ensureMinio(projectId)).created
  return out
}

/**
 * 启动时检查平台账号有没有供给所需的全局权限（CREATE USER / CREATE DATABASE ...）。
 * 没有就打个显眼的 warning —— 否则等到"建项目"时才报 `CREATE command denied`，
 * 看起来像平台坏了。一次性修复命令写在 `scripts/grant-mysql.sh` / README。
 */
export async function checkMysqlPrivileges(): Promise<boolean> {
  try {
    const [rows] = await pool().query<{ n: number } & import('@webgen/db').RowDataPacket[]>(
      `SHOW GRANTS FOR CURRENT_USER()`,
    )
    const text = JSON.stringify(rows)
    const ok = /ALL PRIVILEGES ON \*\.\*/.test(text) || /CREATE USER/.test(text)
    if (!ok) {
      console.warn(
        '[provision] ⚠️ 平台 MySQL 账号没有 CREATE USER / 全局 CREATE 权限，"选了 MySQL 的项目"会建库失败。\n' +
          '           一次性修复：bash scripts/grant-mysql.sh（或按 README 手动 GRANT）。',
      )
    }
    return ok
  } catch (e) {
    console.warn(`[provision] 检查 MySQL 权限失败（不影响启动）：${(e as Error).message}`)
    return false
  }
}
