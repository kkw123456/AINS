import { config } from '../config.ts'
import { all, get, online, type NodeEntry } from '../cluster/registry.ts'
import { ExecutorClient } from '../cluster/executor-client.ts'

/**
 * 选节点（§1.1）。**即使眼下只有 1 个节点，沙箱创建也一律走这里**——
 * 否则以后加节点要把所有 executor 调用点翻一遍（S0 验收 ⑦）。
 *
 * 策略：粘性优先（同一项目尽量待在原节点，工作区在它的本地盘），
 * 其次挑负载最轻的在线节点。
 */
export function pickNode(preferredNodeId?: string | null): ExecutorClient {
  const nodes = online()
  if (nodes.length === 0) {
    const known = all().map((n) => n.url).filter(Boolean)
    throw new Error(
      known.length > 0
        ? `没有在线节点（已知地址 ${known.join(', ')}，但都没来心跳）。检查 executor 是否在跑。`
        : '没有任何节点。检查 EXECUTOR_URLS 配置与 executor 是否在跑。',
    )
  }

  const preferred = get(preferredNodeId)
  if (preferred && preferred.url && !isStale(preferred)) {
    return new ExecutorClient(preferred.nodeId, preferred.url)
  }

  const best = [...nodes].sort((a, b) => load(a) - load(b))[0]!
  return new ExecutorClient(best.nodeId, best.url)
}

/** 粘性判断用：这个项目现在落在哪个节点上 */
export function nodeOf(entry: NodeEntry | undefined): string | null {
  return entry?.nodeId ?? null
}

/** 已知节点 → 客户端；节点不在线则 null（调用方决定是报错还是回退） */
export function clientFor(nodeId: string | null | undefined): ExecutorClient | null {
  const node = get(nodeId)
  if (!node?.url) return null
  return new ExecutorClient(node.nodeId, node.url)
}

function load(n: NodeEntry): number {
  const capacity = n.info?.capacity ?? config.maxProjects
  return (n.info?.sandboxes ?? 0) / Math.max(capacity, 1)
}

function isStale(n: NodeEntry): boolean {
  return Date.now() - n.lastSeenAt > config.nodeStaleMs
}
