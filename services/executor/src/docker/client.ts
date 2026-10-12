import { existsSync } from 'node:fs'
import { chown, mkdir } from 'node:fs/promises'
import Docker from 'dockerode'
import { config } from '../config.ts'
import { SANDBOX_GID, SANDBOX_UID } from '../ownership.ts'

const socketPath = process.env.DOCKER_SOCKET?.trim() || '/var/run/docker.sock'

if (!existsSync(socketPath)) {
  throw new Error(
    `找不到 docker socket：${socketPath}。executor 必须能直连 docker；` +
      `本机请确认 WSL 里 docker 守护进程在跑（systemctl is-active docker）。`,
  )
}

/**
 * ★ 全仓库唯一持有 docker socket 的地方。
 * 外面只通过 executor 暴露的几类接口间接用它——不提供"执行任意 docker 命令"的口子。
 */
export const docker = new Docker({ socketPath })

/** 沙箱与 Traefik 共享的网络；不在 compose 里跑时自动补建 */
export async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [config.dockerNetwork] } })
  if (nets.some((n) => n.Name === config.dockerNetwork)) return
  await docker.createNetwork({ Name: config.dockerNetwork, Driver: 'bridge' })
}

/**
 * 备好共用的 pnpm store 目录，并交给沙箱用户。
 *
 * 它被挂成容器里的 `/workspace/.pnpm-store`。**必须由宿主先建好、先 chown** ——
 * docker 会在挂载点不存在时用 root 建一个空目录，那样 uid 10001 的 pnpm 写不进去，
 * 于是它静默退回联网安装，问题看起来又像"网络慢"。
 */
export async function ensurePnpmStore(): Promise<void> {
  await mkdir(config.pnpmStoreDir, { recursive: true }).catch(() => {})
  // 只 chown 这一层：里面是内容寻址的缓存目录，pnpm 自己会按需创建子目录。
  // 递归 chown 一个几万文件的 store 每次建容器都跑一遍，纯属浪费。
  await chown(config.pnpmStoreDir, SANDBOX_UID, SANDBOX_GID).catch(() => {})
}
