import Fastify from 'fastify'
import { initSchema } from '@webgen/db'
import * as registry from './cluster/registry.ts'
import { config } from './config.ts'
import { chatRoutes } from './routes/chat.ts'
import { deployRoutes } from './routes/deploy.ts'
import { internalRoutes } from './routes/internal.ts'
import { manageRoutes } from './routes/manage.ts'
import { projectRoutes } from './routes/projects.ts'
import { snapshotRoutes } from './routes/snapshots.ts'
import { checkMysqlPrivileges } from './provision.ts'
import { hasSecretKey } from './secrets.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err, req, reply) => {
  const e = err as Error & { statusCode?: number }
  if (e.statusCode === 400) {
    return reply.code(400).send({ ok: false, error: e.message })
  }
  req.log.error(err as Error)
  return reply.code(500).send({ ok: false, error: e.message })
})

await app.register(projectRoutes)
await app.register(chatRoutes)
await app.register(internalRoutes)
await app.register(snapshotRoutes)
await app.register(deployRoutes)
await app.register(manageRoutes)

app.get('/healthz', async () => ({ ok: true, role: 'orchestrator' }))

// MySQL 可能比 orchestrator 起得晚（compose 里它自己也要初始化），重试几次
async function waitForDb(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initSchema()
      return
    } catch (err) {
      if (i === attempts) throw err
      app.log.warn(`等 MySQL 就绪（第 ${i}/${attempts} 次）：${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

await waitForDb()

// S4：数据服务的两处启动自检（都不阻断启动，只告警）
await checkMysqlPrivileges()
if (!hasSecretKey()) {
  app.log.warn(
    '未设 WEBGEN_SECRET_KEY：project_env 里的连接串将以**明文**落库（仅限本机 dev；生产必须设）。',
  )
}

registry.configure({ staleMs: config.nodeStaleMs })
registry.seed(config.seedExecutors)

await app.listen({ port: config.port, host: '0.0.0.0' })
app.log.info(
  `orchestrator :${config.port} · 预览域名 *.${config.previewDomain}:${config.previewPort} · ` +
    `预置节点 ${config.seedExecutors.join(', ')}（等心跳）`,
)
