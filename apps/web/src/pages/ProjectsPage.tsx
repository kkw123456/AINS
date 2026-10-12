import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, SearchIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AppShell } from '@/components/app-nav.tsx'
import { ProjectCard } from '@/components/ProjectCard.tsx'
import { useProjects } from '../hooks/useProjects.ts'

type Sort = 'updated' | 'created' | 'name'

/**
 * 项目管理。
 *
 * 从首页搬过来的：首页那次改版只留了创建框，项目列表归这儿。
 * 卡片本身还是首页原来那个（带实时迷你缩略图），这里补上找东西的能力 ——
 * 项目一多，光靠"最近改动"排是不够的。
 */
export function ProjectsPage() {
  const { projects, error, loading, remove } = useProjects()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('updated')

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = needle
      ? projects.filter((p) =>
          [p.name, p.template, p.slug, p.id].some((s) => s.toLowerCase().includes(needle)),
        )
      : projects

    const sorted = [...filtered]
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh')
      if (sort === 'created') return b.createdAt.localeCompare(a.createdAt)
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    return sorted
  }, [projects, q, sort])

  return (
    <AppShell>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-semibold">项目</h1>
          <Badge variant="secondary">{projects.length}</Badge>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜名字 / 模板 / 地址"
                className="w-56 pl-7 text-xs"
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">最近改动</SelectItem>
                <SelectItem value="created">创建时间</SelectItem>
                <SelectItem value="name">名称</SelectItem>
              </SelectContent>
            </Select>
            <Button asChild size="sm">
              <Link to="/">
                <PlusIcon />
                新建
              </Link>
            </Button>
          </div>
        </header>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="overflow-hidden rounded-xl border bg-card">
                <div className="aspect-[1280/738] animate-pulse bg-muted/40" />
                <div className="space-y-2 p-3">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
                </div>
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {projects.length === 0 ? '还没有项目' : '没有匹配的项目'}
            </p>
            {projects.length === 0 ? (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link to="/">去建一个</Link>
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] items-stretch gap-4">
            {/* 缩略图是活的 iframe，卡片一多就是一堆并发渲染 —— 只给前 8 张开 */}
            {shown.map((p, i) => (
              <ProjectCard key={p.id} project={p} thumb={i < 8} onDelete={remove} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
