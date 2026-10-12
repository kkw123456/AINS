import type { FastifyInstance } from 'fastify'
import type { NodeInfo } from '@webgen/shared'
import * as registry from '../cluster/registry.ts'

/**
 * 节点心跳入口。executor 会带上自己的 nodeId 与对外 URL——
 * orchestrator 才知道该往哪儿回调（§1.1 节点注册）。
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/nodes/heartbeat', async (req, reply) => {
    const body = req.body as (NodeInfo & { url?: string }) | undefined
    if (!body?.nodeId) return reply.code(400).send({ ok: false, error: '缺少 nodeId' })
    registry.heartbeat(body, body.url)
    return reply.send({ ok: true })
  })

  /** 自检用：现在有哪些节点、状态如何 */
  app.get('/api/nodes', async (_req, reply) => {
    return reply.send({
      ok: true,
      nodes: registry.all().map((n) => ({
        nodeId: n.nodeId,
        url: n.url,
        online: !!n.url && Date.now() - n.lastSeenAt < 45_000,
        sandboxes: n.info?.sandboxes ?? null,
        capacity: n.info?.capacity ?? null,
        diskFreeMb: n.info?.diskFreeMb ?? null,
        images: n.info?.images ?? [],
        lastSeenAt: n.lastSeenAt ? new Date(n.lastSeenAt).toISOString() : null,
      })),
    })
  })
}
