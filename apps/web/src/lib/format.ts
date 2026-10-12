/** 几个纯展示用的小工具，别为这个引依赖。 */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} 分 ${Math.round(s - m * 60)} 秒`
}

/** 「3 分钟前」这种。列表卡片上比 ISO 时间戳好读。 */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** 工具名去掉 MCP 前缀，界面上显示 `write_file` 而不是 `mcp__sandbox__write_file`。 */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '')
}

export const TOOL_LABEL: Record<string, string> = {
  list_files: '列目录',
  read_file: '读文件',
  write_file: '写文件',
  edit_file: '改文件',
  run: '执行命令',
  verify: '验证',
}

export function toolLabel(name: string): string {
  const short = shortToolName(name)
  return TOOL_LABEL[short] ?? short
}
