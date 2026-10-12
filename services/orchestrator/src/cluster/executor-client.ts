import type { ExecResult, NodeInfo, SandboxHandle, TemplateSpec } from '@webgen/shared'
import type { SandboxSource } from './source.ts'

export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly logs?: string,
  ) {
    super(message)
    this.name = 'ExecutorError'
  }
}

export interface CreateSandboxResult {
  sandbox: SandboxHandle
  host: string
  reused: boolean
  nodeId: string
}

export interface FileTreeEntry {
  path: string
  name: string
  dir: boolean
  size: number
  depth: number
  mtimeMs: number
  skipped?: boolean
}

/**
 * 调某个节点 executor 的受限 API。**orchestrator 不认识 docker**——
 * 所有容器相关操作都必须从这里过，这是 §1 里"两个进程分家"的落地。
 */
export class ExecutorClient {
  constructor(
    readonly nodeId: string,
    readonly url: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.url), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* 非 JSON，交给下面报错 */
    }
    if (!res.ok) {
      const obj = (parsed ?? {}) as { error?: string; logs?: string }
      throw new ExecutorError(
        obj.error || `executor ${this.nodeId} 返回 ${res.status}`,
        res.status,
        obj.logs,
      )
    }
    return parsed as T
  }

  nodeInfo(): Promise<{ ok: boolean; node: NodeInfo }> {
    return this.req('GET', '/node/info')
  }

  listTemplates(): Promise<{ ok: boolean; templates: string[] }> {
    return this.req('GET', '/templates')
  }

  /**
   * 拿一个模板的完整 spec。
   *
   * `projectId` 只有**组合**用得上（组合的镜像 tag 里含项目 id，见 executor 的
   * `/templates/:name`）。模板项目传不传都一样 —— 但调用点通常手边正好有项目行，
   * 那就顺手传上，省得在两处各写一次"是不是组合"的判断。
   */
  getTemplate(
    name: string,
    projectId?: string,
    layout?: number,
  ): Promise<{ ok: boolean; name: string; spec: TemplateSpec }> {
    const q = new URLSearchParams()
    if (projectId) q.set('projectId', projectId)
    // 布局影响组合的 build/run 命令（新布局要 cd 到 backend/frontend），所以带上
    if (layout !== undefined) q.set('layout', String(layout))
    const s = q.toString()
    return this.req('GET', `/templates/${encodeURIComponent(name)}${s ? `?${s}` : ''}`)
  }

  /**
   * 按组合构建项目镜像。**幂等**：镜像已经在就秒回（不重新 build）。
   * 之所以单列成一个接口而不是塞进 createSandbox：agent 一轮生成会重建最多 4 次沙箱，
   * 塞进去就等于一轮 build 四次。
   */
  buildImage(
    projectId: string,
    stack: unknown,
  ): Promise<{ ok: boolean; image: string; log: string }> {
    return this.req('POST', '/images/build', { projectId, stack })
  }

  /** 删掉某个项目的所有镜像版本（删项目时调用）。 */
  removeImages(projectId: string): Promise<{ ok: boolean; removed: string[] }> {
    return this.req('DELETE', `/images/${encodeURIComponent(projectId)}`)
  }

  /**
   * 建沙箱。`source` 二选一：`{template}` 是"一个模板一整套"，`{stack}` 是组合。
   * **别在这里判断该用哪个** —— 那是 `sandboxSource(project)` 的事，
   * 这样 7 个调用点用的是同一份判断。
   */
  createSandbox(
    projectId: string,
    source: SandboxSource,
    role: 'edit' | 'preview' = 'edit',
  ): Promise<CreateSandboxResult> {
    return this.req('POST', '/sandboxes', { projectId, ...source, role })
  }

  waitSandbox(
    sandboxId: string,
    timeoutMs?: number,
    healthPath?: string,
  ): Promise<{ ok: boolean; host: string }> {
    return this.req('POST', `/sandboxes/${sandboxId}/wait`, { timeoutMs, healthPath })
  }

  deleteSandbox(sandboxId: string): Promise<{ ok: boolean; removed: boolean }> {
    return this.req('DELETE', `/sandboxes/${sandboxId}`)
  }

  exec(sandboxId: string, cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
    return this.req<{ ok: boolean } & ExecResult>('POST', `/sandboxes/${sandboxId}/exec`, {
      cmd,
      ...opts,
    })
  }

  route(sandboxId: string): Promise<{
    ok: boolean
    host: string
    port: number
    containerId: string
    ip: string | null
    running: boolean
  }> {
    return this.req('GET', `/sandboxes/${sandboxId}/route`)
  }

  logs(sandboxId: string, lines = 100): Promise<{ ok: boolean; logs: string }> {
    return this.req('GET', `/sandboxes/${sandboxId}/logs?lines=${lines}`)
  }

  listFiles(
    projectId: string,
    dir = '',
  ): Promise<{ ok: boolean; root: string; files: FileTreeEntry[] }> {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : ''
    return this.req('GET', `/workspaces/${projectId}/files${q}`)
  }

  /**
   * 导出 zip。**不能走 req()**——那个假定响应是 JSON，这个响应体是二进制。
   * 失败时反而还是 JSON 错误信封，所以这里手工兜一层。
   *
   * 整包进 Buffer：上限在 executor 侧（maxExportBytes，默认 64MB），有界，可以接受。
   */
  async exportZip(
    projectId: string,
    dir: string,
    name: string,
  ): Promise<{ buf: Buffer; filename: string }> {
    const url = new URL(`/workspaces/${projectId}/export`, this.url)
    if (dir) url.searchParams.set('dir', dir)
    if (name) url.searchParams.set('name', name)

    const res = await fetch(url)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = `executor ${this.nodeId} 返回 ${res.status}`
      try {
        msg = (JSON.parse(text) as { error?: string }).error || msg
      } catch {
        /* 不是 JSON 就用默认消息 */
      }
      throw new ExecutorError(msg, res.status)
    }
    const cd = res.headers.get('content-disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `${projectId}.zip`
    return { buf: Buffer.from(await res.arrayBuffer()), filename }
  }

  readFile(projectId: string, path: string): Promise<{ ok: boolean; content: string; size: number }> {
    return this.req('GET', `/workspaces/${projectId}/file?path=${encodeURIComponent(path)}`)
  }

  writeFile(projectId: string, path: string, content: string): Promise<{ ok: boolean; size: number }> {
    return this.req('PUT', `/workspaces/${projectId}/file`, { path, content })
  }

  removeWorkspace(projectId: string): Promise<{ ok: boolean }> {
    return this.req('DELETE', `/workspaces/${projectId}`)
  }

  // ------------------------------------------------------- 快照（S3，§5.1）

  /**
   * 打一个快照。**没有改动时后端返回 `committed:false`**，调用方据此决定
   * 要不要记一行 snapshots —— 别堆空版本，时间线上全是无意义的点。
   */
  snapshot(
    projectId: string,
    label: string,
  ): Promise<{ ok: boolean; committed: boolean; sha: string | null; nothingToDo: boolean }> {
    return this.req('POST', `/workspaces/${projectId}/snapshot`, { label })
  }

  listSnapshots(
    projectId: string,
  ): Promise<{ ok: boolean; snapshots: { sha: string; label: string; date: string }[] }> {
    return this.req('GET', `/workspaces/${projectId}/snapshots`)
  }

  /** 把工作区回退到某个快照。后端只动已跟踪文件，不会删 node_modules。 */
  checkout(projectId: string, ref: string): Promise<{ ok: boolean; head: string }> {
    return this.req('POST', `/workspaces/${projectId}/checkout`, { ref })
  }

  // --------------------------------------------------------- 发布（S3，§5.2）

  materializeSite(
    projectId: string,
    slug: string,
    version: number,
    artifactDir: string,
  ): Promise<{ ok: boolean; path: string; target: string }> {
    return this.req('POST', `/projects/${projectId}/publish/static`, { slug, version, artifactDir })
  }

  materializePreview(
    projectId: string,
    version: number,
    artifactDir: string,
  ): Promise<{ ok: boolean; path: string; target: string }> {
    return this.req('POST', `/projects/${projectId}/publish/preview`, { version, artifactDir })
  }

  materializeRelease(
    projectId: string,
    ref: string,
    slug: string,
    version: number,
  ): Promise<{ ok: boolean; path: string; target: string }> {
    return this.req('POST', `/projects/${projectId}/publish/release`, { ref, slug, version })
  }

  /** 切线上版本（回滚就是调它）。目标不在磁盘上会 400。 */
  activateSite(slug: string, version: number): Promise<{ ok: boolean }> {
    return this.req('POST', `/publish/site/${slug}/activate`, { version })
  }

  renameSiteDir(oldSlug: string, newSlug: string): Promise<{ ok: boolean }> {
    return this.req('POST', `/publish/site/${oldSlug}/rename`, { newSlug })
  }

  removeSite(slug: string): Promise<{ ok: boolean }> {
    return this.req('DELETE', `/publish/site/${slug}`)
  }

  removePreview(projectId: string): Promise<{ ok: boolean }> {
    return this.req('DELETE', `/publish/preview/${projectId}`)
  }

  // ------------------------------------------------------ 生产实例（S3，§4）

  /**
   * 起生产容器。`source` 二选一（template / stack），和建沙箱用同一个类型 ——
   * 少了组合这条路，症状是"预览和生成都好，一发布就报模板不存在"。
   */
  createProduction(
    a: { projectId: string; slug: string; version: number; releaseDir: string } & SandboxSource,
  ): Promise<{ ok: boolean; containerId: string; containerName: string; port: number; host: string }> {
    return this.req('POST', '/production', a)
  }

  /**
   * 等生产实例健康。用模板的 `healthPath` 探，不是写死的 `/`。
   * 容器退出会带 `logs`（退出前的输出就是失败原因）。
   */
  waitProduction(
    slug: string,
    version: number,
    projectId: string,
    source: SandboxSource,
    timeoutMs = 60_000,
  ): Promise<{ ok: boolean; healthy: boolean; path: string }> {
    return this.req('POST', `/production/${slug}/${version}/health`, {
      projectId,
      ...source,
      timeoutMs,
    })
  }

  listProduction(
    slug: string,
  ): Promise<{ ok: boolean; instances: { name: string; version: number; running: boolean; containerId: string }[] }> {
    return this.req('GET', `/production/${slug}`)
  }

  removeProduction(slug: string, version: number): Promise<{ ok: boolean; removed: boolean }> {
    return this.req('DELETE', `/production/${slug}/${version}`)
  }

  /** 停但保留容器 —— 回滚要靠它（§4「保留上一个供回滚」） */
  stopProduction(slug: string, version: number): Promise<{ ok: boolean; stopped: boolean }> {
    return this.req('POST', `/production/${slug}/${version}/stop`)
  }

  startProduction(slug: string, version: number): Promise<{ ok: boolean; started: boolean }> {
    return this.req('POST', `/production/${slug}/${version}/start`)
  }
}
