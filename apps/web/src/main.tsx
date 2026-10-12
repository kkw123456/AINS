import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ThemeProvider } from '@/components/theme-provider'
// TooltipProvider 要包在最外层：Radix 的 tooltip 是全局单例，每个 tooltip 各持一个 provider
// 会导致 hover 一个、另一个的计时器乱掉（延迟行为不一致）。
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
