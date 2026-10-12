/** 面向 UI 的事件流。与 §8 里 SSE 的 `delta/thinking/tool/verify/error/done` 对齐。 */

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; detail: string }
  /** 拿到 / 切换了 SDK 会话 id（下一轮 resume 用它接上下文） */
  | { type: 'session'; id: string }
  /** verify 闭环的一次结果 */
  | { type: 'verify'; ok: boolean; attempt: number; detail: string }
  | { type: 'error'; message: string }
  | { type: 'done'; costUsd: number; turns: number; durationMs: number; ok: boolean }

export interface AgentRunResult {
  ok: boolean
  costUsd: number
  turns: number
  durationMs: number
  /** 最后一次 verify 的说明，失败时给用户看的 */
  detail: string
}
