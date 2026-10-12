import type { FastifyInstance } from 'fastify'
import { parseStack, StackError } from '@webgen/shared'
import { buildImageFor, listProjectImages, removeProjectImages } from '../images/build.ts'
import { specFor } from '../images/recipe.ts'
import { assertSafeId, GuardError } from '../guards.ts'

/**
 * 按组合构建项目镜像（S3.5）。
 *
 * 它**独立于建容器**。为什么必须是独立一步：agent 每轮生成会重建最多 4 次沙箱
 * （`maxRepairRounds=3`），要是把 build 挂在 `POST /sandboxes` 上，一轮生成就要 build 四次。
 * 镜像是磁盘上的东西、会一直留着，所以只有"这个项目的组合第一次出现"时才真的 build。
 */
export async function imageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/images/build', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: string; stack?: unknown }
    if (!body.projectId) throw new GuardError('缺少 projectId')
    assertSafeId(body.projectId, 'projectId')

    let stack
    try {
      stack = parseStack(body.stack)
    } catch (e) {
      if (e instanceof StackError) throw new GuardError(e.message)
      throw e
    }

    const r = await buildImageFor(body.projectId, stack)
    return reply.send({ ok: true, ...r, spec: specFor(stack, r.image) })
  })

  app.get('/images/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    return reply.send({ ok: true, images: await listProjectImages(projectId) })
  })

  app.delete('/images/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    return reply.send({ ok: true, ...(await removeProjectImages(projectId)) })
  })
}
