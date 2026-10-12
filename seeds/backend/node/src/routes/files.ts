import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { ObjectStore } from '../store/object-store.js'

/** 该接口不收 query；用 zod 显式校验，拒绝多余/异常的 query。 */
const listQuery = z.object({})

/** POST 的 body：可选 `{"content":"..."}`。没给 body / 没给 content 就用默认那句话。 */
const uploadBody = z.object({
  content: z.string().max(1_000_000).optional(),
})

export interface FilesDeps {
  store: ObjectStore
}

/** 没提供内容时写进去的默认句子（中文，和后端问候一致）。 */
const DEFAULT_CONTENT = '你好，来自 Node 后端的问候！'

/** 列出对象时的上限 —— 别把整个 bucket 拉回来。 */
const LIST_LIMIT = 20

/**
 * 对象存储（「文件系统」）接口。契约字段固定：
 *   GET  /api/files → { backend:"node", storage:"minio"|"none", bucket, objects:[...] }
 *   POST /api/files → { backend:"node", storage:"minio"|"none", bucket, key }
 *
 * 没接对象存储（config.objectStore==="none"）→ storage="none"、bucket=""、
 *   objects=[]（GET）/ key=""（POST），**是正常返回，不是错误**。
 * 接了但连不上 → 记 warning、storage 报 "none"、服务照常 —— 对象存储是旁路，
 *   不该拖垮接口（跟 Redis 降级同一档）。
 */
export function filesRoutes(deps: FilesDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/api/files', async (request, reply) => {
      listQuery.parse(request.query)
      const { store } = deps
      if (store.kind === 'none') {
        return reply.send({ backend: 'node', storage: 'none', bucket: '', objects: [] })
      }
      try {
        const objects = await store.list(LIST_LIMIT)
        return reply.send({
          backend: 'node',
          storage: 'minio',
          bucket: store.bucket,
          objects,
        })
      } catch (err) {
        request.log.warn({ err }, 'MinIO 不可达，GET /api/files 降级为 storage="none"')
        return reply.send({ backend: 'node', storage: 'none', bucket: '', objects: [] })
      }
    })

    app.post('/api/files', async (request, reply) => {
      const { content } = uploadBody.parse(request.body ?? {})
      const { store } = deps
      if (store.kind === 'none') {
        return reply.send({ backend: 'node', storage: 'none', bucket: '', key: '' })
      }
      const key = `upload-${Date.now()}.txt`
      try {
        await store.put(key, content ?? DEFAULT_CONTENT)
        return reply.send({ backend: 'node', storage: 'minio', bucket: store.bucket, key })
      } catch (err) {
        request.log.warn({ err }, 'MinIO 不可达，POST /api/files 降级为 storage="none"')
        return reply.send({ backend: 'node', storage: 'none', bucket: '', key: '' })
      }
    })
  }
}
