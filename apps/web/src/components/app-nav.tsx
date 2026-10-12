import { NavLink } from 'react-router-dom'
import { BoxesIcon, FolderIcon, LayoutTemplateIcon, SparklesIcon } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

const LINKS = [
  { to: '/', label: '新建', icon: SparklesIcon, end: true },
  { to: '/projects', label: '项目', icon: FolderIcon, end: false },
  { to: '/containers', label: '容器', icon: BoxesIcon, end: false },
  { to: '/templates', label: '模板', icon: LayoutTemplateIcon, end: false },
]

/**
 * 管理面的共用导航。
 *
 * **工作台不用它** —— 工作台有自己的顶栏，而且三栏布局已经把横向空间吃满了，
 * 再加一条导航会挤掉预览区。工作台通过顶栏的「← 全部项目」回到这边。
 */
export function AppNav() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-xs font-semibold text-primary">
          w
        </div>
        <span className="text-sm font-semibold">webgen</span>
      </div>

      <nav className="flex items-center gap-0.5">
        {LINKS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            <Icon className="size-3.5" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  )
}

/** 管理面页面的外壳：导航 + 可滚动内容区 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppNav />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
