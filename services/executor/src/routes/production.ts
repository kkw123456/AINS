import type { FastifyInstance } from 'fastify'
import { createProduction, listProduction, productionContainerName, removeProduction, startProduction, stopProduction } from '../docker/production.ts'
import { containerStatus, probeHealth, tailLogs } from '../docker/inspect.ts'
import { GuardError, assertSafeId } from '../guards.ts'
import { resolveSpec } from '../workspace/seed.ts'

/**
 * 生产实例接口（S3）。起/停/查 + 健康检查。
 *
 * 健康检查终于用上了 `spec.healthPath` —— 这个字段被解析进 TemplateSpec 之后
 * **从来没被消费过**，`/sandboxes/:id/wait` 一直写死探 `/`。
 */
export async function productionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/production', async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string
      slug?: string
      version?: number
      releaseDir?: string
      template?: string
      /** 组合项目走这个（S3.5），和 template 二选一 */
      stack?: unknown
      /** 工作区布局版本（S4）。1 = 扁平，2 = backend/frontend/deploy。缺省 2。 */
      layout?: number
      /** 项目级运行时环境变量（连接串等），合并进 spec.env 覆盖组合默认值。 */
      env?: Record<string, string>
    }
    if (!body.projectId || !body.slug || !body.version || !body.releaseDir) {
      throw new GuardError('需要 projectId / slug / version / releaseDir（外加 template 或 stack）')
    }
    assertSafeId(body.projectId, 'projectId')
    assertSafeId(body.slug, 'slug')

    // ⚠️ 组合项目必须走 stack 这条路：拿 `stack-<后端>-<前端>-<数据>` 当模板名
    // 去查磁盘会报"模板不存在"，而现象是**只有发布挂**（预览和生成都是好的）。
    const baseSpec = await resolveSpec(body, body.projectId)
    const spec =
      body.env && typeof body.env === 'object'
        ? { ...baseSpec, env: { ...baseSpec.env, ...body.env } }
        : baseSpec
    const created = await createProduction({
      projectId: body.projectId,
      slug: body.slug,
      version: body.version,
      releaseDir: body.releaseDir,
      spec,
    })
    return reply.send({ ok: true, ...created })
  })

  /**
   * 等生产实例真的健康。
   *
   * 用 `spec.healthPath ?? '/'`：应用的 `/health` 才代表"业务起来了"，
   * 探 `/` 在静态产物还没生成时会误判（返回 200 但其实是个占位页）。
   */
  app.post('/production/:slug/:version/health', async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string }
    assertSafeId(slug, 'slug')
    const body = (req.body ?? {}) as {
      template?: string
      stack?: unknown
      projectId?: string
      /** 工作区布局版本（S4）：影响组合的 build/run 命令。缺省 2。 */
      layout?: number
      timeoutMs?: number
    }

    // 生产健康检查也要能按组合解析 —— 否则起得来、等不到健康，发布永远失败。
    // ⚠️ 组合的镜像 tag 含 **projectId**，不是 slug（改过 slug 的项目两者不一样），
    //    所以这里要 projectId，别图省事拿 slug 顶上。
    if (!body.projectId) throw new GuardError('需要 projectId')
    assertSafeId(body.projectId, 'projectId')
    const spec = await resolveSpec(body, body.projectId)
    const name = productionContainerName(slug, Number(version))
    // 上限放到 300s：生产容器自己也要构建一遍，S4 的种子变重后带前端的组合要 60~130s。
    const deadline = Date.now() + Math.min(body.timeoutMs ?? 60_000, 300_000)

    const containers = await listProduction(slug)
    const target = containers.find((c) => c.version === Number(version))
    if (!target) return reply.code(404).send({ ok: false, error: '这个版本的生产容器不存在' })

    const path = spec.healthPath || '/'
    while (Date.now() < deadline) {
      const st = await containerStatus(target.containerId).catch(() => null)
      if (!st?.running) {
        // 容器退了：退出前的日志就是失败原因，原样带出去给调用方显示
        const logs = await tailLogs(target.containerId, 40).catch(() => '')
        return reply.code(502).send({
          ok: false,
          error: `生产容器退出（exit=${st?.exitCode ?? '未知'}），健康检查失败`,
          logs,
        })
      }
      // probeHealth 走容器 IP，**不走预览域名**——*.localhost 只有宿主浏览器认（§4.1）
      if (await probeHealth(target.containerId, spec.port, path)) {
        return reply.send({ ok: true, healthy: true, path })
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    return reply.code(504).send({ ok: false, error: `等 ${path} 健康超时（${name}）` })
  })

  app.get('/production/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    assertSafeId(slug, 'slug')
    return reply.send({ ok: true, instances: await listProduction(slug) })
  })

  /** 停某个版本但保留容器（发布新版后回收旧的；§4「保留上一个供回滚」） */
  app.post('/production/:slug/:version/stop', async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string }
    assertSafeId(slug, 'slug')
    return reply.send({ ok: true, ...(await stopProduction(slug, Number(version))) })
  })

  /** 把停着的某个版本拉起来（回滚） */
  app.post('/production/:slug/:version/start', async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string }
    assertSafeId(slug, 'slug')
    return reply.send({ ok: true, ...(await startProduction(slug, Number(version))) })
  })

  app.delete('/production/:slug/:version', async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string }
    assertSafeId(slug, 'slug')
    const r = await removeProduction(slug, Number(version))
    return reply.send({ ok: true, ...r })
  })
}
