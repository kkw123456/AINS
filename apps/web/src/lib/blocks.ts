import type { AgentEvent } from '../api/types.ts'
import { shortToolName } from './format.ts'

/**
 * 把事件流折成"可渲染的块"。
 *
 * 规则只有一条：**相邻同类型合并，换类型就开新块**。够用，而且是纯函数——
 * 事件流每次重连都会从头重放一遍，所以这个函数必须能被反复调用、结果只取决于输入。
 *
 * ⚠️ 两种 verify 别搞混：
 *  - `tool{name:'verify'}` 是 orchestrator 自己发的过程提示（"第 N 次验证：重建沙箱并访问 /"），
 *    它就是一条普通命令，进 tools 组。
 *  - `verify{ok,attempt,detail}` 是 agent-core 发的**结果**，单独成块、失败要红。
 */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tools'; items: ToolItem[] }
  | { kind: 'verify'; ok: boolean; attempt: number; detail: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; ok: boolean; costUsd: number; turns: number; durationMs: number }

export interface ToolItem {
  name: string
  detail: string
}

export function buildBlocks(events: AgentEvent[]): Block[] {
  const out: Block[] = []

  const last = () => out[out.length - 1]

  for (const ev of events) {
    switch (ev.type) {
      case 'delta': {
        const prev = last()
        if (prev?.kind === 'text') prev.text += ev.text
        else out.push({ kind: 'text', text: ev.text })
        break
      }
      case 'thinking': {
        const prev = last()
        if (prev?.kind === 'thinking') prev.text += ev.text
        else out.push({ kind: 'thinking', text: ev.text })
        break
      }
      case 'tool': {
        const prev = last()
        const item: ToolItem = { name: ev.name, detail: ev.detail }
        if (prev?.kind === 'tools') prev.items.push(item)
        else out.push({ kind: 'tools', items: [item] })
        break
      }
      case 'verify':
        out.push({ kind: 'verify', ok: ev.ok, attempt: ev.attempt, detail: ev.detail })
        break
      case 'error':
        out.push({ kind: 'error', message: ev.message })
        break
      case 'done':
        out.push({
          kind: 'done',
          ok: ev.ok,
          costUsd: ev.costUsd,
          turns: ev.turns,
          durationMs: ev.durationMs,
        })
        break
      case 'session':
        // SDK 会话 id 是内部状态，不给用户看
        break
    }
  }

  return out
}

/**
 * 本轮 agent 动过的文件——从 tool 事件里现推，用来给文件树打点（即时反馈，不等 /diff）。
 *
 * 这两个工具的 detail **就是路径本身**（claude.ts 的 summariseToolInput 优先取 `input.path`），
 * 所以直接拿来用，不用解析。注意这里只认这两个工具：`run` 的事件 detail 是命令行。
 */
export function touchedPaths(events: AgentEvent[]): Set<string> {
  const set = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'tool') continue
    const name = shortToolName(ev.name)
    if (name !== 'write_file' && name !== 'edit_file') continue
    const p = ev.detail.trim()
    if (p && p.length < 400) set.add(p)
  }
  return set
}
