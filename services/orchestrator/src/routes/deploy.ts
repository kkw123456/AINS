import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { InstanceKind } from '@webgen/shared'
import { ExecutorError } from '../cluster/executor-client.ts'
import { sandboxSource, type SandboxSource } from '../cluster/source.ts'

/**
 * 等生产容器健康的超时。
 *
 * ★ 120 秒而不是 60：**发布出来的那份代码是从零构建的** —— `materializeRelease`
 *   只铺源码（不含 node_modules/dist，那是 .gitignore 挡掉的），所以容器的启动脚本
 *   要现跑一次 `pnpm install && pnpm build`。宿主忙的时候（比如刚建过几个项目、
 *   沙箱还在构建）实测会超过 60 秒，而**发布失败会把整个新版本回滚掉** ——
 *   于是一次偶发的慢变成了"发布不上去"，很难查。
 *   代价：真坏了的发布要多等一分钟才报错。这个方向上宁可等。
 */
/**
 * 等生产容器健康的上限。生产容器**也要自己构建一遍**（nginx + 后端），
 * 而 S4 的种子变重了（TS/Fastify / go 多模块 / 前端构建），本机实测带前端的组合
 * 构建要 60~130 秒 —— 120 秒会不够。给足余量。
 */
const PRODUCTION_HEALTH_TIMEOUT_MS = 240_000
import { anyClientFor } from '../cluster/lookup.ts'
import { config, liveUrl } from '../config.ts'
import { waitForHost } from '../preview-probe.ts'
import * as store from '../store.ts'

/**
 * 发布与线上版本管理（§4 / §5.2 / §8）。
 *
 * **「发布原子生效」要分形态定义**，实现里也是两套完全不同的机制：
 *  - **静态**：产物拷进 `sites/<slug>/v<n>/`，然后**原子翻软链**。
 *    单次 `rename()`，毫秒级，没有窗口 —— 这一条是真的原子。
 *  - **服务**：起新版本容器 → 健康检查 → 停旧版本。
 *    **不是零瞬间**，能做到的是「健康检查不过 → 线上完全不受影响」（失败即无变化），
 *    以及健康通过后尽快切完。docker provider 的 label 创建后不可改，
 *    所以不存在"改路由指向另一端"这种操作。
 */

/** 同一个项目不允许并发发布：两次发布交错会互相翻软链/停错容器。 */
const deploying = new Set<string>()

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------- 改 slug（自定义线上地址）

  /**
   * 改 slug。线上地址是 `<slug>.<SITE_DOMAIN>`，所以这等于**给站点改名**。
   *
   * 三件事必须一起做，少一件都会留下一个指向空目录的线上地址：
   *  ① 改 DB；
   *  ② 把 `sites/<old>` / `releases/<old>` 整目录改名（`current` 是**相对**软链，所以跟着走）；
   *  ③ 服务型还得**重新发布**——容器名和 Traefik router 里都嵌了 slug，改不了（label 创建后不可变）。
   */
  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { slug?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const slug = body.slug?.trim().toLowerCase()
    if (!slug) return reply.code(400).send({ ok: false, error: '缺少 slug' })
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      return reply.code(400).send({
        ok: false,
        error: 'slug 只能用 a-z 0-9 和短横线，2~63 位，且以字母或数字开头',
      })
    }
    // 保留前缀：这些已经被预览/编辑容器的域名空间占了，撞上会导致路由打架
    if (/^(p|d|www|api|site|static)-/.test(slug) || slug === 'site' || slug === 'static') {
      return reply.code(400).send({ ok: false, error: `slug 不能以 p- / d- 开头，也不能是保留字` })
    }
    if (await store.slugTaken(slug, id)) {
      return reply.code(409).send({ ok: false, error: `slug「${slug}」已经被别的项目占了` })
    }
    if (slug === project.slug) return reply.send({ ok: true, slug, unchanged: true })

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    await client.renameSiteDir(project.slug, slug).catch((e) => {
      // 改名失败不该拦着改 DB —— 发布物没了比地址没改更严重，但先让用户知道
      console.warn(`[slug] 发布物改名失败（${project.slug} → ${slug}）：${(e as Error).message}`)
    })
    await store.updateSlug(id, slug)

    // 服务型的容器/router 名里嵌着 slug，改不了，必须重发一次才生效
    const active = await store.getActiveDeployment(id)
    const needsRepublish = project.kind === 'service' && Boolean(active)
    return reply.send({
      ok: true,
      slug,
      url: liveUrl(slug),
      needsRepublish,
      note: needsRepublish
        ? '地址已改。服务型的线上容器名里带着旧 slug，请重新发布一次让它在新地址上生效。'
        : undefined,
    })
  })

  // ------------------------------------------------------------ 查

  app.get('/api/projects/:id/deployments', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    const deployments = await store.listDeployments(id)
    return reply.send({
      ok: true,
      deployments,
      active: deployments.find((d) => d.active) ?? null,
      liveUrl: liveUrl(project.slug),
    })
  })

  app.get('/api/projects/:id/instances', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    return reply.send({
      ok: true,
      instances: await store.listInstances(id),
      /** 服务型才有生产容器；静态的线上是软链，没有容器 */
      production: project.kind === 'service' ? await listProductionSafe(id, project.slug) : [],
    })
  })

  // ------------------------------------------------------------ 发布

  app.post('/api/projects/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { snapshotId?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    if (deploying.has(id)) {
      return reply.code(409).send({ ok: false, error: '这个项目正在发布中，等它跑完' })
    }

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    // ⚠️ projectId 必须带上：组合项目（S3.5）的 spec 里 image 含项目 id。
    // 漏了它的症状是"模板项目能发布、组合项目发布直接 502 读不到 spec"。
    const spec = await client
      .getTemplate(project.template, project.id, project.layoutVersion)
      .then((r) => r.spec)
      .catch(() => null)
    if (!spec) return reply.code(502).send({ ok: false, error: '读不到模板 spec' })

    const snapshots = await store.listSnapshots(id)
    if (snapshots.length === 0) {
      return reply
        .code(400)
        .send({ ok: false, error: '这个项目还没有任何快照。先让 agent 跑一轮生成（构建通过会自动打快照）' })
    }

    // 指定了快照就按它发；没指定就用最新那版
    const snapshot = body.snapshotId
      ? snapshots.find((s) => s.id === body.snapshotId)
      : snapshots[0]
    if (!snapshot) return reply.code(404).send({ ok: false, error: '快照不存在' })

    deploying.add(id)
    try {
      const result =
        project.kind === 'static'
          ? await deployStatic(id, project.slug, spec.artifactDir, snapshot, snapshots[0]!.id)
          : await deployService(id, project.slug, await sandboxSource(project), snapshot, spec)
      return reply.send({ ok: true, ...result })
    } catch (err) {
      // ExecutorError 带 logs（容器退出前的输出就是失败原因），要原样带给前端
      if (err instanceof ExecutorError) {
        return reply.code(502).send({ ok: false, error: err.message, logs: err.logs })
      }
      // 自己抛的带 statusCode 的错误（比如"静态只能发当前这一版"要 400）
      const e = err as Error & { statusCode?: number; logs?: string }
      if (e.statusCode) {
        return reply.code(e.statusCode).send({ ok: false, error: e.message, logs: e.logs })
      }
      throw err
    } finally {
      deploying.delete(id)
    }
  })

  // -------------------------------------------------- 回滚线上版本

  /**
   * 把**线上**退回到某个已发布过的版本。和 `/rollback`（回退工作区）不是一回事：
   * 这个动的是用户看到的那份，工作区一动不动。
   */
  app.post('/api/projects/:id/deployments/:version/activate', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    const target = Number(version)
    const deployments = await store.listDeployments(id)
    const dep = deployments.find((d) => d.version === target)
    if (!dep) {
      return reply.code(404).send({ ok: false, error: `项目里没有 v${target} 这条发布记录` })
    }

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    if (deploying.has(id)) {
      return reply.code(409).send({ ok: false, error: '这个项目正在发布中，等它跑完' })
    }
    deploying.add(id)
    try {
      if (dep.kind === 'static') {
        // 静态回滚 = 翻软链，毫秒级。目标产物不在磁盘上会显式 400，不假装成功。
        await client.activateSite(project.slug, target)
      } else {
        // 服务回滚 = 把**停着的那个容器拉起来**（不是重建）。
        // 容器已经不在了（保留策略回收过）就明说 —— 别从当前代码重建一个"像"的版本，
        // 那不是回滚，是发了个新东西。
        const started = await client.startProduction(project.slug, target)
        if (!started.started) {
          return reply.code(400).send({
            ok: false,
            error: `v${target} 的生产容器已经被回收了，无法回滚。重新发布一次会得到一个新的版本号。`,
          })
        }
        // 拉起来之后要等它真的健康才切；起不来就报错，别把线上切到一个坏容器上
        await client.waitProduction(project.slug, target, project.id, await sandboxSource(project), PRODUCTION_HEALTH_TIMEOUT_MS)

        const current = await store.getActiveDeployment(id)
        if (current && current.version !== target) {
          await client.stopProduction(project.slug, current.version).catch(() => {})
        }
      }

      await store.setActiveDeployment(id, dep.id)
      await store.upsertInstance({
        projectId: id,
        role: 'production',
        kind: dep.kind,
        version: target,
        state: 'running',
        health: 'healthy',
      })
      return reply.send({ ok: true, version: target, url: dep.url })
    } finally {
      deploying.delete(id)
    }
  })
}

// ---------------------------------------------------------------- 内部

async function listProductionSafe(
  projectId: string,
  slug: string,
): Promise<{ name: string; version: number; running: boolean }[]> {
  const client = await anyClientFor(projectId)
  if (!client) return []
  return client
    .listProduction(slug)
    .then((r) => r.instances)
    .catch(() => [])
}

/**
 * 静态发布。
 *
 * ⚠️ **只能发当前这一版**：产物是"工作区里现在这个 `dist/`"，而工作区一直在被 agent 改。
 * 如果允许拿一个旧快照来发，发出去的其实是**当前**的产物、却记成了旧版本号 ——
 * 版本记录会撒谎。要退回去用「回滚」（旧版本的产物还在 `sites/<slug>/v<n>/` 里，没删）。
 */
async function deployStatic(
  projectId: string,
  slug: string,
  artifactDir: string | undefined,
  snapshot: { id: string; seq: number; gitRef: string },
  latestSnapshotId: string,
) {
  if (!artifactDir) {
    throw new Error('这个模板是 static 但没有 artifactDir，模板定义有问题')
  }
  if (snapshot.id !== latestSnapshotId) {
    throw Object.assign(
      new Error(
        '静态项目只能发布当前这一版（产物就是工作区里现在这份）。要退回去用「回滚线上版本」，历史版本的产物还在磁盘上。',
      ),
      { statusCode: 400 },
    )
  }

  const client = await anyClientFor(projectId)
  if (!client) throw new Error('没有可用节点')

  const r = await client.materializeSite(projectId, slug, snapshot.seq, artifactDir)

  const url = liveUrl(slug)
  // ★ 翻完软链还要**探到线上地址真的能打开**才算发布成功。
  // 少了这一步，"发布成功"就只是"文件拷过去了"的同义词 —— 用户点开看到 404 会以为发丢了。
  // 静态翻软链是瞬时的，所以探不到基本意味着静态伺服本身有问题，要明确报出来。
  if (!(await waitForHost(`${slug}.${config.siteDomain}`, 10_000))) {
    throw Object.assign(
      new Error(
        `产物已经铺到 ${r.path}，但线上地址 ${url} 打不开。静态伺服（sites 容器）可能没在跑，检查 docker compose ps。`,
      ),
      { statusCode: 504 },
    )
  }

  const id = `dep-${randomBytes(6).toString('hex')}`
  await store.insertDeployment({
    id,
    projectId,
    snapshotId: snapshot.id,
    version: snapshot.seq,
    kind: 'static',
    instanceId: null, // 静态没有容器
    url,
    path: r.path,
  })
  await store.setActiveDeployment(projectId, id)
  // 静态实例没有容器，但实例记录仍然有意义：它记着"线上现在指向第几版"
  await store.upsertInstance({
    projectId,
    role: 'production',
    kind: 'static',
    version: snapshot.seq,
    state: 'running',
    health: 'healthy',
  })

  return { version: snapshot.seq, url, path: r.path, kind: 'static' as InstanceKind }
}

/**
 * 服务发布。**失败时线上不受任何影响** —— 新容器起不来/不健康就整个撤掉，旧版本继续跑。
 */
async function deployService(
  projectId: string,
  slug: string,
  /** 模板名或组合 —— 详见 cluster/source.ts。**别只传模板名**：组合项目传模板名会让发布挂掉 */
  source: SandboxSource,
  snapshot: { id: string; seq: number; gitRef: string },
  spec: { port: number; healthPath?: string },
) {
  const client = await anyClientFor(projectId)
  if (!client) throw new Error('没有可用节点')

  // 1) 把快照的代码导出来（不含 node_modules/dist，正是"该快照代码"）
  const released = await client.materializeRelease(projectId, snapshot.gitRef, slug, snapshot.seq)

  // 2) 起新版本容器
  const created = await client.createProduction({
    projectId,
    slug,
    version: snapshot.seq,
    releaseDir: released.path,
    ...source,
  })

  // 3) 健康检查。不过就把新容器撤掉，**旧版本原封不动**
  try {
    await client.waitProduction(slug, snapshot.seq, projectId, source, PRODUCTION_HEALTH_TIMEOUT_MS)
  } catch (err) {
    await client.removeProduction(slug, snapshot.seq).catch(() => {})
    const e = err as ExecutorError
    throw Object.assign(
      new Error(`新版本没能起来，已回滚（线上仍是原来那一版）：${e.message}`),
      { statusCode: 502, logs: e.logs },
    )
  }

  // 3.5) ★ 容器健康 ≠ 线上能打开：还要等 Traefik 把新容器的 label 收进路由表。
  // 这一步不做的话，deploy 会"成功返回"而线上地址还是 404（而且是**新容器**的 404 页，
  // 因为路由指向了它但还没生效），直到几秒后才好 —— 刚发布完就去点的人会以为发丢了。
  if (!(await waitForHost(created.host, 15_000))) {
    await client.removeProduction(slug, snapshot.seq).catch(() => {})
    throw Object.assign(
      new Error('容器起来了，但线上地址一直打不开（edge 路由没生效？）。已撤掉新版本，线上没变。'),
      { statusCode: 504 },
    )
  }

  // 4) 记发布，并把上一个版本停掉（保留它的 release 目录，回滚要用）
  const url = liveUrl(slug)
  const id = `dep-${randomBytes(6).toString('hex')}`
  await store.insertDeployment({
    id,
    projectId,
    snapshotId: snapshot.id,
    version: snapshot.seq,
    kind: 'service',
    instanceId: `${projectId}:production`,
    url,
    path: released.path,
  })

  // 停掉上一个版本，但**保留它的容器**（§4「停旧版本（保留上一个供回滚）」）。
  // 删掉的话回滚只能重建，而重建会重新跑构建、产物可能和当时不一样 —— 那不是"回到那一版"。
  const before = await store.getActiveDeployment(projectId)
  await store.setActiveDeployment(projectId, id)
  await store.upsertInstance({
    projectId,
    role: 'production',
    kind: 'service',
    version: snapshot.seq,
    containerId: created.containerId,
    state: 'running',
    health: 'healthy',
  })

  if (before && before.version !== snapshot.seq) {
    await client.stopProduction(slug, before.version).catch(() => {})

    // 保留策略：**只留 current + 上一个**，再往前的容器彻底删掉。
    // 静态是产物、很小，所以全留；服务每个版本都是一个常驻容器，不能无限留。
    for (const d of await store.listDeployments(projectId)) {
      if (d.version === snapshot.seq || d.version === before.version) continue
      if (d.kind !== 'service') continue
      await client.removeProduction(slug, d.version).catch(() => {})
    }
  }

  return { version: snapshot.seq, url, path: released.path, kind: 'service' as InstanceKind }
}
