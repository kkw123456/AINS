import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from '../config.ts'
import { GuardError } from '../guards.ts'
import { workspaceDir } from './paths.ts'

const run = promisify(execFile)

/**
 * 工作区的快照 = git commit（§5.1）。
 *
 * ★ **git 跑在宿主上、由 executor 执行，不在沙箱里。** 三个理由：
 *  ① 四个沙箱镜像里**只有 Java 那个有 git**（Maven 带进来的），node/python/go 都没有；
 *  ② §5.3 定了「文件读写在沙箱之外完成，但走 executor」——沙箱冷着也要能回滚；
 *  ③ 快照历史不该由 agent 经手。
 *
 * 以 **root** 执行（executor 本身就跑在 root 下）。
 *
 * 本来想降成 uid 10001 让 `.git` 的属主和沙箱用户一致，**但那样根本跑不起来**：
 * `$WEBGEN_DATA_DIR` 默认是 `/root/webgen-data`，而 `/root` 是 0700 ——
 * 沙箱里能访问工作区是因为那是 **bind mount**（走挂载点，不穿越 `/root`），
 * 宿主上以 10001 跑 git 就直接 `Permission denied`。
 *
 * 代价：`.git` 归 root，而下一次 `createSandbox` 的 `chownTree` 会把它一并交给 10001。
 * 也就是说"agent 碰不到快照历史"这个性质**本来就不成立**（见方案文件的风险清单）。
 */

/** 每个仓库都要带的 git 参数。集中一处，免得漏掉某个调用点。 */
const GIT_BASE = [
  // 工作区属主是 10001 而调用者是 root，不声明安全目录 git 直接拒绝操作
  '-c',
  'safe.directory=*',
  '-c',
  'user.name=webgen',
  '-c',
  'user.email=webgen@localhost',
  // 容器里没配 gpg；不关掉的话 commit 会去找签名密钥然后失败
  '-c',
  'commit.gpgsign=false',
  // 工作区在 ext4 上，别让 autocrlf 改写行尾——生成的代码原样进快照
  '-c',
  'core.autocrlf=false',
]

/**
 * 首次建仓要写的忽略规则。
 *
 * ⚠️ 这份清单不是"顺手加的"：不写它，`git add -A` 会把 `node_modules`（几万个文件）
 * 塞进仓库，第一次快照就能把磁盘和耗时打爆。dist/build 同理——它们是**构建产物**，
 * 发布时从工作区拷，不该进版本历史。
 */
const DEFAULT_GITIGNORE = `# webgen 自动生成：工作区快照要忽略的东西
# node_modules 几万个文件，进仓库会把快照打爆
node_modules/
.pnpm-store/

# 构建产物：发布时单独拷，不进版本历史
dist/
build/
out/
target/
.next/
.nuxt/
__pycache__/
*.pyc
.venv/
venv/

# 缓存与日志
.cache/
.mypy_cache/
.pytest_cache/
*.log

# 构建锁：编辑容器和预览容器共享工作区，两个启动脚本要靠它串行化构建
# （见 docker/script.ts）。它不属于项目代码，别让它每次都产生一个快照。
.webgen-build.lock

# 数据层的落点（选了 SQLite 才有）：那是**运行期状态**，不是源码。
# 不让它进快照有两个理由：① 二进制库文件会把快照撑大；
# ② 回滚代码时**不该把数据一起倒回去** —— 用户要的是"回到上一版代码"，
#    不是"把数据也退回当时那个样子"。
data/
`

async function git(ws: string, args: string[], opts: { maxBuffer?: number } = {}) {
  return run('git', ['-C', ws, ...GIT_BASE, ...args], {
    // HOME 指向工作区：git 要有个能写的地方放 global config，别去动 /root/.gitconfig
    env: { ...process.env, HOME: ws },
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
  })
}

/**
 * 确保工作区是个 git 仓库。
 *
 * ⚠️ 如果 `.git` 不见了（**agent 用 `run` 工具 `rm -rf` 掉是可能的**，rm 在白名单里），
 * 这里会重建仓库——丢掉那段历史，但工作区文件还在。调用方要**大声记日志**，
 * 因为这意味着"回滚到上一版"会静默少掉一段时间。
 */
export async function ensureRepo(projectId: string): Promise<{ created: boolean }> {
  const ws = workspaceDir(projectId)
  const created = !existsSync(join(ws, '.git'))

  if (created) await git(ws, ['init', '-q', '-b', 'main'])

  const ignore = join(ws, '.gitignore')
  if (!existsSync(ignore)) await writeFile(ignore, DEFAULT_GITIGNORE, 'utf8')

  return { created }
}

export interface CommitResult {
  committed: boolean
  sha: string | null
  /** 没有改动时为 true，UI 上就不必说"已提交" */
  nothingToDo: boolean
}

/**
 * 提交一次快照。**没有改动就不提交**（否则每次 verify 都堆一个空 commit）。
 *
 * 注意：`.gitignore` 会把 node_modules/dist 挡在外面，所以"agent 只改了源码"
 * 才会产生快照；只跑了个构建是不会有新版本的——这是对的。
 */
export async function commit(projectId: string, label: string): Promise<CommitResult> {
  const ws = workspaceDir(projectId)
  const { created } = await ensureRepo(projectId)
  if (created) {
    // 走到这里意味着这个项目要么是第一次快照，要么 `.git` 被删过（agent 的 rm 在白名单里）。
    // 后者会**静默丢掉一段历史**，所以这条日志必须留。
    console.warn(`[git] 工作区 ${projectId} 之前没有 .git，已建仓 —— 若是被删过，该项目的快照历史有断裂`)
  }

  const { stdout: status } = await git(ws, ['status', '--porcelain'])
  if (status.trim().length === 0) {
    // 没有改动就不提交：否则每次 verify 都会堆一个空 commit，时间线上一串无意义的点
    const { stdout: head } = await git(ws, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
    return { committed: false, sha: head.trim() || null, nothingToDo: true }
  }

  await git(ws, ['add', '-A'])
  // --no-verify：工作区里可能有用户自己的 hooks，别让它们卡住平台的提交
  await git(ws, ['commit', '-q', '--no-verify', '-m', label || 'snapshot'])

  const { stdout } = await git(ws, ['rev-parse', 'HEAD'])
  return { committed: true, sha: stdout.trim(), nothingToDo: false }
}

export interface GitLogEntry {
  sha: string
  label: string
  /** ISO 时间 */
  date: string
}

/** 列历史。用 0x1f 当分隔符：commit message 里可能有任意字符，只有控制字符安全。 */
export async function log(projectId: string, limit = 200): Promise<GitLogEntry[]> {
  const ws = workspaceDir(projectId)
  if (!existsSync(join(ws, '.git'))) return []

  const { stdout } = await git(ws, ['log', `-n`, String(limit), '--format=%H%x1f%s%x1f%cI'], {
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const [sha = '', label = '', date = ''] = line.split('\x1f')
      return { sha, label, date }
    })
}

/**
 * 把工作区检出到某个快照。
 *
 * ⚠️ 用 `reset --hard` 而不是 `checkout -f <ref> -- .`：
 * 后者**只恢复工作树、不移动 HEAD**，于是回滚完 `git status` 会显示一堆"本地修改"，
 * 下一次快照又把"回滚"当成新改动提交一遍（实测踩到：回滚返回的 head 还是旧版本）。
 * `reset --hard` 一步同时移动 HEAD 和恢复已跟踪文件。
 *
 * ⚠️ **绝不能用 `git clean`**：`node_modules` / `dist` 在 .gitignore 里，
 * `clean -fdx` 会把它们删光，一次回滚就得重装几分钟依赖。
 * `reset --hard` 不碰未跟踪/被忽略的文件，正好。
 */
export async function checkout(projectId: string, ref: string): Promise<{ head: string }> {
  const ws = workspaceDir(projectId)
  if (!existsSync(join(ws, '.git'))) throw new GuardError('这个工作区还没有快照历史')

  await git(ws, ['reset', '--hard', ref])
  const { stdout } = await git(ws, ['rev-parse', 'HEAD'])
  return { head: stdout.trim() }
}

/**
 * 把某个快照的**代码**导出成一个干净的目录（发布服务型项目用）。
 *
 * 用 `git archive` 而不是 checkout 一个工作树：导出的内容只包含**已跟踪**的文件，
 * 天然没有 node_modules / dist / 未跟踪垃圾，也不需要再 clean 一次。
 * 这正是 §5.2 说的「只读镜像 + **该快照代码**」里那份代码。
 */
export async function archiveTo(projectId: string, ref: string, destDir: string): Promise<void> {
  const ws = workspaceDir(projectId)
  if (!existsSync(join(ws, '.git'))) throw new GuardError('这个工作区还没有快照历史')

  // tar 落在工作区外面（root 可写），git 只需要读权限
  const tarPath = join(config.dataDir, `.webgen-archive-${Date.now()}.tar`)
  await git(ws, ['archive', '--format=tar', `--output=${tarPath}`, ref])
  try {
    // 用系统 tar 解出来：git 自己没有"解包到目录"的子命令
    await run('tar', ['-xf', tarPath, '-C', destDir])
  } finally {
    await unlink(tarPath).catch(() => {})
  }
}
