import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { createMemoryStore } from '../src/store/memory'
import { createObjectStore } from '../src/store/object-store'

/**
 * 契约测试：只用内存 store，走 app.inject()，不需要真实端口、不碰外部依赖。
 * 目的只有一个 —— 守住 smoke 脚本依赖的那几个字段。
 */
describe('HTTP 契约', () => {
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

  it('GET /health → 200 纯文本 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toBe('ok')
  })

  it('GET /api/hello → 200 JSON {message, backend:"node"}', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hello' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { message: string; backend: string }
    expect(body.backend).toBe('node')
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })

  it('GET /api/visits → 200，计数自增、storage/cache 正确', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/visits' })).json() as {
      visits: number
      storage: string
      cache: string | null
    }
    expect(first.storage).toBe('memory')
    expect(first.cache).toBeNull()

    const second = (await app.inject({ method: 'GET', url: '/api/visits' })).json() as {
      visits: number
    }
    expect(second.visits).toBe(first.visits + 1)
  })

  it('未知路由 → 404 且是统一错误体', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
