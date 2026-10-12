import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_LIMITS, mergeLimits, parseStack, parseTemplate, StackError, TemplateError } from '@webgen/shared'
import type { Backend, Frontend, Stack, TemplateSpec } from '@webgen/shared'
import { config } from '../config.ts'
import { assertSafeId, GuardError } from '../guards.ts'
import { imageTagFor, nginxConfFor, specFor } from '../images/recipe.ts'
import { ensureWorkspace, workspaceDir } from './paths.ts'

/**
 * 模板解析是 executor 的职责（§2.1）——**别把 node 写死在这里**，
 * 加一门语言应该只是加一个模板目录 + 一个镜像。
 */
export async function loadTemplate(name: string): Promise<TemplateSpec> {
  assertSafeId(name, 'template')
  const file = join(config.templatesDir, name, 'template.json')
  if (!existsSync(file)) {
    // S4「工程化模板」删掉了 node-web/fastapi/go-web/java-web 的目录，但**老项目**
    // （projects.template 还是这些名字）仍要能解析出 spec，否则一打开就挂。
    // 所以它们的 spec 冻结在这里（值就是各自 template.json 的原样）。
    const legacy = LEGACY_TEMPLATES[name]
    if (legacy) return legacy
    throw new GuardError(`模板不存在：${name}（找的是 ${file}）`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    throw new TemplateError(`模板 ${name} 的 template.json 不是合法 JSON：${String(err)}`)
  }
  return parseTemplate(raw, name)
}

/**
 * 被 S4 删掉目录的**老模板**。**只增不改** —— 这是历史，改了会影响已存在的项目。
 * 新项目不再走这些名字（老模板已收敛成组合预设，见前端 lib/stacks.ts）。
 */
const LEGACY_TEMPLATES: Record<string, TemplateSpec> = {
  'node-web': {
    kind: 'service',
    image: 'webgen/node:22',
    port: 8080,
    runCommand: 'node server.mjs',
    healthPath: '/health',
    limits: mergeLimits(DEFAULT_LIMITS, { memoryMb: 512 }),
    deps: [],
  },
  fastapi: {
    kind: 'service',
    image: 'webgen/python:3.12',
    port: 8000,
    runCommand: 'uvicorn app:app --host 0.0.0.0 --port $PORT',
    healthPath: '/health',
    limits: mergeLimits(DEFAULT_LIMITS, { memoryMb: 768 }),
    deps: [],
  },
  'go-web': {
    kind: 'service',
    image: 'webgen/go:1.25',
    port: 8080,
    buildCommand: 'go build -o /tmp/app .',
    runCommand: '/tmp/app',
    healthPath: '/health',
    limits: mergeLimits(DEFAULT_LIMITS, { memoryMb: 512 }),
    deps: [],
  },
  'java-web': {
    kind: 'service',
    image: 'webgen/java:21',
    port: 8080,
    buildCommand: 'mvn -q package -DskipTests',
    runCommand: 'java -jar target/app.jar',
    healthPath: '/health',
    limits: mergeLimits(DEFAULT_LIMITS, { memoryMb: 1024 }),
    deps: [],
  },
}

export function templateSeedDir(name: string): string {
  return join(config.templatesDir, name, 'seed')
}

export async function listTemplates(): Promise<string[]> {
  const entries = await readdir(config.templatesDir, { withFileTypes: true })
  const names: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (existsSync(join(config.templatesDir, e.name, 'template.json'))) names.push(e.name)
  }
  return names.sort()
}

/**
 * 把模板的 seed 铺进工作区。**只在工作区还是空的时铺**——
 * 否则会把 agent 已经写出来的代码覆盖掉。
 */
export async function seedWorkspace(
  projectId: string,
  templateName: string,
): Promise<{ seeded: boolean }> {
  const dir = await ensureWorkspace(projectId)
  const entries = await readdir(dir).catch(() => [] as string[])
  if (entries.length > 0) return { seeded: false }

  const seed = templateSeedDir(templateName)
  if (!existsSync(seed)) return { seeded: false }
  await cp(seed, dir, { recursive: true })
  return { seeded: true }
}

/** 删工作区。默认移到回收目录而不是直接删，免得误删没法救。 */
export async function removeWorkspace(projectId: string): Promise<void> {
  const dir = workspaceDir(projectId)
  if (!existsSync(dir)) return
  const trash = join(config.dataDir, 'trash')
  await cp(dir, join(trash, `${projectId}-${Date.now()}`), { recursive: true }).catch(() => {})
  await rm(dir, { recursive: true, force: true })
}

// ─────────────────────────────────────────────── 组合种子（S3.5）

/**
 * 从「一个模板名」**或**「一份组合」解析出 spec。二选一，都不给就报错。
 *
 * 抽成一处是因为**有四个入口**都要做这件事：建沙箱、起生产容器、生产健康检查、
 * 查单个模板。散着写的话，加组合这条路时漏掉哪个入口，那个入口就会拿
 * `stack-go-vue-none` 去磁盘上找模板目录，然后报"模板不存在" ——
 * 而且只在那条少见的路径上复现（实测：发布就是这么挂的，预览和生成却是好的）。
 *
 * ⚠️ 组合的镜像 tag 含 projectId（`webgen-app/<id>:<hash>`），所以必须传进来。
 */
export async function resolveSpec(
  src: { template?: string; stack?: unknown; layout?: number },
  projectId: string,
): Promise<TemplateSpec> {
  // 布局缺省按 2（新布局）：只有显式传 1 的老项目才走扁平布局。
  const layout = src.layout ?? 2
  if (src.stack !== undefined && src.stack !== null) {
    let stack: Stack
    try {
      stack = parseStack(src.stack)
    } catch (e) {
      if (e instanceof StackError) throw new GuardError(e.message)
      throw e
    }
    return specFor(stack, imageTagFor(projectId, stack), layout)
  }
  if (!src.template) throw new GuardError('需要 template 或 stack')
  return loadTemplate(src.template)
}

function backendSeedDir(backend: Backend): string {
  return join(config.seedsDir, 'backend', backend)
}

function frontendSeedDir(frontend: Frontend): string {
  return join(config.seedsDir, 'frontend', frontend)
}

/**
 * 按**组合**铺种子：后端片段 + 前端片段（可选）+ 生成的 nginx.conf。
 *
 * 和 `seedWorkspace` 的关系：那个负责"一个模板一整套、原样拷"，这个负责"按选择拼"。
 *
 * ★ 布局（S4）：`layout>=2` 时三个片段落在**各自的目录**里 ——
 *   `backend/`（后端）、`frontend/`（前端 / 纯静态页）、`deploy/nginx.conf`（平台生成的入口配置）。
 *   这解决了老扁平布局里的隐患：Node 后端一旦变成 TS 工程，它就**也要** `package.json`，
 *   而前端也要 —— 扁平铺法下"同名文件只许一个片段出"就守不住了。分目录之后**不会再撞**。
 *   `layout=1`（老项目）保持"都铺在工作区根"的旧行为。
 */
export async function seedWorkspaceFromStack(
  projectId: string,
  stack: Stack,
  layout = 2,
): Promise<{ seeded: boolean; files: string[] }> {
  const dir = await ensureWorkspace(projectId)
  const entries = await readdir(dir).catch(() => [] as string[])
  // 只在空工作区上铺 —— 否则会把 agent 已经写出来的代码覆盖掉（和 seedWorkspace 同一条规矩）
  if (entries.length > 0) return { seeded: false, files: [] }

  const v2 = layout >= 2
  const files: string[] = []

  const be = backendSeedDir(stack.backend)
  if (!existsSync(be)) throw new GuardError(`后端种子片段不存在：${be}`)
  await cp(be, v2 ? join(dir, 'backend') : dir, { recursive: true })
  files.push(v2 ? `backend/（${stack.backend}）` : `seeds/backend/${stack.backend}`)

  if (stack.frontend) {
    const fe = frontendSeedDir(stack.frontend)
    if (!existsSync(fe)) throw new GuardError(`前端种子片段不存在：${fe}`)
    await cp(fe, v2 ? join(dir, 'frontend') : dir, { recursive: true })
    files.push(v2 ? `frontend/（${stack.frontend}）` : `seeds/frontend/${stack.frontend}`)
  }

  // nginx 配置是**项目代码**（agent 加一条路由是完全正当的需求），所以写在工作区里、
  // 用 `nginx -c <路径>` 启动，而不是烤进镜像当黑盒。
  // ⚠️ 它必须在**片段拷完之后**写：同布局下要是有同名文件会被它盖掉（反过来就悄悄赢了）。
  if (v2) {
    await mkdir(join(dir, 'deploy'), { recursive: true })
    await writeFile(join(dir, 'deploy', 'nginx.conf'), nginxConfFor(stack, layout), 'utf8')
    files.push('deploy/nginx.conf（生成）')
  } else {
    await writeFile(join(dir, 'nginx.conf'), nginxConfFor(stack, layout), 'utf8')
    files.push('nginx.conf（生成）')
  }

  return { seeded: true, files }
}
