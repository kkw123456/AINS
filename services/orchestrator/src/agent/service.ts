import { randomBytes } from 'node:crypto'
import {
  ClaudeAgentRunner,
  type AgentEvent,
  type SandboxBridge,
  type VerifyOutcome,
} from '@webgen/agent-core'
import type { FileDiff, Stack } from '@webgen/shared'
import { ExecutorError, type ExecutorClient } from '../cluster/executor-client.ts'
import { sandboxSource } from '../cluster/source.ts'
import { config } from '../config.ts'
import { clientFor, pickNode } from '../scheduler/index.ts'
import * as store from '../store.ts'

/** 每个项目保留多少条事件用于 SSE 重放（防内存无上限） */
const MAX_LOG = 3000

/**
 * 生成会话中心（单机版）。
 *
 * §1.1 说分布式时 agent 循环要拆成独立可伸缩的 worker —— 那时这里换成一个
 * 消费队列的进程即可，**接口形状不用变**（其余代码只认 start/subscribe）。
 * 单机先同进程跑，省掉队列与 IPC。
 */
export class AgentService {
  private readonly logs = new Map<string, AgentEvent[]>()
  private readonly subs = new Map<string, Set<(e: AgentEvent) => void>>()
  /** ★ 按 projectId 的互斥锁（§1.2 第 1 条）：同一项目同时只能有一轮生成在跑 */
  private readonly running = new Set<string>()
  /** 本轮 agent 改过的文件，key 是路径（Map 保持写入顺序）。见 FileDiff 的注释。 */
  private readonly diffs = new Map<string, Map<string, FileDiff>>()

  isRunning(projectId: string): boolean {
    return this.running.has(projectId)
  }

  history(projectId: string): AgentEvent[] {
    return this.logs.get(projectId) ?? []
  }

  /** 本轮改了哪些文件（§5.1）。没跑过就是空数组。 */
  diff(projectId: string): FileDiff[] {
    return [...(this.diffs.get(projectId)?.values() ?? [])]
  }

  subscribe(projectId: string, cb: (e: AgentEvent) => void): () => void {
    let set = this.subs.get(projectId)
    if (!set) {
      set = new Set()
      this.subs.set(projectId, set)
    }
    set.add(cb)
    const s = set
    return () => {
      s.delete(cb)
      if (s.size === 0) this.subs.delete(projectId)
    }
  }

  /** 项目被删时把内存痕迹清掉 */
  discard(projectId: string): void {
    this.logs.delete(projectId)
    this.subs.delete(projectId)
    this.diffs.delete(projectId)
  }

  private emit(projectId: string, ev: AgentEvent): void {
    const log = this.logs.get(projectId) ?? []
    log.push(ev)
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
    this.logs.set(projectId, log)
    for (const cb of this.subs.get(projectId) ?? []) {
      try {
        cb(ev)
      } catch {
        /* 单个订阅者出错不影响别人 */
      }
    }
  }

  /** 起一轮生成。**不阻塞**——调用方拿到 Promise 后可以立刻返回 202。 */
  async start(projectId: string, prompt: string): Promise<void> {
    if (this.running.has(projectId)) {
      throw new Error('这个项目正在生成中，等这一轮跑完再发')
    }
    this.running.add(projectId)
    this.logs.set(projectId, [])
    this.diffs.set(projectId, new Map())
    try {
      await store.appendMessage({ projectId, role: 'user', content: prompt })
      await this.runOnce(projectId, prompt)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.emit(projectId, { type: 'error', message })
      this.emit(projectId, { type: 'done', ok: false, costUsd: 0, turns: 0, durationMs: 0 })
      await store.appendMessage({ projectId, role: 'system', content: `生成失败：${message}` })
    } finally {
      this.running.delete(projectId)
    }
  }

  /**
   * 打一个快照并记一行版本。**失败绝不能把一轮生成搞崩** ——
   * 生成出来的代码已经在工作区里了，用户照样能看能发布，只是少一个版本点。
   * 所以这里吞掉异常、只记日志。
   *
   * 返回这一版的 seq（没有改动时返回 null），给调用方去刷新预览用。
   */
  private async takeSnapshot(
    projectId: string,
    client: ExecutorClient,
    label: string,
  ): Promise<number | null> {
    try {
      const r = await client.snapshot(projectId, label)
      if (!r.committed || !r.sha) return null // 没有改动，不堆空版本

      const seq = await store.nextSnapshotSeq(projectId)
      const id = `snap-${randomBytes(6).toString('hex')}`
      await store.insertSnapshot({
        id,
        projectId,
        seq,
        label,
        gitRef: r.sha,
        createdBy: 'auto',
      })
      return seq
    } catch (e) {
      console.warn(`[snapshot] 项目 ${projectId} 打快照失败（不影响本轮生成）：${(e as Error).message}`)
      return null
    }
  }

  /**
   * 把**预览实例**换成刚通过验证的这一版（§4：「每次 agent 回合通过 verify →
   * 自动构建 → 原子替换当前预览实例指向的版本」——所以"部署到预览"是自动的，
   * 只有"发布到线上"才是显式动作）。
   *
   * 两种形态做法不同，因为 §4 说了静态实例是 **0 个专属容器**：
   *  - 静态：把产物铺到 `previews/<id>/current`（共享静态伺服直接读，不用起容器）
   *  - 服务：重建预览容器（`p-<id>`）
   *
   * 失败同样不影响本轮生成 —— 代码已经在了，下一次验证会再试。
   */
  private async refreshPreview(
    projectId: string,
    client: ExecutorClient,
    project: { template: string; kind: 'static' | 'service'; stack: Stack | null; layoutVersion: number },
    artifactDir: string | undefined,
    version: number,
  ): Promise<void> {
    try {
      if (project.kind === 'static') {
        if (!artifactDir) return
        await client.materializePreview(projectId, version, artifactDir)
        await store.upsertInstance({
          projectId,
          role: 'preview',
          kind: 'static',
          version,
          sandboxId: null, // 静态没有容器
          state: 'running',
          health: 'healthy',
        })
        return
      }

      // 服务型：重建预览容器。先删旧的，否则 `/sandboxes` 会按 (project, preview) 复用那个旧的
      const old = await store.getInstance(projectId, 'preview')
      if (old?.sandboxId) await client.deleteSandbox(old.sandboxId).catch(() => {})

      const created = await client.createSandbox(
        projectId,
        await sandboxSource({
          id: projectId,
          template: project.template,
          stack: project.stack,
          layoutVersion: project.layoutVersion,
        }),
        'preview',
      )
      await store.upsertInstance({
        projectId,
        role: 'preview',
        kind: 'service',
        version,
        sandboxId: created.sandbox.sandboxId,
        nodeId: client.nodeId,
        port: created.sandbox.port,
        state: 'running',
      })
      // 不等它 —— 用户看到的是骨架屏，几十秒内会好；等的话会把这一轮生成拖长
    } catch (e) {
      console.warn(`[preview] 项目 ${projectId} 刷新预览失败（不影响本轮生成）：${(e as Error).message}`)
    }
  }

  private async runOnce(projectId: string, prompt: string): Promise<void> {
    const project = await store.getProject(projectId)
    if (!project) throw new Error('项目不存在')

    const inst = await store.getInstance(projectId, 'edit')
    const client: ExecutorClient = clientFor(inst?.nodeId) ?? pickNode(null)

    // 沙箱 id 是**可变**的：每轮验证都会把容器重建一次
    const sandbox = { id: inst?.sandboxId ?? null }

    // ⚠️ projectId 必须带上：组合项目（S3.5）的 spec 里 image 是
    // `webgen-app/<projectId>:<hash>`，executor 拼不出来就会明确报错。
    // 漏了这个参数的症状是"模板项目好好的，组合项目一生成就失败"。
    const spec = (await client.getTemplate(project.template, project.id, project.layoutVersion)).spec

    /**
     * ★ 本轮 diff 的采集点。
     *
     * agent 的两个写工具（`write_file` / `edit_file`）**都落到 `bridge.writeFile`**，
     * 所以在这里、在真正写下去**之前**记一份旧内容，就正好是"这轮改了哪些文件"。
     * 只在某个路径本轮**第一次**被写时读旧内容——同一文件被改五次也只读一次。
     *
     * 存在的文件列表懒加载一次并缓存整轮：不这么做的话，每个文件都要多一次探测请求，
     * 而且分不清"文件不存在"和"文件存在但读不出来（二进制/超限）"。
     */
    let knownFiles: Promise<Set<string>> | null = null
    const pathsAtRunStart = () => {
      knownFiles ??= client
        .listFiles(projectId)
        .then((r) => new Set(r.files.filter((f) => !f.dir).map((f) => f.path)))
        .catch(() => new Set<string>())
      return knownFiles
    }

    const recordDiff = async (path: string, after: string): Promise<void> => {
      const mine = this.diffs.get(projectId)
      if (!mine) return
      const seen = mine.get(path)
      if (seen) {
        seen.after = after
        return
      }
      const existed = (await pathsAtRunStart()).has(path)
      const before = existed
        ? await client
            .readFile(projectId, path)
            .then((r) => r.content)
            .catch(() => null) // 二进制 / 超限：内容拿不到，但状态仍是 modified
        : null
      mine.set(path, {
        path,
        status: existed ? 'modified' : 'added',
        before,
        after,
      })
    }

    const bridge: SandboxBridge = {
      async listFiles() {
        const r = await client.listFiles(projectId)
        return r.files.map((f) => ({
          path: f.path,
          name: f.name,
          dir: f.dir,
          size: f.size,
          skipped: f.skipped,
        }))
      },
      async readFile(path) {
        return (await client.readFile(projectId, path)).content
      },
      async writeFile(path, content) {
        await recordDiff(path, content)
        await client.writeFile(projectId, path, content)
      },
      async run(cmd, opts) {
        if (!sandbox.id) throw new Error('沙箱不在运行中，先让平台把它拉起来')
        const r = await client.exec(sandbox.id, cmd, opts)
        return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
      },
    }

    /**
     * ★ verify 的真身：**把沙箱整个重建一遍**。
     *
     * 容器的 Cmd 就是 `<buildCommand> && <runCommand>`（见 executor 的 create.ts），
     * 所以"容器起得来"这一件事同时证明了：构建通过 → 应用启动 → 端口在听。
     * 起不来的话容器会退出，退出前的日志就是给模型看的失败原因。
     */
    const verify = async (attempt: number): Promise<VerifyOutcome> => {
      this.emit(projectId, {
        type: 'tool',
        name: 'verify',
        detail: `第 ${attempt + 1} 次验证：重建沙箱并访问 /`,
      })
      if (sandbox.id) await client.deleteSandbox(sandbox.id).catch(() => {})

      const created = await client.createSandbox(projectId, await sandboxSource(project))
      sandbox.id = created.sandbox.sandboxId
      await store.upsertInstance({
        projectId,
        role: 'edit',
        kind: project.kind,
        sandboxId: sandbox.id,
        nodeId: client.nodeId,
        port: created.sandbox.port,
        state: 'running',
      })

      try {
        await client.waitSandbox(sandbox.id, config.verifyTimeoutMs)
      } catch (e) {
        const logs = e instanceof ExecutorError ? (e.logs ?? '') : ''
        return { ok: false, detail: logs || (e as Error).message }
      }

      // ★ 走到这里就是"构建通过"——§5.1 说的「每次构建通过就自动 commit」。
      // 挂在这一行而不是别处：`verify` 是"构建通过"这个事实的**唯一来源**，
      // 放在跑完之后的统一收尾里会把没通过的那些尝试也提交进去。
      const seq = await this.takeSnapshot(projectId, client, `第 ${attempt + 1} 次验证通过`)

      // 有新版本才刷预览：没改动说明产物没变，白重建一次容器只是浪费
      if (seq) await this.refreshPreview(projectId, client, project, spec.artifactDir, seq)

      return { ok: true, detail: '构建通过，应用已启动并且可以访问' }
    }

    const runner = new ClaudeAgentRunner({
      bridge,
      spec,
      projectName: project.name,
      verify,
      model: config.agentModel,
      // 0 表示不限（见 config.agentMaxTurns 的说明）；不传就是不传，SDK 那边也就不设上限
      maxTurnsPerAttempt: config.agentMaxTurns || undefined,
    })

    let assistantText = ''
    let lastCost = 0
    let ok = false

    const resumeSessionId = await store.getSdkSessionId(projectId)

    for await (const ev of runner.run({
      projectId,
      prompt,
      resumeSessionId,
      maxRepairRounds: config.maxRepairRounds,
    })) {
      this.emit(projectId, ev)
      if (ev.type === 'delta') assistantText += ev.text
      if (ev.type === 'session') await store.setSdkSessionId(projectId, ev.id)
      if (ev.type === 'done') {
        lastCost = ev.costUsd
        ok = ev.ok
      }
    }

    // verify 失败时，最后一条 verify 的 detail 就是用户该看到的原因
    const lastVerify = [...this.history(projectId)].reverse().find((e) => e.type === 'verify')
    const tail =
      !ok && lastVerify && lastVerify.type === 'verify'
        ? `\n\n> 未通过验证：\n\`\`\`\n${lastVerify.detail.slice(-2000)}\n\`\`\``
        : ''

    await store.appendMessage({
      projectId,
      role: 'assistant',
      content: (assistantText.trim() || '（本轮没有文字输出）') + tail,
      costUsd: lastCost,
    })
  }
}

export const agentService = new AgentService()
