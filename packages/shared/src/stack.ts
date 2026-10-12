import type { DepKind } from './types.ts'

/**
 * 技术栈的**组合**（S3.5）。
 *
 * 和"模板"的关系：模板是「一个语言 + 一个种子 + 一个预建镜像」，是**写死的枚举**；
 * 组合是「选几样，平台自己组装」—— 所以组合不能配一个预建镜像（那是乘法），
 * 镜像必须按选中的组合当场生成。
 *
 * ⚠️ 这个文件里**只能有纯类型和纯函数**，不能 import 任何 node 内置模块 ——
 * 前端也会 import 它（技术栈选择器要用这些类型）。
 * 生成 Dockerfile / 推导镜像 tag 那些带 `node:crypto` 的活放在 executor 侧。
 */

export const FRONTENDS = ['vue', 'react', 'static'] as const
export const BACKENDS = ['node', 'python', 'go', 'java'] as const
export const DATA_LAYERS = ['sqlite', 'mysql', 'redis', 'minio'] as const

export type Frontend = (typeof FRONTENDS)[number]
export type Backend = (typeof BACKENDS)[number]
export type DataLayer = (typeof DATA_LAYERS)[number]

export interface Stack {
  /** 没有前端就是纯后端（API / SSR） */
  frontend: Frontend | null
  /** 必填：它决定镜像基座，也是那个常驻进程 */
  backend: Backend
  /**
   * 数据层，**多选**（S4）：可同时要 MySQL 和 Redis。
   * - `sqlite` 是**文件不是进程**（落 `/workspace/data`），不额外占容器；
   * - `mysql` 是共享实例里的**每项目一库一账号**（连接串由平台供给后注入）；
   * - `redis` 是共享实例，**按 key 前缀隔离**（`REDIS_KEY_PREFIX=<id>:`）。
   * `sqlite` 与 `mysql` 是**互斥的关系型存储**（同给时 mysql 优先）；`redis` 正交。
   */
  data: DataLayer[]
}

/** 后端 → 基座镜像。**所有基座都必须是 glibc**（见 dockerfileFor 的说明） */
export const BACKEND_IMAGE: Record<Backend, string> = {
  node: 'webgen/node:22',
  python: 'webgen/python:3.12',
  go: 'webgen/go:1.25',
  java: 'webgen/java:21',
}

/** 前端 → 它需要的构建工具链镜像（都是 node 系） */
export const FRONTEND_IMAGE = 'webgen/node:22'

/** 后端进程在容器内听的**内部**端口。对外的那个口归 nginx（见 specFor） */
export const APP_PORT = 3001

/** nginx 对外的端口，也就是 Traefik 唯一路由的那个口 */
export const EDGE_PORT = 8080

/**
 * 容器内**持久数据目录**。工作区是 bind mount 到宿主的，所以这个目录下的东西
 * 在容器删除/重建之后还在 —— 这就是"数据层"在这个平台上唯一的含义。
 * 选了数据层才会把它注入成 `WEBGEN_DATA_DIR`（没选就完全不注入，种子退回内存态）。
 */
export const DATA_DIR = '/workspace/data'

export class StackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StackError'
  }
}

/** 校验一份组合。**宽容但明确**：不认识的值直接报错，不静默降级成默认值。 */
export function parseStack(raw: unknown): Stack {
  if (raw === null || typeof raw !== 'object') throw new StackError('stack 必须是个对象')
  const o = raw as Record<string, unknown>

  const backend = o.backend
  if (typeof backend !== 'string' || !(BACKENDS as readonly string[]).includes(backend)) {
    throw new StackError(`backend 必须是 ${BACKENDS.join(' / ')} 之一，收到 ${JSON.stringify(backend)}`)
  }

  // 前端和数据层都可以为 null（不要这一层）
  const frontend = o.frontend ?? null
  if (frontend !== null && (typeof frontend !== 'string' || !(FRONTENDS as readonly string[]).includes(frontend))) {
    throw new StackError(`frontend 必须是 null 或 ${FRONTENDS.join(' / ')} 之一，收到 ${JSON.stringify(frontend)}`)
  }

  // 数据层**多选**。宽容但明确：接受 `null` / 单值字符串 / 数组三种写法
  //   （单值是为了兼容 S3.5 的旧调用），不认识的值直接报错，不静默降级。
  const rawData = o.data ?? null
  const data: DataLayer[] = []
  if (rawData !== null) {
    const arr = Array.isArray(rawData) ? rawData : [rawData]
    for (const item of arr) {
      if (typeof item !== 'string' || !(DATA_LAYERS as readonly string[]).includes(item)) {
        throw new StackError(`data 的元素必须是 ${DATA_LAYERS.join(' / ')} 之一，收到 ${JSON.stringify(item)}`)
      }
      if (!data.includes(item as DataLayer)) data.push(item as DataLayer)
    }
  }

  return {
    frontend: frontend as Frontend | null,
    backend: backend as Backend,
    data,
  }
}

/**
 * 组合需要的**依赖服务**（§6）。S4 起第一次有了执行语义：
 * `data` 里选了 mysql / redis，就会被供给（建库建账号 / 注入连接串）。
 * `sqlite` 是文件、不是依赖服务，不产出 dep。
 */
export function stackDeps(stack: Stack): DepKind[] {
  const deps: DepKind[] = []
  if (stack.data.includes('mysql')) deps.push('mysql')
  if (stack.data.includes('redis')) deps.push('redis')
  if (stack.data.includes('minio')) deps.push('minio')
  return deps
}

/** 给界面用的一句话描述，如「Vue + Go + MySQL + Redis」 */
export function stackLabel(stack: Stack): string {
  const parts = [
    stack.frontend ? labelOfFrontend(stack.frontend) : null,
    labelOfBackend(stack.backend),
    ...stack.data.map(labelOfData),
  ]
  return parts.filter(Boolean).join(' + ')
}

/**
 * 组合的**模板名**。组合项目在 `projects.template` 那一列里留下的就是它。
 *
 * ★ 为什么要有这个东西：下游有十来处调用是「拿 project.template 去找 executor 要 spec / 建沙箱」。
 *   让这些地方继续按一个**字符串模板名**工作，就不必逐个改它们的签名、也不必把组合
 *   这个概念漏进发布/快照那几条路。名字里已经把这门组合编码完了，所以它是自解释的：
 *   看见 `stack-go-vue-mysql-redis` 就知道它是什么（数据段是**多个**、用 `-` 连，
 *   空则写 `none`；因为各段的值都不含 `-`，所以逆解析无歧义）。
 *
 * ⚠️ 前缀 `stack-` 是**预留**的：`templates/` 下不许再出现以它开头的目录名。
 *   （executor 的 /templates/:name 会先按组合解析它，解析失败才会去磁盘上找。）
 */
export function stackTemplateName(stack: Stack): string {
  const data = stack.data.length ? stack.data.join('-') : 'none'
  return `stack-${stack.backend}-${stack.frontend ?? 'none'}-${data}`
}

/** `stackTemplateName` 的逆。不是组合名（或值不认识）时返回 null，**不抛**。 */
export function parseStackTemplateName(name: string): Stack | null {
  if (!name.startsWith('stack-')) return null
  const parts = name.slice('stack-'.length).split('-')
  if (parts.length < 3) return null
  const [b, f, ...d] = parts as [string, string, ...string[]]

  if (!(BACKENDS as readonly string[]).includes(b)) return null
  if (f !== 'none' && !(FRONTENDS as readonly string[]).includes(f)) return null

  const data: DataLayer[] = []
  for (const layer of d) {
    if (layer === 'none') continue
    if (!(DATA_LAYERS as readonly string[]).includes(layer)) return null
    if (!data.includes(layer as DataLayer)) data.push(layer as DataLayer)
  }

  return {
    backend: b as Backend,
    frontend: f === 'none' ? null : (f as Frontend),
    data,
  }
}

export function labelOfFrontend(f: Frontend): string {
  return { vue: 'Vue', react: 'React', static: '纯静态页' }[f]
}

export function labelOfBackend(b: Backend): string {
  return { node: 'Node.js', python: 'Python', go: 'Go', java: 'Java' }[b]
}

export function labelOfData(d: DataLayer): string {
  return { sqlite: 'SQLite', mysql: 'MySQL', redis: 'Redis', minio: 'MinIO' }[d]
}
