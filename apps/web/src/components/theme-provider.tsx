import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORE_KEY = 'webgen.theme'

interface ThemeCtx {
  /** 用户选的（可能是 system） */
  theme: Theme
  /** 实际生效的（system 解析之后） */
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

/**
 * 主题。**默认深色**（不是跟随系统）—— 这个工具的配色本来就是照着模板 seed 那套
 * 深色 slate 定的，白底是后来补的附属品。跟随系统仍然可选。
 *
 * 做法是在 <html> 上挂/摘 `dark` 类，样式侧全靠 shadcn 那套 CSS 变量
 * （styles.css 里的 :root / .dark）。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'dark'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const next = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      setResolved(next)
      document.documentElement.classList.toggle('dark', next === 'dark')
      // 让原生控件（滚动条、表单）也跟着走
      document.documentElement.style.colorScheme = next
    }
    apply()
    // 只有 system 模式才需要听系统变化
    if (theme !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORE_KEY, t)
    setThemeState(t)
  }, [])

  return <Ctx.Provider value={{ theme, resolved, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 里用')
  return ctx
}
