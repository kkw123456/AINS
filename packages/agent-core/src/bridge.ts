/**
 * agent-core 与"沙箱"之间的唯一接口。
 *
 * ★ 刻意不依赖 executor 的 HTTP 客户端：agent-core 只认这个形状，
 * 由调用方（orchestrator）把 executor 包成实现。这样：
 *   · agent-core 不知道传输方式（HTTP/本地/远程都行）
 *   · 分布式时换成"经 scheduler 找到的节点"也只是换一个实现
 */

export interface SandboxFileEntry {
  path: string
  name: string
  dir: boolean
  size: number
  /** 因 node_modules/.git 之类被折叠的目录：能看见名字，但没展开 */
  skipped?: boolean
}

export interface SandboxRunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SandboxBridge {
  listFiles(dir?: string): Promise<SandboxFileEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** argv 形式，不接受 shell 字符串——白名单在 executor 侧强制 */
  run(
    cmd: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<SandboxRunResult>
}
