import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { agentService } from '../agent/service.ts'
import { ExecutorError } from '../cluster/executor-client.ts'
import { sandboxSource } from '../cluster/source.ts'
import { anyClientFor } from '../cluster/lookup.ts'
import * as store from '../store.ts'

/**
 * 快照与回滚（§5.1 / §8）。
 *
 * 快照是**宿主的 git commit**，不是容器里做的事——见 executor 的 workspace/git.ts。
 * 所以沙箱冷着的时候照样能列、能打、能回滚。
 */
export async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects/:id/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    return reply.send({ ok: true, snapshots: await store.listSnapshots(id) })
  })

  /**
   * 手动打一个快照（`created_by='user'`）。自动的那些是 verify 通过时打的（§5.1）。
   *
   * 生成中拒绝：agent 正在改文件，这一刻提交下去会得到一个"改了一半"的版本，
   * 而且回滚到它的人会以为那是个完整状态。和 C3 的写入互斥是同一条道理。
   */
  app.post('/api/projects/:id/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { label?: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    if (agentService.isRunning(id)) {
      return reply
        .code(409)
        .send({ ok: false, error: '这个项目正在生成中，等这一轮跑完再打快照' })
    }

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    try {
      const label = body.label?.trim() || '手动快照'
      const r = await client.snapshot(id, label)
      if (!r.committed || !r.sha) {
        return reply.send({ ok: true, committed: false, snapshot: null })
      }

      const seq = await store.nextSnapshotSeq(id)
      const snapId = `snap-${randomBytes(6).toString('hex')}`
      await store.insertSnapshot({
        id: snapId,
        projectId: id,
        seq,
        label,
        gitRef: r.sha,
        createdBy: 'user',
      })
      return reply.send({ ok: true, committed: true, snapshot: await store.getSnapshot(snapId) })
    } catch (err) {
      if (err instanceof ExecutorError) {
        return reply.code(502).send({ ok: false, error: err.message })
      }
      throw err
    }
  })

  /**
   * 把**工作区**回退到某个快照（§5.1 的"版本回滚"）。
   *
   * ⚠️ 注意和「发布回滚」不是一回事：这个动的是编辑工作区（"我要从这个版本继续改"），
   * 发布回滚动的是线上指向（"让用户看到上一个版本"）。两个都在 S3 里，别混。
   *
   * 回退后要把编辑容器重建一次 —— 容器的 Cmd 是 `buildCommand && runCommand`，
   * 工作区变了但容器还跑着旧产物，预览会显示回退前的内容（用户会以为回滚没生效）。
   */
  app.post('/api/projects/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { snapshotId?: string }
    if (!body.snapshotId) return reply.code(400).send({ ok: false, error: '缺少 snapshotId' })

    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })

    if (agentService.isRunning(id)) {
      return reply
        .code(409)
        .send({ ok: false, error: '这个项目正在生成中，等这一轮跑完再回滚' })
    }

    const snapshot = await store.getSnapshot(body.snapshotId)
    if (!snapshot || snapshot.projectId !== id) {
      return reply.code(404).send({ ok: false, error: '快照不存在' })
    }

    const client = await anyClientFor(id)
    if (!client) return reply.code(503).send({ ok: false, error: '没有可用节点' })

    try {
      const r = await client.checkout(id, snapshot.gitRef)

      // 重建编辑容器：让预览反映回退后的代码。
      // 失败不算回滚失败——工作区已经退回去了，容器下次访问时会按需重建。
      const inst = await store.getInstance(id, 'edit')
      if (inst?.sandboxId) {
        await client.deleteSandbox(inst.sandboxId).catch(() => {})
      }
      const created = await client
        .createSandbox(id, await sandboxSource(project))
        .catch(() => null)

      if (created) {
        await store.upsertInstance({
          projectId: id,
          role: 'edit',
          kind: project.kind,
          sandboxId: created.sandbox.sandboxId,
          nodeId: client.nodeId,
          port: created.sandbox.port,
          state: 'running',
          version: snapshot.seq,
        })
        await client.waitSandbox(created.sandbox.sandboxId, 60_000).catch(() => {})
      }

      return reply.send({ ok: true, head: r.head, version: snapshot.seq })
    } catch (err) {
      if (err instanceof ExecutorError) {
        return reply.code(502).send({ ok: false, error: err.message })
      }
      throw err
    }
  })
}
