import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { zipSync, type Zippable } from 'fflate'
import { config } from '../config.ts'
import { GuardError } from '../guards.ts'
import { SKIP_DIRS } from './files.ts'
import { resolveInWorkspace } from './paths.ts'

/**
 * 导出 zip（§5.3 能力清单最后一条）。
 *
 * 放在 executor 而不是 orchestrator：文件在**这台机器**上，而且 §5.3 说死了
 * 「文件读写在沙箱之外完成，但走 executor」——orchestrator 直读本地目录是以后要还的债。
 *
 * 两条硬约束（照抄 files.ts 的教训）：
 *  ① **必须排除 node_modules / .git / 缓存**。一个装过依赖的工作区几万个文件，
 *     打一次包就能把内存撑爆。
 *  ② 有总量上限，超了**显式报错**（§2.4），不静默截断出一个残包。
 *
 * 过滤规则**和文件树完全一致**（同一个 SKIP_DIRS、同一套点文件规则），
 * 所以「导出的就是你看到的」——不会出现树里没有、包里有的东西。
 */

const MAX_DEPTH = 12

/** 与 files.ts 的 walk 保持一字不差 */
function visible(name: string): boolean {
  return !name.startsWith('.') || name === '.env.example'
}

export interface ExportResult {
  zip: Uint8Array
  entries: number
  bytes: number
}

export async function zipWorkspace(
  projectId: string,
  subRoot = '',
): Promise<ExportResult> {
  const root = resolveInWorkspace(projectId, subRoot)
  const st = await stat(root).catch(() => null)
  if (!st?.isDirectory()) throw new GuardError(`目录不存在：${subRoot || '工作区根'}`)

  const files: string[] = []
  let total = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!visible(e.name)) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        if (depth + 1 < MAX_DEPTH) await walk(abs, depth + 1)
        continue
      }
      if (!e.isFile()) continue // 符号链接等一律不进包
      const fst = await stat(abs).catch(() => null)
      if (!fst) continue
      total += fst.size
      if (total > config.maxExportBytes) {
        throw new GuardError(
          `导出内容超过上限（${config.maxExportBytes} 字节），请改用「只要构建产物」或先清理工作区`,
        )
      }
      files.push(abs)
      if (files.length > config.maxExportEntries) {
        throw new GuardError(`导出文件数超过上限（${config.maxExportEntries} 个）`)
      }
    }
  }

  await walk(root, 0)

  const data: Zippable = {}
  for (const abs of files) {
    // zip 里的路径一律用 /（zip 规范），不能用平台分隔符
    data[relative(root, abs).split(/[\\/]/).join('/')] = [new Uint8Array(await readFile(abs)), { level: 6 }]
  }

  return { zip: zipSync(data, { level: 6 }), entries: files.length, bytes: total }
}
