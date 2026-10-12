import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLinkIcon, GitBranchIcon, GlobeIcon, RocketIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/theme-toggle'
import { VersionPanel } from '@/components/VersionPanel.tsx'
import type { ProjectRow } from '../api/types.ts'
import type { Connection } from '../hooks/useAgentRun.ts'

/**
 * 工作台顶栏。
 *
 * §9 要求顶栏放「版本时间线 + 发布按钮 + 在线地址」。三样都收在「版本与发布」那一个入口里 ——
 * 它们本来就是同一件事的三个面（看有哪些版本 / 决定发哪一版 / 看线上是哪一版），
 * 摊成三个按钮只会让顶栏变挤。
 */
export function TopBar({
  project,
  previewUrl,
  live,
  liveUrl,
  running,
  connection,
  onChanged,
}: {
  project: ProjectRow
  previewUrl: string
  live: { version: number; url: string; kind: 'static' | 'service' } | null
  liveUrl: string
  running: boolean
  connection: Connection
  onChanged: () => void
}) {
  const [panelOpen, setPanelOpen] = useState(false)

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-3">
      <Button asChild variant="ghost" size="xs" className="text-muted-foreground">
        {/* 回项目列表，不是回首页 —— 首页现在只是创建框，从工作台回去没有意义 */}
        <Link to="/projects">← 项目</Link>
      </Button>

      <Separator orientation="vertical" className="h-5" />

      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{project.name}</span>
        <Badge variant="secondary">{project.template}</Badge>
        <Badge variant="outline">{project.kind === 'service' ? '服务型' : '静态'}</Badge>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ConnectionDot connection={connection} running={running} />

        {/* 预览地址（给人看的那份，永远在 p-<id>） */}
        <Button asChild variant="outline" size="xs" className="max-w-[220px] font-mono">
          <a href={previewUrl} target="_blank" rel="noreferrer" title={`预览：${previewUrl}`}>
            <span className="min-w-0 truncate">{previewUrl}</span>
            <ExternalLinkIcon className="opacity-60" />
          </a>
        </Button>

        {/* 线上地址：只有发布过才显示，和预览是**两个不同的东西**，不能混成一个入口 */}
        {live ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="outline" size="xs" className="max-w-[220px] font-mono">
                <a href={live.url} target="_blank" rel="noreferrer">
                  <GlobeIcon className="text-success" />
                  <span className="min-w-0 truncate">{live.url}</span>
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>线上 v{live.version}（已发布）</TooltipContent>
          </Tooltip>
        ) : null}

        <Button
          variant={live ? 'outline' : 'default'}
          size="xs"
          onClick={() => setPanelOpen(true)}
          title={liveUrl}
        >
          {live ? <GitBranchIcon /> : <RocketIcon />}
          {live ? `版本 v${live.version}` : '版本与发布'}
        </Button>

        <ThemeToggle />
      </div>

      <VersionPanel
        projectId={project.id}
        slug={project.slug}
        projectKind={project.kind}
        running={running}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        onChanged={onChanged}
      />
    </header>
  )
}

function ConnectionDot({ connection, running }: { connection: Connection; running: boolean }) {
  const [color, text] =
    connection === 'open'
      ? running
        ? ['bg-primary', '生成中']
        : ['bg-success', '空闲']
      : connection === 'connecting'
        ? ['bg-warning', '连接中']
        : ['bg-destructive', '已断开']

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${color}`} />
          <span className="text-xs text-muted-foreground">{text}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>事件流状态：{connection}</TooltipContent>
    </Tooltip>
  )
}
