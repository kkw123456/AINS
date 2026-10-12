/**
 * 把 `spec.env`（模板/组合要求的环境变量）转成 docker 的 `KEY=value` 数组。
 *
 * 单独抽出来是因为**沙箱容器和生产容器必须用同一份**：两处各写一遍的话，
 * 迟早只有一处加了新变量，于是"预览好好的、发布出去就少一个变量"——
 * 这种只在生产复现的差异最难查。
 */
export function envPairs(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}
