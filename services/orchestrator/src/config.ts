import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')

const envFile = join(REPO_ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

// claude 拒绝以 root 运行（"cannot be used with root/sudo privileges"）。
// WSL / 容器里默认就是 root，所以必须显式声明自己在沙箱里 —— 这是官方留的逃生口。
// 真正正确的做法是让服务以非 root 用户跑；这条是开发期的让步。
if (!process.env.IS_SANDBOX) process.env.IS_SANDBOX = '1'

function num(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`环境变量 ${key} 不是数字: ${raw}`)
  return v
}

export const config = {
  port: num('ORCHESTRATOR_PORT', 8800),
  previewDomain: process.env.PREVIEW_DOMAIN?.trim() || 'localhost',
  previewScheme: process.env.PREVIEW_SCHEME?.trim() || 'http',
  previewPort: num('PREVIEW_PORT', 8088),

  /**
   * 已发布站点的域名**完整后缀**：线上地址是 `<slug>.<siteDomain>`。
   * 默认值里已含 `site` 这一段；nginx 模板那边别再拼 `.site.`，会变成 `x.site.site.localhost`。
   */
  siteDomain: process.env.SITE_DOMAIN?.trim() || 'site.localhost',

  /** 单机时就是本机 executor；多节点时靠它做初始注册，之后由心跳维护 */
  seedExecutors: (process.env.EXECUTOR_URLS?.trim() || 'http://127.0.0.1:8100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** 节点心跳多久没来就当掉线 */
  nodeStaleMs: num('NODE_STALE_MS', 45_000),

  maxProjects: num('MAX_PROJECTS', 50),
  maxServiceProjects: num('MAX_SERVICE_PROJECTS', 5),

  /** 一期没登录，所有项目先记在这个 owner 下（决策 2：owner 字段从第一天就在） */
  defaultOwner: process.env.WEBGEN_OWNER?.trim() || 'local',

  // ---------------------------------------------------------- S1 生成引擎

  /** 留空则用 claude 自己的默认模型 */
  agentModel: process.env.WEBGEN_AGENT_MODEL?.trim() || undefined,
  /** 一轮生成里最多几次「改 → 验证 → 修」 */
  maxRepairRounds: num('AGENT_MAX_REPAIR_ROUNDS', 3),
  /**
   * 单轮最多几个 SDK 回合。**0 = 不限**（默认）。
   *
   * 原先是写死 60，一大轮生成会被 SDK 掐断，报「Reached maximum number of turns (60)」，
   * 交付的是改了一半的**半成品** —— 比多花 token 糟。要限就设个正数。
   * 注意真正的兜底不是它：`verifyTimeoutMs` 卡住每次 verify，
   * verify 失败会被回灌、最多 `maxRepairRounds` 轮，所以跑不到天荒地老。
   */
  agentMaxTurns: num('WEBGEN_AGENT_MAX_TURNS', 0),
  /** 每次 verify 等应用起来的上限 */
  verifyTimeoutMs: num('AGENT_VERIFY_TIMEOUT_MS', 120_000),
} as const

/** 预览地址：`<scheme>://p-<id>.<domain>:<port>`（本地端口就是 8088） */
export function previewUrl(projectId: string): string {
  const port = config.previewScheme === 'https' ? '' : `:${config.previewPort}`
  return `${config.previewScheme}://p-${projectId}.${config.previewDomain}${port}/`
}

/**
 * 编辑容器的地址（§4 的「实时视图」，`d-<id>`）。
 * 故意和预览分开：编辑容器里是 agent 正在折腾的那份，预览是给人看的那份。
 */
export function devUrl(projectId: string): string {
  const port = config.previewScheme === 'https' ? '' : `:${config.previewPort}`
  return `${config.previewScheme}://d-${projectId}.${config.previewDomain}${port}/`
}

/** 已发布站点的线上地址：`<scheme>://<slug>.<SITE_DOMAIN>:<port>` */
export function liveUrl(slug: string): string {
  const port = config.previewScheme === 'https' ? '' : `:${config.previewPort}`
  return `${config.previewScheme}://${slug}.${config.siteDomain}${port}/`
}
