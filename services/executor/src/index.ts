import { mkdir } from 'node:fs/promises'
import Fastify from 'fastify'
import { TemplateError } from '@webgen/shared'
import { config, workspaceRoot } from './config.ts'
import { ensureNetwork } from './docker/client.ts'
import { listSandboxRecords } from './docker/inspect.ts'
import { GuardError } from './guards.ts'
import { startHeartbeat } from './heartbeat.ts'
import * as registry from './registry.ts'
import { imageRoutes } from './routes/images.ts'
import { nodeRoutes } from './routes/node.ts'
import { productionRoutes } from './routes/production.ts'
import { publishRoutes } from './routes/publish.ts'
import { sandboxRoutes } from './routes/sandboxes.ts'
import { workspaceRoutes } from './routes/workspaces.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err, req, reply) => {
  if (err instanceof GuardError || err instanceof TemplateError) {
    return reply.code(400).send({ ok: false, error: err.message })
  }
  const e = err as Error & { statusCode?: number }
  if (e.statusCode === 400) {
    return reply.code(400).send({ ok: false, error: e.message })
  }
  req.log.error(err as Error)
  return reply.code(500).send({ ok: false, error: e.message })
})

await app.register(sandboxRoutes)
await app.register(workspaceRoutes)
await app.register(nodeRoutes)
await app.register(publishRoutes)
await app.register(productionRoutes)
await app.register(imageRoutes)

app.get('/healthz', async () => ({ ok: true, node: config.nodeId, role: 'executor' }))

await mkdir(workspaceRoot, { recursive: true })
await ensureNetwork().catch((err) => {
  app.log.warn({ err }, '建 docker 网络失败，沙箱可能连不上 Traefik')
})

// 内存登记表只是缓存；真相在 docker 里——重启后按 label 重建（§2.1）
const records = await listSandboxRecords().catch(() => [])
registry.reset(records)

await app.listen({ port: config.port, host: '0.0.0.0' })
app.log.info(
  `executor [${config.nodeId}] :${config.port} · 工作区 ${workspaceRoot} · ` +
    `已接管 ${records.length} 个在跑的沙箱 · 模板目录 ${config.templatesDir}`,
)

startHeartbeat()
