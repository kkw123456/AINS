import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CircleAlertIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatPane } from '../components/ChatPane.tsx'
import { CenterPane, type CenterTab } from '../components/CenterPane.tsx'
import { FilesPane } from '../components/FilesPane.tsx'
import { Split } from '../components/Split.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { useAgentRun } from '../hooks/useAgentRun.ts'
import { usePreview } from '../hooks/usePreview.ts'
import { useProject } from '../hooks/useProject.ts'
import { touchedPaths } from '../lib/blocks.ts'

const PREVIEW_TAB: CenterTab = { kind: 'preview', key: 'preview' }

export function WorkbenchPage() {
  const { id } = useParams<{ id: string }>()
  const { data, error, loading, reload } = useProject(id)
  const run = useAgentRun(id)
  const preview = usePreview(id, run.running, Boolean(data))
  const [notice, setNotice] = useState<string | null>(null)

  /*
   * 中间面板的 tab 状态放在这一层：左边文件树点一下要在中间开 tab，
   * 两个栏都得读到它，所以只能由它们的共同祖先持有。
   */
  const [tabs, setTabs] = useState<CenterTab[]>([PREVIEW_TAB])
  const [activeKey, setActiveKey] = useState('preview')

  const touched = useMemo(() => touchedPaths(run.events), [run.events])

  const openTab = useCallback((tab: CenterTab) => {
    setTabs((prev) => (prev.some((t) => t.key === tab.key) ? prev : [...prev, tab]))
    setActiveKey(tab.key)
  }, [])

  const openFile = useCallback(
    (path: string) => openTab({ kind: 'file', key: `file:${path}`, path }),
    [openTab],
  )
  const openDiff = useCallback(
    (path: string) => openTab({ kind: 'diff', key: `diff:${path}`, path }),
    [openTab],
  )

  const closeTab = useCallback(
    (key: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.key !== key)
        // 关掉当前这个就落到左边那个上（没有就回预览）—— 和编辑器的习惯一致
        if (key === activeKey) {
          const idx = prev.findIndex((t) => t.key === key)
          setActiveKey((next[idx - 1] ?? next[0] ?? PREVIEW_TAB).key)
        }
        return next.length > 0 ? next : [PREVIEW_TAB]
      })
    },
    [activeKey],
  )

  // 项目被换掉/删掉时把 tab 清回预览，别留着上个项目的文件 tab
  useEffect(() => {
    setTabs([PREVIEW_TAB])
    setActiveKey('preview')
  }, [id])

  // 提示条自己消失，不堆在屏幕上
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // 流里报的错和接口报的错都要能看见
  const banner = run.error ?? error

  const activeTab = tabs.find((t) => t.key === activeKey)
  const activePath = activeTab && 'path' in activeTab ? activeTab.path : null

  if (loading && !data) {
    return <Centered>加载项目…</Centered>
  }
  if (!data) {
    return (
      <Centered>
        <div className="space-y-2 text-center">
          <p className="text-sm text-destructive">{error ?? '项目不存在'}</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/projects">← 项目列表</Link>
          </Button>
        </div>
      </Centered>
    )
  }

  const artifactDir = data.spec?.artifactDir

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        project={data.project}
        previewUrl={data.previewUrl}
        live={data.live}
        liveUrl={data.liveUrl}
        running={run.running}
        connection={run.connection}
        onChanged={() => void reload()}
      />

      {banner ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5">
          <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
          <span className="text-xs text-destructive">{banner}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6 text-muted-foreground"
            onClick={run.clearError}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {/*
        ★ 栏位与 DESIGN §9 原稿**故意不同**（§9 写的是「左｜对话 中｜预览 右｜代码」）：
        实际是**文件（左）· 中间 tab 区（预览 / 文件 / diff）· 对话（右）**。
        编辑器从左边搬到了中间做成 tab —— 中间最宽，给代码正合适。
        别再"照着文档改回去"。
      */}
      <Split
        left={
          <FilesPane
            projectId={data.project.id}
            artifactDir={artifactDir}
            template={data.project.template}
            running={run.running}
            touched={touched}
            activePath={activePath}
            onOpenFile={openFile}
            onOpenDiff={openDiff}
          />
        }
        center={
          <CenterPane
            projectId={data.project.id}
            tabs={tabs}
            activeKey={activeKey}
            onActivate={setActiveKey}
            onClose={closeTab}
            onOpenDiff={openDiff}
            preview={preview}
            running={run.running}
            previewUrl={data.previewUrl}
            onNotice={setNotice}
          />
        }
        right={
          <ChatPane
            messages={run.messages}
            events={run.events}
            running={run.running}
            sending={run.sending}
            disabled={run.running || run.sending}
            onSend={(t) => void run.send(t)}
          />
        }
      />

      {notice ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg">
          {notice}
        </div>
      ) : null}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
