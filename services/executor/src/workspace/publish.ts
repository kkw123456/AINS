import { cp, mkdir, rm, symlink, rename, chmod, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'
import { GuardError } from '../guards.ts'
import { archiveTo } from './git.ts'
import { resolveInWorkspace } from './paths.ts'

/**
 * 发布原语：把「某个版本的东西」物化到边缘/运行侧能读到的地方。
 *
 * 三条路：
 *  - 静态**发布**：工作区的 `dist/` → `sites/<slug>/<version>/`，翻 `current` 软链
 *  - 静态**预览**：工作区的 `dist/` → `previews/<id>/<version>/`，翻 `current` 软链
 *  - 服务**发布**：git 快照的代码 → `releases/<slug>/<version>/`，给生产容器只读挂载
 *
 * 为什么都要拷一份、不能直接指向工作区：
 *  - 工作区一直在被 agent 改，"线上指向一个正在变的目录"等于没有发布；
 *  - §5.2 明确要求「开发沙箱与生产容器严格分离」。
 */

/**
 * 原子翻软链。
 *
 * ⚠️ **不能用 `ln -sfn`** —— 它是"先删再建"，中间那一瞬谁去读就是 404。
 * 正确做法是先在同目录建一个临时软链，再 `rename` 覆盖：同文件系统的 rename 是原子的。
 *
 * 目标用**相对路径**（`../v3` 而不是 `/root/.../v3`）：这样把 `sites/<old>` 整目录改名成
 * `sites/<new>`（改 slug 时要做）之后，软链依然有效。
 */
async function flipSymlink(dir: string, target: string): Promise<void> {
  const tmp = join(dir, `.current.${process.pid}.${Date.now()}`)
  await symlink(target, tmp)
  await rename(tmp, join(dir, 'current')) // 覆盖已有软链也是原子的
}

/**
 * 确保 nginx（以非 root 的 worker 身份读文件）读得到。
 *
 * ⚠️ 不加这一步的话，从工作区拷过来的文件可能带着不适合的权限位，
 * 表现是**清一色 403 而且 nginx 的错误日志里也只说 permission denied**，
 * 很容易误以为是路径配错了。
 */
async function makeWorldReadable(root: string): Promise<void> {
  const walk = async (p: string): Promise<void> => {
    const st = await stat(p)
    await chmod(p, st.isDirectory() ? 0o755 : 0o644)
    if (!st.isDirectory()) return
    for (const name of await readdir(p)) await walk(join(p, name))
  }
  await walk(root)
}

export interface MaterializeResult {
  path: string
  /** `current` 软链现在指向哪个版本（相对） */
  target: string
}

/**
 * 把某个版本的**构建产物**铺到目标根下并翻软链。
 * 静态发布和静态预览共用这一份逻辑，只是根目录不同。
 */
async function materializeArtifact(
  workspaceArtifactDir: string,
  rootDir: string,
  version: number,
): Promise<MaterializeResult> {
  if (!existsSync(workspaceArtifactDir)) {
    throw new GuardError(
      `构建产物目录不存在：${workspaceArtifactDir}。先让项目构建通过（agent 跑一轮 verify），或者检查模板的 artifactDir 配得对不对。`,
    )
  }

  const versionDir = join(rootDir, `v${version}`)
  // 幂等：同一个版本重复发布（比如回滚回同一版）不该残留上一次的旧文件
  await rm(versionDir, { recursive: true, force: true })
  await mkdir(versionDir, { recursive: true })
  await cp(workspaceArtifactDir, versionDir, { recursive: true })
  await makeWorldReadable(versionDir)

  await flipSymlink(rootDir, `v${version}`)
  return { path: versionDir, target: `v${version}` }
}

/** 静态发布：`<workspace>/<artifactDir>` → `sites/<slug>/v<version>/` */
export async function materializeSite(
  projectId: string,
  slug: string,
  version: number,
  artifactDir: string,
): Promise<MaterializeResult> {
  const src = resolveInWorkspace(projectId, artifactDir)
  const root = join(config.sitesDir, slug)
  await mkdir(root, { recursive: true })
  return materializeArtifact(src, root, version)
}

/** 静态预览：同样的产物 → `previews/<id>/v<version>/`，给 `p-<id>` 用 */
export async function materializePreview(
  projectId: string,
  version: number,
  artifactDir: string,
): Promise<MaterializeResult> {
  const src = resolveInWorkspace(projectId, artifactDir)
  const root = join(config.previewsDir, projectId)
  await mkdir(root, { recursive: true })
  return materializeArtifact(src, root, version)
}

/**
 * 服务发布：把某个快照的**代码**导出成 `releases/<slug>/v<version>/`。
 *
 * 用 git archive 而不是复制工作区：导出的只有**已跟踪**文件，
 * 天然没有 node_modules / dist / 未跟踪垃圾，正是 §5.2 说的「该快照代码」。
 */
export async function materializeRelease(
  projectId: string,
  ref: string,
  slug: string,
  version: number,
): Promise<MaterializeResult> {
  const root = join(config.releasesDir, slug)
  const versionDir = join(root, `v${version}`)
  await rm(versionDir, { recursive: true, force: true })
  await mkdir(versionDir, { recursive: true })

  await archiveTo(projectId, ref, versionDir)
  await makeWorldReadable(versionDir)

  await flipSymlink(root, `v${version}`)
  return { path: versionDir, target: `v${version}` }
}

/** 切换已发布静态站的线上版本（回滚就是调它）。目标目录不存在要显式报错，别假装成功。 */
export async function activateSiteVersion(slug: string, version: number): Promise<void> {
  const root = join(config.sitesDir, slug)
  const versionDir = join(root, `v${version}`)
  if (!existsSync(versionDir)) {
    throw new GuardError(`版本 v${version} 的产物已经不在磁盘上了（sites/${slug}/v${version}），无法切回去`)
  }
  await flipSymlink(root, `v${version}`)
}

/** 删项目时把发布物一起清掉（用户已确认：删项目就清发布） */
export async function removeSite(slug: string): Promise<void> {
  await rm(join(config.sitesDir, slug), { recursive: true, force: true })
  await rm(join(config.releasesDir, slug), { recursive: true, force: true })
}

export async function removePreview(projectId: string): Promise<void> {
  await rm(join(config.previewsDir, projectId), { recursive: true, force: true })
}

/** 改 slug 时把已有的发布物改名，否则线上地址会指向一个空目录 */
export async function renameSiteDir(oldSlug: string, newSlug: string): Promise<void> {
  for (const base of [config.sitesDir, config.releasesDir]) {
    const from = join(base, oldSlug)
    if (existsSync(from)) await rename(from, join(base, newSlug))
  }
}
