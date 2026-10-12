import type { FastifyInstance } from 'fastify'
import { GuardError, assertSafeId } from '../guards.ts'
import {
  activateSiteVersion,
  materializePreview,
  materializeRelease,
  materializeSite,
  removePreview,
  removeSite,
  renameSiteDir,
} from '../workspace/publish.ts'

/**
 * 发布物化接口（S3）。
 *
 * 为什么这些是 executor 的活而不是 orchestrator 直接写盘：
 * §5.3 定了「文件链路一律走 executor，别图省事直读本地目录」——
 * 单机看着绕，多节点下 orchestrator 和工作区根本不在同一台机器上。
 * 发布物同理：产物要落在**边缘能读到的那台机器**上。
 */
export async function publishRoutes(app: FastifyInstance): Promise<void> {
  /** 静态发布：把工作区的产物铺到 sites/<slug>/v<version>/ 并翻 current */
  app.post('/projects/:projectId/publish/static', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    const body = (req.body ?? {}) as { slug?: string; version?: number; artifactDir?: string }
    if (!body.slug || !body.version || !body.artifactDir) {
      throw new GuardError('需要 slug / version / artifactDir')
    }
    assertSafeId(body.slug, 'slug')
    const r = await materializeSite(projectId, body.slug, body.version, body.artifactDir)
    return reply.send({ ok: true, ...r })
  })

  /** 静态预览：同样的产物铺到 previews/<id>/v<version>/，给 p-<id> 用 */
  app.post('/projects/:projectId/publish/preview', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    const body = (req.body ?? {}) as { version?: number; artifactDir?: string }
    if (!body.version || !body.artifactDir) throw new GuardError('需要 version / artifactDir')
    const r = await materializePreview(projectId, body.version, body.artifactDir)
    return reply.send({ ok: true, ...r })
  })

  /** 服务发布：把快照的代码导出成 releases/<slug>/v<version>/，给生产容器挂 */
  app.post('/projects/:projectId/publish/release', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    const body = (req.body ?? {}) as { ref?: string; slug?: string; version?: number }
    if (!body.ref || !body.slug || !body.version) throw new GuardError('需要 ref / slug / version')
    assertSafeId(body.slug, 'slug')
    const r = await materializeRelease(projectId, body.ref, body.slug, body.version)
    return reply.send({ ok: true, ...r })
  })

  /** 切线上版本（回滚就是调它）。目标版本不在磁盘上会显式 400，不假装成功。 */
  app.post('/publish/site/:slug/activate', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    assertSafeId(slug, 'slug')
    const body = (req.body ?? {}) as { version?: number }
    if (!body.version) throw new GuardError('需要 version')
    await activateSiteVersion(slug, body.version)
    return reply.send({ ok: true })
  })

  /** 改 slug：把已有发布物一起改名，否则新地址指向一个空目录 */
  app.post('/publish/site/:slug/rename', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    assertSafeId(slug, 'slug')
    const body = (req.body ?? {}) as { newSlug?: string }
    if (!body.newSlug) throw new GuardError('需要 newSlug')
    assertSafeId(body.newSlug, 'newSlug')
    await renameSiteDir(slug, body.newSlug)
    return reply.send({ ok: true })
  })

  app.delete('/publish/site/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    assertSafeId(slug, 'slug')
    await removeSite(slug)
    return reply.send({ ok: true })
  })

  app.delete('/publish/preview/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    await removePreview(projectId)
    return reply.send({ ok: true })
  })
}
