import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLinkIcon, ImageOffIcon, Trash2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProjectListItem } from '../hooks/useProjects.ts'
import { relativeTime } from '../lib/format.ts'

/** 缩略图按桌面宽度渲染再整体缩放，不然移动端断点会把页面排成一条竖线 */
const VIEWPORT_W = 1280
const VIEWPORT_H = 738
const FALLBACK_W = 280

/**
 * 项目卡片。
 *
 * 缩略图是**实时小 iframe**（§9 要的"缩略图"，但没有截图接口）：
 * 把预览页按桌面宽度渲染再整体缩放，`pointer-events: none` 防误点，
 * `loading="lazy"` 让首屏之外的卡片不加载。零基础设施，和预览栏同一套机制。
 *
 * 缩放比例**要实测容器宽度**（ResizeObserver）：卡片宽度由网格自适应，
 * 写死比例的话缩略图只会占左边一块、右边留一条黑边。
 *
 * 沙箱没在跑（stopped/cold）就退回占位块 —— **不要**让 iframe 去撞一个 404，
 * 那样卡片会闪一下 Traefik 的错误页，比占位块难看多了。
 */
export function ProjectCard({
  project,
  thumb,
  onDelete,
}: {
  project: ProjectListItem
  /** false 时不渲染活 iframe（首页卡片多的时候只给前几张） */
  thumb: boolean
  onDelete: (id: string) => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(FALLBACK_W)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width
      if (w && w > 0) setBoxW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const live = thumb && project.instance?.state === 'running' && project.instance.sandboxId !== null
  const scale = boxW / VIEWPORT_W

  return (
    <div className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <div
        ref={boxRef}
        className="relative overflow-hidden border-b bg-muted/30"
        style={{ width: '100%', height: Math.round(VIEWPORT_H * scale) }}
      >
        {live ? (
          <iframe
            src={project.previewUrl}
            title={`${project.name} 缩略`}
            loading="lazy"
            scrolling="no"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
            style={{ width: VIEWPORT_W, height: VIEWPORT_H, transform: `scale(${scale})` }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground/50">
            <ImageOffIcon className="size-5" />
            <span className="text-[11px]">沙箱未运行</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/p/${project.id}`}
            className="min-w-0 truncate text-sm font-medium transition-colors hover:text-primary"
            title={project.name}
          >
            {project.name}
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>删除项目</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Badge variant="secondary">{project.template}</Badge>
          <span className="min-w-0 truncate" title={project.updatedAt}>
            {relativeTime(project.updatedAt)}
          </span>
        </div>

        {/* 地址是卡片上最常点的东西，给它一整行，别和元信息挤在一起 */}
        <a
          href={project.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-auto flex items-center gap-1 truncate rounded-md border border-transparent px-1.5 py-1 font-mono text-[11px] text-primary transition-colors hover:border-border hover:bg-accent"
          title={`打开 ${project.previewUrl}`}
        >
          <ExternalLinkIcon className="size-3 shrink-0 opacity-60" />
          <span className="min-w-0 truncate">{project.previewUrl}</span>
        </a>
      </div>

      {/* 删除是不可逆的（工作区会进回收目录、DB 行直接删），所以要二次确认 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除「{project.name}」？</DialogTitle>
            <DialogDescription>
              容器、Traefik 路由和数据库记录都会回收，工作区会移进回收目录。
              这个动作在界面上没法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmOpen(false)
                onDelete(project.id)
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
