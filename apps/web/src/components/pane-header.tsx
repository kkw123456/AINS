import type { ReactNode } from 'react'

/** 三栏统一的栏头：左边标题，右边放该栏自己的工具。 */
export function PaneHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b bg-card px-2.5">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {children}
    </div>
  )
}
