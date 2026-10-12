import { useEffect, useMemo, useState } from 'react'
import { CpuIcon, DatabaseIcon, HardDriveIcon, LayersIcon, MemoryStickIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { AppShell } from '@/components/app-nav.tsx'
import { getTemplateSpec, listTemplates } from '@/api/client'
import type { TemplateItem, TemplateSpec } from '@/api/types'
import { groupStacks, TIERS, type StackOption } from '@/lib/stacks'

/**
 * 模板管理。
 *
 * 模板是**只读**的：它的定义在仓库里的 `templates/<name>/template.json`，
 * 加一个模板 = 加一个目录 + 在 `scripts/build-images.sh` 里加一个镜像。
 * 这里只做"看清它到底是什么"——发包/发布那套一期的边界里没有。
 *
 * 有意展示 `/api/templates` 那份**投影过的**摘要里没有的东西：
 * `artifactDir` / `runCommand` / `buildCommand` / `limits`，
 * 因为它们才是"这个模板怎么跑起来、有几个容器"的答案。
 */
export function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [specs, setSpecs] = useState<Record<string, TemplateSpec | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const list = await listTemplates()
        setTemplates(list)
        const entries = await Promise.all(
          list.map(async (t) => [t.name, await getTemplateSpec(t.name).catch(() => null)] as const),
        )
        setSpecs(Object.fromEntries(entries))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // 复用首页那份分类：模板在界面上是"前端 / 后端 / 数据服务"，不是按语言堆一起
  const groups = useMemo(() => groupStacks(templates), [templates])

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-semibold">模板</h1>
          <Badge variant="secondary">{templates.length}</Badge>
          <span className="text-xs text-muted-foreground">
            模板决定镜像 —— 加一门语言 = 加一个 <code className="font-mono">templates/&lt;name&gt;/</code> 目录
          </span>
        </header>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="py-10 text-center text-xs text-muted-foreground/70">加载中…</p>
        ) : (
          TIERS.map(({ tier, title, hint }) => {
            const items = groups[tier as 'frontend' | 'backend' | 'data']
            return (
              <section key={tier} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-medium">{title}</h2>
                  <span className="text-[11px] text-muted-foreground/60">{hint}</span>
                </div>

                {items.length === 0 ? (
                  <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-3">
                    <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
                    <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                      还没有可建的数据服务，排在 <span className="text-muted-foreground">S4</span>。
                      <br />
                      <span className="text-muted-foreground/50">
                        数据服务不是一种"技术栈"，而是后端模板用 <code className="font-mono">deps</code>{' '}
                        声明的依赖（共享 MySQL、每项目一库 + 独立 role）。
                      </span>
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {items.map((o) => (
                      <TemplateCard key={o.template.name} option={o} spec={specs[o.template.name]} />
                    ))}
                  </div>
                )}
              </section>
            )
          })
        )}

        {/* 测试件不参与三段分类，单独一栏说清楚它是什么 */}
        {groups.fixtures.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-medium">测试件</h2>
              <span className="text-[11px] text-muted-foreground/60">
                不是给用户用的，是验收脚本的夹具
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {groups.fixtures.map((o) => (
                <TemplateCard key={o.template.name} option={o} spec={specs[o.template.name]} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  )
}

function TemplateCard({ option, spec }: { option: StackOption; spec: TemplateSpec | null | undefined }) {
  const { template, meta } = option
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold"
          style={{ color: meta.color, backgroundColor: `color-mix(in oklab, ${meta.color} 18%, transparent)` }}
        >
          {meta.monogram}
        </span>
        <span className="text-sm font-medium">{meta.label}</span>
        <Badge variant="outline" className="ml-auto">
          {template.kind === 'static' ? '静态' : '服务型'}
        </Badge>
        {meta.recommended ? <Badge variant="secondary">推荐</Badge> : null}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">{meta.blurb}</p>

      {spec ? (
        <>
          <Separator />
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[10px]">
            {/*
              ⚠️ 网格子项和 flex 子项一样默认 min-width:auto —— 不加 min-w-0 的话
              `truncate` 不生效，一条长 runCommand 会把卡片撑破（grid 也得写）。
            */}
            <dt className="text-muted-foreground/60">image</dt>
            <dd className="min-w-0 truncate">{spec.image}</dd>
            <dt className="text-muted-foreground/60">port</dt>
            <dd>{spec.port}</dd>
            {spec.buildCommand ? (
              <>
                <dt className="text-muted-foreground/60">build</dt>
                <dd className="min-w-0 truncate" title={spec.buildCommand}>
                  {spec.buildCommand}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground/60">run</dt>
            <dd className="min-w-0 truncate" title={spec.runCommand}>
              {spec.runCommand}
            </dd>
            <dt className="text-muted-foreground/60">artifactDir</dt>
            <dd>{spec.artifactDir ?? <span className="text-muted-foreground/50">—（服务型没有）</span>}</dd>
            <dt className="text-muted-foreground/60">healthPath</dt>
            <dd>{spec.healthPath ?? '—'}</dd>
            <dt className="text-muted-foreground/60">deps</dt>
            <dd>{spec.deps?.length ? spec.deps.join(', ') : '—'}</dd>
          </dl>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
            <span className="flex items-center gap-1">
              <CpuIcon className="size-3" />
              {spec.limits.cpus} CPU
            </span>
            <span className="flex items-center gap-1">
              <MemoryStickIcon className="size-3" />
              {spec.limits.memoryMb} MB
            </span>
            <span className="flex items-center gap-1">
              <HardDriveIcon className="size-3" />
              {spec.limits.diskMb} MB
            </span>
            <span className="flex items-center gap-1">
              <LayersIcon className="size-3" />
              {spec.limits.pids} pids
            </span>
          </div>
        </>
      ) : (
        <p className="text-[10px] text-muted-foreground/50">读不到完整 spec（executor 不在线？）</p>
      )}
    </div>
  )
}
