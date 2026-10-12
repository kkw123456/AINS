import type { Stack } from '@webgen/shared'
import type {
  AgentEvent,
  ContainerItem,
  Deployment,
  DeploymentsResponse,
  FileDiff,
  FileEntry,
  InstanceKind,
  InstanceRow,
  MessageRow,
  NodeRow,
  Ok,
  PreviewState,
  ProductionInstance,
  ProjectRow,
  Snapshot,
  TemplateItem,
  TemplateSpec,
} from './types.ts'

/**
 * 统一拆信封。
 *
 * 后端的约定是成功 `{ok:true, ...}`、失败 `{ok:false, error}`；但**未匹配的路由**
 * 会穿过 Fastify 的默认 404（`{statusCode,error,message}`），形状不一样，所以这里
 * 对"没有 ok 字段"的响应要兜一层。
 */
export class ApiError extends Error {
  readonly status: number
  readonly logs?: string
  readonly previewUrl?: string

  constructor(status: number, message: string, extra?: { logs?: string; previewUrl?: string }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.logs = extra?.logs
    this.previewUrl = extra?.previewUrl
  }
}

async function request<T extends Ok>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    })
  } catch (e) {
    // 网络层就挂了（后端没起、代理断了）——给个比 "Failed to fetch" 有用的说法
    throw new ApiError(0, `请求后端失败：${(e as Error).message}`, undefined)
  }

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(res.status, `响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }

  const b = body as {
    ok?: boolean
    error?: string
    message?: string
    logs?: string
    previewUrl?: string
  }
  if (!res.ok || b.ok === false) {
    // 优先用后端的 error，其次 Fastify 默认 404 的 message，最后退到状态码
    const msg = b.error || b.message || `HTTP ${res.status}`
    throw new ApiError(res.status, msg, { logs: b.logs, previewUrl: b.previewUrl })
  }
  return body as T
}

const get = <T extends Ok>(p: string) => request<T>(p)
const send = <T extends Ok>(method: string, p: string, body?: unknown) =>
  request<T>(p, { method, body: body === undefined ? undefined : JSON.stringify(body) })

// ------------------------------------------------------------------- 项目

export const listTemplates = () =>
  get<Ok & { templates: TemplateItem[] }>('/api/templates').then((r) => r.templates)

export const listProjects = () =>
  get<Ok & { projects: (ProjectRow & { previewUrl: string; instance: InstanceRow | null })[] }>(
    '/api/projects',
  ).then((r) => r.projects)

export const getProject = (id: string) =>
  get<
    Ok & {
      project: ProjectRow
      instances: InstanceRow[]
      previewUrl: string
      devUrl?: string
      spec: TemplateSpec
      live: { version: number; url: string; kind: InstanceKind } | null
      liveUrl: string
    }
  >(`/api/projects/${id}`)

/**
 * 建项目。`template` 和 `stack` **二选一**：
 *   template —— 一个模板目录一整套（node-web / vue-static …）
 *   stack    —— 组合（前端 × 后端 × 数据），镜像按组合当场生成
 * 服务端两条路合流，所以返回体形状一样。
 */
export const createProject = (body: {
  template?: string
  stack?: Stack
  name?: string
  prompt?: string
}) =>
  send<Ok & { project: ProjectRow; previewUrl: string; generating: boolean }>(
    'POST',
    '/api/projects',
    body,
  )

export const deleteProject = (id: string) =>
  send<Ok & { warnings?: string[] }>('DELETE', `/api/projects/${id}`)

export const listNodes = () => get<Ok & { nodes: NodeRow[] }>('/api/nodes').then((r) => r.nodes)

// ------------------------------------------------------------------- 生成

export const sendMessage = (id: string, text: string) =>
  send<Ok & { running: boolean }>('POST', `/api/projects/${id}/messages`, { text })

export const getAgent = (id: string) =>
  get<Ok & { running: boolean; events: AgentEvent[]; messages: MessageRow[] }>(
    `/api/projects/${id}/agent`,
  )

export const getDiff = (id: string) =>
  get<Ok & { files: FileDiff[] }>(`/api/projects/${id}/diff`).then((r) => r.files)

/** SSE 地址。走 Vite 代理到 orchestrator（它没有 CORS，不能跨源直连）。 */
export const streamUrl = (id: string) => `/api/projects/${id}/stream`

// ------------------------------------------------------------------- 预览

export const getPreviewUrl = (id: string) =>
  get<Ok & { url: string; kind: string; state: PreviewState; nodeId?: string; port?: number }>(
    `/api/projects/${id}/preview-url`,
  )

export const waitPreview = (id: string, timeoutMs = 120_000) =>
  send<Ok & { host: string; ready: true; previewUrl: string }>(
    'POST',
    `/api/projects/${id}/wait`,
    { timeoutMs },
  )

export const startEditor = (id: string, wait = true) =>
  send<Ok & { sandbox?: unknown; host?: string; ready?: boolean }>(
    'POST',
    `/api/projects/${id}/editor/start`,
    { wait },
  )

/**
 * 把**预览**拉起来。和 `editor/start` 是两件事——编辑容器在 `d-<id>`，
 * 预览在 `p-<id>`；复用的话"刷新预览"会顺手把 agent 的容器重启一遍。
 * 静态项目没有预览容器，这个接口会直接告诉你"没容器可起"。
 */
export const startPreview = (id: string, wait = true) =>
  send<Ok & { ready?: boolean; kind?: string; note?: string }>(
    'POST',
    `/api/projects/${id}/preview/start`,
    { wait },
  )

export const stopEditor = (id: string) =>
  send<Ok & { removed: boolean }>('POST', `/api/projects/${id}/editor/stop`)

// ------------------------------------------------------------------- 文件

export const listFiles = (id: string, dir = '') =>
  get<Ok & { root: string; files: FileEntry[] }>(
    `/api/projects/${id}/files${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
  ).then((r) => r.files)

export const readFile = (id: string, path: string) =>
  get<Ok & { content: string; size: number }>(
    `/api/projects/${id}/file?path=${encodeURIComponent(path)}`,
  )

export const writeFile = (id: string, path: string, content: string) =>
  send<Ok & { size: number }>('PUT', `/api/projects/${id}/file`, { path, content })

/** 导出 zip 的直链：同源走代理，直接给 <a download> 用，不用 fetch+blob。 */
export const exportUrl = (id: string, scope: 'workspace' | 'artifacts' = 'workspace') =>
  `/api/projects/${id}/export?scope=${scope}`

// ------------------------------------------------------------------- 快照 / 发布（S3）

export const listSnapshots = (id: string) =>
  get<Ok & { snapshots: Snapshot[] }>(`/api/projects/${id}/snapshots`).then((r) => r.snapshots)

export const createSnapshot = (id: string, label: string) =>
  send<Ok & { committed: boolean; snapshot: Snapshot | null }>(
    'POST',
    `/api/projects/${id}/snapshots`,
    { label },
  )

/** 把**工作区**退回某个快照（"我要从这个版本继续改"）。和回滚线上不是一回事。 */
export const rollbackWorkspace = (id: string, snapshotId: string) =>
  send<Ok & { head: string; version: number }>('POST', `/api/projects/${id}/rollback`, {
    snapshotId,
  })

export const getDeployments = (id: string) =>
  get<Ok & DeploymentsResponse>(`/api/projects/${id}/deployments`)

export const deploy = (id: string, snapshotId?: string) =>
  send<Ok & { version: number; url: string; path: string; kind: InstanceKind }>(
    'POST',
    `/api/projects/${id}/deploy`,
    snapshotId ? { snapshotId } : {},
  )

/** 把**线上**切回某个版本（回滚）。 */
export const activateDeployment = (id: string, version: number) =>
  send<Ok & { version: number; url: string }>(
    'POST',
    `/api/projects/${id}/deployments/${version}/activate`,
    {},
  )

export const updateSlug = (id: string, slug: string) =>
  send<Ok & { slug: string; url: string; needsRepublish?: boolean; note?: string }>(
    'PATCH',
    `/api/projects/${id}`,
    { slug },
  )

export const getInstances = (id: string) =>
  get<Ok & { instances: InstanceRow[]; production: ProductionInstance[] }>(
    `/api/projects/${id}/instances`,
  )

// ------------------------------------------------------------------- 管理面

/** 全局容器视图：所有项目的编辑/预览/生产实例拉平成一个列表，外加节点状态 */
export const listContainers = () =>
  get<Ok & { containers: ContainerItem[]; nodes: NodeRow[] }>('/api/containers')

/** 单个模板的**完整** spec（`/api/templates` 那份是投影过的，没有 artifactDir/runCommand） */
export const getTemplateSpec = (name: string) =>
  get<Ok & { name: string; spec: TemplateSpec }>(
    `/api/templates/${encodeURIComponent(name)}`,
  ).then((r) => r.spec)
