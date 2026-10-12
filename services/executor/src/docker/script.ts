import { APP_PORT } from '@webgen/shared'
import type { TemplateSpec } from '@webgen/shared'

/** 工作区里那把构建锁的文件名。**故意放进工作区** —— 见下面 buildScript 的说明。 */
export const BUILD_LOCK = '.webgen-build.lock'

/**
 * 把 `spec` 拼成容器启动时执行的那段脚本：**先构建、再起进程**。
 *
 * 抽出来是因为沙箱容器和生产容器**必须逐字一致**：两边各写一遍的话，
 * 迟早只有一边加了新东西（这次加的锁就是），于是"预览没问题、发布出去就坏"。
 */
export function buildScript(spec: TemplateSpec): string {
  const sub = (s: string) =>
    s.replaceAll('$PORT', String(spec.port)).replaceAll('$APP_PORT', String(APP_PORT))

  const lines = ['set -eo pipefail']

  if (spec.buildCommand) {
    /*
     * ★ 构建必须**串行化**，而且要跨容器串行。
     *
     * 为什么：同一个项目有编辑容器（`d-<id>`）和预览容器（`p-<id>`），
     * 它们**共享同一个工作区**（bind mount 是同一份），而两个容器的启动脚本都会跑
     * `pnpm install && pnpm build` / `mvn package`。它们在创建时几乎是同时起来的，
     * 于是两个进程同时往同一个 node_modules / dist / target 里写 ——
     * 实测的后果是预览那次安装要等 **75 秒**（争用同一个 pnpm store 锁），
     * 而 agent 每轮生成最多重建 4 次沙箱，这个代价会重复付。
     *
     * 锁文件只能放在**工作区里**：那是两个容器唯一共享的路径（临时目录、家目录都不共享）。
     *
     * 用 fd 9 而不是 `flock <file> -c '<cmd>'`：后者要把整条构建命令塞进一个参数里，
     * 而构建命令里本来就有引号和 `&&`，转义出错会变成一条**静默跑错**的命令。
     */
    lines.push(
      `exec 9>/workspace/${BUILD_LOCK}`,
      'flock 9',
      sub(spec.buildCommand),
      // 构建一结束就放锁：后面那个常驻进程不该一直占着它
      'flock -u 9',
    )
  }

  lines.push(sub(spec.runCommand))
  return lines.join('\n')
}
