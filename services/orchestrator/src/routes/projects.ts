import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { InstanceKind } from '@webgen/shared'
import { parseStack, stackDeps, stackLabel, stackTemplateName, type Stack } from '@webgen/shared'
import { agentService } from '../agent/service.ts'
import { ExecutorError, type ExecutorClient } from '../cluster/executor-client.ts'
import { anyClientFor, clientFor, safePickNode } from '../cluster/lookup.ts'
import { sandboxSource } from '../cluster/source.ts'
import { config, devUrl, liveUrl, previewUrl } from '../config.ts'
import { probeHost, waitForPreview } from '../preview-probe.ts'
import { pickNode } from '../scheduler/index.ts'
import { dropMysql, provisionDeps } from '../provision.ts'
import { decryptSecret, encryptSecret, maskSecret } from '../secrets.ts'
import * as store from '../store.ts'

const OWNER = config.defaultOwner
/**
 * 编辑容器（agent 折腾的那份，域名 `d-<id>`）。
 *
 * S3 之前它同时也是预览容器；拆开之后 `p-<id>` 归 `PREVIEW`。
 * 文件类操作（列表/读写/导出/diff/快照）**永远走 EDIT** ——
 * 工作区只有一份，就挂在编辑实例记的那个节点上。
 */
const EDIT = 'edit' as const
/** 服务型的预览容器（域名 `p-<id>`）。静态没有预览容器，走共享静态伺服。 */
const PREVIEW = 'preview' as const

async function newProjectId(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = randomBytes(4).toString('hex')
    if (!(await store.getProject(id))) return id
  }
  throw new Error('生成项目 id 失败（连撞 8 次，基本不可能）')
}

/**
 * 这个项目的**就绪路径** —— 探它才算"用户真能用"。
 *
 *  · 静态项目 → `/`：没有后端，产物铺好就能看。
 *  · 服务型 / 组合项目 → 模板 spec 的 healthPath。**组合项目这一步是必须的**：
 *    它 `/` 是 nginx 从磁盘伺服的前端产物，后端没起来也是 200 —— 拿 `/` 当就绪判据
 *    会得到"预览就绪"但点开是 502 的假阳性（实测踩到过）。
 *
 * 拿不到 spec 就退回 `/`：宁可漏判，也不要因为一次查询失败把**就绪**判成失败。
 */
async function readinessPath(
  project: { kind: InstanceKind; template: string; id: string; layoutVersion: number },
  client: ExecutorClient,
): Promise<string> {
  if (project.kind === 'static') return '/'
  return client
    .getTemplate(project.template, project.id, project.layoutVersion)
    .then((r) => r.spec.healthPath ?? '/')
    .catch(() => '/')
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------- 模板

  app.get('/api/templates', async (_req, reply) => {
    const client = pickNode(null)
    const { templates } = await client.listTemplates()
    const specs = []
    for (const name of templates) {
      const t = await client.getTemplate(name).catch(() => null)
      specs.push({
        name,
        kind: t?.spec.kind ?? 'service',
        image: t?.spec.image ?? '',
        port: t?.spec.port ?? 0,
        deps: t?.spec.deps ?? [],
      })
    }
    return reply.send({ ok: true, templates: specs })
  })

  // ------------------------------------------------------------- 项目

  app.get('/api/projects', async (_req, reply) => {
    const projects = await store.listProjects(OWNER)
    const out = []
    for (const p of projects) {
      const inst = await store.getInstance(p.id, EDIT)
      out.push({ ...p, previewUrl: previewUrl(p.id), instance: inst })
    }
    return reply.send({ ok: true, projects: out })
  })

  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as {
      template?: string
      stack?: unknown
      name?: string
      prompt?: string
    }

    /*
     * 两条建项目路，**二选一**：
     *   template —— 老路：一个模板目录一整套（node-web / fastapi / vue-static …）
     *   stack    —— 组合路（S3.5）：前端 × 后端 × 数据，镜像按组合当场生成
     *
     * 从这里往下两者**完全合流**：都收敛成一个 `{template 名, kind}`，都走
     * `sandboxSource(...)` 决定给 executor 发什么。所以下游一行都不用分叉。
     */
    let stack: Stack | null = null
    let template: string
    let kind: InstanceKind

    if (body.stack !== undefined && body.stack !== null) {
      try {
        stack = parseStack(body.stack)
      } catch (err) {
        return reply.code(400).send({ ok: false, error: `技术栈不合法：${(err as Error).message}` })
      }
      // 组合出来的**永远是服务型**：容器里跑着 nginx + 后端进程。
      // 纯静态站（没有后端）不走这条路 —— 那是 vue-static 那种模板，由共享静态伺服承担。
      kind = 'service'
      // 组合在 projects.template 那一列里留下的是**组合名**（stack-go-vue-none）——
      // 下游十来处按"字符串模板名"工作的地方因此不用改（见 shared 的 stackTemplateName）。
      template = stackTemplateName(stack)
    } else {
      const t = body.template?.trim()
      if (!t) return reply.code(400).send({ ok: false, error: '缺少 template 或 stack' })

      // 先校验模板存在，并拿 kind——服务型项目有单独更严的上限（§2.4 ②）
      const bootstrap = pickNode(null)
      try {
        kind = (await bootstrap.getTemplate(t)).spec.kind
      } catch (err) {
        return reply
          .code(400)
          .send({ ok: false, error: `模板 ${t} 不可用：${(err as Error).message}` })
      }
      template = t
    }

    const total = await store.countProjects(OWNER)
    if (total >= config.maxProjects) {
      return reply.code(409).send({
        ok: false,
        error: `项目数已达上限（${config.maxProjects}）。先删几个再建。`,
      })
    }
    if (kind === 'service') {
      const svc = await store.countServiceProjects(OWNER)
      if (svc >= config.maxServiceProjects) {
        return reply.code(409).send({
          ok: false,
          error:
            `服务型项目已达上限（${config.maxServiceProjects}）——` +
            `它们每个都要在线上常驻一个进程，所以单独设了更严的额度。`,
        })
      }
    }

    const id = await newProjectId()
    // 默认名：组合项目用一句人话（"Vue + Go + SQLite"），别把 `stack-go-vue-none` 摔到界面上
    const fallbackName = stack ? stackLabel(stack) : template
    const name = body.name?.trim() || `${fallbackName} ${id.slice(0, 6)}`
    await store.insertProject({
      id,
      owner: OWNER,
      name,
      slug: id,
      template,
      stack,
      kind,
      status: 'creating',
    })

    // S4：按组合**供给依赖服务**（建库/建账号 / 登记 redis）。**必须在建沙箱之前** ——
    // 连接串要经 `spec.env` 在容器起来时就在；晚一步容器就没有 `DATABASE_URL`。
    if (stack) {
      try {
        await provisionDeps(id, stackDeps(stack))
      } catch (e) {
        await store.setProjectStatus(id, 'error')
        return reply.code(502).send({
          ok: false,
          error: `依赖服务供给失败：${(e as Error).message}`,
        })
      }
    }

    try {
      // ★ 即使只有一个节点，也一律经 scheduler 拿 executor（S0 验收 ⑦）
      const client = pickNode(null)
      const created = await client.createSandbox(
        id,
        await sandboxSource({ id, template, stack, layoutVersion: 2 }),
        'edit',
      )

      await store.upsertInstance({
        projectId: id,
        role: EDIT,
        kind,
        sandboxId: created.sandbox.sandboxId,
        nodeId: client.nodeId,
        port: created.sandbox.port,
        state: 'running',
      })

      /*
       * ★ S3 拆分：**服务型的预览是另一个容器**（`p-<id>`），编辑容器搬到 `d-<id>`。
       * 为什么在创建时就起：现在还没有闲置回收，预览容器闲着也不会被停，
       * 所以"按需起"省不下什么，反而让新项目一开始就没有预览。
       * 等闲置回收落地后，这里改成惰性创建即可（`preview/start` 已经就位）。
       *
       * **静态项目不起预览容器** —— 它的预览由共享静态伺服读 `previews/<id>/current` 承担
       * （§4：静态实例 0 个专属容器），那份产物要等第一次构建通过才有。
       */
      if (kind === 'service') {
        const pv = await client
          .createSandbox(id, await sandboxSource({ id, template, stack, layoutVersion: 2 }), 'preview')
          .catch(() => null) // 预览起不来不该让建项目失败：编辑容器已经好了
        if (pv) {
          await store.upsertInstance({
            projectId: id,
            role: PREVIEW,
            kind,
            sandboxId: pv.sandbox.sandboxId,
            nodeId: client.nodeId,
            port: pv.sandbox.port,
            state: 'running',
          })
        }
      }

      await store.setProjectStatus(id, 'ready')

      // 带 prompt 就是"一句话建站"：起一轮生成，**不等它跑完**（进度走 /stream）
      const prompt = body.prompt?.trim()
      if (prompt) void agentService.start(id, prompt)

      return reply.send({
        ok: true,
        project: { id, name, slug: id, template, stack, kind, status: 'ready' },
        previewUrl: previewUrl(id),
        sandbox: created.sandbox,
        nodeId: client.nodeId,
        reused: created.reused,
        generating: Boolean(prompt),
      })
    } catch (err) {
      await store.setProjectStatus(id, 'error')
      const logs = err instanceof ExecutorError ? err.logs : undefined
      return reply.code(502).send({
        ok: false,
        error: `沙箱创建失败：${(err as Error).message}`,
        previewUrl: previewUrl(id),
        logs,
      })
    }
  })

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    const instances = await store.listInstances(id)

    // 完整 spec 一起给：前端要 `artifactDir` 才能切「源码 / 构建产物」两个根
    // （/api/templates 那份是投影过的，没这几个字段）。拿不到就算了，不算致命。
    const client = clientFor(instances.find((i) => i.role === EDIT)?.nodeId) ?? safePickNode()
    const spec = client
      ? await client
          .getTemplate(project.template, project.id, project.layoutVersion)
          .then((r) => r.spec)
          .catch(() => null)
      : null

    return reply.send({
      ok: true,
      project,
      instances,
      previewUrl: previewUrl(id),
      devUrl: devUrl(id),
      spec,
      // 线上状态：顶栏要靠它显示"已发布 v3"和线上地址，多给一次请求不值当
      live: await store
        .getActiveDeployment(id)
        .then((d) => (d ? { version: d.version, url: d.url, kind: d.kind } : null)),
      liveUrl: liveUrl(project.slug),
    })
  })

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const warnings: string[] = []
    const instances = await store.listInstances(id)
    // 按各实例记的节点分组清理：编辑容器和预览容器可能落在不同节点上
    const clients = new Map<string, ReturnType<typeof clientFor>>()
    for (const inst of instances) {
      const key = inst.nodeId ?? ''
      if (!clients.has(key)) clients.set(key, clientFor(inst.nodeId))
    }

    const anyClient = [...clients.values()].find(Boolean) ?? null
    if (!anyClient) {
      warnings.push('没有在线节点，容器、发布物和工作区都没能回收（需要节点恢复后人工处理）')
    } else {
      // ① 所有沙箱（编辑 + 预览）。注意 `webgen.production=1` 的容器不在这里，
      //    它们由 executor 的 /production 接口单独管。
      for (const inst of instances) {
        if (!inst.sandboxId) continue
        const c = clients.get(inst.nodeId ?? '') ?? anyClient
        await c.deleteSandbox(inst.sandboxId).catch((e) => {
          warnings.push(`删沙箱失败（${inst.role}）：${(e as Error).message}`)
        })
      }

      // ② 生产容器：**所有版本都要删**（current + 上一个），否则会留下没人管得着的常驻进程。
      //    D 删项目 = 连发布一起清（用户已确认）。
      const prods = await anyClient
        .listProduction(project.slug)
        .then((r) => r.instances)
        .catch(() => [])
      for (const p of prods) {
        await anyClient.removeProduction(project.slug, p.version).catch((e) => {
          warnings.push(`删生产容器 v${p.version} 失败：${(e as Error).message}`)
        })
      }

      // ③ 发布物：sites/<slug> 与 releases/<slug> 一起清掉
      await anyClient.removeSite(project.slug).catch((e) => {
        warnings.push(`删发布物失败：${(e as Error).message}`)
      })
      await anyClient.removePreview(id).catch(() => {})

      // ④ 工作区（内部会先拷一份到回收目录）
      await anyClient.removeWorkspace(id).catch((e) => {
        warnings.push(`删工作区失败：${(e as Error).message}`)
      })

      /*
       * ⑤ 项目镜像（S3.5）。
       *
       * ⚠️ **必须在容器都删完之后**再删：被容器占着的镜像删不掉（executor 那边
       *    对这种失败是"跳过"，所以删早了的后果是镜像悄悄留下来，而不是报错）。
       *
       * 组合的镜像名里含 projectId（`webgen-app/<id>:<hash>`），所以能精确地只删
       * 这一个项目的。不删的话会**线性堆积** —— 每建一个项目多一个，改过组合再多一个旧 tag。
       * 模板项目没有自己的镜像（用的就是 `webgen/node:22` 那些预拉的基础镜像），
       * 这个调用对它们是个空操作。
       */
      await anyClient.removeImages(id).catch((e) => {
        warnings.push(`删项目镜像失败：${(e as Error).message}`)
      })
    }

    /*
     * ⑥ 依赖服务（S4）。用户选了「删项目连库一起删」：`DROP DATABASE p_<id>` + `DROP USER`。
     * 放在**容器都删完之后**（容器可能还连着库）；幂等（IF EXISTS）；
     * 失败只进 warnings[]，不阻断 DB 行清理（和上面几步一致）。
     */
    await dropMysql(id).catch((e) => {
      warnings.push(`删库失败：${(e as Error).message}`)
    })
    await store.deleteProjectServices(id).catch(() => {})
    await store.deleteProjectEnv(id).catch(() => {})

    await store.deleteMessages(id)
    await store.deleteSnapshots(id)
    await store.deleteDeployments(id)
    await store.deleteInstances(id)
    await store.deleteProject(id)
    agentService.discard(id)
    return reply.send({ ok: true, warnings })
  })

  // ------------------------------------------- 依赖服务 / 环境变量（S4，§8）

  /** 该项目的环境变量（**脱敏**返回；连接串永不回明文）。 */
  app.get('/api/projects/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    const rows = await store.listProjectEnv(id)
    return reply.send({
      ok: true,
      env: rows.map((r) => {
        let valueMasked = '****'
        try {
          valueMasked = maskSecret(decryptSecret(r.valueEncrypted))
        } catch {
          valueMasked = '<解不开>'
        }
        return { key: r.key, scope: r.scope, valueMasked, updatedAt: r.updatedAt }
      }),
    })
  })

  /** 写入一个环境变量（加密落库）。**重启容器后生效**（env 是容器启动时注入的）。 */
  app.put('/api/projects/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { key?: string; value?: string; scope?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    const key = body.key?.trim()
    if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
      return reply.code(400).send({ ok: false, error: 'key 必须是大写字母/数字/下划线，且以字母开头' })
    }
    if (typeof body.value !== 'string') {
      return reply.code(400).send({ ok: false, error: 'value 必须是字符串' })
    }
    const scope = body.scope === 'build' ? 'build' : 'runtime'
    await store.upsertProjectEnv({
      projectId: id,
      key,
      valueEncrypted: encryptSecret(body.value),
      scope,
    })
    return reply.send({ ok: true, note: '已写入；重启预览 / 编辑容器后生效' })
  })

  /** 该项目的依赖服务与（脱敏的）连接信息。 */
  app.get('/api/projects/:id/services', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    const services = await store.listProjectServices(id)
    const envs = await store.listProjectEnv(id)
    const maskedOf = (k: string): string | null => {
      const r = envs.find((e) => e.key === k)
      if (!r) return null
      try {
        return maskSecret(decryptSecret(r.valueEncrypted))
      } catch {
        return null
      }
    }
    return reply.send({
      ok: true,
      services: services.map((s) => ({
        kind: s.kind,
        dbName: s.dbName,
        roleName: s.roleName,
        createdAt: s.createdAt,
        url:
          s.kind === 'mysql'
            ? maskedOf('DATABASE_URL')
            : s.kind === 'redis'
              ? maskedOf('REDIS_URL')
              : s.kind === 'minio'
                ? maskedOf('S3_ENDPOINT')
                : null,
      })),
    })
  })

  /** 按需供给一个依赖服务（建库建账号 / 登记 redis）。 */
  app.post('/api/projects/:id/services', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { kind?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    if (body.kind !== 'mysql' && body.kind !== 'redis' && body.kind !== 'minio') {
      return reply.code(400).send({ ok: false, error: 'kind 必须是 mysql / redis / minio' })
    }
    try {
      await provisionDeps(id, [body.kind])
    } catch (e) {
      return reply.code(502).send({ ok: false, error: `供给失败：${(e as Error).message}` })
    }
    return reply.send({ ok: true, note: '已供给；重启容器后连接串才注入' })
  })

  // ------------------------------------------------- 编辑容器（按需开 / 停）

  app.post('/api/projects/:id/editor/start', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { wait?: boolean }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const inst = await store.getInstance(id, EDIT)
    const client = clientFor(inst?.nodeId) ?? pickNode(null)

    try {
      const created = await client.createSandbox(id, await sandboxSource(project))
      await store.upsertInstance({
        projectId: id,
        role: EDIT,
        kind: project.kind,
        sandboxId: created.sandbox.sandboxId,
        nodeId: client.nodeId,
        port: created.sandbox.port,
        state: 'running',
      })

      if (body.wait) {
        const ready = await client.waitSandbox(created.sandbox.sandboxId, 60_000)
        return reply.send({ ok: true, sandbox: created.sandbox, host: ready.host, ready: true })
      }
      return reply.send({ ok: true, sandbox: created.sandbox, reused: created.reused })
    } catch (err) {
      const logs = err instanceof ExecutorError ? err.logs : undefined
      return reply
        .code(502)
        .send({ ok: false, error: (err as Error).message, logs })
    }
  })

  app.post('/api/projects/:id/editor/stop', async (req, reply) => {
    const { id } = req.params as { id: string }
    const inst = await store.getInstance(id, EDIT)
    if (!inst?.sandboxId) return reply.send({ ok: true, removed: false })

    const client = clientFor(inst.nodeId)
    if (client) await client.deleteSandbox(inst.sandboxId).catch(() => {})

    await store.upsertInstance({
      projectId: id,
      role: EDIT,
      kind: inst.kind,
      sandboxId: null,
      nodeId: inst.nodeId,
      port: null,
      state: 'stopped',
    })
    return reply.send({ ok: true, removed: true })
  })

  /**
   * 等**预览**真的能打开（或明确报出为什么不能）。
   *
   * 语义是"用户点开 `p-<id>` 能看到东西"，所以看的是**预览**，不是编辑容器 ——
   * 拆分之后编辑容器在 `d-<id>`，它起没起来跟用户能不能看到预览没关系。
   */
  app.post('/api/projects/:id/wait', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { timeoutMs?: number }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const inst = await store.getInstance(id, PREVIEW)

    // 静态：没有容器可等，探一眼产物铺出来没有
    if (project.kind === 'static') {
      const reachable = await waitForPreview(id, Math.min(body.timeoutMs ?? 15_000, 60_000))
      if (!reachable) {
        return reply.code(504).send({
          ok: false,
          error: '预览地址打不开。静态项目的预览要等第一次构建通过才会铺出产物。',
          previewUrl: previewUrl(id),
        })
      }
      return reply.send({ ok: true, ready: true, previewUrl: previewUrl(id) })
    }

    const client = clientFor(inst?.nodeId)
    if (!inst?.sandboxId || !client) {
      return reply
        .code(409)
        .send({ ok: false, error: '没有在跑的预览容器，先调 preview/start' })
    }

    const total = Math.min(body.timeoutMs ?? 90_000, 180_000)
    try {
      // ① 容器里的进程活着
      const r = await client.waitSandbox(inst.sandboxId, total)

      // ② 还要预览地址真能打开——容器活着 ≠ 路由生效（见 preview-probe.ts）
      //    ⚠️ 路径必须是**这个项目自己的就绪路径**，不能写死 '/'：组合项目的 '/'
      //    是 nginx 伺服的前端产物，后端没起来也是 200，写死 '/' 就是假阳性。
      const reachable = await waitForPreview(id, 15_000, await readinessPath(project, client))

      await store.upsertInstance({
        projectId: id,
        role: PREVIEW,
        kind: inst.kind,
        sandboxId: inst.sandboxId,
        nodeId: inst.nodeId,
        port: inst.port,
        state: 'running',
        health: reachable ? 'healthy' : 'unhealthy',
      })

      if (!reachable) {
        return reply.code(504).send({
          ok: false,
          error: '预览容器已就绪，但预览地址打不开（edge 路由未生效？）',
          previewUrl: previewUrl(id),
        })
      }
      return reply.send({ ...r, ready: true, previewUrl: previewUrl(id) })
    } catch (err) {
      const logs = err instanceof ExecutorError ? err.logs : undefined
      return reply.code(502).send({ ok: false, error: (err as Error).message, logs })
    }
  })

  // ------------------------------------------------------------- 预览地址

  /**
   * `p-<id>` 现在能不能打开。**必须看预览实例，不能看编辑实例** ——
   * S3 拆分后编辑容器搬到了 `d-<id>`，拿它的状态当预览状态会撒谎：
   * 编辑容器活着但预览容器挂了时，会报 'ready' 而用户打开 `p-<id>` 是 404。
   *
   * 静态项目没有预览容器（§4：0 个专属容器），它的预览是共享静态伺服读
   * `previews/<id>/current` 那份产物 —— 有没有那份产物就是它的状态。
   */
  app.get('/api/projects/:id/preview-url', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const url = previewUrl(id)
    const dev = devUrl(id)

    // 静态：没有容器，看产物铺出来没有
    if (project.kind === 'static') {
      const inst = await store.getInstance(id, PREVIEW)
      const version = inst?.version ?? 0
      if (!version) return reply.send({ ok: true, url, devUrl: dev, kind: project.kind, state: 'none' })
      // 产物在不在，直接探线上地址最实在（顺带证明静态伺服是活的）
      const reachable = await probeHost(`p-${id}.${config.previewDomain}`)
      return reply.send({
        ok: true,
        url,
        devUrl: dev,
        kind: project.kind,
        state: reachable ? 'ready' : 'none',
        version,
      })
    }

    // 服务型：看预览实例
    const inst = await store.getInstance(id, PREVIEW)
    if (!inst?.sandboxId) {
      return reply.send({ ok: true, url, devUrl: dev, kind: project.kind, state: 'none' })
    }
    const client = clientFor(inst.nodeId)
    if (!client) return reply.send({ ok: true, url, devUrl: dev, kind: project.kind, state: 'cold' })

    const route = await client.route(inst.sandboxId).catch(() => null)
    return reply.send({
      ok: true,
      url,
      devUrl: dev,
      kind: project.kind,
      state: route?.running ? 'ready' : 'cold',
      nodeId: inst.nodeId,
      port: inst.port,
    })
  })

  /**
   * 把预览实例拉起来（服务型），或者把静态预览的产物铺出来。
   *
   * 为什么单独一个接口而不是复用 `editor/start`：拆分之后它们是**两个不同的东西** ——
   * 编辑容器里是 agent 正在折腾的那份，预览是给人看的那份。
   * 复用的话，"刷新预览"会顺手把 agent 的容器重启一遍。
   */
  app.post('/api/projects/:id/preview/start', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { wait?: boolean }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const inst = await store.getInstance(id, PREVIEW)
    const client = clientFor(inst?.nodeId) ?? safePickNode()
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    // 静态：没有容器可起 —— 但工作区里可能已经有构建产物（agent 跑过 verify），
    // 那就把它铺到预览位置。只会说"没容器可起"是不对的：用户明明有东西可看。
    if (project.kind === 'static') {
      const spec = await client
        .getTemplate(project.template, project.id, project.layoutVersion)
        .then((r) => r.spec)
        .catch(() => null)
      if (!spec?.artifactDir) {
        return reply.code(400).send({ ok: false, error: '模板是 static 但没有 artifactDir' })
      }

      const seq = (await store.getInstance(id, PREVIEW))?.version ?? 0
      try {
        await client.materializePreview(id, seq || 1, spec.artifactDir)
        await store.upsertInstance({
          projectId: id,
          role: PREVIEW,
          kind: 'static',
          version: seq || 1,
          sandboxId: null,
          state: 'running',
          health: 'healthy',
        })
        const reachable = await waitForPreview(id, 15_000)
        return reply.send({ ok: true, kind: 'static', ready: reachable })
      } catch (e) {
        // 产物目录还不存在 = 还没构建成功过。这是**正常状态**（§4 的骨架屏场景），不是故障。
        return reply.send({
          ok: true,
          kind: 'static',
          ready: false,
          note: `还没有构建产物（${(e as Error).message}）。静态项目的预览要等第一次构建通过。`,
        })
      }
    }

    try {
      const created = await client.createSandbox(id, await sandboxSource(project), 'preview')
      await store.upsertInstance({
        projectId: id,
        role: PREVIEW,
        kind: project.kind,
        sandboxId: created.sandbox.sandboxId,
        nodeId: client.nodeId,
        port: created.sandbox.port,
        state: 'running',
      })
      if (!body.wait) return reply.send({ ok: true, sandbox: created.sandbox, reused: created.reused })

      // 等到**预览地址**真能打开为止，不只是容器活着
      await client.waitSandbox(created.sandbox.sandboxId, 60_000).catch(() => {})
      const reachable = await waitForPreview(id, 15_000, await readinessPath(project, client))
      if (!reachable) {
        return reply.code(504).send({
          ok: false,
          error: '预览容器起来了，但预览地址打不开（edge 路由没生效？）',
          previewUrl: previewUrl(id),
        })
      }
      return reply.send({ ok: true, sandbox: created.sandbox, ready: true })
    } catch (err) {
      const logs = err instanceof ExecutorError ? err.logs : undefined
      return reply.code(502).send({ ok: false, error: (err as Error).message, logs })
    }
  })

  // --------------------------------------------------- 工作区文件（透传）

  app.get('/api/projects/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string }
    // `dir` 就是「源码 / 构建产物两个根」：源码 = 不传，构建产物 = 传 spec.artifactDir。
    // 单文件读写不用这个参数——前端把 dir 和 path 拼成完整相对路径即可（jail 在 executor）。
    const { dir } = req.query as { dir?: string }
    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })
    try {
      return reply.send(await client.listFiles(id, dir ?? ''))
    } catch (err) {
      if (err instanceof ExecutorError && err.status === 400) {
        return reply.code(404).send({ ok: false, error: err.message })
      }
      throw err
    }
  })

  app.get('/api/projects/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { path } = req.query as { path?: string }
    if (!path) return reply.code(400).send({ ok: false, error: '缺少 path' })
    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })
    return reply.send(await client.readFile(id, path))
  })

  app.put('/api/projects/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { path?: string; content?: string }
    if (!body.path || typeof body.content !== 'string') {
      return reply.code(400).send({ ok: false, error: '需要 path 与 content' })
    }

    // §14 C3：编辑器写入与 agent 回合改的是同一份文件，二者必须互斥，
    // **明确不做 last-write-wins**——用户的手改被静默覆盖，事后极难排查。
    // 这里挡的是"生成中用户来写"这个方向；反方向（用户在编辑时锁住 agent）
    // 需要编辑租约，留给 S3。
    if (agentService.isRunning(id)) {
      return reply
        .code(409)
        .send({ ok: false, error: '这个项目正在生成中，等这一轮跑完再改文件' })
    }

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })
    return reply.send(await client.writeFile(id, body.path, body.content))
  })

  /**
   * 本轮 agent 改了哪些文件（§5.1）。**没有 git**（快照 = git commit 是 S3），
   * 所以内容是在写文件那一刻采的（见 agent/service.ts 的 recordDiff）。
   * 没跑过生成就是空数组——不是错误。
   */
  app.get('/api/projects/:id/diff', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    return reply.send({ ok: true, files: agentService.diff(id) })
  })

  /**
   * 导出 zip。**二进制响应，不走 {ok:true} 信封**——前端直接 `<a download>` 甩过来。
   * scope=artifacts 时折成 spec.artifactDir 传给 executor（它不认识模板）。
   */
  app.get('/api/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { scope } = req.query as { scope?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    let dir = ''
    if (scope === 'artifacts') {
      const spec = await client
        .getTemplate(project.template, project.id, project.layoutVersion)
        .then((r) => r.spec)
        .catch(() => null)
      // 一期所有模板都是 service，没有 artifactDir（parseTemplate 只允许 static 带它）。
      // 这不是故障，是"这个模板没有构建产物"，说清楚。
      if (!spec?.artifactDir) {
        return reply.code(400).send({
          ok: false,
          error: `模板 ${project.template} 是服务型，没有独立的构建产物目录`,
        })
      }
      dir = spec.artifactDir
    }

    try {
      const { buf, filename } = await client.exportZip(id, dir, `${project.slug}-${scope ?? 'workspace'}`)
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('content-length', String(buf.byteLength))
        .send(buf)
    } catch (err) {
      if (err instanceof ExecutorError) {
        return reply.code(err.status === 400 ? 400 : 502).send({ ok: false, error: err.message })
      }
      throw err
    }
  })

  app.get('/api/projects/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { lines?: string }
    const inst = await store.getInstance(id, EDIT)
    const client = clientFor(inst?.nodeId)
    if (!inst?.sandboxId || !client) return reply.send({ ok: true, logs: '' })
    const r = await client.logs(inst.sandboxId, Number(q.lines) || 100).catch(() => ({ logs: '' }))
    return reply.send({ ok: true, ...r })
  })
}
