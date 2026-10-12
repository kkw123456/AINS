import { Client } from 'minio'
import type { Logger } from 'pino'
import type { AppConfig, ObjectStorageKind } from '../config.js'

/**
 * 对象存储（「文件系统」）的统一接口。两种实现收敛到它：
 *   - minio：真的连 S3 兼容对象存储（共享 MinIO 实例，每项目一个 bucket）
 *   - none ：没配 S3_* 时的空实现（列表恒为空、写入是 no-op）
 *
 * 路由只认这个接口，不关心底下有没有 S3 —— "没接对象存储"不是错误分支，
 * 就是 storage="none" 的正常返回。
 */
export interface ObjectStore {
  readonly kind: ObjectStorageKind
  /** bucket 名（没接时是空串，接口里原样回给调用方） */
  readonly bucket: string
  /** 幂等：确保 bucket 存在（不在就建）。同一实例只真正跑一次，失败不缓存以便下次重试。 */
  ensureBucket(): Promise<void>
  /** 列出对象名，最多 `limit` 个。 */
  list(limit: number): Promise<string[]>
  /** 写入一个对象（内容为字符串或 Buffer）。 */
  put(key: string, content: string | Buffer): Promise<void>
}

/** 没配对象存储时的空实现 —— 调用方不必到处判空。 */
function createNullStore(): ObjectStore {
  return {
    kind: 'none',
    bucket: '',
    async ensureBucket() {
      /* 没有对象存储，无需 ensure */
    },
    async list() {
      return []
    },
    async put() {
      /* 没有对象存储，写入丢弃 */
    },
  }
}

/**
 * 按 config.objectStore 选实现。
 *
 * ⚠️ 构造 MinIO 客户端**不做任何网络 I/O** —— 连不上 MinIO 也不会拖垮启动。
 * 真正的连通性在第一次 ensureBucket/list/put 时才暴露，由路由 try/catch 降级为
 * storage="none"（见 routes/files.ts）。凭证来自平台注入的 S3_* 环境变量。
 *
 * bucket 名**直接用注入的 S3_BUCKET**（形如 `p-<projectId>`，连字符），种子不自己拼。
 */
export function createObjectStore(config: AppConfig, logger: Logger): ObjectStore {
  if (config.objectStore === 'none') return createNullStore()

  // superRefine 已保证配了 endpoint 就有 key/bucket，这里断言只是为了 TS 收窄。
  const endpoint = new URL(config.S3_ENDPOINT as string)
  const useSSL = endpoint.protocol === 'https:'
  const port = endpoint.port ? Number(endpoint.port) : useSSL ? 443 : 80

  const bucket = config.S3_BUCKET as string
  const client = new Client({
    endPoint: endpoint.hostname,
    port,
    useSSL,
    accessKey: config.S3_ACCESS_KEY as string,
    secretKey: config.S3_SECRET_KEY as string,
    region: config.S3_REGION,
    // MinIO 走 path-style（bucket 进 path，不进 Host）；共享实例下这是对的一档。
    pathStyle: true,
  })

  // 同一进程只真正 ensure 一次；并发首调用共享同一个 Promise。
  // 失败时把这个 Promise 清掉 —— 下一次请求可以再试（MinIO 可能只是刚好没起来）。
  let bucketReady: Promise<void> | null = null
  const ensureBucket = (): Promise<void> => {
    if (bucketReady) return bucketReady
    bucketReady = (async () => {
      const exists = await client.bucketExists(bucket)
      if (!exists) await client.makeBucket(bucket, config.S3_REGION)
    })()
    bucketReady.catch(() => {
      bucketReady = null
    })
    return bucketReady
  }

  logger.info({ endpoint: config.S3_ENDPOINT, bucket }, '已接入 MinIO 对象存储')

  return {
    kind: 'minio',
    bucket,
    ensureBucket,
    async list(limit: number): Promise<string[]> {
      await ensureBucket()
      const names: string[] = []
      const stream = client.listObjectsV2(bucket, '', true)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const done = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err) reject(err)
          else resolve()
        }
        stream.on('data', (obj: { name?: string }) => {
          if (obj.name) names.push(obj.name)
          if (names.length >= limit) {
            stream.destroy()
            done()
          }
        })
        stream.on('end', () => done())
        stream.on('error', (err: Error) => done(err))
      })
      return names.slice(0, limit)
    },
    async put(key: string, content: string | Buffer): Promise<void> {
      await ensureBucket()
      const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
      await client.putObject(bucket, key, body)
    },
  }
}
