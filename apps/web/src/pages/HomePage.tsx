import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleAlertIcon, ServerIcon, SparklesIcon, WandSparklesIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AppShell } from '@/components/app-nav.tsx'
import { StackComposer, ComposerNote } from '@/components/stack-composer.tsx'
import { StackPicker } from '@/components/stack-picker.tsx'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DEFAULT_COMPOSED_STACK, PRESETS, defaultStack, groupStacks } from '@/lib/stacks'
import type { Stack } from '@webgen/shared'
import { useProjects } from '../hooks/useProjects.ts'

const DEFAULT_PROMPT =
  '做一个个人主页：标题写「你好，webgen」，下面列出三个技能，右下角显示当前时间（每秒刷新）。只用原生 HTML/CSS/JS，别引入依赖。'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * 首页 = **只有创建框**。
 *
 * 项目列表搬到「项目」页了 —— 首页的职责只有一个：让你尽快把一句话变成项目。
 * 列表放这儿会让首屏变成"管理界面"，而这页每次打开都是为了新建。
 */
export function HomePage() {
  const nav = useNavigate()
  const { templates, nodes, error, creating, create } = useProjects()

  const [prompt, setPrompt] = useState('')
  const [template, setTemplate] = useState('')
  // ★ 两种建法二选一：按**组合**（三段各选一个，镜像按组合当场生成）或按**模板**（一个模板一整套）。
  //   默认组合 —— 它是这个平台真正想让你用的那条路（§0：组合是动态的，不可能预建镜像）。
  const [mode, setMode] = useState<'stack' | 'template'>('stack')
  const [stack, setStack] = useState<Stack>(DEFAULT_COMPOSED_STACK)
  const [localError, setLocalError] = useState<string | null>(null)

  // 模板列表回来后挑默认值。**优先推荐项**（node-web）：列表按名字排序，
  // 直接取第一个会落到 `broken-fixture` 上 —— 那是 smoke-repair 用的故意坏掉的测试件。
  const groups = useMemo(() => groupStacks(templates), [templates])
  useEffect(() => {
    if (template) return
    const d = defaultStack(groups)
    if (d) setTemplate(d)
  }, [groups, template])

  const online = nodes.filter((n) => n.online)
  const canSubmit = online.length > 0 && !creating && (mode === 'stack' || Boolean(template))

  const submit = async () => {
    setLocalError(null)
    if (mode === 'template' && !template) {
      setLocalError('先选一个模板')
      return
    }
    const id = await create({
      ...(mode === 'stack' ? { stack } : { template }),
      prompt: prompt.trim() || undefined,
    })
    // 带 prompt 时后端是 fire-and-forget 起生成，所以直接进工作台让流去接
    if (id) nav(`/p/${id}`)
  }

  return (
    <AppShell>
      <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
        {/* 柔光：给纯深色页面一点纵深，不引图片资源 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,--theme(--color-primary)/10%,transparent)]"
        />

        <header className="relative flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">说一句话，建一个能跑的站</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              生成过程在浏览器里实时可见，通过验证后可以一键发布到线上地址。
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={online.length ? 'success' : 'destructive'} className="shrink-0">
                <ServerIcon className="size-3" />
                {online.length ? `${online.length} 个节点在线` : '没有节点在线'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {online.length
                ? online.map((n) => `${n.nodeId}·${n.sandboxes ?? 0}/${n.capacity ?? 0}`).join('，')
                : '没有 executor 在线，建项目会失败'}
            </TooltipContent>
          </Tooltip>
        </header>

        <section className="relative rounded-xl border bg-card shadow-sm transition-colors focus-within:border-primary/50">
          <div className="flex items-center gap-2 px-4 pt-3">
            <WandSparklesIcon className="size-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">描述你想要的应用</span>
          </div>

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={DEFAULT_PROMPT}
            className="min-h-0 resize-none border-0 bg-transparent px-4 py-2 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
          />

          <Separator />

          <div className="space-y-3 px-4 py-3">
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'stack' | 'template')}>
              <TabsList className="h-7">
                <TabsTrigger value="stack" className="h-5 px-2 text-[11px]">
                  按技术栈
                </TabsTrigger>
                <TabsTrigger value="template" className="h-5 px-2 text-[11px]">
                  按模板
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'stack' ? (
              <>
                {/* 快捷预设（S4）：老模板收敛成了"前端=纯静态页 + 某后端"的组合，点一下填进选择器 */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">快捷预设</span>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        disabled={creating}
                        onClick={() => setStack(p.stack)}
                        title={p.blurb}
                        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <StackComposer value={stack} onChange={setStack} disabled={creating} />
                <ComposerNote value={stack} />
              </>
            ) : (
              <StackPicker
                groups={groups}
                value={template}
                onChange={setTemplate}
                disabled={creating}
              />
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-[11px] text-muted-foreground/70">
                描述留空就用占位那句 · {isMac ? '⌘' : 'Ctrl'}+↵ 直接生成
              </span>
              <Button className="ml-auto" size="sm" onClick={() => void submit()} disabled={!canSubmit}>
                <SparklesIcon />
                {creating ? '创建中…' : '生成'}
              </Button>
            </div>
          </div>
        </section>

        {localError || error ? (
          // §0 决策 13：超限/失败必须**显式**说明原因，不静默降级。
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="text-xs leading-relaxed text-destructive">{localError ?? error}</span>
          </div>
        ) : null}
      </div>
    </AppShell>
  )
}
