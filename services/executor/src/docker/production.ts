import type { TemplateSpec } from '@webgen/shared'
import { APP_PORT } from '@webgen/shared'
import { config } from '../config.ts'
import { chownTree } from '../ownership.ts'
import { docker, ensureNetwork, ensurePnpmStore } from './client.ts'
import { envPairs } from './env.ts'
import { buildScript } from './script.ts'

/**
 * 生产容器（§5.2 / §4）。和沙箱共用一套镜像，但**刻意不复用 createSandbox**——
 * 两者的差异全是"错了就很难查"的那类，硬塞进一个函数会让两边都难读：
 *
 * | | 沙箱 | 生产 |
 * |---|---|---|
 * | 挂载 | `<workspace>:/workspace`（读写，agent 随便折腾） | `<releases>/<slug>/v<n>:/workspace`（**每版本一份拷贝**） |
 * | 重启策略 | `no`（崩了就崩了，我们看退出原因） | `unless-stopped`（**常驻，不参与闲置回收**） |
 * | label | `webgen.sandbox=1` | `webgen.production=1` |
 * | router | `p-<id>` / `d-<id>`（默认优先级） | `pub-<slug>`（**priority=100**） |
 *
 * ⚠️ label 必须区分开：`listSandboxRecords` 只认 `webgen.sandbox=1` 来重建登记表，
 * 生产容器带了这个 label 会被当成沙箱接管、还会被算进 `EXECUTOR_CAPACITY`。
 *
 * ⚠️ 挂载是**读写**的，不是 §1.3 说的"只读"。原因是容器的 Cmd 是
 * `<buildCommand> && <runCommand>`，构建要往工作目录里写（`pnpm install` 的 node_modules、
 * maven 的 target）。"线上那份不会被 agent 改到"这个性质靠的是**每版本一份拷贝**，
 * 不是挂载标志位。真正的"构建产物镜像 + 只读挂载"要等构建与运行拆成两步，那是以后的事。
 */
export interface ProductionArgs {
  projectId: string
  slug: string
  version: number
  /** 从快照导出的代码目录（executor 的 publish.release 铺好的） */
  releaseDir: string
  spec: TemplateSpec
}

export interface ProductionCreated {
  containerId: string
  containerName: string
  port: number
  /**
   * 线上地址的 **host**（`<slug>.<siteDomain>`）。
   * 完整 URL 由 orchestrator 拼 —— scheme 和对外端口是它的配置，
   * executor 只知道容器内部的事，不该去猜外面用什么协议。
   */
  host: string
}

export function productionHost(slug: string): string {
  return `${slug}.${config.siteDomain}`
}

export function productionContainerName(slug: string, version: number): string {
  return `webgen-prod-${slug}-v${version}`
}

export async function createProduction(args: ProductionArgs): Promise<ProductionCreated> {
  const { projectId, slug, version, releaseDir, spec } = args
  await ensureNetwork()
  await ensurePnpmStore()

  /*
   * ★ 属主交给沙箱用户 —— 和 createSandbox 同一条理由，但在这里**更关键**：
   *
   * 发布出来的这份代码是 executor 以 root 铺的（`materializeRelease` 只把它调成
   * "谁都能读"）。而容器的启动脚本**要在工作区里构建**（`pnpm install` 写 node_modules、
   * `vite build` 写 dist、`mvn package` 写 target）—— 那些写操作 uid 10001 做不了，
   * 于是容器起来就退，健康检查一路超时，最后发布整个回滚。
   *
   * 现象是"预览好好的、生成也好好的，**只有发布**失败"，很容易往发布那边查。
   * （模板项目里 `node-web` 这种没有构建步骤的能过，所以这个坑一直没露出来。）
   */
  await chownTree(releaseDir)

  const port = spec.port
  const host = productionHost(slug)
  const name = productionContainerName(slug, version)
  // router 名字按 slug 而不是版本：切流量靠的是**优先级**（见下），
  // 若按版本命名，新旧两个 router 会同时匹配同一个 Host，Traefik 谁赢说不准。
  const router = `pub-${slug}`

  // 启动脚本（含跨容器的构建锁）和沙箱共用 buildScript —— 两边各写一份的话，
  // 迟早只有一边加了新东西，症状是"预览好好的、发布出去就坏"
  const script = buildScript(spec)

  const labels: Record<string, string> = {
    // ★ 不用 webgen.sandbox=1，理由见文件头
    'webgen.production': '1',
    'webgen.project': projectId,
    'webgen.slug': slug,
    'webgen.version': String(version),
    'webgen.node': config.nodeId,
    'traefik.enable': 'true',
    'traefik.docker.network': config.dockerNetwork,
    [`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${router}.entrypoints`]: 'web',
    // ⚠️ priority=100 是给共享静态伺服的兜底 HostRegexp（priority=1）压场用的。
    // 不写的话线上站点会被静态伺服抢走（反过来也一样要防）。
    [`traefik.http.routers.${router}.priority`]: '100',
    [`traefik.http.services.${router}.loadbalancer.server.port`]: String(port),
  }

  await removeByName(name)

  const limits = spec.limits
  const container = await docker.createContainer({
    name,
    Image: spec.image,
    Cmd: ['bash', '-lc', script],
    WorkingDir: '/workspace',
    Labels: labels,
    // 生产是 NODE_ENV=production：生成出来的应用里若有 dev/prod 分支，这里才是线上那一支
    // ★ spec.env 必须和沙箱那处一致（用同一个 envPairs）——否则会出现"预览有数据层、线上没有"
    Env: [`PORT=${port}`, `APP_PORT=${APP_PORT}`, 'NODE_ENV=production', ...envPairs(spec.env)],
    HostConfig: {
      Binds: [
        `${releaseDir}:/workspace`,
        // 和沙箱同一份共用 store（理由见 config.pnpmStoreDir）。
        // ⚠️ 发布这份代码是**从零**构建的（release 目录只有源码），所以这里**更**需要它 ——
        // 不挂的话每次发布都要联网装一遍前端依赖，慢到会撞满健康检查超时、把整个版本回滚掉。
        `${config.pnpmStoreDir}:/workspace/.pnpm-store`,
      ],
      NetworkMode: config.dockerNetwork,
      NanoCpus: limits.cpus * 1e9,
      Memory: limits.memoryMb * 1024 * 1024,
      // 和沙箱一样显式禁 swap：否则越限的进程会去刷 swap 而不是被 OOM 干掉
      MemorySwap: limits.memoryMb * 1024 * 1024,
      PidsLimit: limits.pids,
      // ★ 常驻：机器重启后生产站自己回来（沙箱是 no，因为它们随时可以重建）
      RestartPolicy: { Name: 'unless-stopped' },
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
    },
  })

  await container.start()
  return { containerId: container.id, containerName: name, port, host }
}

/**
 * **停**掉某个生产版本，但保留容器。
 *
 * ⚠️ 这里刻意用 stop 而不是 remove：§4 说「停旧版本（**保留上一个供回滚**）」。
 * 删掉容器的话，回滚时只能重新建一个——那和"回到上一个版本"不是一回事
 * （重建会重新跑一遍构建，产物可能和当时不一样）。停着的容器 `start` 一下就能回去，
 * 这才是"保留上一个"的意义。
 */
export async function stopProduction(
  slug: string,
  version: number,
): Promise<{ stopped: boolean }> {
  const found = await docker.listContainers({
    all: true,
    filters: { name: [productionContainerName(slug, version)] },
  })
  const target = found.find((c) => c.Names.some((n) => n === `/${productionContainerName(slug, version)}`))
  if (!target) return { stopped: false }
  if (target.State !== 'running') return { stopped: true }
  await docker.getContainer(target.Id).stop({ t: 5 }).catch(() => {})
  return { stopped: true }
}

/** 把一个停着的生产容器拉起来（回滚用）。容器不在会明确报错。 */
export async function startProduction(
  slug: string,
  version: number,
): Promise<{ started: boolean }> {
  const name = productionContainerName(slug, version)
  const found = await docker.listContainers({ all: true, filters: { name: [name] } })
  const target = found.find((c) => c.Names.some((n) => n === `/${name}`))
  if (!target) return { started: false }
  if (target.State !== 'running') await docker.getContainer(target.Id).start()
  return { started: true }
}

/** 彻底删掉某个生产版本（保留策略到期，或删项目时） */
export async function removeProduction(
  slug: string,
  version: number,
): Promise<{ removed: boolean }> {
  const name = productionContainerName(slug, version)
  return { removed: await removeByName(name) }
}

/** 列某个 slug 的所有生产容器（含已退出的） */
export async function listProduction(
  slug: string,
): Promise<{ name: string; version: number; running: boolean; containerId: string }[]> {
  const found = await docker.listContainers({
    all: true,
    filters: { label: [`webgen.production=1`, `webgen.slug=${slug}`] },
  })
  return found.map((c) => ({
    name: c.Names[0]?.replace(/^\//, '') ?? '',
    version: Number(c.Labels['webgen.version'] ?? 0),
    running: c.State === 'running',
    containerId: c.Id,
  }))
}

async function removeByName(name: string): Promise<boolean> {
  const found = await docker.listContainers({ all: true, filters: { name: [name] } })
  let removed = false
  for (const c of found) {
    if (!c.Names.some((n) => n === `/${name}`)) continue
    await docker.getContainer(c.Id).remove({ force: true, v: true }).catch(() => {})
    removed = true
  }
  return removed
}
