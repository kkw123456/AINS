import type { InstanceRole } from '@webgen/shared'
import { pickNode } from '../scheduler/index.ts'
import * as store from '../store.ts'
import { ExecutorClient } from './executor-client.ts'
import * as registry from './registry.ts'

/**
 * 「这个项目该找哪台 executor」的三种问法。
 *
 * 抽出来是因为 S3 之后不止 projects.ts 要用（snapshots / deploy 都要），
 * 而**各写一份必然会漂**——尤其是 `anyClientFor` 里"优先粘性节点"这条，
 * 写错了会读到另一台机器上空的工作区，症状是"文件突然全没了"。
 */

/** 按 nodeId 取客户端；节点不在线返回 null（调用方决定报错还是回退） */
export function clientFor(nodeId: string | null | undefined): ExecutorClient | null {
  const node = registry.get(nodeId)
  if (!node?.url) return null
  return new ExecutorClient(node.nodeId, node.url)
}

/** 没有节点在线时 pickNode 会抛——很多地方只是想"尽力而为"，不要因此 500 */
export function safePickNode(): ExecutorClient | null {
  try {
    return pickNode(null)
  } catch {
    return null
  }
}

/**
 * 文件类操作落到哪个节点：**优先项目粘性的那个**（工作区在它本地盘上），
 * 拿不到再退到任意在线节点——但那样会读不到文件，所以必须优先粘性。
 *
 * S3 起带 `role`：同一个项目可能同时有编辑容器和预览容器，
 * 但**工作区只有一份**，永远在编辑实例记的那个节点上。
 */
export async function anyClientFor(
  projectId: string,
  role: InstanceRole = 'edit',
): Promise<ExecutorClient | null> {
  const inst = await store.getInstance(projectId, role)
  const sticky = clientFor(inst?.nodeId)
  if (sticky) return sticky
  return safePickNode()
}
