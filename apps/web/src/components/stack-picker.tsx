import { CheckIcon, DatabaseIcon, SparklesIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { TIERS, type GroupedStacks, type StackOption, type Tier } from '@/lib/stacks'

/**
 * 技术栈选择器。
 *
 * 为什么不用下拉：可选项只有个位数，而且**每个选项都需要解释**
 * （"Spring Boot" 和 "Node.js 服务" 的差别对新人不自明）。下拉里塞不下说明，
 * 展开前也看不见有什么可选 —— 这正是原来那个界面的毛病。
 *
 * 分类是**前端 / 后端 / 数据服务**，不是按语言分组：
 * 用户想的是"我要做个什么形态的东西"，不是"我要用哪门语言"。
 * 语言信息在 chip 的小方块和标签里，不占分类层级。
 */
export function StackPicker({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: GroupedStacks
  value: string
  onChange: (name: string) => void
  disabled?: boolean
}) {
  const all = [...groups.frontend, ...groups.backend, ...groups.data, ...groups.fixtures]
  const active = all.find((o) => o.template.name === value)

  if (all.length === 0) {
    return <p className="text-xs text-muted-foreground/70">没有可用模板（executor 不在线？）</p>
  }

  return (
    <div className="space-y-3">
      {TIERS.map(({ tier, title, hint }) => {
        const items = groups[tier as 'frontend' | 'backend' | 'data']
        return (
          <div key={tier} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
              <span className="text-[10px] text-muted-foreground/50">{hint}</span>
            </div>
            {items.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {items.map((o) => (
                  <StackChip
                    key={o.template.name}
                    option={o}
                    selected={o.template.name === value}
                    disabled={disabled}
                    onSelect={onChange}
                  />
                ))}
              </div>
            ) : (
              <EmptyTier tier={tier} />
            )}
          </div>
        )
      })}

      {/* 测试件不参与三段分类：它是给 smoke-repair 用的，混进"后端"会让人以为能建真项目 */}
      {groups.fixtures.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          <span className="text-[10px] text-muted-foreground/50">测试件</span>
          {groups.fixtures.map((o) => (
            <StackChip
              key={o.template.name}
              option={o}
              selected={o.template.name === value}
              disabled={disabled}
              onSelect={onChange}
              muted
            />
          ))}
        </div>
      ) : null}

      {/* 选中项的说明。放在这儿而不是 hover 提示里 —— 选之前就该看得到。 */}
      {active ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground/80">
          <Badge variant={active.template.kind === 'static' ? 'warning' : 'secondary'}>
            {active.template.kind === 'static' ? '静态' : '服务型'}
          </Badge>
          <span className="font-mono text-muted-foreground/60">{active.template.image}</span>
          <span className="text-muted-foreground/40">·</span>
          <span>{active.meta.blurb}</span>
        </div>
      ) : null}
    </div>
  )
}

function StackChip({
  option,
  selected,
  disabled,
  muted,
  onSelect,
}: {
  option: StackOption
  selected: boolean
  disabled?: boolean
  muted?: boolean
  onSelect: (name: string) => void
}) {
  const { template, meta } = option
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(template.name)}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-all',
        selected
          ? 'border-primary/50 bg-primary/10 text-foreground shadow-xs'
          : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/40 hover:bg-accent',
        muted && !selected && 'opacity-60',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <Monogram text={meta.monogram} color={meta.color} />
      <span className={cn('font-medium', selected && 'text-foreground')}>{meta.label}</span>
      {meta.recommended ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center">
              <SparklesIcon className="size-3 text-primary" />
            </span>
          </TooltipTrigger>
          <TooltipContent>默认推荐：最省事的起点</TooltipContent>
        </Tooltip>
      ) : null}
      {selected ? <CheckIcon className="size-3 text-primary" /> : null}
    </button>
  )
}

/**
 * 数据服务这一段现在是空的，而且是**刻意留的位置**。
 * 不写成"暂无数据"就完事 —— 那看起来像坏了；要说清楚它为什么空、什么时候有。
 */
function EmptyTier({ tier }: { tier: Tier }) {
  if (tier !== 'data') {
    return <p className="text-[11px] text-muted-foreground/50">这一段暂时没有可选项。</p>
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2">
      <DatabaseIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        还不能单独建数据服务，排在 <span className="text-muted-foreground">S4</span>。
        <br />
        <span className="text-muted-foreground/50">
          到时候是「共享 MySQL、每项目一个库 + 独立 role，Redis 按前缀隔离」；
          后端模板可以用 <code className="font-mono">deps</code> 声明自己需要它们，不需要你手动选。
        </span>
      </p>
    </div>
  )
}

/** 语言缩写小方块。用语言惯用色，一眼能认出是哪一家。 */
function Monogram({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="flex size-[18px] shrink-0 items-center justify-center rounded text-[9px] font-bold"
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)` }}
    >
      {text}
    </span>
  )
}
