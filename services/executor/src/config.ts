import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** services/executor/src → 仓库根 */
const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../..')

// Node 24 自带，不必引 dotenv。真实环境变量优先于文件。
const envFile = join(REPO_ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

function num(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`环境变量 ${key} 不是数字: ${raw}`)
  return v
}

/** 数据根。抽成常量是因为 config 字面量内部引用不到自己，而下面好几个路径要从它派生。 */
const DATA_DIR = resolve(process.env.WEBGEN_DATA_DIR?.trim() || '/root/webgen-data')

export const config = {
  nodeId: process.env.WEBGEN_NODE_ID?.trim() || 'node-a',
  port: num('EXECUTOR_PORT', 8100),

  /** 工作区根：必须在 ext4 上（§4.1） */
  dataDir: DATA_DIR,
  templatesDir: resolve(process.env.WEBGEN_TEMPLATES_DIR?.trim() || join(REPO_ROOT, 'templates')),

  /**
   * 组合用的**种子片段**目录（S3.5）。和 templatesDir 是两回事：
   *   templates/<name>/seed  = 「一个模板一整套」，原样拷
   *   seeds/backend/<lang>   = 「一层」的片段，按选中的组合拼起来
   * 拼装逻辑在 workspace/seed.ts；这里只记路径。
   */
  seedsDir: resolve(process.env.WEBGEN_SEEDS_DIR?.trim() || join(REPO_ROOT, 'seeds')),

  /** 沙箱与 Traefik 共享的网络，由 compose 创建 */
  dockerNetwork: process.env.WEBGEN_DOCKER_NETWORK?.trim() || 'webgen-net',

  /**
   * **所有项目共用的 pnpm store**，挂在每个含前端的容器里的 `/workspace/.pnpm-store`。
   *
   * ★ 为什么非得这样：pnpm 只肯用**和项目同一个文件系统**上的 store（跨设备它
   *   直接无视 store-dir 配置、就地重开一个）。所以镜像里预热一份 store 是没用的
   *   （试过，白做）。而"就地新开一个"意味着**每次发布/每次新容器都要联网装一遍** ——
   *   本机实测那一步能挂到 56 秒/次（日志里一段静默，然后突然出一堆行），
   *   于是"建到能看"在 7 秒到 90 秒之间随机跳，最坏直接撞满就绪超时。
   *
   * 这个目录在**数据盘**上（和 workspace 同一个 fs，所以硬链成立），
   * 由 `scripts/warm-pnpm-store.sh` 预热一次，之后每个项目的 `pnpm install`
   * 都是同盘硬链 —— 不联网、秒级。
   */
  pnpmStoreDir: resolve(
    process.env.WEBGEN_PNPM_STORE_DIR?.trim() || join(DATA_DIR, 'pnpm-store'),
  ),

  /** 本节点最多同时跑几个沙箱 */
  sandboxCapacity: num('EXECUTOR_CAPACITY', 20),

  previewDomain: process.env.PREVIEW_DOMAIN?.trim() || 'localhost',

  /**
   * 已发布站点的域名**完整后缀**：线上地址是 `<slug>.<siteDomain>`。
   * 默认值里已经含 `site` 这一段 —— 别再往模板里拼 `.site.`，会变成 `x.site.site.localhost`。
   */
  siteDomain: process.env.SITE_DOMAIN?.trim() || 'site.localhost',

  /** orchestrator 地址，心跳上报用；留空则不上报 */
  orchestratorUrl: process.env.ORCHESTRATOR_URL?.trim() || '',
  /** 本节点对外的可达地址，随心跳一起报给 orchestrator（多节点时必须有） */
  advertiseUrl:
    process.env.WEBGEN_ADVERTISE_URL?.trim() ||
    `http://127.0.0.1:${process.env.EXECUTOR_PORT?.trim() || 8100}`,
  heartbeatMs: num('EXECUTOR_HEARTBEAT_MS', 10_000),

  /** exec 默认与最大超时 */
  execTimeoutMs: num('EXEC_TIMEOUT_MS', 120_000),
  execMaxTimeoutMs: num('EXEC_MAX_TIMEOUT_MS', 600_000),

  /** 单次 exec 输出上限（字节），防止一条命令把内存打爆 */
  execMaxOutput: num('EXEC_MAX_OUTPUT', 256 * 1024),

  /** 文件接口上限（§5.3） */
  maxReadBytes: num('MAX_READ_BYTES', 512 * 1024),
  maxWriteBytes: num('MAX_WRITE_BYTES', 2 * 1024 * 1024),
  maxListEntries: num('MAX_LIST_ENTRIES', 20_000),

  /**
   * 导出 zip 的上限。打包是**整包进内存**的，不设限一个工作区就能把 executor 撑爆。
   * 超了显式报错（§2.4：超限必须显式失败，不静默降级）。
   */
  maxExportBytes: num('MAX_EXPORT_BYTES', 64 * 1024 * 1024),
  maxExportEntries: num('MAX_EXPORT_ENTRIES', 20_000),

  // ------------------------------------------------- 发布物（S3）
  // 三个落脚点都在数据盘上、和边缘（nginx）共享的目录里 ——
  // §4 的推论说得明白：**静态产物必须放在边缘可达的位置**，分布式下节点本地盘边缘读不到。
  // HA-0 靠同机共享目录；HA-1 换对象存储时只改这三个的取值来源。

  /** 已发布的静态产物：sites/<slug>/v<version>/ + current 软链 */
  sitesDir: resolve(process.env.WEBGEN_SITES_DIR?.trim() || join(DATA_DIR, 'sites')),
  /** 静态项目的预览产物：previews/<projectId>/v<version>/ + current 软链 */
  previewsDir: resolve(process.env.WEBGEN_PREVIEWS_DIR?.trim() || join(DATA_DIR, 'previews')),
  /** 服务型发布时从快照导出的代码：releases/<slug>/v<version>/，生产容器只读挂它 */
  releasesDir: resolve(process.env.WEBGEN_RELEASES_DIR?.trim() || join(DATA_DIR, 'releases')),
} as const

export const workspaceRoot = join(config.dataDir, 'workspaces')
