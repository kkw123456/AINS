import { useMemo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { FileEntry } from '../api/types.ts'
import { formatBytes } from '../lib/format.ts'

/**
 * 文件树。
 *
 * 后端给的是**带 `depth` 的平铺列表**（已排序：目录在前、按 zh 排），
 * 所以这里不用拼树对象 —— 按 `depth` 缩进渲染，折叠某个目录时把
 * `startsWith(dir + '/')` 的后续条目藏起来就够了。
 */
export function FileTree({
  files,
  activePath,
  touched,
  onOpen,
}: {
  files: FileEntry[]
  activePath: string | null
  /** 本轮 agent 动过的文件（从事件里现推的，用来打点） */
  touched: Set<string>
  onOpen: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    if (collapsed.size === 0) return files
    const prefixes = [...collapsed].map((d) => d + '/')
    return files.filter((f) => !prefixes.some((p) => f.path.startsWith(p)))
  }, [files, collapsed])

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (files.length === 0) {
    return <p className="px-3 py-4 text-center text-xs text-muted-foreground/70">这个根下没有文件</p>
  }

  return (
    <ul className="py-1 text-xs">
      {visible.map((f) => {
        const isCollapsed = collapsed.has(f.path)
        const isActive = activePath === f.path
        return (
          <li key={f.path}>
            <button
              type="button"
              disabled={f.skipped}
              onClick={() => (f.dir ? toggle(f.path) : onOpen(f.path))}
              style={{ paddingLeft: 8 + (f.depth - 1) * 12 }}
              className={cn(
                'flex w-full items-center gap-1.5 py-[3px] pr-2 text-left transition-colors',
                isActive
                  ? 'bg-primary/15 text-foreground'
                  : 'text-muted-foreground hover:bg-accent',
                f.skipped && 'cursor-default opacity-50',
              )}
              title={f.path}
            >
              {f.dir ? (
                isCollapsed ? (
                  <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
                ) : (
                  <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                )
              ) : (
                <span className="w-3 shrink-0" />
              )}
              {f.dir ? (
                <FolderIcon className="size-3 shrink-0 opacity-60" />
              ) : (
                <FileIcon className="size-3 shrink-0 opacity-40" />
              )}
              {/* min-w-0：flex 子项默认不肯收缩，没有它 truncate 是摆设（长文件名会撑破文件树） */}
              <span className={cn('min-w-0 truncate', f.dir && 'text-foreground')}>{f.name}</span>

              {f.skipped ? (
                <Badge variant="secondary" className="ml-auto shrink-0 px-1 text-[10px]">
                  已折叠
                </Badge>
              ) : touched.has(f.path) ? (
                // 本轮 agent 改过 —— 点是个即时反馈，不等 /diff 回来
                <span
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                  title="本轮 agent 改过"
                />
              ) : !f.dir ? (
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
                  {formatBytes(f.size)}
                </span>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
