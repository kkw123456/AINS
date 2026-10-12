import type { VisitStore } from './index.js'

/**
 * 没有任何数据层时的进程内计数。
 * 重启归零 —— 那不是 bug，正是"没选数据层"应有的样子。
 */
export function createMemoryStore(): VisitStore {
  let n = 0
  return {
    kind: 'memory',
    async hit() {
      return ++n
    },
    async close() {
      /* 无需释放 */
    },
  }
}
