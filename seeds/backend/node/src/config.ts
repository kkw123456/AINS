import { z } from 'zod'

/**
 * 启动期读一次环境变量并校验（zod）。
 *
 * 坏配置**必须**在这里抛错、让入口非零退出 —— 绝不放过一个"看起来起来了、
 * 其实连不上数据库"的进程。zod 的报错信息会指出具体哪个变量不对。
 *
 * 存储选择规则（启动时定死，体现在 /api/visits 的 storage 字段）：
 *   1. 有 DATABASE_URL          → mysql   （与 sqlite 互斥，且优先级更高）
 *   2. 否则有 WEBGEN_DATA_DIR   → sqlite  （落 ${WEBGEN_DATA_DIR}/app.db）
 *   3. 都没有                   → memory  （进程内计数，重启归零）
 *
 * 对象存储（S3 兼容，MinIO）是**可选**的旁路：平台按项目注入一整套 S3_* 变量，
 * 没注入就是"这个项目没接对象存储"（storage="none"、优雅降级、绝不因此崩）。
 * 但**只配了一半**（给了 endpoint 却没给 key/bucket）属于坏配置 —— 那才是真错了，
 * 启动期就要抛出来，别带着半套凭证进服务状态。
 */
const envSchema = z
  .object({
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEBGEN_DATA_DIR: z.string().min(1).optional(),
    // mysql://user:pass@host:3306/db —— zod 的 .url() 走 new URL()，接受任意 scheme
    DATABASE_URL: z.string().url().optional(),
    // redis://[:pass@]host:6379/0
    REDIS_URL: z.string().url().optional(),
    REDIS_KEY_PREFIX: z.string().default(''),
    // ── 对象存储（S3 兼容，MinIO），平台按项目注入 ──
    // 形如 http://minio:9000（容器内按服务名访问）；没配就是不接对象存储。
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    // 每个项目一个 bucket，形如 p-<projectId>（连字符；MinIO 不接受下划线 bucket 名）
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().default('us-east-1'),
  })
  .superRefine((v, ctx) => {
    // 给了 endpoint 就必须给全 —— 半套 S3 配置是配置错误，早暴露。
    if (!v.S3_ENDPOINT) return
    const missing = (
      [
        ['S3_ACCESS_KEY', v.S3_ACCESS_KEY],
        ['S3_SECRET_KEY', v.S3_SECRET_KEY],
        ['S3_BUCKET', v.S3_BUCKET],
      ] as const
    )
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_ENDPOINT'],
        message: `配了 S3_ENDPOINT 就必须同时配：${missing.join('、')}`,
      })
    }
  })

export type StorageKind = 'mysql' | 'sqlite' | 'memory'
export type CacheKind = 'redis' | null
/** 对象存储类型：配全了 S3_* 就是 'minio'，否则 'none'（接口里 storage 字段的来源） */
export type ObjectStorageKind = 'minio' | 'none'
export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL']

export interface AppConfig {
  APP_PORT: number
  LOG_LEVEL: LogLevel
  WEBGEN_DATA_DIR?: string
  DATABASE_URL?: string
  REDIS_URL?: string
  REDIS_KEY_PREFIX: string
  S3_ENDPOINT?: string
  S3_ACCESS_KEY?: string
  S3_SECRET_KEY?: string
  S3_BUCKET?: string
  S3_REGION: string
  /** 主存储类型（由上面的规则推导，不是直接读的变量） */
  storage: StorageKind
  /** 缓存类型：配了 REDIS_URL 就是 'redis'，否则 null */
  cache: CacheKind
  /** 对象存储类型：配全了 S3_* 就是 'minio'，否则 'none' */
  objectStore: ObjectStorageKind
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * 读环境变量 → 校验 → 推导出 storage / cache。
 * `env` 可注入（测试用）；默认取 process.env。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 空字符串等价于"没配" —— .env 里常见的 `KEY=` 不该把一个可选变量变成非法值。
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  )

  const parsed = envSchema.safeParse(cleaned)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new ConfigError(`环境变量校验失败：${detail}`)
  }

  const c = parsed.data
  const storage: StorageKind = c.DATABASE_URL ? 'mysql' : c.WEBGEN_DATA_DIR ? 'sqlite' : 'memory'
  const cache: CacheKind = c.REDIS_URL ? 'redis' : null
  const objectStore: ObjectStorageKind = c.S3_ENDPOINT ? 'minio' : 'none'

  return { ...c, storage, cache, objectStore }
}
