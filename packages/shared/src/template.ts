/**
 * 模板契约（§2.1）。template.json 是 executor / orchestrator / 发布三处的共同接口，
 * 所以解析必须严格——坏模板要在建沙箱之前就报错，而不是跑到一半才发现。
 */

import type { DepKind, InstanceKind } from './types.ts'
import { DEFAULT_LIMITS, mergeLimits, type ResourceLimits } from './limits.ts'

export interface TemplateSpec {
  /** static = 伺服产物目录；service = 跑一个常驻进程 */
  kind: InstanceKind
  /** 沙箱镜像，机器上需预拉 */
  image: string
  /** 容器内服务监听的端口 */
  port: number
  /** 启动命令，可用 $PORT 占位 */
  runCommand: string
  /** 构建命令；为空表示无需构建 */
  buildCommand?: string
  /** kind=static 时必填：产物目录（相对工作区） */
  artifactDir?: string
  /** 发布时的健康检查路径 */
  healthPath?: string
  /**
   * 额外注入容器的环境变量。**组合项目用它传数据层路径**（WEBGEN_DATA_DIR）——
   * 之所以走这里而不是硬编码在 createSandbox 里：那是"模板的要求"，
   * 换一个组合（比如以后接共享 MySQL）注入的就是另一组变量，不该改到 docker 层去。
   */
  env?: Record<string, string>
  /** 资源上限。解析后一定是完整的（已用 DEFAULT_LIMITS 补齐并被 LIMIT_CEILING 夹住） */
  limits: ResourceLimits
  /** 需要的依赖服务 */
  deps?: DepKind[]
  /**
   * **组合项目专用**：后端在容器内真正监听的端口（对应环境变量 `APP_PORT`）。
   *
   * 为什么要有它：组合项目里 `port` 是 **nginx 对外的口**（EDGE_PORT=8080），后端进程
   * 听的是**另一个内部口**（`APP_PORT`=3001），只有 nginx 认识它。提示词需要据此告诉
   * agent"后端要监听哪个口"，否则一个**完全照提示词写**的 agent 会把后端绑到 8080、
   * 和 nginx 撞端口（模板项目不设这个字段 —— 它们的 `port` 就是应用自己的口）。
   */
  backendPortEnv?: number
}

const KINDS: InstanceKind[] = ['static', 'service']

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/**
 * 解析并校验一份 template.json。
 * @param raw    已 JSON.parse 的对象
 * @param source 出错信息里显示来源（通常是模板目录名）
 */
export function parseTemplate(raw: unknown, source: string): TemplateSpec {
  const where = `template "${source}"`
  if (typeof raw !== 'object' || raw === null) {
    throw new TemplateError(`${where}: 不是一个对象`)
  }
  const t = raw as Record<string, unknown>

  const kind = t.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind as InstanceKind)) {
    throw new TemplateError(`${where}: kind 必须是 ${KINDS.join(' | ')}，实际是 ${String(kind)}`)
  }

  const image = reqString(t, 'image', where)
  const runCommand = reqString(t, 'runCommand', where)

  const port = t.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TemplateError(`${where}: port 必须是 1~65535 的整数，实际是 ${String(port)}`)
  }

  const artifactDir = optString(t, 'artifactDir', where)
  if (kind === 'static' && !artifactDir) {
    throw new TemplateError(`${where}: kind=static 时必须给 artifactDir`)
  }
  if (kind === 'service' && artifactDir) {
    throw new TemplateError(`${where}: kind=service 不该有 artifactDir`)
  }

  const deps = t.deps
  if (deps !== undefined) {
    if (!Array.isArray(deps) || deps.some((d) => d !== 'mysql' && d !== 'redis' && d !== 'minio')) {
      throw new TemplateError(`${where}: deps 只允许包含 "mysql" / "redis" / "minio"`)
    }
  }

  const limitsRaw = t.limits
  if (limitsRaw !== undefined && (typeof limitsRaw !== 'object' || limitsRaw === null)) {
    throw new TemplateError(`${where}: limits 必须是一个对象`)
  }

  return {
    kind: kind as InstanceKind,
    image,
    port,
    runCommand,
    buildCommand: optString(t, 'buildCommand', where),
    artifactDir,
    healthPath: optString(t, 'healthPath', where),
    limits: mergeLimits(DEFAULT_LIMITS, limitsRaw as Partial<ResourceLimits> | undefined),
    deps: (deps as DepKind[] | undefined) ?? [],
    env: parseEnv(t.env, where),
    backendPortEnv: optNumber(t, 'backendPortEnv', where),
  }
}

/**
 * 解析 env。**只收字符串到字符串** —— 让 `{"PORT": 3000}` 这种数字静默变成 "3000"
 * 不如直接报错：docker 的环境变量终究是字符串，早一点暴露，省得到容器里才发现
 * 某个值是 `undefined` 或 `NaN`。
 */
function parseEnv(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TemplateError(`${where}: env 必须是一个对象`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new TemplateError(`${where}: env.${k} 必须是字符串（环境变量没有数字/布尔类型）`)
    }
    out[k] = v
  }
  return out
}

function reqString(t: Record<string, unknown>, key: string, where: string): string {
  const v = t[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new TemplateError(`${where}: 缺少必填字段 ${key}`)
  }
  return v
}

function optString(
  t: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const v = t[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new TemplateError(`${where}: ${key} 必须是字符串`)
  return v.trim() === '' ? undefined : v
}

function optNumber(t: Record<string, unknown>, key: string, where: string): number | undefined {
  const v = t[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new TemplateError(`${where}: ${key} 必须是 1~65535 的整数`)
  }
  return v
}
