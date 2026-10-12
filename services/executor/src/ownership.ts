import { chown } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 沙箱容器的镜像里用户是 uid 10001（非 root，§2.2），
 * 而工作区 bind mount 自宿主（executor 以 root 跑）——属主对不上，
 * 沙箱里就会"连自己工作区都写不了"。
 *
 * 所以：宿主要把工作区交给 10001；executor 自己通过文件接口新写的文件，
 * 也要跟着交出去，否则沙箱下一次改不动它。
 *
 * 这两个常量必须和 sandbox/images/<语言>/Dockerfile 里的 useradd 保持一致。
 */
export const SANDBOX_UID = 10001
export const SANDBOX_GID = 10001

export async function chownTree(path: string): Promise<void> {
  await chown(path, SANDBOX_UID, SANDBOX_GID).catch(() => {})
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const child = join(path, e.name)
    if (e.isDirectory()) {
      await chownTree(child)
    } else {
      await chown(child, SANDBOX_UID, SANDBOX_GID).catch(() => {})
    }
  }
}

export async function chownEntry(path: string): Promise<void> {
  await chown(path, SANDBOX_UID, SANDBOX_GID).catch(() => {})
}
