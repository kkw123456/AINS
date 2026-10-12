import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ExecResult, SandboxHandle, TemplateSpec } from '@webgen/shared'
import { parseStack, StackError } from '@webgen/shared'
import { docker } from '../docker/client.ts'
import { createSandbox, instanceHost, type SandboxRole } from '../docker/create.ts'
import { execInContainer } from '../docker/exec.ts'
import { buildImageFor } from '../images/build.ts'
import {
  containerStatus,
  explainFailure,
  probeHealth,
  tailLogs,
} from '../docker/inspect.ts'
import { config } from '../config.ts'
import { GuardError, assertSafeId } from '../guards.ts'
import * as registry from '../registry.ts'
import { resolveSpec, seedWorkspace, seedWorkspaceFromStack } from '../workspace/seed.ts'
import { ensureWorkspace } from '../workspace/paths.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  /** 建沙箱：铺模板 → 建容器 → 登记。已有**同角色**的沙箱则直接复用。 */
  app.post('/sandboxes', async (req, reply) => {
    const body = req.body as
      | {
          projectId?: string
          template?: string
          stack?: unknown
          role?: 'edit' | 'preview'
          /** 工作区布局版本（S4）：1 = 扁平，2 = backend/frontend/deploy。缺省 2。 */
          layout?: number
          /** 项目级运行时环境变量（连接串等），会被合并进 spec.env（覆盖组合默认值）。 */
          env?: Record<string, string>
        }
      | undefined
    if (!body?.projectId) throw new GuardError('缺少 projectId')
    // template 和 stack **二选一**：前者是老的"一个模板一整套"，后者是组合。
    // 两条路最终都收敛到同一个 `spec`，所以下面建容器那段完全共用（S3.5 的核心取舍）。
    if (!body.template && body.stack === undefined) {
      throw new GuardError('缺少 template 或 stack')
    }
    const projectId = assertSafeId(body.projectId, 'projectId')
    // 默认 edit：老调用点（orchestrator 的建项目 / editor.start）不带 role，行为不变
    const role: SandboxRole = body.role === 'preview' ? 'preview' : 'edit'

    // ★ 按 (projectId, role) 复用。只按 projectId 会在拆分后返回错的容器
    const existing = registry.findByProject(projectId, role)
    if (existing) {
      const st = await containerStatus(existing.containerId).catch(() => null)
      if (st?.running) {
        return reply.send({
          ok: true,
          reused: true,
          sandbox: {
            sandboxId: existing.sandboxId,
            port: existing.port,
            hostPort: existing.hostPort,
            nodeId: existing.nodeId,
          } satisfies SandboxHandle,
          host: instanceHost(projectId, role),
        })
      }
      registry.drop(existing.sandboxId)
    }

    if (registry.count() >= config.sandboxCapacity) {
      return reply.code(429).send({
        ok: false,
        error: `本节点沙箱数已达上限（${config.sandboxCapacity}）。`,
      })
    }

    let spec: TemplateSpec
    if (body.stack !== undefined) {
      let stack
      try {
        stack = parseStack(body.stack)
      } catch (e) {
        if (e instanceof StackError) throw new GuardError(e.message)
        throw e
      }
      // ★ build 是**独立一步**，且只在这个组合第一次出现时真的构建
      //   （buildImageFor 里镜像在就直接返回）。这一步绝不能省：agent 每轮生成会重建
      //   最多 4 次沙箱，要是每次 create 都 build，一轮生成就要 build 四次。
      await buildImageFor(projectId, stack)
      spec = await resolveSpec(body, projectId)
      await ensureWorkspace(projectId)
      await seedWorkspaceFromStack(projectId, stack, body.layout ?? 2)
    } else {
      spec = await resolveSpec(body, projectId)
      await ensureWorkspace(projectId)
      await seedWorkspace(projectId, body.template!)
    }

    // 项目级 env（连接串等）**覆盖**组合推导出来的默认值。create.ts 的 Env 里
    // envPairs 放在最后，所以这里的值会赢（语义一致）。
    if (body.env && typeof body.env === 'object') {
      spec = { ...spec, env: { ...spec.env, ...body.env } }
    }

    const sandboxId = `sbx-${randomUUID().slice(0, 8)}`

    const created = await createSandbox({
      projectId,
      sandboxId,
      workspaceDir: await ensureWorkspace(projectId),
      spec,
      role,
    })

    registry.put({
      sandboxId,
      projectId,
      role,
      nodeId: config.nodeId,
      containerId: created.containerId,
      port: created.port,
      healthPath: spec.healthPath ?? '/',
      hostPort: null,
      createdAt: new Date().toISOString(),
    })

    return reply.send({
      ok: true,
      reused: false,
      sandbox: {
        sandboxId,
        port: created.port,
        hostPort: null,
        nodeId: config.nodeId,
      } satisfies SandboxHandle,
      host: created.host,
    })
  })

  /** 等沙箱真的能访问（或明确报出为什么不能） */
  app.post('/sandboxes/:id/wait', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { timeoutMs?: number; healthPath?: string }
    const healthPath = body.healthPath
    const rec = registry.get(id)
    if (!rec) return reply.code(404).send({ ok: false, error: '沙箱不存在' })

    const timeoutMs = Math.min(body.timeoutMs ?? 60_000, 180_000)
    const deadline = Date.now() + timeoutMs
    let lastLogs = ''

    while (Date.now() < deadline) {
      const st = await containerStatus(rec.containerId).catch(() => null)
      if (!st) return reply.code(404).send({ ok: false, error: '容器不见了' })

      if (!st.running) {
        lastLogs = await tailLogs(rec.containerId).catch(() => '')
        return reply.code(502).send({
          ok: false,
          error: `沙箱启动失败：${explainFailure(st, lastLogs)}`,
          logs: lastLogs,
        })
      }

      // 探模板声明的 healthPath（默认 /）：应用的 /health 才代表"业务起来了"，
      // 只探 / 在静态产物还没生成时会误判。sandboxes.ts 一直写死探 '/'，这里接上。
      //
      // ★ 调用方没给 healthPath 时，用**这个沙箱自己的**（登记时从 spec 记下来的）——
      //   组合项目的 `/` 是 nginx 从磁盘伺服的前端产物，它 200 **不代表后端起来了**。
      if (await probeHealth(rec.containerId, rec.port, healthPath ?? rec.healthPath ?? '/')) {
        return reply.send({
          ok: true,
          ready: true,
          host: instanceHost(rec.projectId, rec.role ?? 'edit'),
        })
      }
      await sleep(500)
    }

    lastLogs = await tailLogs(rec.containerId).catch(() => '')
    return reply.code(504).send({ ok: false, error: '等待沙箱就绪超时', logs: lastLogs })
  })

  /** 删沙箱：容器、路由、登记一起回收；**工作区保留**（产物不该跟着沙箱走） */
  app.delete('/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rec = registry.get(id)
    if (!rec) return reply.send({ ok: true, removed: false })

    const container = docker.getContainer(rec.containerId)
    await container.stop({ t: 3 }).catch(() => {})
    // force+volumes：路由随 label 一起消失（Traefik docker provider 自动回收）
    await container.remove({ force: true, v: true }).catch(() => {})
    registry.drop(id)
    return reply.send({ ok: true, removed: true })
  })

  /** 跑一条命令。argv 形式，走白名单 + 路径 jail。 */
  app.post('/sandboxes/:id/exec', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as
      | { cmd?: unknown; cwd?: string; timeoutMs?: number }
      | undefined
    const rec = registry.get(id)
    if (!rec) return reply.code(404).send({ ok: false, error: '沙箱不存在' })
    if (!Array.isArray(body?.cmd) || body.cmd.some((c) => typeof c !== 'string')) {
      throw new GuardError('cmd 必须是字符串数组')
    }

    const container = docker.getContainer(rec.containerId)
    const result: ExecResult = await execInContainer(container, body.cmd as string[], {
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
    })
    return reply.send({ ok: result.code === 0, ...result })
  })

  /** 反代目标（Traefik docker provider 自己管路由，这个接口只用于自检/跨机） */
  app.get('/sandboxes/:id/route', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rec = registry.get(id)
    if (!rec) return reply.code(404).send({ ok: false, error: '沙箱不存在' })
    const st = await containerStatus(rec.containerId).catch(() => null)
    return reply.send({
      ok: true,
      host: instanceHost(rec.projectId, rec.role ?? 'edit'),
      port: rec.port,
      containerId: rec.containerId,
      ip: st?.ip ?? null,
      running: st?.running ?? false,
    })
  })

  /** 容器日志尾部。排"起不来"用——没有它只能干瞪眼。 */
  app.get('/sandboxes/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { lines?: string }
    const rec = registry.get(id)
    if (!rec) return reply.code(404).send({ ok: false, error: '沙箱不存在' })
    const logs = await tailLogs(rec.containerId, Number(q.lines) || 100).catch(() => '')
    return reply.send({ ok: true, logs })
  })

  app.get('/sandboxes', async (_req, reply) => reply.send({ ok: true, sandboxes: registry.list() }))
}
