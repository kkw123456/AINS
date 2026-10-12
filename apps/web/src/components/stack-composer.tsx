import { CheckIcon, InfoIcon } from 'lucide-react'
import type { Backend, DataLayer, Frontend, Stack } from '@webgen/shared'
import { DATA_LAYERS, stackLabel } from '@webgen/shared'
import { Badge } from '@/components/ui/badge'
import {
  BACKEND_CHOICES,
  DATA_CHOICES,
  FRONTEND_CHOICES,
  type Choice,
} from '@/lib/stacks'
import { cn } from '@/lib/utils'

/**
 * 技术栈**组合**选择器（S3.5）。
 *
 * 和老的 `StackPicker` 的区别：那个是"从若干个写死的模板里挑一个"，这个是
 * **三段各挑一个，平台当场把它们组装起来**（前端 × 后端 × 数据）。
 *
 * 为什么这样才对：组合是动态的，**不可能一个组合预建一个镜像**（那是乘法）。
 * 所以镜像是按选中的组合当场生成的（Dockerfile 由平台拼，见 executor 的 images/recipe.ts），
 * 三段的选择因此必须是**相互独立的三组单选**，而不是一长串"预置套餐"。
 *
 * 后端那一段没有「不要」选项 —— 它决定镜像基座，也是容器里那个常驻进程。
 */
export function StackComposer({
  value,
  onChange,
  disabled,
}: {
  value: Stack
  onChange: (next: Stack) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <Row
        title="前端"
        hint="构建成静态产物，由容器里的 nginx 伺服"
        choices={FRONTEND_CHOICES}
        value={value.frontend}
        disabled={disabled}
        onPick={(frontend) => onChange({ ...value, frontend })}
      />
      <Row
        title="后端"
        hint="跑一个常驻进程；也决定镜像基座"
        choices={BACKEND_CHOICES}
        value={value.backend}
        disabled={disabled}
        onPick={(backend: Backend) => onChange({ ...value, backend })}
      />
      <MultiRow
        title="数据"
        hint="可多选：MySQL / Redis；SQLite 与 MySQL 二选一"
        choices={DATA_CHOICES}
        value={value.data}
        disabled={disabled}
        onToggle={(data) => onChange({ ...value, data })}
      />

      {/* 选完给一句人话的结果 + 一句它意味着什么。**选之前就该知道会得到什么。** */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground/80">
        <Badge variant="secondary">{stackLabel(value)}</Badge>
        <span className="text-muted-foreground/50">
          一个容器，nginx 在前面；前端产物和 <code className="font-mono">/api/</code> 从同一个口出。
        </span>
      </div>
    </div>
  )
}

function Row<T>({
  title,
  hint,
  choices,
  value,
  disabled,
  onPick,
}: {
  title: string
  hint: string
  choices: Choice<T>[]
  value: T
  disabled?: boolean
  onPick: (next: T) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground/50">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((c) => (
          <Chip
            key={String(c.id)}
            choice={c}
            selected={c.id === value}
            disabled={disabled}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  )
}

/** 数据段专用：**多选**。sqlite / mysql 互斥（都是关系型存储），redis 正交。 */
function MultiRow({
  title,
  hint,
  choices,
  value,
  disabled,
  onToggle,
}: {
  title: string
  hint: string
  choices: Choice<DataLayer>[]
  value: DataLayer[]
  disabled?: boolean
  onToggle: (next: DataLayer[]) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground/50">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {choices.map((c) => (
          <Chip
            key={c.id}
            choice={c}
            selected={value.includes(c.id)}
            disabled={disabled}
            onPick={() => onToggle(toggleData(value, c.id))}
          />
        ))}
      </div>
    </div>
  )
}

/** 数据段的切换规则：互斥的是 sqlite/mysql，redis 自由；结果按 DATA_LAYERS 归一化排序。 */
function toggleData(cur: DataLayer[], layer: DataLayer): DataLayer[] {
  let next: DataLayer[]
  if (cur.includes(layer)) {
    next = cur.filter((d) => d !== layer)
  } else if (layer === 'sqlite' || layer === 'mysql') {
    next = [...cur.filter((d) => d !== 'sqlite' && d !== 'mysql'), layer]
  } else {
    next = [...cur, layer]
  }
  return DATA_LAYERS.filter((d) => next.includes(d))
}

function Chip<T>({
  choice,
  selected,
  disabled,
  onPick,
}: {
  choice: Choice<T>
  selected: boolean
  disabled?: boolean
  onPick: (next: T) => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(choice.id)}
      aria-pressed={selected}
      title={choice.blurb}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-all',
        selected
          ? 'border-primary/50 bg-primary/10 text-foreground shadow-xs'
          : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/40 hover:bg-accent',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <Monogram text={choice.monogram} color={choice.color} />
      <span className={cn('font-medium', selected && 'text-foreground')}>{choice.label}</span>
      {selected ? <CheckIcon className="size-3 text-primary" /> : null}
    </button>
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

/** 选中项的那句说明。放在下面而不是只做 hover 提示 —— 选之前就该看得到。 */
export function ComposerNote({ value }: { value: Stack }) {
  const hit = [
    ...FRONTEND_CHOICES.filter((c) => c.id === value.frontend),
    ...BACKEND_CHOICES.filter((c) => c.id === value.backend),
    ...DATA_CHOICES.filter((c) => value.data.includes(c.id)),
  ]
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
      <InfoIcon className="mt-0.5 size-3 shrink-0" />
      <span>{hit.map((c) => c.blurb).join(' ')}</span>
    </p>
  )
}
