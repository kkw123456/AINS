/**
 * 全局领域类型。服务端与前端共用，改这里等于改契约。
 */

/** 容器的三种角色。编辑容器也是 instance（role='edit'），与预览/生产共用一套生命周期（§7）。 */
export type InstanceRole = 'edit' | 'preview' | 'production'

/** 实例形态：静态产物目录 / 跑着的服务。由 template.json 声明（§4）。 */
export type InstanceKind = 'static' | 'service'

export type InstanceState = 'creating' | 'running' | 'stopped' | 'error'

export type Health = 'unknown' | 'healthy' | 'unhealthy'

export type ProjectStatus = 'creating' | 'ready' | 'error'

/** 依赖服务种类（§6）。一期只放行这两样。 */
export type DepKind = 'mysql' | 'redis' | 'minio'

export interface Project {
  id: string
  owner: string
  name: string
  /** 子域名用的 slug，只允许 [a-z0-9-] */
  slug: string
  template: string
  status: ProjectStatus
  createdAt: string
}

export interface Instance {
  id: string
  projectId: string
  role: InstanceRole
  kind: InstanceKind
  /** 递增版本号；预览与生产各自指向一个版本 */
  version: number
  containerId: string | null
  nodeId: string | null
  port: number | null
  state: InstanceState
  health: Health
  lastUsedAt: string | null
}

/** executor 侧登记的运行中沙箱 */
export interface SandboxRecord {
  sandboxId: string
  projectId: string
  /**
   * 编辑容器还是预览容器（S3 拆分）。同一个项目两者会同时存在，
   * 所以**按项目找沙箱时必须带 role**，否则会把编辑容器错当成预览容器。
   * 老数据没有这个字段，一律当 `edit`。
   */
  role?: 'edit' | 'preview'
  nodeId: string
  containerId: string
  /** 容器内服务监听的端口 */
  port: number
  /**
   * 这个沙箱的**就绪探针路径**（模板 spec 的 healthPath，默认 `/`）。
   *
   * ★ 为什么要记在这儿、还要落成 label：`/sandboxes/:id/wait` 默认探的就是它。
   *   组合出来的项目（S3.5）是「nginx 在前面 + 后端在 3001」，探 `/` 会**立刻**拿到
   *   200（nginx 从磁盘伺服前端产物），于是"后端根本没起来"也报就绪 ——
   *   实测就是这么骗过 `/api/projects/:id/wait` 的：预览地址返回 502（后端不在），
   *   而 wait 说 ready。探 `/health`（穿 nginx 到后端）才是"用户真能用"的意思。
   */
  healthPath?: string
  /** publish 到宿主机的端口（跨机反代时用）；单机共享网络时为 null */
  hostPort: number | null
  createdAt: string
}

export type NodeState = 'online' | 'draining' | 'offline'

export interface NodeInfo {
  nodeId: string
  state: NodeState
  /** 已登记沙箱数 / 上限 */
  sandboxes: number
  capacity: number
  /** 工作区所在磁盘的剩余 MB */
  diskFreeMb: number
  /** 已预拉的镜像 */
  images: string[]
  lastSeenAt: string
}

/** POST /sandboxes 的返回 */
export interface SandboxHandle {
  sandboxId: string
  port: number
  /** 单机共享网络时不 publish，为 null（跨机反代才用） */
  hostPort: number | null
  nodeId: string
}

/** POST /sandboxes/:id/exec 的返回 */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** 命令是否因超时被杀 */
  timedOut: boolean
}

/**
 * 一轮生成里 agent 改过的一个文件（§5.1「这轮改了哪些文件」）。
 *
 * 一期工作区里还**没有 git**（"快照 = git commit" 是 S3），所以 diff 只能自己采：
 * agent 的写操作一律走 sandbox 的 write_file / edit_file 两个工具，**两个都落在
 * `SandboxBridge.writeFile` 上**，就在那里记下改之前的内容（见 orchestrator 的 agent/service.ts）。
 *
 * ⚠️ 已知采不到的：agent 用 `run` 工具跑构建/装依赖产生或改动的文件（lockfile、dist/）。
 * 这是有意的——那些是构建噪音，不是"这轮改了什么"。
 */
export interface FileDiff {
  path: string
  /** delete 采不到（见上），所以只有这两种 */
  status: 'added' | 'modified'
  /**
   * 改之前的内容。`null` 有两种意思，靠 `status` 区分：
   * `added` + null = 确实是新建；`modified` + null = 文件在，但内容拿不到
   * （二进制或超过读取上限），这时 UI 该说「内容不可读」而不是装作是空文件。
   */
  before: string | null
  after: string
}

/** 快照是谁产生的（§5.1）。auto = 构建通过后自动提交，user = 手动打的点。 */
export type SnapshotBy = 'auto' | 'user'

/**
 * 一次快照 = 工作区的一次 git commit（§5.1）。
 * `seq` 就是**版本号**：项目内从 1 递增，发布记录和实例的 version 都跟着它。
 */
export interface Snapshot {
  id: string
  projectId: string
  seq: number
  label: string
  /** commit sha；回滚和导出产物都靠它 */
  gitRef: string
  createdBy: SnapshotBy
  createdAt: string
}

/**
 * 一条发布记录。`active=true` 的那条就是当前线上版本。
 *
 * 静态与服务的差别只在 `instanceId`（静态为 null，没有容器）和 `path` 指向哪儿；
 * 其余共用一个形状，回滚逻辑才不用分两套写。
 */
export interface Deployment {
  id: string
  projectId: string
  snapshotId: string
  /** 发布的是哪个版本（= 快照的 seq） */
  version: number
  kind: InstanceKind
  /** 服务型的生产实例 id；静态为 null */
  instanceId: string | null
  /** 线上地址，如 `http://myapp.site.localhost:8088/` */
  url: string
  /** 产物/代码在宿主上的落点（静态 sites/<slug>/<v>，服务 releases/<slug>/<v>） */
  path: string
  active: boolean
  createdAt: string
}
