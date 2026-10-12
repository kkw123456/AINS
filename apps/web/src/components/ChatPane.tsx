import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownIcon, InfoIcon, SendIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { PaneHeader } from './pane-header.tsx'
import { ConversationBlockView, RunCard } from './ConversationBlock.tsx'
import type { AgentEvent, MessageRow } from '../api/types.ts'
import { buildBlocks } from '../lib/blocks.ts'

/**
 * 右栏：对话。
 *
 * 消息（落库的历史）和本轮事件流是**两个来源**：
 *  - `messages` 来自 `/agent`，是一轮跑完才落库的问答记录；
 *  - `events` 来自 `/stream`，是正在跑的这一轮的实时过程。
 * 生成中两者会同时存在（消息里有你刚发的那句、事件里有模型正在做的事），这是对的。
 */
export function ChatPane({
  messages,
  events,
  running,
  sending,
  disabled,
  onSend,
}: {
  messages: MessageRow[]
  events: AgentEvent[]
  running: boolean
  sending: boolean
  disabled: boolean
  onSend: (text: string) => void
}) {
  const blocks = useMemo(() => buildBlocks(events), [events])
  const viewportRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  // 本轮结果：done 块在就是跑完了，ok 决定卡片配色
  const lastDone = blocks.findLast((b) => b.kind === 'done')
  const runState = !lastDone ? null : lastDone.ok ? 'ok' : 'fail'

  // 自动滚到底，但**用户往上翻的时候不许把他拽回来** —— 这是聊天界面的基本礼貌
  useEffect(() => {
    if (!atBottom) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks, messages, atBottom])

  const onScroll = () => {
    const el = viewportRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <PaneHeader title="对话">
        {running ? (
          <Badge variant="secondary" className="gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            生成中
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">空闲</span>
        )}
      </PaneHeader>

      <ScrollArea viewportRef={viewportRef} onScroll={onScroll} className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {messages.length === 0 && blocks.length === 0 ? (
            <EmptyState />
          ) : null}

          {messages.map((m) => (
            <MessageBubble key={m.seq} message={m} />
          ))}

          {blocks.length > 0 ? (
            <RunCard running={running} state={runState}>
              {blocks.map((b, i) => (
                <ConversationBlockView key={i} block={b} />
              ))}
            </RunCard>
          ) : null}
        </div>
      </ScrollArea>

      {!atBottom ? (
        <Button
          variant="outline"
          size="xs"
          onClick={() => setAtBottom(true)}
          className="mx-auto -mt-9 mb-2 rounded-full shadow-md"
        >
          <ArrowDownIcon />
          回到底部
        </Button>
      ) : null}

      <Composer disabled={disabled} sending={sending} onSend={onSend} />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center gap-2 text-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-muted">
        <InfoIcon className="size-4 text-muted-foreground/60" />
      </div>
      <p className="text-xs text-muted-foreground">还没有对话</p>
      <p className="max-w-[16rem] text-[11px] leading-relaxed text-muted-foreground/60">
        在下面说一句你想改什么，比如「标题换成我的名字，配色改成暖色」
      </p>
    </div>
  )
}

function MessageBubble({ message }: { message: MessageRow }) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[88%] rounded-2xl rounded-br-md border border-primary/20 bg-primary/10 px-3 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
          {message.content}
        </div>
        <span className="pr-1 text-[10px] text-muted-foreground/50">{timeOf(message.createdAt)}</span>
      </div>
    )
  }

  if (message.role === 'system') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span className="text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {message.content}
        </span>
      </div>
    )
  }

  // 助手：不用气泡。模型写的是成段的散文，包在气泡里又窄又难读。
  return (
    <div className="space-y-1.5">
      <Markdownish text={message.content} />
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
        <span>{timeOf(message.createdAt)}</span>
        {message.costUsd !== null ? <span>${message.costUsd.toFixed(4)}</span> : null}
      </div>
    </div>
  )
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 极简渲染：只把 ``` 围栏拆出来当代码块，其余按原文换行显示。
 * 这一轮**不引 markdown 库** —— 助手正文本来就是模型写的散文，
 * 真正需要成型的是 verify 失败时回灌的那段日志，那个正好在围栏里。
 */
function Markdownish({ text }: { text: string }) {
  const parts = useMemo(() => (text.includes('```') ? text.split('```') : [text]), [text])
  if (parts.length === 1) {
    return (
      <div className="text-[13px] leading-[1.65] break-words whitespace-pre-wrap">{text}</div>
    )
  }
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {/* 围栏第一行可能是语言标记，也可能只是换行 —— 两种都吃掉 */}
            {p.replace(/^[ \t]*[a-zA-Z0-9_+-]*[ \t]*\n/, '').trimEnd()}
          </pre>
        ) : p.trim() ? (
          <div key={i} className="text-[13px] leading-[1.65] break-words whitespace-pre-wrap">
            {p.trim()}
          </div>
        ) : null,
      )}
    </div>
  )
}

function Composer({
  disabled,
  sending,
  onSend,
}: {
  disabled: boolean
  sending: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || disabled || sending) return
    onSend(t)
    setText('')
  }

  return (
    <div className="border-t bg-card p-2.5">
      <div
        className={cn(
          'rounded-lg border bg-background transition-colors focus-within:border-primary/50',
          disabled && 'opacity-60',
        )}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发，Shift+Enter 换行 —— 和所有聊天框一致。
            // isComposing 必须判：中文输入法选词时的回车不能当发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
          disabled={disabled}
          placeholder={disabled ? '正在生成中，等这一轮跑完…' : '说一句你想改什么…'}
          className="min-h-0 resize-none border-0 bg-transparent text-[13px] shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="text-[10px] text-muted-foreground/60">Enter 发送 · Shift+Enter 换行</span>
          <Button size="xs" onClick={submit} disabled={disabled || sending || !text.trim()}>
            <SendIcon />
            {sending ? '发送中…' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  )
}
