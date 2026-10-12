import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLinkIcon, FileCodeIcon, GitCompareArrowsIcon, MonitorIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ApiError, getDiff, readFile, writeFile } from '@/api/client'
import type { FileDiff } from '@/api/types'
import { CodeEditor } from './CodeEditor.tsx'
import { DiffView } from './DiffView.tsx'
import type { PreviewController } from '../hooks/usePreview.ts'

/**
 * 中间面板 = 一个 tab 区：**预览** + 打开的文件（+ 单个文件的 diff）。
 *
 * 为什么把文件预览从左边挪到中间：左边已经要放文件树和改动列表了，
 * 再塞编辑器会让每一栏都窄得没法用。中间本来就是最宽的那栏，给代码正合适 ——
 * 预览变成其中一个 tab，而不是独占中间。
 *
 * 生成中**不阻塞这个面板**：只有"预览"这个 tab 显示骨架屏，
 * tab 栏照常能切去别的文件看代码。以前中间整块变 loading，生成时什么都干不了。
 */
export type CenterTab =
  | { kind: 'preview'; key: 'preview' }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'diff'; key: string; path: string }

export function CenterPane({
  projectId,
  tabs,
  activeKey,
  onActivate,
  onClose,
  onOpenDiff,
  preview,
  running,
  previewUrl,
  onNotice,
}: {
  projectId: string
  tabs: CenterTab[]
  activeKey: string
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onOpenDiff: (path: string) => void
  preview: PreviewController
  running: boolean
  previewUrl: string
  onNotice: (msg: string) => void
}) {
  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <TabBar
        tabs={tabs}
        activeKey={active?.key ?? 'preview'}
        onActivate={onActivate}
        onClose={onClose}
      />

      <div className="min-h-0 flex-1">
        {!active || active.kind === 'preview' ? (
          <PreviewTab
            controller={preview}
            running={running}
            previewUrl={previewUrl}
            onOpenDiff={onOpenDiff}
          />
        ) : active.kind === 'file' ? (
          <FileTab
            key={active.path}
            projectId={projectId}
            path={active.path}
            running={running}
            onNotice={onNotice}
            onOpenDiff={onOpenDiff}
          />
        ) : (
          <DiffTab key={active.path} projectId={projectId} path={active.path} />
        )}
      </div>
    </div>
  )
}

/**
 * tab 栏。
 *
 * **预览是钉住的**：它单独占左边一块，不参与右边的横向滚动 ——
 * 文件开多了往右划的时候，预览不能被划出视野（它是这个面板存在的理由）。
 * 右边是可滚动的文件/diff tab，能横着划，也能逐个关掉。
 */
function TabBar({
  tabs,
  activeKey,
  onActivate,
  onClose,
}: {
  tabs: CenterTab[]
  activeKey: string
  onActivate: (key: string) => void
  onClose: (key: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const previewTab = tabs.find((t) => t.kind === 'preview')
  const rest = tabs.filter((t) => t.kind !== 'preview')

  // 新开的 tab 可能在可视区外，切过去时把它滚进来
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeKey)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  const label = (t: CenterTab) => ('path' in t ? (t.path.split('/').pop() ?? t.path) : '预览')

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b bg-card">
      {/* 钉住的那一格：不滚动、不可关 */}
      {previewTab ? (
        <button
          type="button"
          onClick={() => onActivate(previewTab.key)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 border-r px-2.5 text-xs whitespace-nowrap',
            activeKey === previewTab.key
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <MonitorIcon className="size-3.5" />
          预览
        </button>
      ) : null}

      {/* 可滚动的那一段 */}
      <div ref={scroller} className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {rest.map((t) => {
          const isActive = t.key === activeKey
          return (
            <div
              key={t.key}
              data-tab={t.key}
              className={cn(
                'group flex shrink-0 items-center gap-1.5 border-r px-2.5 text-xs whitespace-nowrap',
                isActive ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              <button
                type="button"
                onClick={() => onActivate(t.key)}
                className="flex items-center gap-1.5"
                title={'path' in t ? t.path : undefined}
              >
                {t.kind === 'diff' ? (
                  <GitCompareArrowsIcon className="size-3.5" />
                ) : (
                  <FileCodeIcon className="size-3.5" />
                )}
                <span className="max-w-[14rem] truncate font-mono">{label(t)}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.key)
                }}
                className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent"
                title="关闭"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 预览 tab：设备宽度、刷新、新窗口，加 iframe 或骨架屏 */
function PreviewTab({
  controller,
  running,
  previewUrl,
  onOpenDiff,
}: {
  controller: PreviewController
  running: boolean
  previewUrl: string
  onOpenDiff: (path: string) => void
}) {
  const [device, setDevice] = useState<'auto' | 'mobile' | 'tablet' | 'desktop'>('auto')
  const [frameKey, setFrameKey] = useState(0)
  const widths = { auto: 0, mobile: 390, tablet: 834, desktop: 1280 }
  const width = widths[device]
  const showFrame = !running && controller.state === 'ready' && !controller.error

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1.5 border-b px-2">
        <Tabs value={device} onValueChange={(v) => setDevice(v as typeof device)}>
          <TabsList>
            <TabsTrigger value="auto">自适应</TabsTrigger>
            <TabsTrigger value="mobile">手机</TabsTrigger>
            <TabsTrigger value="tablet">平板</TabsTrigger>
            <TabsTrigger value="desktop">桌面</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setFrameKey((k) => k + 1)
            controller.refresh()
          }}
        >
          <RefreshCwIcon />
          刷新
        </Button>
        <Button asChild variant="outline" size="xs">
          <a href={previewUrl} target="_blank" rel="noreferrer" title={previewUrl}>
            <ExternalLinkIcon />
            新窗口
          </a>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="min-h-full p-3">
          {controller.error ? (
            <div className="mx-auto max-w-lg rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-xs font-medium text-destructive">预览起不来</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{controller.error}</p>
              {controller.errorLogs ? (
                <pre className="mt-2 max-h-56 overflow-auto rounded border bg-muted/40 p-2 text-[11px] text-muted-foreground">
                  {controller.errorLogs}
                </pre>
              ) : null}
              <Button variant="outline" size="xs" onClick={controller.retry} className="mt-2">
                重试
              </Button>
            </div>
          ) : showFrame ? (
            <div className="mx-auto" style={{ width: width || '100%', height: '100%' }}>
              <iframe
                key={`${frameKey}-${controller.refreshKey}`}
                src={controller.url || previewUrl}
                title="预览"
                className="h-full min-h-[70vh] w-full rounded-md border bg-white"
              />
            </div>
          ) : (
            <Skeleton running={running} state={controller.state} busy={controller.busy} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function Skeleton({
  running,
  state,
  busy,
}: {
  running: boolean
  state: string
  busy: boolean
}) {
  const text = running
    ? '正在生成…生成通过验证后这里会显示页面。切到文件 tab 可以看代码。'
    : busy
      ? '正在启动容器（冷启动 1~5 秒）…'
      : state === 'none'
        ? '这个项目还没有构建成功过'
        : '正在准备预览…'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="w-full max-w-md space-y-2">
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        <div className="h-24 w-full animate-pulse rounded bg-muted/60" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
      <p className="text-xs text-muted-foreground/70">{text}</p>
    </div>
  )
}

/** 文件 tab：读内容 → 编辑 → 保存（生成中被后端 409 挡住，和 C3 一致） */
function FileTab({
  projectId,
  path,
  running,
  onNotice,
  onOpenDiff,
}: {
  projectId: string
  path: string
  running: boolean
  onNotice: (msg: string) => void
  onOpenDiff: (path: string) => void
}) {
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [exists, setExists] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void readFile(projectId, path)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setDraft(r.content)
        setExists(true)
      })
      .catch((e) => {
        if (cancelled) return
        setExists(false)
        onNotice(`读不了这个文件：${(e as Error).message}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, path, onNotice])

  const dirty = draft !== content

  const save = async () => {
    if (!dirty) return
    try {
      await writeFile(projectId, path, draft)
      setContent(draft)
      onNotice(`已保存 ${path}`)
    } catch (e) {
      const err = e as ApiError
      onNotice(err.status === 409 ? err.message : `保存失败：${err.message}`)
      if (err.status === 409) setDraft(content)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {path}
        </span>
        {dirty ? <span className="text-[11px] text-warning">未保存</span> : null}
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground/70"
          onClick={() => onOpenDiff(path)}
        >
          <GitCompareArrowsIcon />
          本轮改动
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="outline"
                size="xs"
                onClick={() => void save()}
                disabled={running || !dirty}
              >
                保存
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {running ? '正在生成中，等这一轮跑完再改（后端也会返回 409）' : '保存（Ctrl/Cmd+S）'}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <p className="mt-8 text-center text-xs text-muted-foreground/70">读取中…</p>
        ) : !exists ? (
          <p className="mt-8 text-center text-xs text-destructive">读不到这个文件</p>
        ) : (
          <CodeEditor
            value={draft}
            path={path}
            readOnly={running}
            onChange={setDraft}
            onSave={() => void save()}
          />
        )}
      </div>
    </div>
  )
}

/** diff tab：单个文件的本轮改动 */
function DiffTab({ projectId, path }: { projectId: string; path: string }) {
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getDiff(projectId)
      .then((files) => {
        const hit = files.find((f) => f.path === path)
        if (hit) setDiff(hit)
        else setError('这一轮没有改动这个文件')
      })
      .catch((e) => setError((e as Error).message))
  }, [projectId, path])

  const stats = useMemo(() => {
    if (!diff?.before) return null
    const a = diff.before.split('\n')
    const b = diff.after.split('\n')
    let changed = 0
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed++
    return changed
  }, [diff])

  if (error) {
    return <p className="mt-8 text-center text-xs text-muted-foreground/70">{error}</p>
  }
  if (!diff) {
    return <p className="mt-8 text-center text-xs text-muted-foreground/70">读取中…</p>
  }
  if (diff.status === 'modified' && diff.before === null) {
    return (
      <p className="p-4 text-xs leading-relaxed text-muted-foreground">
        这个文件改动前的内容读不出来（二进制或超过读取上限），没法算 diff。
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <Badge variant={diff.status === 'added' ? 'success' : 'warning'}>
          {diff.status === 'added' ? '新增' : '修改'}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {path}
        </span>
        {stats !== null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/60">{stats} 行不同</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <DiffView original={diff.before ?? ''} modified={diff.after} path={path} />
      </div>
    </div>
  )
}
