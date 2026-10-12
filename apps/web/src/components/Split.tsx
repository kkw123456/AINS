import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

const MIN_LEFT = 280
const MAX_LEFT = 720
const MIN_RIGHT = 300
const MAX_RIGHT = 900
/** 中间（预览/tab 区）至少要留这么宽，不然它会被两侧挤成 0 */
const MIN_CENTER = 320
const HANDLE = 5
// v2：左右两栏的内容对调过（文件在左、对话在右），v1 存的宽度是反的，换个 key 免得出怪布局
const STORE_KEY = 'webgen.pane-widths.v2'

interface Widths {
  left: number
  right: number
}

function load(): Widths {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Widths>
      return {
        left: clamp(p.left ?? 460, MIN_LEFT, MAX_LEFT),
        right: clamp(p.right ?? 380, MIN_RIGHT, MAX_RIGHT),
      }
    }
  } catch {
    /* 存坏了就用默认值 */
  }
  // 左边是文件树，右边是对话；中间 tab 区吃掉剩下的
  return { left: 460, right: 380 }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 三栏布局 + 两个拖拽分隔条。
 *
 * ★ **两侧的宽度必须按容器实际宽度夹住**。它们是 `flex: 0 0 auto` 的定宽，
 * 加起来（默认 460 + 380 = 840）在窄窗口里会超过视口 —— 中间被压成 0、
 * 整行横向溢出，**最右边的对话栏就被推出屏幕**（症状是"右侧面板溢出了"）。
 * 所以渲染时用夹过的宽度，但**存的还是用户拖的那个值** ——
 * 窗口变宽之后要能恢复回去，不能把用户的设置改掉。
 *
 * 手写而不是引 `react-resizable-panels`：模型很简单，而且**无论用不用库都得解决同一个坑** ——
 * 指针拖到中间的 iframe 上时 iframe 会吞掉 pointermove，拖拽当场卡死。
 * 解法是拖拽期间给 body 加 `is-dragging`（styles.css 里对 iframe 打了 `pointer-events: none`）。
 * 既然这个必须自己写，库就只剩一个依赖的价值了。
 */
export function Split({
  left,
  center,
  right,
}: {
  left: ReactNode
  center: ReactNode
  right: ReactNode
}) {
  const [widths, setWidths] = useState<Widths>(load)
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)
  const [boxW, setBoxW] = useState(0)
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // 容器宽度：夹宽度要用它
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

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('is-dragging')
    return () => document.body.classList.remove('is-dragging')
  }, [dragging])

  const onPointerDown = useCallback(
    (side: 'left' | 'right') => (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { side, startX: e.clientX, startW: widths[side] }
      setDragging(side)
    },
    [widths],
  )

  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      // 右侧是"从右边算"的距离，所以方向相反
      const delta = d.side === 'left' ? e.clientX - d.startX : d.startX - e.clientX
      const next = clamp(
        d.startW + delta,
        d.side === 'left' ? MIN_LEFT : MIN_RIGHT,
        d.side === 'left' ? MAX_LEFT : MAX_RIGHT,
      )
      setWidths((w) => ({ ...w, [d.side]: next }))
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(null)
      setWidths((w) => {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(w))
        } catch {
          /* 存不了就算了，不影响使用 */
        }
        return w
      })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  // ★ 夹：两侧合计不能超过 (容器宽 - 中间最小宽 - 两个分隔条)。
  // 按比例先收右边（对话栏被推出去是最难受的），再收左边。
  const rendered = (() => {
    if (boxW <= 0) return widths
    const budget = boxW - HANDLE * 2 - MIN_CENTER
    if (widths.left + widths.right <= budget) return widths

    const overflow = widths.left + widths.right - budget
    const right = Math.max(MIN_RIGHT, widths.right - overflow)
    const stillOver = widths.left + right - budget
    const left = stillOver > 0 ? Math.max(MIN_LEFT, widths.left - stillOver) : widths.left
    return { left, right }
  })()

  const handle = (side: 'left' | 'right') => (
    <div
      onPointerDown={onPointerDown(side)}
      className={`group flex cursor-col-resize items-center justify-center hover:bg-accent ${
        dragging === side ? 'bg-primary/60' : ''
      }`}
      style={{ width: HANDLE, flex: '0 0 auto' }}
      role="separator"
      aria-orientation="vertical"
    >
      <div className="h-8 w-px bg-border group-hover:bg-muted-foreground" />
    </div>
  )

  return (
    <div ref={boxRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ width: rendered.left, flex: '0 0 auto' }}
      >
        {left}
      </div>
      {handle('left')}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{center}</div>
      {handle('right')}
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ width: rendered.right, flex: '0 0 auto' }}
      >
        {right}
      </div>
    </div>
  )
}
