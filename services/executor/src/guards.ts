/**
 * 命令白名单 + 路径 jail。
 *
 * ⚠️ 这两层都是**纵深防御，不是安全边界**——真正的边界是容器本身
 * （非 root、限额、禁内网、不挂宿主）。白名单挡的是"手滑"和"明显越界"，
 * 挡不住蓄意的代码执行，那是 §10 里说清楚的前提。
 */

import { resolve, sep } from 'node:path'

/** argv[0] 的允许集合。按语言族放行，够 S0 用。 */
const ALLOWED_BINARIES = new Set([
  // 包管理 / 运行时
  'pnpm', 'npm', 'npx', 'yarn', 'node', 'bun',
  'python', 'python3', 'pip', 'pip3', 'uvicorn', 'gunicorn', 'pytest',
  'go', 'php', 'composer', 'java', 'mvn', 'gradle',
  // 构建 / 检查
  'tsc', 'vite', 'next', 'eslint', 'prettier',
  // 常用文件操作（工作区内）
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'echo', 'pwd', 'env', 'which',
  'sh', 'bash',
])

/** 明确拒绝的：越出工作区、碰宿主、装持久化后门 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|\/)(\.\.)(\/|$)/, // 路径穿越
  /^\/proc\/sys/, // 内核参数
  /docker\.sock/i,
  /^\/dev\/(sd|nvme|mmcblk)/i, // 块设备
]

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export function assertCommandAllowed(cmd: string[]): void {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new GuardError('cmd 必须是非空数组（argv 形式，不接受 shell 字符串）')
  }
  const bin = cmd[0]!
  const base = bin.split('/').pop()!
  if (!ALLOWED_BINARIES.has(base)) {
    throw new GuardError(`命令 ${base} 不在白名单内`)
  }
  for (const arg of cmd.slice(1)) {
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(arg)) throw new GuardError(`参数被拒绝（命中 ${re}）：${arg}`)
    }
  }
}

/**
 * 把容器内的相对路径解析到 /workspace 下，并保证没有越界。
 * 返回容器内的绝对路径。
 */
export function containerPath(rel: string): string {
  const clean = (rel || '.').replace(/^\/+/, '')
  const abs = resolve('/workspace', clean)
  if (abs !== '/workspace' && !abs.startsWith('/workspace' + sep)) {
    throw new GuardError(`路径越出工作区：${rel}`)
  }
  return abs
}

/**
 * 只允许 [a-zA-Z0-9._-] 的片段，用于 projectId / sandboxId 这类会进
 * 路径名、容器名、域名、Traefik 路由名的标识。**不做这一步，
 * 一个 `..` 就能穿到宿主**。
 */
export function assertSafeId(id: string, label = 'id'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new GuardError(`${label} 不合法：${JSON.stringify(id)}`)
  }
  return id
}
