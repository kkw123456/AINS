import { statfs } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { NodeInfo } from '@webgen/shared'
import { config, workspaceRoot } from '../config.ts'
import { docker } from '../docker/client.ts'
import * as registry from '../registry.ts'

let state: 'online' | 'draining' = 'online'

export function isDraining(): boolean {
  return state === 'draining'
}

export async function nodeInfo(): Promise<NodeInfo> {
  const fs = await statfs(workspaceRoot).catch(() => null)
  const diskFreeMb = fs ? Math.floor((fs.bavail * fs.bsize) / (1024 * 1024)) : -1

  const images = await docker
    .listImages()
    .then((list) =>
      list
        .flatMap((i) => i.RepoTags ?? [])
        .filter((t) => t.startsWith('webgen/'))
        .sort(),
    )
    .catch(() => [] as string[])

  return {
    nodeId: config.nodeId,
    state,
    sandboxes: registry.count(),
    capacity: config.sandboxCapacity,
    diskFreeMb,
    images,
    lastSeenAt: new Date().toISOString(),
  }
}

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/node/info', async (_req, reply) => reply.send({ ok: true, node: await nodeInfo() }))

  /** 停新沙箱，但不动已经在跑的（迁移由上层编排，见 §1.2 drain） */
  app.post('/node/drain', async (_req, reply) => {
    state = 'draining'
    return reply.send({ ok: true, node: await nodeInfo() })
  })

  app.post('/node/resume', async (_req, reply) => {
    state = 'online'
    return reply.send({ ok: true, node: await nodeInfo() })
  })
}
