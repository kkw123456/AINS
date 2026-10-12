import { mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { workspaceRoot } from '../config.ts'
import { assertSafeId, GuardError } from '../guards.ts'

/**
 * 工作区在**宿主机的持久目录**上，容器只是执行器（决策 7）。
 * 所以沙箱停着，文件照样能读能写——这是"看，永远不需要等"的前提。
 */
export function workspaceDir(projectId: string): string {
  return join(workspaceRoot, assertSafeId(projectId, 'projectId'))
}

export async function ensureWorkspace(projectId: string): Promise<string> {
  const dir = workspaceDir(projectId)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 把外部传来的相对路径解析成宿主绝对路径，并保证没越出工作区 */
export function resolveInWorkspace(projectId: string, rel: string): string {
  const root = workspaceDir(projectId)
  const abs = resolve(root, rel || '.')
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new GuardError(`路径越出工作区：${rel}`)
  }
  return abs
}
