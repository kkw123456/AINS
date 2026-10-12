import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Stack } from '@webgen/shared'
import { docker } from '../docker/client.ts'
import { GuardError } from '../guards.ts'
import { dockerfileFor, imageTagFor } from './recipe.ts'

/**
 * 按组合 build 出项目镜像。
 *
 * 生成的 Dockerfile 里**一条 RUN 都没有**（基座在本地、`COPY --from` 是本地拷层），
 * 所以整个 build 不联网、**实测 0.2 秒**（冷缓存也一样）。
 * 这条是"S3.5 每项目一个镜像"在时间上能成立的全部原因 ——
 * 别往生成的 Dockerfile 里加 `RUN apt-get install ...` 之类，那会把网络抖动
 * 带进"建项目"这条路上，而那条路**端到端没有任何超时**。
 */

export interface BuildResult {
  image: string
  /** Docker 的构建日志（出错时带出去给人看） */
  log: string
}

export async function buildImageFor(projectId: string, stack: Stack): Promise<BuildResult> {
  const tag = imageTagFor(projectId, stack)

  // 已经建过就直接返回。组合没变 → tag 没变 → 不用重建。
  // （Docker 自己的层缓存也会命中，但少起一次 build 更省。）
  if (await imageExists(tag)) return { image: tag, log: '（镜像已存在，跳过构建）' }

  const ctx = await mkdtemp(join(tmpdir(), 'webgen-img-'))
  try {
    await writeFile(join(ctx, 'Dockerfile'), dockerfileFor(stack), 'utf8')
    return await runBuild(ctx, tag)
  } finally {
    await rm(ctx, { recursive: true, force: true }).catch(() => {})
  }
}

async function runBuild(ctx: string, tag: string): Promise<BuildResult> {
  // 用系统的 tar 打上下文，不引 tar 库 —— `git.ts` 的 archiveTo 也是这么做的。
  // `-C ctx .` 而不是列文件名：以后要往上下文里加文件（比如种子）时不用改这里。
  const tar = spawn('tar', ['-cf', '-', '-C', ctx, '.'])
  const tarErr: Buffer[] = []
  tar.stderr.on('data', (b: Buffer) => tarErr.push(b))

  const tarDone = new Promise<void>((resolve, reject) => {
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new GuardError(`打 tar 上下文失败：${Buffer.concat(tarErr).toString()}`)),
    )
  })

  // 注意 tar.stdout 是边产边喂给 docker 的，所以**不能**先 await tarDone 再 build
  // （管道缓冲区一满就死锁）。两个一起等。
  const buildDone = docker
    .buildImage(tar.stdout, { t: tag, rm: true, forcerm: true })
    .then(
      (stream) =>
        new Promise<string>((resolve, reject) => {
          const chunks: string[] = []
          docker.modem.followProgress(
            stream,
            (err) => (err ? reject(err) : resolve(chunks.join(''))),
            (ev: { stream?: string; error?: string }) => {
              if (ev.stream) chunks.push(ev.stream)
              if (ev.error) chunks.push(ev.error)
            },
          )
        }),
    )

  const [log] = await Promise.all([buildDone, tarDone])
  if (!(await imageExists(tag))) {
    throw new GuardError(`build 跑完了但镜像不在（${tag}）。构建日志：\n${log.slice(-2000)}`)
  }
  return { image: tag, log }
}

async function imageExists(tag: string): Promise<boolean> {
  return docker
    .listImages({ filters: { reference: [tag] } })
    .then((list) => list.length > 0)
    .catch(() => false)
}

/** 列某个项目建过的所有镜像（组合改了会留下旧 tag） */
export async function listProjectImages(projectId: string): Promise<string[]> {
  return docker
    .listImages({ filters: { reference: [`webgen-app/${projectId}:*`] } })
    .then((list) => list.flatMap((i) => i.RepoTags ?? []).filter((t) => t !== '<none>:<none>'))
    .catch(() => [])
}

/**
 * 删项目时把它的镜像一并删掉。
 *
 * ⚠️ 不删的话会**线性堆积**：现在机器上 37 个镜像已经占了 16GB，
 * 而每建一个项目就多一个（组合改了还会再多一个旧 tag）。
 */
export async function removeProjectImages(projectId: string): Promise<{ removed: string[] }> {
  const tags = await listProjectImages(projectId)
  const removed: string[] = []
  for (const tag of tags) {
    await docker.getImage(tag).remove({ force: true }).then(
      () => removed.push(tag),
      () => {}, // 被容器占着删不掉就算了，下次再清
    )
  }
  return { removed }
}
