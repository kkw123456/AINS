import type { AgentEvent, AgentRunResult } from './events.ts'

export interface AgentRunOptions {
  /** 项目 id，用于日志与工具调用 */
  projectId: string
  /** 用户这一轮要什么 */
  prompt: string
  /** 历史会话 id（SDK 的 session_id），用于接回上下文 */
  resumeSessionId?: string | null
  /** 最多几轮 verify-repair */
  maxRepairRounds?: number
}

/**
 * §3.1 收敛点：业务层只认这个接口。
 * 唯一实现是 Claude Agent SDK；将来换模型 = 加一个实现，业务层不动。
 */
export interface AgentRunner {
  run(opts: AgentRunOptions): AsyncIterable<AgentEvent>
  /** 最近一次 run 的结果（SSE 客户端晚到时可补） */
  lastResult?(): AgentRunResult | null
}
