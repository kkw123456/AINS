import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SandboxBridge } from './bridge.ts'

/**
 * 把沙箱包成一组 MCP 工具给模型用。
 *
 * ★ 为什么不用 claude 自带的 Read/Write/Bash：那些工具会跑在**跑 agent 的那台机器**上，
 * 而生成出来的代码必须只在沙箱里执行（§1.3 / §10）。自带工具一旦启用，
 * 沙箱就形同虚设 —— 所以 claude 侧只放行本文件定义的这几个 `mcp__sandbox__*`
 * （见 claude.ts 的 disallowedTools）。
 *
 * 每个工具都只是**转发**：真正的路径 jail / 命令白名单 / 资源限额在 executor 那一侧。
 */

export const SANDBOX_SERVER_NAME = 'sandbox'

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] }
}
function errorText(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  return `${(n / 1024 / 1024).toFixed(1)}M`
}

export function createSandboxServer(bridge: SandboxBridge) {
  return createSdkMcpServer({
    name: SANDBOX_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'list_files',
        '列出工作区里的文件与目录。node_modules / .git 这类目录只会显示名字、不展开。传 dir 只看某个子目录。',
        { dir: z.string().optional().describe('相对工作区的子目录，省略即工作区根') },
        async ({ dir }) => {
          try {
            const all = await bridge.listFiles()
            const prefix = dir ? dir.replace(/^\.?\/+/, '').replace(/\/+$/, '') : ''
            const rows = all
              .filter((f) => (prefix ? f.path === prefix || f.path.startsWith(prefix + '/') : true))
              .map((f) => {
                const rel = prefix ? f.path.slice(prefix.length + 1) : f.path
                if (!rel) return null
                if (f.dir) return `${rel}/${f.skipped ? '   (内容已折叠)' : ''}`
                return `${rel}  ${fmtBytes(f.size)}`
              })
              .filter(Boolean)
            return text(rows.length ? rows.join('\n') : '（空）')
          } catch (e) {
            return errorText(`列出失败：${(e as Error).message}`)
          }
        },
      ),

      tool(
        'read_file',
        '读一个文件的完整内容。路径相对工作区根。',
        { path: z.string() },
        async ({ path }) => {
          try {
            return text(await bridge.readFile(path))
          } catch (e) {
            return errorText(`读取失败：${(e as Error).message}`)
          }
        },
      ),

      tool(
        'write_file',
        '写入（或新建）一个文件，整份覆盖。路径相对工作区根，父目录会自动创建。',
        { path: z.string(), content: z.string() },
        async ({ path, content }) => {
          try {
            await bridge.writeFile(path, content)
            return text(`已写入 ${path}（${fmtBytes(Buffer.byteLength(content))}）`)
          } catch (e) {
            return errorText(`写入失败：${(e as Error).message}`)
          }
        },
      ),

      tool(
        'edit_file',
        '做一次精确替换：把文件里的 old_string 换成 new_string。old_string 必须在文件中**恰好出现一次**，否则会报错（这是防误改，别用模糊匹配绕过）。',
        { path: z.string(), old_string: z.string(), new_string: z.string() },
        async ({ path, old_string, new_string }) => {
          try {
            const before = await bridge.readFile(path)
            const parts = before.split(old_string)
            if (parts.length === 1) return errorText(`${path} 里找不到 old_string`)
            if (parts.length > 2) {
              return errorText(
                `${path} 里 old_string 出现了 ${parts.length - 1} 次，不唯一。多给一些上下文让它唯一。`,
              )
            }
            await bridge.writeFile(path, parts.join(new_string))
            return text(`已修改 ${path}`)
          } catch (e) {
            return errorText(`编辑失败：${(e as Error).message}`)
          }
        },
      ),

      tool(
        'run',
        '在沙箱里执行命令并拿到输出。**必须传 argv 数组**（如 ["pnpm","install"]、["ls","-la"]），' +
          '不支持管道、重定向、&& —— 需要什么就分几次调用。命令只在沙箱容器里跑，碰不到宿主机。',
        {
          cmd: z.array(z.string()).min(1).describe('argv 数组，第一项是可执行文件名'),
          cwd: z.string().optional().describe('相对工作区的目录，默认工作区根'),
          timeoutMs: z.number().optional().describe('超时毫秒，默认 120000'),
        },
        async ({ cmd, cwd, timeoutMs }) => {
          try {
            const r = await bridge.run(cmd, { cwd, timeoutMs })
            const out: string[] = []
            if (r.stdout) out.push(r.stdout.replace(/\s+$/, ''))
            if (r.stderr) out.push(`[stderr]\n${r.stderr.replace(/\s+$/, '')}`)
            const tail = r.timedOut ? '（已超时终止）' : `exit=${r.code}`
            return r.code === 0 && !r.timedOut
              ? text(`${tail}\n${out.join('\n')}`)
              : errorText(`${tail}\n${out.join('\n') || '（无输出）'}`)
          } catch (e) {
            return errorText(`执行失败：${(e as Error).message}`)
          }
        },
      ),
    ],
  })
}

/** 供 claude.ts 拼 allowedTools 用 */
export const SANDBOX_TOOL_NAMES = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'run',
].map((n) => `mcp__${SANDBOX_SERVER_NAME}__${n}`)
