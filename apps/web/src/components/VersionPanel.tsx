import { useCallback, useEffect, useState } from 'react'
import {
  CheckIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  Loader2Icon,
  RocketIcon,
  Undo2Icon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  activateDeployment,
  ApiError,
  createSnapshot,
  deploy,
  getDeployments,
  listSnapshots,
  rollbackWorkspace,
  updateSlug,
} from '@/api/client'
import type { Deployment, Snapshot } from '@/api/types'
import { relativeTime } from '@/lib/format'

/**
 * 版本与发布（§9 顶栏那颗"版本时间线 + 发布按钮"）。
 *
 * 两个「回滚」在这里是**两个不同的按钮**，别合并：
 *  - 「检出到工作区」= 我要从这个版本继续改（动的是编辑工作区）
 *  - 「切回线上」= 让用户看到这个版本（动的是线上指向，工作区一动不动）
 * 混成一个的话，用户点"回滚"之后不知道自己的改动去哪了。
 */
export function VersionPanel({
  projectId,
  slug,
  projectKind,
  running,
  open,
  onOpenChange,
  onChanged,
}: {
  projectId: string
  slug: string
  projectKind: 'static' | 'service'
  running: boolean
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 发布/改 slug 之后让外层刷新项目数据 */
  onChanged: () => void
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [active, setActive] = useState<Deployment | null>(null)
  const [liveUrl, setLiveUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [slugDraft, setSlugDraft] = useState(slug)

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([listSnapshots(projectId), getDeployments(projectId)])
      setSnapshots(s)
      setDeployments(d.deployments)
      setActive(d.active)
      setLiveUrl(d.liveUrl)
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message })
    }
  }, [projectId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => setSlugDraft(slug), [slug])

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    setNotice(null)
    try {
      setNotice({ kind: 'ok', text: await fn() })
      await load()
      onChanged()
    } catch (e) {
      const err = e as ApiError
      setNotice({
        kind: 'err',
        // 502 带 logs 的（生产容器起不来）要把原因带出来 —— 只显示"发布失败"等于没说
        text: err.logs ? `${err.message}\n\n${err.logs.slice(-1200)}` : err.message,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>版本与发布</DialogTitle>
          <DialogDescription>
            每次构建通过会自动打一个快照（auto）。发布是**显式**动作，改了不会自动上线。
          </DialogDescription>
        </DialogHeader>

        {/* ---------------- 线上状态 ---------------- */}
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">线上</span>
            {active ? (
              <>
                <Badge variant="success">v{active.version}</Badge>
                <Button asChild variant="outline" size="xs" className="font-mono">
                  <a href={liveUrl} target="_blank" rel="noreferrer">
                    {liveUrl}
                    <ExternalLinkIcon className="opacity-60" />
                  </a>
                </Button>
              </>
            ) : (
              <Badge variant="secondary">还没发布过</Badge>
            )}
            <Button
              className="ml-auto"
              size="sm"
              disabled={running || busy !== null || snapshots.length === 0}
              onClick={() =>
                void run('deploy', async () => {
                  const r = await deploy(projectId)
                  return `已发布 v${r.version} → ${r.url}`
                })
              }
            >
              {busy === 'deploy' ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
              {active ? '再发一版' : '发布'}
            </Button>
          </div>

          {/* slug 编辑：线上地址就是 <slug>.site.<域名>，所以这等于给站点改名 */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Label htmlFor="slug-input" className="text-muted-foreground">
              地址前缀
            </Label>
            <input
              id="slug-input"
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              disabled={busy !== null}
              className="w-52 rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="my-site"
            />
            <span className="font-mono text-[11px] text-muted-foreground/60">.site.localhost</span>
            <Button
              variant="outline"
              size="xs"
              disabled={busy !== null || slugDraft === slug}
              onClick={() =>
                void run('slug', async () => {
                  const r = await updateSlug(projectId, slugDraft)
                  return r.note ?? `地址已改为 ${r.url}`
                })
              }
            >
              改地址
            </Button>
          </div>
        </div>

        {notice ? (
          <pre
            className={cn(
              'max-h-40 overflow-auto rounded-md border px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap',
              notice.kind === 'ok'
                ? 'border-success/30 bg-success/5 text-success'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
          >
            {notice.text}
          </pre>
        ) : null}

        <Separator />

        {/* ---------------- 版本时间线 ---------------- */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">版本时间线</span>
          <Button
            variant="outline"
            size="xs"
            disabled={running || busy !== null}
            onClick={() =>
              void run('snap', async () => {
                const r = await createSnapshot(projectId, '手动快照')
                return r.committed ? `已打快照 ${r.snapshot?.seq}` : '没有改动，不需要新版本'
              })
            }
          >
            <GitCommitHorizontalIcon />
            现在打一个
          </Button>
        </div>

        {snapshots.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground/70">
            还没有版本。让 agent 跑一轮生成，构建通过会自动打快照。
          </p>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="space-y-1.5 pr-2">
              {snapshots.map((s) => {
                const published = deployments.find((d) => d.snapshotId === s.id)
                const isActive = active?.snapshotId === s.id
                return (
                  <li
                    key={s.id}
                    className={cn(
                      'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2',
                      isActive ? 'border-success/40 bg-success/5' : 'bg-background',
                    )}
                  >
                    <Badge variant={isActive ? 'success' : 'secondary'} className="shrink-0">
                      v{s.seq}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-xs" title={s.label}>
                      {s.label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
                      {s.createdBy === 'auto' ? '自动' : '手动'} · {relativeTime(s.createdAt)}
                    </span>

                    {isActive ? (
                      <Badge variant="success" className="shrink-0 gap-1">
                        <CheckIcon /> 线上
                      </Badge>
                    ) : published ? (
                      <Button
                        variant="outline"
                        size="xs"
                        className="shrink-0"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`act-${s.seq}`, async () => {
                            await activateDeployment(projectId, published.version)
                            return `线上已切回 v${published.version}`
                          })
                        }
                      >
                        <Undo2Icon />
                        切回线上
                      </Button>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            <Button
                              variant="outline"
                              size="xs"
                              className="shrink-0"
                              disabled={
                                busy !== null ||
                                // 静态的产物就是工作区里现在这份，发旧版本会"记成旧版本号、发的却是新产物"
                                (projectKind === 'static' && s.seq !== snapshots[0]!.seq)
                              }
                              onClick={() =>
                                void run(`dep-${s.seq}`, async () => {
                                  const r = await deploy(projectId, s.id)
                                  return `已发布 v${r.version} → ${r.url}`
                                })
                              }
                            >
                              <RocketIcon />
                              发布这版
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {projectKind === 'static' && s.seq !== snapshots[0]!.seq
                            ? '静态项目只能发布当前这一版（产物就是工作区现在这份）。要退回去用「切回线上」。'
                            : '把这个版本发到线上'}
                        </TooltipContent>
                      </Tooltip>
                    )}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            variant="ghost"
                            size="xs"
                            className="shrink-0 text-muted-foreground/70"
                            disabled={running || busy !== null}
                            onClick={() =>
                              void run(`co-${s.seq}`, async () => {
                                await rollbackWorkspace(projectId, s.id)
                                return `工作区已退到 v${s.seq}（线上没动）`
                              })
                            }
                          >
                            <Undo2Icon />
                            检出
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>把工作区退回这个版本，接着改。不影响线上。</TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
