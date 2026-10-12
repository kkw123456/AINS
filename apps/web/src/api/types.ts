/**
 * 后端响应的本地镜像。
 *
 * 为什么不直接用 `@webgen/shared` 的类型：**共享的那套和接口真实返回的不完全一样**。
 *  - `GET /api/projects` 返回的是 `ProjectRow`（多了 `owner`/`createdAt`）+ `previewUrl` + `instance`，
 *    而 shared 里的 `Project` 没有 `kind`、也没有 `instance`。
 *  - `InstanceRow`（DB 映射）带 `sandboxId`，shared 的 `Instance` 没有。
 *  - 信封 `{ok:true,...}` / `{ok:false,error}` 和 Redis 那套鉴权后的包装都只在这里有意义。
 * 所以枚举（kind/status/role/state）**复用 shared 的**（那是真契约），其余在这里按接口实际形状重述。
 */
import type { Health, InstanceKind, InstanceRole, InstanceState, ProjectStatus } from '@webgen/shared'

export type { Health, InstanceKind, InstanceRole, InstanceState, ProjectStatus }

/** 所有成功响应的信封 */
export interface Ok {
  ok: true
}

/** 所有失败响应的信封；`logs` 只在沙箱创建失败时出现 */
export interface Err {
  ok: false
  error: string
  logs?: string
  previewUrl?: string
}

export interface ProjectRow {
  id: string
  owner: string
  name: string
  slug: string
  template: string
  kind: InstanceKind
  status: ProjectStatus
  createdAt: string
  /** 最近改动 = max(创建时间, 最后一条消息, 编辑实例最后使用) —— orchestrator 侧算好的 */
  updatedAt: string
}

export interface InstanceRow {
  id: string
  projectId: string
  role: InstanceRole
  kind: InstanceKind
  version: number
  sandboxId: string | null
  containerId: string | null
  nodeId: string | null
  port: number | null
  state: InstanceState
  health: Health
  lastUsedAt: string | null
}

/** 模板列表项。注意这是**投影过的** spec：没有 runCommand / buildCommand / artifactDir。 */
export interface TemplateItem {
  name: string
  kind: InstanceKind
  image: string
  port: number
  deps: string[]
}

/**
 * `GET /api/projects/:id` 里的完整模板 spec。
 * `artifactDir` 只有 kind='static' 才有（parseTemplate 明令禁止 service 带它）。
 */
export interface TemplateSpec {
  kind: InstanceKind
  image: string
  port: number
  runCommand: string
  buildCommand?: string
  artifactDir?: string
  healthPath?: string
  limits: { cpus: number; memoryMb: number; buildMemoryMb: number; diskMb: number; pids: number }
  deps?: string[]
}

// ------------------------------------------------------------------ SSE 事件

/**
 * ★ `reset` 不在 AgentEvent 里 —— 它是 orchestrator 在**每次连接**时自己塞的哨兵，
 * 后面紧跟当前这一轮的全量重放。收到它就必须把手里的 events 清空。
 */
export interface ResetEvent {
  type: 'reset'
  running: boolean
}

export interface DeltaEvent {
  type: 'delta'
  text: string
}
export interface ThinkingEvent {
  type: 'thinking'
  text: string
}
export interface ToolEvent {
  type: 'tool'
  name: string
  detail: string
}
export interface SessionEvent {
  type: 'session'
  id: string
}
export interface VerifyEvent {
  type: 'verify'
  ok: boolean
  attempt: number
  detail: string
}
export interface ErrorEvent {
  type: 'error'
  message: string
}
export interface DoneEvent {
  type: 'done'
  costUsd: number
  turns: number
  durationMs: number
  ok: boolean
}

export type AgentEvent =
  | DeltaEvent
  | ThinkingEvent
  | ToolEvent
  | SessionEvent
  | VerifyEvent
  | ErrorEvent
  | DoneEvent

/** SSE 线上一共有这两种形状 */
export type StreamFrame = ResetEvent | AgentEvent

export interface MessageRow {
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  costUsd: number | null
  createdAt: string
}

export interface FileEntry {
  path: string
  name: string
  dir: boolean
  size: number
  depth: number
  mtimeMs: number
  /** 因 node_modules / .git 这类被折叠：只有名字，没有内容 */
  skipped?: boolean
}

export interface FileDiff {
  path: string
  status: 'added' | 'modified'
  /** 新建文件时为 null */
  before: string | null
  after: string
}

export interface NodeRow {
  nodeId: string
  url: string
  online: boolean
  sandboxes: number | null
  capacity: number | null
  diskFreeMb: number | null
  images: string[]
  lastSeenAt: string | null
}

export type PreviewState = 'none' | 'cold' | 'ready'

// ---------------------------------------------------------------- S3

/** 快照是谁产生的：auto = 构建通过后自动提交，user = 手动打的点 */
export type SnapshotBy = 'auto' | 'user'

export interface Snapshot {
  id: string
  projectId: string
  /** 版本号，项目内从 1 递增 */
  seq: number
  label: string
  gitRef: string
  createdBy: SnapshotBy
  createdAt: string
}

export interface Deployment {
  id: string
  projectId: string
  snapshotId: string
  version: number
  kind: InstanceKind
  /** 服务型才有生产实例 id；静态为 null（线上是软链，没有容器） */
  instanceId: string | null
  /** 线上地址 */
  url: string
  path: string
  active: boolean
  createdAt: string
}

export interface DeploymentsResponse {
  deployments: Deployment[]
  active: Deployment | null
  liveUrl: string
}

/** 生产容器（只有服务型有；静态的线上没有容器） */
export interface ProductionInstance {
  name: string
  version: number
  running: boolean
}

/**
 * 容器管理页的一行。**这是"容器"不是"项目"**：
 * 一个服务型项目可能同时有编辑沙箱 + 预览沙箱 + 若干生产容器。
 */
export interface ContainerItem {
  key: string
  projectId: string
  projectName: string
  slug: string
  template: string
  kind: InstanceKind
  /** edit / preview / production / production-container（docker 侧的真实生产容器） */
  role: InstanceRole | 'production-container'
  version: number
  state: string
  health: string
  nodeId: string | null
  sandboxId: string | null
  containerId: string | null
  containerName?: string
  port: number | null
  lastUsedAt: string | null
  /** 这一行是怎么被伺服的（静态没有专属容器，这里会说明） */
  servedBy: string
}
