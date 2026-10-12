import type { FastifyInstance } from 'fastify'
import { agentService } from '../agent/service.ts'
import * as store from '../store.ts'

/**
 * 对话与事件流。
 *
 * ⚠️ SSE 要先 `reply.hijack()` 再写 `reply.raw` —— 不 hijack 的话 Fastify
 * 会以为这个请求还没回复，拿到的是被包过的流。
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /** 发一句话，**立刻返回 202**：生成在后台跑，进度从 /stream 看 */
  app.post('/api/projects/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { text?: string }
    const text = body.text?.trim()
    if (!text) return reply.code(400).send({ ok: false, error: '缺少 text' })

    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    if (agentService.isRunning(id)) {
      return reply.code(409).send({ ok: false, error: '这个项目正在生成中，等这一轮跑完再发' })
    }

    void agentService.start(id, text)
    return reply.code(202).send({ ok: true, running: true })
  })

  /** 事件流：先 reset，再整段回放，之后增量推送（EventSource 会自动重连，必须能重放） */
  app.get('/api/projects/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const send = (ev: unknown): void => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }

    send({ type: 'reset', running: agentService.isRunning(id) })
    for (const ev of agentService.history(id)) send(ev)

    const unsub = agentService.subscribe(id, send)
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000)

    req.raw.on('close', () => {
      clearInterval(ping)
      unsub()
      res.end()
    })
  })

  /** 一次性拿全量状态（不订阅流）：调试与首屏用 */
  app.get('/api/projects/:id/agent', async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await store.getProject(id)
    if (!project) return reply.code(404).send({ ok: false, error: '项目不存在' })
    return reply.send({
      ok: true,
      running: agentService.isRunning(id),
      events: agentService.history(id),
      messages: await store.listMessages(id),
    })
  })
}
