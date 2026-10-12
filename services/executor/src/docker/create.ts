import type { TemplateSpec } from '@webgen/shared'
import { APP_PORT } from '@webgen/shared'
import { config } from '../config.ts'
import { chownTree } from '../ownership.ts'
import { docker, ensureNetwork, ensurePnpmStore } from './client.ts'
import { envPairs } from './env.ts'
import { buildScript } from './script.ts'

/** 沙箱只有两种角色；生产容器走另一条路（见 docker/production.ts） */
export type SandboxRole = 'edit' | 'preview'

/**
 * 每个角色一个域名。**这是 S3 拆分的关键**：
 *  - `p-<id>` 是**用户可见的预览地址**，从 S0 就定死了（C6），所以它归预览实例；
 *  - 编辑容器搬到 `d-<id>`（§4 的「实时视图」）—— 里面是 agent 正在折腾的那份，
 *    它重启/崩溃不该影响用户正在看的预览。
 *
 * 拆之前两者是同一个容器，§1.3「预览实例不能直接用编辑容器的 dev server」是被违反的。
 */
export function instanceHost(projectId: string, role: SandboxRole): string {
  const prefix = role === 'edit' ? 'd' : 'p'
  return `${prefix}-${projectId}.${config.previewDomain}`
}

export function containerName(projectId: string, role: SandboxRole): string {
  return role === 'edit' ? `webgen-sbx-${projectId}` : `webgen-prev-${projectId}`
}

/** 兼容旧调用：预览的域名 */
export function previewHost(projectId: string): string {
  return instanceHost(projectId, 'preview')
}

export interface CreateArgs {
  projectId: string
  sandboxId: string
  /** 宿主机上的工作区绝对路径 */
  workspaceDir: string
  spec: TemplateSpec
  /** 建的是编辑容器还是预览容器。默认 edit（老调用点行为不变）。 */
  role?: SandboxRole
}

export interface Created {
  containerId: string
  port: number
  host: string
  containerName: string
}

/**
 * 建沙箱容器。要点：
 *  - 镜像是**模板决定的**，executor 里不写死语言
 *  - 挂载**只有两个，都是刻意的**：工作区（读写）+ 共用的 pnpm store（读写）。
 *    §4 原来写的是"唯一开的宿主挂载是工作区"，S3.5 加了第二个，理由见 config.pnpmStoreDir ——
 *    不加它，前端依赖每次都要联网装一遍。两个都指向 `<dataDir>` 下的受控路径，
 *    不碰宿主家目录/源码/配置，也不传 docker socket。
 *  - 不挂宿主家目录/源码/配置，不传 docker socket
 *  - 限额来自 template.limits，已被 LIMIT_CEILING 夹过
 */
export async function createSandbox(args: CreateArgs): Promise<Created> {
  const { projectId, sandboxId, workspaceDir, spec } = args
  const role: SandboxRole = args.role ?? 'edit'
  await ensureNetwork()
  await ensurePnpmStore()

  // 属主交给沙箱用户，否则非 root 的容器连自己工作区都写不了
  await chownTree(workspaceDir)

  const port = spec.port
  const host = instanceHost(projectId, role)
  // router 名字必须带角色前缀：两个容器共用一个项目 id，名字撞了 Traefik 会把路由合到一条上
  const router = `${role === 'edit' ? 'd' : 'p'}-${projectId}`
  const name = containerName(projectId, role)

  // 起容器就一并把 build + run 跑起来；build 失败则容器直接退出，
  // 退出原因可以从 docker logs / inspect 里看到（比"后台 nohup"可靠得多）。
  //
  // ⚠️ 两个占位符都要替换：`$PORT` 是**对外**那个口（组合项目里归 nginx），
  //    `$APP_PORT` 是后端在容器内听的**内部**口。只替换一个的话，
  //    后端会去听对外端口，和 nginx 撞在一起 —— 现象是"容器起来了但访问不了"。
  //    替换 + 那把跨容器的构建锁都在 buildScript 里（和生产容器共用同一份）。
  const script = buildScript(spec)

  const labels: Record<string, string> = {
    // 自己的标记：重启后据此重建登记表
    'webgen.sandbox': '1',
    'webgen.sandboxId': sandboxId,
    'webgen.project': projectId,
    // ★ 角色。重启重建登记表时靠它区分编辑/预览（只按 projectId 会认错容器）
    'webgen.role': role,
    'webgen.node': config.nodeId,
    'webgen.port': String(port),
    'webgen.host': host,
    // 就绪探针路径。落成 label 是为了**重启后重建登记表**时还在 ——
    // 内存表是缓存，docker 才是真相（见 inspect.ts 的 listSandboxRecords）。
    'webgen.healthPath': spec.healthPath ?? '/',
    // Traefik docker provider：容器一起来路由就生效，容器一删路由就回收（验收 ⑤）
    'traefik.enable': 'true',
    'traefik.docker.network': config.dockerNetwork,
    [`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${router}.entrypoints`]: 'web',
    [`traefik.http.services.${router}.loadbalancer.server.port`]: String(port),
  }

  // 同名残留先清掉（recreate 场景）。注意名字**带角色**：拆了之后编辑和预览是两个容器
  await removeByName(name)

  const limits = spec.limits
  const container = await docker.createContainer({
    name,
    Image: spec.image,
    Cmd: ['bash', '-lc', script],
    WorkingDir: '/workspace',
    Labels: labels,
    // ★ APP_PORT 必须**同时**以环境变量注入，不能只靠上面那个字符串替换：
    //   种子里有读 `process.env.APP_PORT` / `os.Getenv("APP_PORT")` / `${APP_PORT:3001}`
    //   的地方，它们看不见替换后的命令行文本。不注入的话那些地方会各自退回
    //   "写死的 3001"，一旦 APP_PORT 常量改了，前端和 nginx 就指向一个后端没在听的口
    //   —— 现象是"网页打得开、/api 全 502"，而且四个后端里只有一部分坏。
    //
    // ★ spec.env 放在**最后**：模板（也就是组合）说的算，平台给的默认值能被它覆盖。
    Env: [`PORT=${port}`, `APP_PORT=${APP_PORT}`, 'NODE_ENV=development', ...envPairs(spec.env)],
    HostConfig: {
      Binds: [
        `${workspaceDir}:/workspace`,
        // ★ 共用的 pnpm store。**这不是优化，是正确性**：不挂它，容器里每次
        //   `pnpm install` 都要联网（pnpm 只肯用和项目同盘的 store，所以镜像里
        //   预热的那份它根本不看），本机实测能到 56 秒一次、最坏撞满就绪超时。
        //   挂上之后是同盘硬链，不联网、秒级。理由详见 config.pnpmStoreDir。
        `${config.pnpmStoreDir}:/workspace/.pnpm-store`,
      ],
      NetworkMode: config.dockerNetwork,
      NanoCpus: limits.cpus * 1e9,
      Memory: limits.memoryMb * 1024 * 1024,
      // ★ MemorySwap 必须显式等于 Memory，即**禁用 swap**。
      // Docker 只设 --memory 时会默认给等量 swap，于是越限的进程会去刷 swap 而不是
      // 被 OOM 杀掉：表现是"卡住直到超时"（实测：吃内存的进程 30s 没死、容器
      // oomKilled=false），而且一个内存失控的生成应用会拖垮**整台宿主**。
      // 设成相等之后越限立刻被 cgroup 干掉，failure 也能被正确识别为"内存超限"。
      MemorySwap: limits.memoryMb * 1024 * 1024,
      PidsLimit: limits.pids,
      // 沙箱是可丢的：崩了不自动重启，我们靠 inspect 看退出原因
      RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
    },
  })

  await container.start()
  return { containerId: container.id, port, host, containerName: name }
}

async function removeByName(name: string): Promise<void> {
  const found = await docker.listContainers({ all: true, filters: { name: [name] } })
  for (const c of found) {
    if (!c.Names.some((n) => n === `/${name}`)) continue
    const container = docker.getContainer(c.Id)
    await container.remove({ force: true, v: true }).catch(() => {})
  }
}
