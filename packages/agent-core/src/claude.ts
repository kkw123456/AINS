import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TemplateSpec } from '@webgen/shared'
import type { SandboxBridge } from './bridge.ts'
import type { AgentEvent } from './events.ts'
import { buildSystemPrompt } from './prompt.ts'
import type { AgentRunOptions, AgentRunner } from './runner.ts'
import { SANDBOX_TOOL_NAMES, createSandboxServer } from './sandbox-tools.ts'

/**
 * claude 自带工具一律禁用 —— 它们会跑在**跑 agent 的那台机器**上，
 * 而生成出来的代码必须只经沙箱（§1.3 / §10）。放行清单里只剩 `mcp__sandbox__*`。
 */
const BUILTIN_TOOLS_BLOCKED = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'Skill',
  'SlashCommand',
  'TodoWrite',
  'WebSearch',
]

export interface VerifyOutcome {
  ok: boolean
  /** 失败时给模型看的东西：构建/启动日志的尾部 */
  detail: string
}

export interface ClaudeRunnerDeps {
  bridge: SandboxBridge
  spec: TemplateSpec
  projectName: string
  /** 一轮真实验证：重建沙箱、把应用跑起来、探活。由 orchestrator 提供（它才知道 executor） */
  verify: (attempt: number) => Promise<VerifyOutcome>
  /**
   * 单轮最多几轮工具调用。**不传就是不限**（见下面 maxTurns 那段说明）。
   */
  maxTurnsPerAttempt?: number
  model?: string
}

interface TurnSummary {
  sessionId: string | null
  costUsd: number
  turns: number
  isError: boolean
  errors: string[]
}

/**
 * §3.1 的唯一实现。循环形态就是 §3.2 那张图：
 *
 *   loop (最多 maxRepairRounds 轮):
 *     模型改代码 → 真跑起来验证 → 通过就结束，不通过把日志回灌继续
 *
 * 每一轮都用 `resume` 接回上一个 SDK 会话 —— 换成"常驻进程 + 异步迭代 prompt"
 * 能省掉每次重新加载的开销，但要多维护一个输入队列；S1 先用 resume 把正确性做对，
 * 延迟留给后面优化（hot path 已经在 prompt 里说清楚了）。
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly deps: ClaudeRunnerDeps) {}

  async *run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const maxRepair = opts.maxRepairRounds ?? 3
    const started = Date.now()
    let prompt = opts.prompt
    let resume = opts.resumeSessionId ?? undefined
    let totalCost = 0
    let totalTurns = 0

    for (let attempt = 0; attempt <= maxRepair; attempt++) {
      const turn = this.turn(prompt, resume)
      let step = await turn.next()
      while (!step.done) {
        yield step.value
        step = await turn.next()
      }
      const s = step.value
      resume = s.sessionId ?? resume
      totalCost += s.costUsd
      totalTurns += s.turns

      if (s.isError && s.errors.length) {
        yield { type: 'error', message: s.errors.join('\n') }
      }

      // ★ 真实验证：把应用跑起来，看它到底能不能访问
      const v = await this.deps.verify(attempt)
      yield { type: 'verify', ok: v.ok, attempt: attempt + 1, detail: v.detail }

      if (v.ok) {
        yield {
          type: 'done',
          ok: true,
          costUsd: totalCost,
          turns: totalTurns,
          durationMs: Date.now() - started,
        }
        return
      }

      if (attempt === maxRepair) {
        yield {
          type: 'done',
          ok: false,
          costUsd: totalCost,
          turns: totalTurns,
          durationMs: Date.now() - started,
        }
        return
      }

      prompt =
        `上一轮没通过验证。这是把应用真的跑起来时的输出：\n\n` +
        '```\n' +
        v.detail.slice(-4000) +
        '\n```\n\n' +
        '请定位并修掉它，然后用 run 自己确认一遍。'
    }
  }

  /** 跑一轮：流式产出事件，返回这一轮的摘要 */
  private async *turn(
    prompt: string,
    resume: string | undefined,
  ): AsyncGenerator<AgentEvent, TurnSummary> {
    const summary: TurnSummary = {
      sessionId: null,
      costUsd: 0,
      turns: 0,
      isError: false,
      errors: [],
    }

    const q = query({
      prompt,
      options: {
        // 显式 cwd。**绝不落进仓库目录**——否则会把仓库的 CLAUDE.md / skills 交给生成器
        cwd: '/tmp',
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        // ★★ **默认不限回合数。**
        //
        // 这里原本写死 60，结果一大轮生成会被 SDK 掐断，报
        // 「Claude Code returned an error result: Reached maximum number of turns (60)」。
        // 那个状态下代码改了一半、verify 没跑完，交付的是个**半成品** ——
        // 这比多花点 token 糟得多（而且「修到能跑」本来就是这个平台的核心承诺）。
        //
        // 需要上限的时候在 `.env` 给 WEBGEN_AGENT_MAX_TURNS（orchestrator 会传进来）。
        // 一个真实的兜底是有的：`AGENT_VERIFY_TIMEOUT_MS` 卡住每次 verify，
        // 而 verify 失败会被回灌、最多 `AGENT_MAX_REPAIR_ROUNDS` 轮 —— 所以不会无限跑。
        ...(this.deps.maxTurnsPerAttempt ? { maxTurns: this.deps.maxTurnsPerAttempt } : {}),
        mcpServers: { sandbox: createSandboxServer(this.deps.bridge) },
        allowedTools: SANDBOX_TOOL_NAMES,
        disallowedTools: BUILTIN_TOOLS_BLOCKED,
        systemPrompt: buildSystemPrompt({
          projectName: this.deps.projectName,
          spec: this.deps.spec,
        }),
        ...(resume ? { resume } : {}),
        ...(this.deps.model ? { model: this.deps.model } : {}),
      },
    })

    try {
      for await (const msg of q) {
        for (const ev of translate(msg, summary)) yield ev
      }
    } catch (e) {
      summary.isError = true
      summary.errors.push(e instanceof Error ? e.message : String(e))
      yield { type: 'error', message: summary.errors[summary.errors.length - 1]! }
    }

    return summary
  }
}

/** 把 SDK 消息翻译成我们自己的事件（§8 的 SSE 事件名） */
function* translate(msg: SDKMessage, summary: TurnSummary): Generator<AgentEvent> {
  const m = msg as unknown as {
    type: string
    subtype?: string
    session_id?: string
    event?: {
      type?: string
      delta?: { type?: string; text?: string; thinking?: string }
    }
    message?: { content?: Array<{ type: string; name?: string; input?: unknown }> }
    total_cost_usd?: number
    num_turns?: number
    is_error?: boolean
  }

  if (m.session_id && m.session_id !== summary.sessionId) {
    summary.sessionId = m.session_id
    yield { type: 'session', id: m.session_id }
  }

  switch (m.type) {
    case 'stream_event': {
      const d = m.event?.delta
      if (d?.type === 'text_delta' && d.text) yield { type: 'delta', text: d.text }
      if (d?.type === 'thinking_delta' && d.thinking) {
        yield { type: 'thinking', text: d.thinking }
      }
      return
    }
    case 'assistant': {
      for (const block of m.message?.content ?? []) {
        if (block.type !== 'tool_use' || !block.name) continue
        yield { type: 'tool', name: block.name, detail: summariseToolInput(block.input) }
      }
      return
    }
    case 'result': {
      summary.costUsd += m.total_cost_usd ?? 0
      summary.turns += m.num_turns ?? 0
      if (m.is_error) {
        summary.isError = true
        summary.errors.push('这一轮以错误收尾')
      }
      return
    }
    default:
      return
  }
}

/** 工具参数摘要：太长的不往事件里塞，前端只用来显示一行 */
function summariseToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  if (typeof o.path === 'string') return o.path
  if (Array.isArray(o.cmd)) return (o.cmd as string[]).join(' ')
  if (typeof o.dir === 'string') return o.dir
  const s = JSON.stringify(input)
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}
