import type { SandboxRecord } from '@webgen/shared'
import { config } from '../config.ts'
import { docker } from './client.ts'

export interface ContainerStatus {
  running: boolean
  /** 已退出时的退出码；还在跑则为 null */
  exitCode: number | null
  /** ★ 内核因内存超限杀掉容器（§2.4：超限必须**显式失败**，不能甩一句"构建失败"） */
  oomKilled: boolean
  ip: string | null
  startedAt: string | null
  finishedAt: string | null
}

export async function containerStatus(containerId: string): Promise<ContainerStatus> {
  const info = await docker.getContainer(containerId).inspect()
  const state = info.State
  const net = info.NetworkSettings?.Networks?.[config.dockerNetwork]
  return {
    running: Boolean(state?.Running),
    exitCode: state?.Running ? null : (state?.ExitCode ?? null),
    oomKilled: Boolean(state?.OOMKilled),
    ip: net?.IPAddress || null,
    startedAt: state?.StartedAt ?? null,
    finishedAt: state?.FinishedAt ?? null,
  }
}

/** 把一条命令的失败翻译成人话 */
export function explainFailure(status: ContainerStatus, stderr: string): string {
  if (status.oomKilled) {
    return `容器因内存超限被系统终止（当前上限 ${process.env.LIMIT_MEMORY_MB ?? '1024'}MB）。` +
      `把模板 limits.memoryMb 调大，或减少依赖。`
  }
  if (status.exitCode === 137) return '容器被 SIGKILL（多半是内存超限或被人为停止）'
  if (status.exitCode === 126) return '命令不可执行（权限或 shebang 问题）'
  if (status.exitCode === 127) return '命令不存在（镜像里没装这个可执行文件？）'
  return stderr.trim().split('\n').slice(-3).join('\n') || `退出码 ${status.exitCode}`
}

/** 拉取容器日志（尾部若干行），给"起不来"排障用 */
export async function tailLogs(containerId: string, lines = 50): Promise<string> {
  const buf = (await docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    tail: lines,
  })) as Buffer
  // 非 TTY 日志是带 8 字节头的多路复用帧，直接剥掉
  const out: string[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4)
    const start = i + 8
    if (start + size > buf.length) break
    out.push(buf.subarray(start, start + size).toString('utf8'))
    i = start + size
  }
  return out.join('')
}

/** 健康探针。★ 走容器 IP，**不走预览域名**——`*.localhost` 只有宿主浏览器认（§4.1） */
export async function probeHealth(
  containerId: string,
  port: number,
  path = '/',
): Promise<boolean> {
  const status = await containerStatus(containerId)
  if (!status.running || !status.ip) return false
  const url = `http://${status.ip}:${port}${path.startsWith('/') ? path : '/' + path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return res.status < 500
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动时用实际容器重建登记表。**唯一的真相在 docker 里**，
 * 内存表只是缓存——executor 重启不该让在跑的沙箱变成孤儿。
 */
export async function listSandboxRecords(): Promise<SandboxRecord[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['webgen.sandbox=1'] },
  })
  const out: SandboxRecord[] = []
  for (const c of containers) {
    const l = c.Labels ?? {}
    if (!l['webgen.sandboxId'] || !l['webgen.project'] || !l['webgen.port']) continue
    out.push({
      sandboxId: l['webgen.sandboxId'],
      projectId: l['webgen.project'],
      // 老容器没有 webgen.role（S3 拆分之前建的），一律当编辑容器 ——
      // 它们是唯一的那个，语义上就是 edit
      role: l['webgen.role'] === 'preview' ? 'preview' : 'edit',
      nodeId: l['webgen.node'] ?? config.nodeId,
      containerId: c.Id,
      port: Number(l['webgen.port']),
      // 老容器（S3.5 之前建的）没有这个 label，退回 '/'，和当年的行为一致
      healthPath: l['webgen.healthPath'] ?? '/',
      hostPort: null,
      createdAt: new Date(c.Created * 1000).toISOString(),
    })
  }
  return out
}
