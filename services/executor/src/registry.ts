import type { SandboxRecord } from '@webgen/shared'
import type { SandboxRole } from './docker/create.ts'

/**
 * 沙箱登记表。内存为准，但**启动时按容器 label 重建**——
 * executor 重启（改代码、tsx watch）不该让已经在跑的沙箱变成孤儿。
 */

const byId = new Map<string, SandboxRecord>()

export function put(rec: SandboxRecord): void {
  byId.set(rec.sandboxId, rec)
}

export function get(sandboxId: string): SandboxRecord | undefined {
  return byId.get(sandboxId)
}

export function drop(sandboxId: string): void {
  byId.delete(sandboxId)
}

export function list(): SandboxRecord[] {
  return [...byId.values()]
}

export function count(): number {
  return byId.size
}

/**
 * 按 (projectId, role) 找。
 *
 * ⚠️ **role 不能省**：S3 拆分之后同一个项目同时有编辑容器和预览容器，
 * 只按 projectId 找会把编辑容器当成预览容器返回 —— 表现是
 * "点预览打开的其实是 agent 正在折腾的那个"，而且 `POST /sandboxes` 的复用逻辑会直接返回错的容器。
 */
export function findByProject(projectId: string, role: SandboxRole): SandboxRecord | undefined {
  for (const r of byId.values()) {
    if (r.projectId === projectId && (r.role ?? 'edit') === role) return r
  }
  return undefined
}

/** 启动时用实际容器状态覆盖内存表（唯一的真相在 docker 里） */
export function reset(records: SandboxRecord[]): void {
  byId.clear()
  for (const r of records) byId.set(r.sandboxId, r)
}
