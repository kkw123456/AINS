import { useCallback, useEffect, useMemo, useState } from 'react'
import { DownloadIcon, FilePlus2Icon, GitCompareArrowsIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PaneHeader } from './pane-header.tsx'
import { FileTree } from './FileTree.tsx'
import { exportUrl, getDiff, listFiles } from '../api/client.ts'
import type { FileDiff, FileEntry } from '../api/types.ts'

type Root = 'source' | 'artifact'
type View = 'tree' | 'diff'

/**
 * 左栏：文件树 + 本轮改动列表。
 *
 * **编辑器不在这里了** —— 它搬到中间面板做成 tab 了（见 CenterPane）。
 * 左边要放树又要放编辑器的话，两样都窄得没法用；而中间本来最宽，给代码正合适。
 * 这一栏现在只负责"找东西"，不负责"看东西"。
 */
export function FilesPane({
  projectId,
  artifactDir,
  template,
  running,
  touched,
  activePath,
  onOpenFile,
  onOpenDiff,
}: {
  projectId: string
  artifactDir: string | undefined
  template: string
  running: boolean
  touched: Set<string>
  /** 中间当前激活的文件，用来在树里高亮 */
  activePath: string | null
  onOpenFile: (path: string) => void
  onOpenDiff: (path: string) => void
}) {
  const [root, setRoot] = useState<Root>('source')
  const [view, setView] = useState<View>('tree')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [error, setError] = useState<string | null>(null)

  const rootDir = root === 'artifact' ? (artifactDir ?? '') : ''

  const loadTree = useCallback(async () => {
    try {
      setFiles(await listFiles(projectId, rootDir))
      setError(null)
    } catch (e) {
      setFiles([])
      setError((e as Error).message)
    }
  }, [projectId, rootDir])

  const loadDiffs = useCallback(async () => {
    try {
      setDiffs(await getDiff(projectId))
    } catch {
      setDiffs([])
    }
  }, [projectId])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  // 每轮生成结束后刷新（agent 可能新建、也可能删了文件）
  useEffect(() => {
    if (running) return
    void loadTree()
    void loadDiffs()
  }, [running, loadTree, loadDiffs])

  const changed = useMemo(() => new Set(diffs.map((d) => d.path)), [diffs])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <PaneHeader title="文件">
        <div className="flex items-center gap-1.5">
          <Tabs value={root} onValueChange={(v) => setRoot(v as Root)}>
            <TabsList>
              <TabsTrigger value="source">源码</TabsTrigger>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn(!artifactDir && 'cursor-not-allowed')}>
                    <TabsTrigger value="artifact" disabled={!artifactDir}>
                      产物
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {artifactDir
                    ? `产物目录：${artifactDir}`
                    : `模板 ${template} 是服务型，没有产物目录（只有 static 模板才有）`}
                </TooltipContent>
              </Tooltip>
            </TabsList>
          </Tabs>
          <Button asChild variant="outline" size="xs">
            <a
              href={exportUrl(projectId, root === 'artifact' ? 'artifacts' : 'workspace')}
              title="把这个根下的内容打包下载"
            >
              <DownloadIcon />
            </a>
          </Button>
        </div>
      </PaneHeader>

      <div className="flex h-8 shrink-0 items-center border-b px-2">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="tree">
              <FilePlus2Icon />
              文件树
            </TabsTrigger>
            <TabsTrigger value="diff" onClick={() => void loadDiffs()}>
              <GitCompareArrowsIcon />
              本轮改动
              {diffs.length > 0 ? <Badge className="px-1 text-[10px]">{diffs.length}</Badge> : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {error ? (
          <p className="px-3 py-4 text-xs text-destructive">{error}</p>
        ) : view === 'tree' ? (
          <FileTree
            files={files}
            activePath={activePath}
            touched={touched}
            onOpen={onOpenFile}
          />
        ) : diffs.length === 0 ? (
          <p className="mt-6 px-4 text-center text-xs leading-relaxed text-muted-foreground/70">
            这一轮 agent 没有改文件。
            <br />
            <span className="text-[11px]">
              （只统计 write_file / edit_file 的改动；构建产物、lockfile 这类跑命令产生的不算）
            </span>
          </p>
        ) : (
          <ul className="py-1">
            {diffs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => onOpenDiff(d.path)}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-2 py-[3px] text-left text-[11px] transition-colors',
                    activePath === d.path
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                  title={d.path}
                >
                  <Badge
                    variant={d.status === 'added' ? 'success' : 'warning'}
                    className="shrink-0 px-1 text-[10px]"
                  >
                    {d.status === 'added' ? 'A' : 'M'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono">{d.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="shrink-0 border-t px-2 py-1.5 text-[10px] text-muted-foreground/50">
        点文件在中间打开 · 本轮改动 {changed.size} 个
      </div>
    </div>
  )
}
