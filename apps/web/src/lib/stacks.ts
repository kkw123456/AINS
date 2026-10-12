import type { Backend, DataLayer, Frontend, Stack } from '@webgen/shared'
import type { TemplateItem } from '@/api/types'

/**
 * 技术栈的展示元数据与分类。
 *
 * ⚠️ 这份表在前端是**权宜之计**：`GET /api/templates` 只回了
 * `{name, kind, image, port, deps}`，没有给人看的标签、说明和分类。
 * 正经的做法是把 `label` / `blurb` / `tier` 写进各自的 `templates/<name>/template.json`，
 * 由 executor 透出来 —— 那样加一个模板不用回来改前端。
 * 现在先放这儿，并且**对未知模板做了降级**（见 metaOf），新加模板时界面不会崩。
 */

/** 展示分类。**注意这是产品分类，不是语言分类** —— 语言体现在 monogram 和 label 上。 */
export type Tier = 'frontend' | 'backend' | 'data'

export interface StackMeta {
  tier: Tier
  label: string
  /** 小方块里的字，用语言惯用的缩写 */
  monogram: string
  /** 语言惯用色，只用在文字和淡底色上 */
  color: string
  blurb: string
  recommended?: boolean
}

const META: Record<string, StackMeta> = {
  'vue-static': {
    tier: 'frontend',
    label: 'Vue 静态站',
    monogram: 'VUE',
    color: '#41B883',
    blurb: 'Vite 构建到 dist/，由边缘伺服产物。工作台的「构建产物」根只有它有内容。',
  },
  'broken-fixture': {
    // 故意不归入三段产品分类：它是给 smoke-repair 用的测试件，
    // 混进「后端」会让人以为可以拿它建真项目。
    tier: 'backend',
    label: '故意坏的测试件',
    monogram: 'XX',
    color: '#94a3b8',
    blurb: '只给 smoke-repair 脚本用，专门验证「自动修到能跑起来」。别拿它建真项目。',
  },
}

/** 这三段是产品分类，顺序就是展示顺序 */
export const TIERS: { tier: Tier; title: string; hint: string }[] = [
  { tier: 'frontend', title: '前端', hint: '构建成静态产物，由边缘直接伺服' },
  { tier: 'backend', title: '后端', hint: '跑一个常驻服务进程' },
  { tier: 'data', title: '数据服务', hint: 'MySQL / Redis，每项目一库 + 独立 role' },
]

/** 不参与三段分类的模板（测试件），单独一行垫底 */
export const FIXTURES = new Set(['broken-fixture'])

function metaOf(t: TemplateItem): StackMeta {
  const known = META[t.name]
  if (known) return known
  // 未知模板的降级：按 kind 猜分类、按镜像名猜语言，猜不到就用模板名首字母。
  const imageLang = /^webgen\/([^:]+)/.exec(t.image)?.[1]
  const lang: Record<string, { monogram: string; color: string }> = {
    node: { monogram: 'JS', color: '#5FA04E' },
    python: { monogram: 'PY', color: '#3776AB' },
    go: { monogram: 'GO', color: '#00ADD8' },
    java: { monogram: 'JV', color: '#E76F00' },
  }
  const hit = imageLang ? lang[imageLang] : undefined
  return {
    tier: t.kind === 'static' ? 'frontend' : 'backend',
    label: t.name,
    monogram: hit?.monogram ?? t.name.slice(0, 2).toUpperCase(),
    color: hit?.color ?? '#94a3b8',
    blurb: `未登记展示信息，镜像 ${t.image || '未知'}。`,
  }
}

export interface StackOption {
  template: TemplateItem
  meta: StackMeta
}

export interface GroupedStacks {
  frontend: StackOption[]
  backend: StackOption[]
  /** 数据服务：一期没有模板，这是**刻意留的位置**（S4） */
  data: StackOption[]
  /** 测试件之类不参与产品分类的 */
  fixtures: StackOption[]
}

export function groupStacks(templates: TemplateItem[]): GroupedStacks {
  const all = templates.map((template) => ({ template, meta: metaOf(template) }))
  const byLabel = (a: StackOption, b: StackOption) => a.meta.label.localeCompare(b.meta.label, 'zh')

  return {
    frontend: all.filter((o) => !FIXTURES.has(o.template.name) && o.meta.tier === 'frontend').sort(byLabel),
    backend: all.filter((o) => !FIXTURES.has(o.template.name) && o.meta.tier === 'backend').sort(byLabel),
    // 模板可以通过 deps 声明它需要 MySQL/Redis，但那是**依赖**，不是可建的技术栈。
    // 真正能单独建数据服务是 S4 的事，这里恒为空。
    data: [],
    fixtures: all.filter((o) => FIXTURES.has(o.template.name)).sort(byLabel),
  }
}

/** 默认选哪个：推荐项优先，其次是第一个后端，最后退回任意一个 */
export function defaultStack(g: GroupedStacks): string {
  return (
    [...g.frontend, ...g.backend].find((o) => o.meta.recommended)?.template.name ??
    g.backend[0]?.template.name ??
    g.frontend[0]?.template.name ??
    ''
  )
}

// ─────────────────────────────────────────── 组合（S3.5）

/**
 * 组合的三段选项。
 *
 * ⚠️ 这份表是**写死在前端的**，和 `groupStacks` 那套（从 /api/templates 来）不是一回事：
 * 组合不是模板，没有模板目录、也没有预建镜像（镜像按组合当场生成），
 * 所以它不可能从 `/api/templates` 里长出来。三段各自的取值域由
 * `@webgen/shared` 的 `FRONTENDS / BACKENDS / DATA_LAYERS` 定义 —— 这里只是给它配上
 * 人看的标签、缩写和说明。**加一门语言要改两处**（shared 的枚举 + 这里），
 * 这是刻意的：shared 那边是纯类型/纯函数（前端后端都要用），这里是纯展示。
 */
export interface Choice<T> {
  /** null 表示"不要这一段" */
  id: T
  label: string
  monogram: string
  color: string
  blurb: string
}

export const FRONTEND_CHOICES: Choice<Frontend | null>[] = [
  { id: 'vue', label: 'Vue', monogram: 'VUE', color: '#41B883', blurb: 'Vite 构建成静态产物，由容器里的 nginx 伺服。' },
  { id: 'react', label: 'React', monogram: 'RE', color: '#61DAFB', blurb: '同上，用 React 19 + Vite。' },
  { id: 'static', label: '纯静态页', monogram: 'HTML', color: '#E34F26', blurb: '一段静态 HTML/CSS，由 nginx 直接伺服，**不做构建**。' },
  { id: null, label: '不要前端', monogram: '—', color: '#94a3b8', blurb: '纯 API / SSR：整个站就是后端。' },
]

export const BACKEND_CHOICES: Choice<Backend>[] = [
  { id: 'node', label: 'Node.js', monogram: 'JS', color: '#5FA04E', blurb: '零依赖 node:http；数据层用内置的 node:sqlite。' },
  { id: 'java', label: 'Spring Boot', monogram: 'JV', color: '#E76F00', blurb: '企业级分层骨架 + 统一返回体 + 全局异常处理。构建最慢（Maven + JVM 启动）。' },
  { id: 'go', label: 'Go', monogram: 'GO', color: '#00ADD8', blurb: '标准库 net/http，编译成静态二进制；工具链已预热。' },
  { id: 'python', label: 'Python', monogram: 'PY', color: '#3776AB', blurb: 'FastAPI + uvicorn；镜像里预热好了，不用等 pip。' },
]

/** 数据段是**多选**（可同时要 MySQL 和 Redis）；`sqlite` 与 `mysql` 二选一（关系型存储）。 */
export const DATA_CHOICES: Choice<DataLayer>[] = [
  { id: 'sqlite', label: 'SQLite', monogram: 'DB', color: '#7dd3fc', blurb: '文件落在工作区里，容器重建数据也不丢；不额外占容器。' },
  { id: 'mysql', label: 'MySQL', monogram: 'MY', color: '#00758F', blurb: '共享实例里**每项目一库一账号**，连接串自动注入。和 SQLite 二选一。' },
  { id: 'redis', label: 'Redis', monogram: 'RD', color: '#DC382D', blurb: '共享实例，**按 key 前缀隔离**。可和任一个同时要。' },
  { id: 'minio', label: 'MinIO', monogram: 'S3', color: '#C72C48', blurb: '共享对象存储（S3 兼容），**每项目一个 bucket**，注入 `S3_*`。做「文件系统」。' },
]

/** 首页默认的组合：够简单，又能立刻看出"前端↔后端通了" */
export const DEFAULT_COMPOSED_STACK: Stack = { frontend: 'vue', backend: 'node', data: [] }

/**
 * 快捷预设（S4）：老模板（node-web / fastapi / go-web / java-web）**收敛成了组合预设** ——
 * 它们不再是一个个写死的模板目录 + 预建镜像，而是「前端=纯静态页 + 某后端」这种组合的快捷方式。
 * 点一下就把组合填进选择器，走的还是 `{stack}` 建项目那条路（后端没有"预设"这个概念）。
 */
export interface StackPreset {
  name: string
  label: string
  blurb: string
  stack: Stack
}

export const PRESETS: StackPreset[] = [
  { name: 'node-web', label: 'Node 服务', blurb: 'TypeScript + Fastify + Vue + MySQL/Redis。', stack: { frontend: 'vue', backend: 'node', data: ['mysql', 'redis'] } },
  { name: 'fastapi', label: 'FastAPI', blurb: 'FastAPI + SQLAlchemy + Vue + MySQL/Redis。', stack: { frontend: 'vue', backend: 'python', data: ['mysql', 'redis'] } },
  { name: 'go-web', label: 'Go 服务', blurb: 'chi + zap + sqlx + Vue + MySQL/Redis。', stack: { frontend: 'vue', backend: 'go', data: ['mysql', 'redis'] } },
  { name: 'java-web', label: 'Spring Boot', blurb: 'Spring Boot 分层骨架 + Vue。（Java 暂不支持 MySQL/Redis，见 README）', stack: { frontend: 'vue', backend: 'java', data: ['mysql', 'redis'] } },
]
