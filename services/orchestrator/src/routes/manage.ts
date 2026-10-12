import type { FastifyInstance } from 'fastify'
import { clientFor, safePickNode } from '../cluster/lookup.ts'
import * as registry from '../cluster/registry.ts'
import { config } from '../config.ts'
import * as store from '../store.ts'

/**
 * 管理面接口（项目管理 / 容器管理 / 模板管理要用的聚合视图）。
 *
 * 为什么要在后端聚合而不是前端并发拉：
 *  - 容器视图要同时看 DB 里的实例（权威的 role/version）**和** docker 里的真实状态
 *    （生产容器可能是 exited/running，DB 里不一定跟得上）；
 *  - 前端逐个项目去拉是 N+1，项目一多就不可用了。
 */
export async function manageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 全局容器视图：三类实例（编辑 / 预览 / 生产）拉平成一个列表。
   *
   * 注意这里列的是**容器**，不是项目：一个服务型项目可能有编辑沙箱 + 预览沙箱 +
   * 若干个生产容器（current + 上一个）。
   */
  app.get('/api/containers', async (_req, reply) => {
    const projects = await store.listProjects(config.defaultOwner)
    const items: unknown[] = []

    for (const p of projects) {
      const instances = await store.listInstances(p.id)
      const client = clientFor(instances.find((i) => i.role === 'edit')?.nodeId)

      for (const i of instances) {
        // 服务型项目的 production 实例行会**和 docker 里的生产容器重复**（下面那段会列全），
        // 指的是同一件事却显示两行。静态没有容器，那一行才有信息量（"线上是第几版"），所以留着。
        if (p.kind === 'service' && i.role === 'production') continue

        items.push({
          key: `${i.id}`,
          projectId: p.id,
          projectName: p.name,
          slug: p.slug,
          template: p.template,
          kind: p.kind,
          role: i.role,
          version: i.version,
          state: i.state,
          health: i.health,
          nodeId: i.nodeId,
          sandboxId: i.sandboxId,
          containerId: i.containerId,
          port: i.port,
          lastUsedAt: i.lastUsedAt,
          // 静态实例没有容器，说明白它是怎么被伺服的
          servedBy: i.kind === 'static' ? '静态伺服（无专属容器）' : '容器',
        })
      }

      // 生产容器是 docker 侧的事实，DB 的 instances 只有一行（current），
      // 而实际可能有 current + 上一个（停着的）。这里按 docker 列全。
      if (p.kind === 'service' && client) {
        const prods = await client
          .listProduction(p.slug)
          .then((r) => r.instances)
          .catch(() => [])
        for (const c of prods) {
          items.push({
            key: `prod:${p.slug}:${c.version}`,
            projectId: p.id,
            projectName: p.name,
            slug: p.slug,
            template: p.template,
            kind: p.kind,
            role: 'production-container',
            version: c.version,
            state: c.running ? 'running' : 'stopped',
            health: 'unknown',
            nodeId: null,
            sandboxId: null,
            containerId: c.containerId,
            containerName: c.name,
            port: null,
            lastUsedAt: null,
            servedBy: '容器（常驻，不参与回收）',
          })
        }
      }
    }

    return reply.send({
      ok: true,
      containers: items,
      nodes: registry.all().map((n) => ({
        nodeId: n.nodeId,
        url: n.url,
        online: !!n.url && Date.now() - n.lastSeenAt < config.nodeStaleMs,
        sandboxes: n.info?.sandboxes ?? null,
        capacity: n.info?.capacity ?? null,
        diskFreeMb: n.info?.diskFreeMb ?? null,
        images: n.info?.images ?? [],
      })),
    })
  })

  /**
   * 单个模板的**完整** spec（模板管理页要看 artifactDir / runCommand / limits 这些，
   * 而 `/api/templates` 那份是投影过的，没有这些字段）。
   */
  app.get('/api/templates/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const client = safePickNode()
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })
    try {
      const r = await client.getTemplate(name)
      return reply.send({ ok: true, name, spec: r.spec })
    } catch (e) {
      return reply.code(404).send({ ok: false, error: (e as Error).message })
    }
  })
}
