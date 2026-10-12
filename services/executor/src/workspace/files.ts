import { readFile, stat, writeFile } from 'node:fs/promises'
import { open, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { config } from '../config.ts'
import { GuardError } from '../guards.ts'
import { chownEntry } from '../ownership.ts'
import { resolveInWorkspace } from './paths.ts'

/**
 * 文件接口（§5.3）。两条硬约束：
 *  ① 默认排除 node_modules / .git / 缓存——一个装满依赖的工作区几万个文件，
 *     一次全量列目录就能把服务打挂。
 *  ② 单文件读写都有大小上限。
 */

/** 列目录时跳过的名字。导出的 zip 也复用这份（见 export.ts）——别各写一份。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.pnpm-store',
  '.mypy_cache',
  '.pytest_cache',
])

export interface FileEntry {
  /** 相对工作区的路径 */
  path: string
  name: string
  dir: boolean
  size: number
  depth: number
  mtimeMs: number
  /** 是否因为 SKIP_DIRS 被折叠（前端可提示"这里还有内容"） */
  skipped?: boolean
}

const MAX_DEPTH = 12

export async function listFiles(
  projectId: string,
  subRoot = '',
): Promise<{ root: string; files: FileEntry[] }> {
  // 「源码 / 构建产物两个根」就靠这一个参数：walk 的起点换个目录而已，
  // 路径 jail 还是 resolveInWorkspace，没有新增逃逸面。
  const root = resolveInWorkspace(projectId, subRoot)
  const st = await stat(root).catch(() => null)
  if (!st?.isDirectory()) throw new GuardError(`目录不存在：${subRoot || '工作区根'}`)
  const out: FileEntry[] = []
  await walk(root, root, 0, out)
  return { root, files: out }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: FileEntry[],
): Promise<void> {
  if (out.length >= config.maxListEntries) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const sorted = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })

  for (const e of sorted) {
    if (out.length >= config.maxListEntries) return
    const abs = join(dir, e.name)
    const rel = relative(root, abs)

    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        out.push({ path: rel, name: e.name, dir: true, size: 0, depth: depth + 1, mtimeMs: 0, skipped: true })
        continue
      }
      out.push({ path: rel, name: e.name, dir: true, size: 0, depth: depth + 1, mtimeMs: 0 })
      if (depth + 1 < MAX_DEPTH) await walk(root, abs, depth + 1, out)
    } else {
      const st = await stat(abs).catch(() => null)
      out.push({
        path: rel,
        name: e.name,
        dir: false,
        size: st?.size ?? 0,
        depth: depth + 1,
        mtimeMs: st?.mtimeMs ?? 0,
      })
    }
  }
}

export async function readTextFile(
  projectId: string,
  rel: string,
): Promise<{ path: string; content: string; size: number }> {
  const abs = resolveInWorkspace(projectId, rel)
  const st = await stat(abs).catch(() => null)
  if (!st || !st.isFile()) throw new GuardError(`不是文件：${rel}`)
  if (st.size > config.maxReadBytes) {
    throw new GuardError(`文件超过读取上限（${config.maxReadBytes} 字节）：${rel}`)
  }

  const fh = await open(abs, 'r')
  try {
    const head = Buffer.alloc(Math.min(8192, st.size))
    await fh.read(head, 0, head.length, 0)
    if (head.includes(0)) throw new GuardError(`看起来是二进制文件，不预览：${rel}`)
  } finally {
    await fh.close()
  }

  return { path: rel, content: await readFile(abs, 'utf8'), size: st.size }
}

export async function writeTextFile(
  projectId: string,
  rel: string,
  content: string,
): Promise<{ path: string; size: number }> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > config.maxWriteBytes) {
    throw new GuardError(`内容超过写入上限（${config.maxWriteBytes} 字节）`)
  }
  const abs = resolveInWorkspace(projectId, rel)
  await writeFile(abs, content, 'utf8')
  // 交还给沙箱用户，否则 agent 下一次改不动这个文件
  await chownEntry(abs)
  return { path: rel, size: bytes }
}

export { basename }
