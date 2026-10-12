import { BrainIcon, CheckIcon, ChevronRightIcon, TerminalIcon, XIcon, ZapIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Block } from '../lib/blocks.ts'
import { formatDuration, toolLabel } from '../lib/format.ts'

/**
 * 对话里的一段。
 *
 * 视觉约定：**每个块左边留一个固定宽度的图标槽**，正文从同一条竖线上开始。
 * 一条长长的生成记录全靠这个槽才能纵向扫读 —— 否则折叠块、正文、验证结果
 * 混在一起，找"哪一步失败了"要一行行读。
 *
 * 折叠规则照 §9：**思考 / 命令折叠**、**verify 失败高亮**。
 */
export function ConversationBlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'text':
      return (
        <Row icon={null}>
          <div className="text-[13px] leading-[1.65] break-words whitespace-pre-wrap">
            {block.text}
          </div>
        </Row>
      )

    case 'thinking':
      return (
        <Row icon={<BrainIcon className="size-3.5 text-muted-foreground/50" />}>
          <Fold label="思考" defaultOpen={false}>
            <div className="border-l border-dashed pl-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground/80">
              {block.text}
            </div>
          </Fold>
        </Row>
      )

    case 'tools':
      return (
        <Row icon={<TerminalIcon className="size-3.5 text-muted-foreground/50" />}>
          <Fold label={`命令 · ${block.items.length}`}>
            <ul className="space-y-1">
              {block.items.map((t, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded px-1 py-0.5 text-xs leading-snug transition-colors hover:bg-accent/60"
                >
                  <Badge variant="secondary" className="mt-px shrink-0">
                    {toolLabel(t.name)}
                  </Badge>
                  {/*
                    命令行**要换行，不要截断** —— 截成 `src/components/Pro…` 等于没说改的是哪个文件。
                    `break-all` 是因为路径里没有空格可断，光靠 break-words 换不了行。
                    min-w-0 同样不能省：flex 子项默认 min-width:auto，不加就连换行空间都不给。
                  */}
                  <span className="min-w-0 flex-1 font-mono text-[11px] break-all text-muted-foreground">
                    {t.detail}
                  </span>
                </li>
              ))}
            </ul>
          </Fold>
        </Row>
      )

    case 'verify':
      // §9「verify 失败高亮」：失败必须显眼，而且默认把报错展开 —— 用户最想看的就这个
      return (
        <Row icon={null}>
          <div
            className={cn(
              'rounded-lg border py-2 pr-2.5 pl-2.5',
              block.ok
                ? 'border-success/30 bg-success/5'
                : 'border-destructive/40 bg-destructive/10',
            )}
          >
            <div
              className={cn(
                'flex items-center gap-1.5 text-xs font-medium',
                block.ok ? 'text-success' : 'text-destructive',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full',
                  block.ok ? 'bg-success/15' : 'bg-destructive/15',
                )}
              >
                {block.ok ? <CheckIcon className="size-2.5" /> : <XIcon className="size-2.5" />}
              </span>
              第 {block.attempt} 次验证{block.ok ? '通过' : '失败'}
            </div>
            {block.detail ? (
              <div className="mt-1.5">
                <Fold label={block.ok ? '详情' : '失败原因'} defaultOpen={!block.ok}>
                  <ScrollArea className="max-h-64">
                    <pre className="rounded bg-background/60 p-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                      {block.detail}
                    </pre>
                  </ScrollArea>
                </Fold>
              </div>
            ) : null}
          </div>
        </Row>
      )

    case 'error':
      return (
        <Row icon={null}>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2">
            <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="text-xs leading-relaxed text-destructive">{block.message}</span>
          </div>
        </Row>
      )

    case 'done':
      return (
        <Row icon={null}>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Badge variant={block.ok ? 'success' : 'destructive'}>
              {block.ok ? <CheckIcon /> : <XIcon />}
              {block.ok ? '本轮通过' : '本轮未通过'}
            </Badge>
            <span className="text-[11px] text-muted-foreground/70">
              {formatDuration(block.durationMs)} · {block.turns} 轮 · ${block.costUsd.toFixed(4)}
            </span>
          </div>
        </Row>
      )
  }
}

/** 统一的"图标槽 + 内容"骨架，见本文件顶部的说明 */
function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <div className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
        {icon ?? <span className="size-1 rounded-full bg-muted-foreground/25" />}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Fold({
  label,
  defaultOpen = false,
  children,
}: {
  label: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/fold">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-muted-foreground"
        >
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/fold:rotate-90" />
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** 运行中的那一轮：带状态头的卡片，把这一轮的块圈在一起 */
export function RunCard({
  running,
  state,
  children,
}: {
  running: boolean
  state: 'ok' | 'fail' | null
  children: React.ReactNode
}) {
  const tone = running ? 'primary' : state === 'fail' ? 'destructive' : 'success'
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-muted/20',
        running && 'border-primary/30',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 border-b px-2.5 py-1.5 text-[11px] font-medium',
          tone === 'primary' && 'border-primary/20 bg-primary/5 text-primary',
          tone === 'success' && 'border-success/20 bg-success/5 text-success',
          tone === 'destructive' && 'border-destructive/25 bg-destructive/5 text-destructive',
        )}
      >
        <ZapIcon className={cn('size-3', running && 'animate-pulse')} />
        {running ? '正在生成' : state === 'fail' ? '这一轮未通过验证' : '这一轮完成'}
      </div>
      <div className="space-y-2.5 p-2.5">{children}</div>
    </div>
  )
}
