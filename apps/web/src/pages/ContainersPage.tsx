import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BoxesIcon, HardDriveIcon, RefreshCwIcon, ServerIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AppShell } from '@/components/app-nav.tsx'
import { listContainers } from '@/api/client'
import type { ContainerItem, NodeRow } from '@/api/types'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/format'

const ROLE_LABEL: Record<string, { text: string; hint: string }> = {
  edit: { text: '编辑', hint: 'agent 在里面折腾。按需开、闲时停，可随时重建。' },
  preview: { text: '预览', hint: '给人看的那份。' },
  // 只有**静态**项目会走到这条：服务型的生产容器由下面那类列全，
  // 静态没有容器，所以这条记录就是"线上指向第几版"的唯一表示。
  production: {
    text: '生产',
    hint: '静态项目的线上指向（一个软链，没有容器）。',
  },
  'production-container': {
    text: '生产',
    hint: '常驻容器，不参与闲置回收。发布新版时旧的会被停掉但保留，供回滚。',
  },
}

/**
 * 容器管理。
 *
 * 这里列的是**容器**不是项目 —— 一个服务型项目可能同时有编辑沙箱 + 预览沙箱 +
 * 生产容器（current + 上一个）。静态项目在运行侧**没有专属容器**，
 * 所以它只会出现编辑/预览两行，且 `servedBy` 会说明是静态伺服在承担。
 */
export function ContainersPage() {
  const [containers, setContainers] = useState<ContainerItem[]>([])
  const [nodes, setNodes] = useState<NodeRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [onlyRunning, setOnlyRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listContainers()
      setContainers(r.containers)
      setNodes(r.nodes)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = onlyRunning ? containers.filter((c) => c.state === 'running') : containers
  const running = containers.filter((c) => c.state === 'running').length

  return (
    <AppShell>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-semibold">容器</h1>
          <Badge variant="secondary">
            {running} 在跑 / 共 {containers.length}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant={onlyRunning ? 'secondary' : 'outline'}
              size="xs"
              onClick={() => setOnlyRunning((v) => !v)}
            >
              只看在跑的
            </Button>
            <Button variant="outline" size="xs" onClick={() => void load()} disabled={loading}>
              <RefreshCwIcon className={cn(loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </header>

        {/* 节点一行一个：容量和磁盘是"还能不能再建"的直接答案 */}
        <div className="flex flex-wrap gap-2">
          {nodes.map((n) => (
            <div
              key={n.nodeId}
              className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
            >
              <span
                className={cn('size-1.5 rounded-full', n.online ? 'bg-success' : 'bg-destructive')}
              />
              <span className="font-medium">{n.nodeId}</span>
              <span className="text-muted-foreground">
                <ServerIcon className="mr-1 inline size-3" />
                {n.sandboxes ?? '?'}/{n.capacity ?? '?'}
              </span>
              {n.diskFreeMb != null ? (
                <span className="text-muted-foreground/70">
                  <HardDriveIcon className="mr-1 inline size-3" />
                  {(n.diskFreeMb / 1024).toFixed(0)} GB
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {loading && containers.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground/70">加载中…</p>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-16 text-center">
            <BoxesIcon className="mx-auto size-6 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">没有容器</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <ScrollArea className="max-h-[65vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">项目</th>
                    <th className="px-3 py-2 font-medium">角色</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">版本</th>
                    <th className="px-3 py-2 font-medium">容器 / 沙箱</th>
                    <th className="px-3 py-2 font-medium">最近使用</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.key} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="px-3 py-2">
                        <Link
                          to={`/p/${c.projectId}`}
                          className="font-medium hover:text-primary"
                          title={`${c.projectName}（${c.template}）`}
                        >
                          {c.projectName}
                        </Link>
                        <div className="font-mono text-[10px] text-muted-foreground/60">
                          {c.slug}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Badge
                                variant={
                                  c.role === 'production' || c.role === 'production-container'
                                    ? 'success'
                                    : c.role === 'preview'
                                      ? 'warning'
                                      : 'secondary'
                                }
                              >
                                {ROLE_LABEL[c.role]?.text ?? c.role}
                              </Badge>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{ROLE_LABEL[c.role]?.hint}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'font-mono',
                            c.state === 'running' ? 'text-success' : 'text-muted-foreground',
                          )}
                        >
                          {c.state}
                        </span>
                        <div className="text-[10px] text-muted-foreground/50">{c.servedBy}</div>
                      </td>
                      <td className="px-3 py-2 font-mono">v{c.version}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
                        {c.containerName ?? c.sandboxId ?? (c.kind === 'static' ? '—' : '—')}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground/70">
                        {c.lastUsedAt ? relativeTime(c.lastUsedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}
      </div>
    </AppShell>
  )
}
