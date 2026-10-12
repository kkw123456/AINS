import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { createMemoryStore } from '../src/store/memory'
import { createObjectStore } from '../src/store/object-store'

/**
 * /api/files 契约（**没配 S3**）：storage="none"、bucket=""、objects=[] 是**正常返回**，
 * 不是错误 —— "这个项目没接对象存储"就该长这样，且服务照常起。
 */
describe('对象存储契约（无 S3）', () => {
  const config = loadConfig({ LOG_LEVEL: 'silent' })
  const logger = createLogger({ LOG_LEVEL: 'silent' })
  const app = buildApp({
    config,
    logger,
    store: createMemoryStore(),
    cache: null,
    objectStore: createObjectStore(config, logger),
  })

  beforeAll(async () => {
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('GET /api/files → 200，storage="none"、bucket=""、objects=[]', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      backend: string
      storage: string
      bucket: string
      objects: string[]
    }
    expect(body.backend).toBe('node')
    expect(body.storage).toBe('none')
    expect(body.bucket).toBe('')
    expect(body.objects).toEqual([])
  })

  it('POST /api/files → 200，storage="none"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload: { content: 'hello' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { backend: string; storage: string; key: string }
    expect(body.backend).toBe('node')
    expect(body.storage).toBe('none')
  })
})
