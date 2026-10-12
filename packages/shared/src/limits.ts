/**
 * 资源上限（§2.4）。模板给默认值，项目级可调，但有天花板。
 */

export interface ResourceLimits {
  cpus: number
  memoryMb: number
  /** 构建时临时放宽——构建是内存大户 */
  buildMemoryMb: number
  diskMb: number
  /** 防 fork bomb */
  pids: number
}

export const DEFAULT_LIMITS: ResourceLimits = {
  cpus: 1,
  memoryMb: 1024,
  buildMemoryMb: 2048,
  diskMb: 2048,
  pids: 256,
}

/**
 * 天花板。项目级可以往下调、往上调，但**不能越过这里**——
 * 否则"可调"就等于没上限。
 */
export const LIMIT_CEILING: ResourceLimits = {
  cpus: 4,
  memoryMb: 4096,
  buildMemoryMb: 8192,
  diskMb: 20480,
  pids: 4096,
}

export function mergeLimits(
  base: ResourceLimits,
  override?: Partial<ResourceLimits>,
): ResourceLimits {
  const out = { ...base }
  if (!override) return out
  for (const key of Object.keys(LIMIT_CEILING) as Array<keyof ResourceLimits>) {
    const v = override[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[key] = Math.min(v, LIMIT_CEILING[key])
    }
  }
  return out
}

/** 项目数上限（§2.4 ②）。服务型项目常驻成本高，单独更严。 */
export interface ProjectQuota {
  maxProjects: number
  maxServiceProjects: number
}

export const DEFAULT_QUOTA: ProjectQuota = {
  maxProjects: 50,
  maxServiceProjects: 5,
}
