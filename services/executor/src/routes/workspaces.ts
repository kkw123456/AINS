import type { FastifyInstance } from 'fastify'
import { parseStackTemplateName } from '@webgen/shared'
import { GuardError, assertSafeId } from '../guards.ts'
import { imageTagFor, specFor } from '../images/recipe.ts'
import { zipWorkspace } from '../workspace/export.ts'
import { listFiles, readTextFile, writeTextFile } from '../workspace/files.ts'
import { checkout, commit, log } from '../workspace/git.ts'
import { loadTemplate, removeWorkspace, listTemplates } from '../workspace/seed.ts'

/**
 * 工作区文件接口。★ 走 executor 而**不走沙箱容器**——
 * 所以沙箱 cold / stopped 的时候照样能浏览、编辑、导出（§5.3）。
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/templates', async (_req, reply) =>
    reply.send({ ok: true, templates: await listTemplates() }),
  )

  /**
   * 单个模板的解析结果。orchestrator 靠它拿 kind（服务型另有更严的项目数上限）。
   *
   * ★ 组合项目没有模板目录，它的"模板名"是 `stack-<后端>-<前端>-<数据>`
   *   （见 shared 的 stackTemplateName）。这里先按组合解析它，**解析不出来才去磁盘上找** ——
   *   顺序反过来的话，一个叫 `stack-go-vue-none` 的目录会悄悄盖掉那个组合。
   *
   * ⚠️ 组合的 spec 里 `image` 是 `webgen-app/<projectId>:<hash>`，**必须带 projectId**
   *   才拼得出来。所以走这条路时 query 里得有 projectId，缺了就明确报错，
   *   别退回一个 image 是空的 spec（那会被下游当成"镜像名叫空字符串"，更难查）。
   */
  app.get('/templates/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const { projectId, layout } = req.query as { projectId?: string; layout?: string }

    const stack = parseStackTemplateName(name)
    if (stack) {
      if (!projectId) {
        throw new GuardError(`组合模板 ${name} 需要带 ?projectId=（镜像 tag 里含项目 id）`)
      }
      assertSafeId(projectId, 'projectId')
      // layout 决定 build/run 命令（新布局要 cd 到 backend/frontend）；缺省按 2。
      return reply.send({
        ok: true,
        name,
        stack,
        spec: specFor(stack, imageTagFor(projectId, stack), layout ? Number(layout) : undefined),
      })
    }

    const spec = await loadTemplate(name)
    return reply.send({ ok: true, name, spec })
  })

  app.get('/workspaces/:projectId/files', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const { dir } = req.query as { dir?: string }
    assertSafeId(projectId, 'projectId')
    const { root, files } = await listFiles(projectId, dir ?? '')
    return reply.send({ ok: true, root, files })
  })

  /**
   * 导出 zip。`dir` 只用来切「源码 / 构建产物」两个根（见 files.ts 的 listFiles）。
   * 响应是二进制，所以**不走** {ok:true} 信封——失败仍然是 JSON 错误信封（errorHandler 管）。
   */
  app.get('/workspaces/:projectId/export', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const { dir, name } = req.query as { dir?: string; name?: string }
    assertSafeId(projectId, 'projectId')
    const { zip, entries, bytes } = await zipWorkspace(projectId, dir ?? '')
    const filename = `${(name || projectId).replace(/[^\w.-]/g, '_')}.zip`
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-webgen-zip-entries', String(entries))
      .header('x-webgen-zip-bytes', String(bytes))
      .send(Buffer.from(zip))
  })

  app.get('/workspaces/:projectId/file', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const { path } = req.query as { path?: string }
    assertSafeId(projectId, 'projectId')
    if (!path) throw new GuardError('缺少 path')
    return reply.send({ ok: true, ...(await readTextFile(projectId, path)) })
  })

  app.put('/workspaces/:projectId/file', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const body = req.body as { path?: string; content?: string } | undefined
    assertSafeId(projectId, 'projectId')
    if (!body?.path) throw new GuardError('缺少 path')
    if (typeof body.content !== 'string') throw new GuardError('content 必须是字符串')
    return reply.send({ ok: true, ...(await writeTextFile(projectId, body.path, body.content)) })
  })

  app.delete('/workspaces/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    await removeWorkspace(projectId)
    return reply.send({ ok: true })
  })

  // ------------------------------------------------ 快照（§5.1，宿主侧 git）

  /**
   * 打一个快照。**没有改动就不提交**，返回 `committed:false`——
   * 调用方（orchestrator）据此决定要不要记一行 snapshots，别堆空版本。
   */
  app.post('/workspaces/:projectId/snapshot', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    const body = (req.body ?? {}) as { label?: string }
    const r = await commit(projectId, body.label?.trim() || 'snapshot')
    return reply.send({ ok: true, ...r })
  })

  app.get('/workspaces/:projectId/snapshots', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    return reply.send({ ok: true, snapshots: await log(projectId) })
  })

  /**
   * 把工作区检出到某个快照（§5.1 的"版本回滚"）。
   * ⚠️ 只恢复已跟踪文件，**不删** node_modules / dist —— 见 git.ts 的说明。
   */
  app.post('/workspaces/:projectId/checkout', async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    assertSafeId(projectId, 'projectId')
    const body = (req.body ?? {}) as { ref?: string }
    if (!body.ref) throw new GuardError('缺少 ref')
    return reply.send({ ok: true, ...(await checkout(projectId, body.ref)) })
  })
}
