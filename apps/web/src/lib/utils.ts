import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn 的地基：把条件类名和 Tailwind 冲突合并两件事一次做完。
 * `cn('px-2', cond && 'px-4')` → 后者赢，而不是两个 px 都留在 DOM 上互相打架。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
