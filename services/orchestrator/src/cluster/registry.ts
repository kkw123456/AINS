import type { NodeInfo } from '@webgen/shared'

/**
 * 节点表。**单节点时它就一个元素，但代码路径必须是多节点的**（§11 S0 验收 ⑦）——
 * 后补这个抽象会把所有 executor 调用点翻一遍。
 */

export interface NodeEntry {
  nodeId: string
  url: string
  info: NodeInfo | null
  lastSeenAt: number
  /** 由 EXECUTOR_URLS 预置、还没收到心跳 */
  seeded: boolean
}

const nodes = new Map<string, NodeEntry>()
let unresolvedUrls: string[] = []
let staleMs = 45_000

export function configure(opts: { staleMs: number }): void {
  staleMs = opts.staleMs
}

/** 启动时用配置里的 URL 预置；节点自行上报 nodeId 后合并 */
export function seed(urls: string[]): void {
  unresolvedUrls = [...urls]
  for (const url of urls) {
    nodes.set(`pending:${url}`, {
      nodeId: `pending:${url}`,
      url,
      info: null,
      lastSeenAt: 0,
      seeded: true,
    })
  }
}

/** 心跳：executor 会带上自己的 nodeId 与对外 URL */
export function heartbeat(info: NodeInfo, url: string | undefined): void {
  const existing = [...nodes.values()].find(
    (n) => n.nodeId === info.nodeId || (url !== undefined && n.url === url),
  )
  const nodeId = info.nodeId
  if (existing && existing.nodeId !== nodeId) nodes.delete(existing.nodeId)

  nodes.set(nodeId, {
    nodeId,
    url: url ?? existing?.url ?? '',
    info,
    lastSeenAt: Date.now(),
    seeded: false,
  })
  if (url) unresolvedUrls = unresolvedUrls.filter((u) => u !== url)
}

export function isStale(entry: NodeEntry): boolean {
  return Date.now() - entry.lastSeenAt > staleMs
}

export function online(): NodeEntry[] {
  return [...nodes.values()].filter((n) => n.url && !isStale(n))
}

export function get(nodeId: string | null | undefined): NodeEntry | undefined {
  if (!nodeId) return undefined
  return nodes.get(nodeId)
}

export function all(): NodeEntry[] {
  return [...nodes.values()]
}
