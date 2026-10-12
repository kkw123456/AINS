import { useCallback, useEffect, useState } from 'react'
import { getAgent, sendMessage, streamUrl } from '../api/client.ts'
import type { AgentEvent, MessageRow, StreamFrame } from '../api/types.ts'

export type Connection = 'connecting' | 'open' | 'closed'

export interface AgentRun {
  running: boolean
  events: AgentEvent[]
  messages: MessageRow[]
  connection: Connection
  error: string | null
  sending: boolean
  send: (text: string) => Promise<void>
  refreshMessages: () => Promise<void>
  clearError: () => void
}

/**
 * 生成会话：把 `/stream`（事件）和 `/agent`（消息）拼成一个状态。
 *
 * ★★ 两条职责分明的铁律，写错了会很难查：
 *
 *  ① **事件只从 SSE 来，不用 /agent 回填事件。**
 *     服务端每次连接都先发 `{type:'reset', running}` 再**全量重放当前这一轮**，
 *     所以重连是自愈的：把重放当权威，不要自己写"去重"逻辑。
 *     如果同时用 /agent 灌事件，重放进行到一半时回填到达就会造成重复——
 *     所以干脆不灌。
 *
 *  ② **message 只从 /agent 来。** 事件流里**没有** message：
 *     用户消息在 POST /messages 成功后落库，助手消息要等整轮跑完才落库。
 *     所以发消息后拉一次，收到 `done` 后再拉一次。
 */
export function useAgentRun(projectId: string | undefined): AgentRun {
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [connection, setConnection] = useState<Connection>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const refreshMessages = useCallback(async () => {
    if (!projectId) return
    try {
      const r = await getAgent(projectId)
      setMessages(r.messages)
      setRunning(r.running)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    let closed = false

    setConnection('connecting')
    setEvents([])
    void refreshMessages()

    const es = new EventSource(streamUrl(projectId))

    // 服务端不写 `event:` 名、也不写 `id:` —— 所有帧都是默认的 message 事件，
    // 所以只能挂 onmessage；也正因为没有 id，Last-Event-ID 永远不触发，重放是唯一的重连协议。
    es.onopen = () => {
      if (!closed) setConnection('open')
    }
    es.onmessage = (m) => {
      let frame: StreamFrame
      try {
        frame = JSON.parse(m.data) as StreamFrame
      } catch {
        return
      }

      if (frame.type === 'reset') {
        if (closed) return
        setConnection('open')
        setEvents([]) // ★ 重放协议的起点：先清空，紧接着就是全量重放
        setRunning(frame.running)
        return
      }

      setEvents((prev) => [...prev, frame])
      if (frame.type === 'done') {
        setRunning(false)
        void refreshMessages() // 助手消息这一轮跑完才落库
      }
      if (frame.type === 'error') setError(frame.message)
    }
    es.onerror = () => {
      // EventSource 会自己重连；重连后服务端重发 reset + 重放，状态自动对齐。
      if (!closed) setConnection('closed')
    }

    return () => {
      closed = true
      es.close()
    }
  }, [projectId, refreshMessages])

  const send = useCallback(
    async (text: string) => {
      if (!projectId) return
      setSending(true)
      setError(null)
      try {
        await sendMessage(projectId, text)

        // ★ 必须**本地**清空事件。
        // 服务端 `start()` 会把它的 logs 清成 []，但它**不会**给已经连着的 SSE 连接补发
        // 一个 reset —— 新的一轮没有"连接事件"。不清的话，上一轮的块会留在屏幕上，
        // 新一轮的 delta 直接接在它后面，看起来像同一轮。
        setEvents([])
        setRunning(true)
        await refreshMessages() // 拉回刚落库的 user 消息
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSending(false)
      }
    },
    [projectId, refreshMessages],
  )

  return {
    running,
    events,
    messages,
    connection,
    error,
    sending,
    send,
    refreshMessages,
    clearError: () => setError(null),
  }
}
