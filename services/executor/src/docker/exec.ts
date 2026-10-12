import { Writable } from 'node:stream'
import type Docker from 'dockerode'
import type { ExecResult } from '@webgen/shared'
import { config } from '../config.ts'
import { assertCommandAllowed, containerPath } from '../guards.ts'
import { docker } from './client.ts'

export interface ExecOptions {
  /** 容器内的工作目录，必须是 /workspace 下的（默认就是它） */
  cwd?: string
  timeoutMs?: number
}

/**
 * 在沙箱里执行一条命令。**只接受 argv 数组，不接受 shell 字符串**——
 * shell 字符串等于把整条命令的解释权交出去，白名单就形同虚设。
 */
export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  assertCommandAllowed(cmd)

  const timeoutMs = Math.min(opts.timeoutMs ?? config.execTimeoutMs, config.execMaxTimeoutMs)
  const workingDir = containerPath(opts.cwd ?? '.')

  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: workingDir,
    AttachStdout: true,
    AttachStderr: true,
    User: 'sandbox',
  })

  const stream = await exec.start({ Detach: false, Tty: false })

  let stdout = ''
  let stderr = ''
  let truncated = false

  const collect = (which: 'out' | 'err') =>
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        const current = which === 'out' ? stdout : stderr
        if (current.length >= config.execMaxOutput) {
          truncated = true
          cb()
          return
        }
        const text = chunk.toString('utf8')
        if (which === 'out') stdout += text
        else stderr += text
        cb()
      },
    })

  docker.modem.demuxStream(stream, collect('out'), collect('err'))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stream.destroy()
  }, timeoutMs)

  await new Promise<void>((resolve) => {
    stream.on('end', () => resolve())
    stream.on('close', () => resolve())
    stream.on('error', () => resolve())
  }).finally(() => clearTimeout(timer))

  // 超时后 ExitCode 可能还没落，认为非零即可
  const info = await exec.inspect().catch(() => null)
  const code = timedOut ? 124 : (info?.ExitCode ?? -1)

  const note = truncated ? `\n…（输出超过 ${config.execMaxOutput} 字节，已截断）` : ''
  return { code, stdout: stdout + note, stderr, timedOut }
}
