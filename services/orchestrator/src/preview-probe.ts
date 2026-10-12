import { request } from 'node:http'
import { config } from './config.ts'

/**
 * 探针：**某个地址现在能不能打开**。
 *
 * 为什么不只用 executor 的容器健康检查：那一层只证明"容器里的进程活着"，
 * 而用户要的是"发过去的请求能到"。两者之间还隔着 edge 的路由表——
 * 容器起来了但 Traefik 还没把 label 收进路由表时，地址会短暂 404
 * （预览那边踩过并因此加了这个探针；**发布这边同样需要**：
 * 不探就返回"发布成功"，用户点开线上地址看到的是 404）。
 *
 * ⚠️ 必须用 node:http 手写请求而不是 fetch()：我们要指定 Host 头，
 * 而 fetch/undici 对 Host 这类头有额外处理，用 http.request 最直白。
 */
export function probeHost(host: string, path = '/'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        // 直连 edge 的回环地址，靠 Host 头让它按域名路由
        host: '127.0.0.1',
        port: config.previewPort,
        path,
        method: 'GET',
        headers: { Host: host },
        timeout: 3000,
      },
      (res) => {
        res.resume()
        resolve((res.statusCode ?? 500) < 400)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

export async function waitForHost(host: string, timeoutMs: number, path = '/'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeHost(host, path)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * 预览地址（`p-<id>`）能不能打开。
 *
 * ⚠️ `path` 默认 `/` 只对**静态**项目成立（产物一铺好 `/` 就 200）。
 * 组合出来的项目（S3.5）是「nginx 在前 + 后端在 3001」，`/` 是 nginx 从磁盘伺服的
 * 前端产物 —— 后端根本没起来它也是 200。所以调用方**必须把项目自己的 healthPath 传进来**，
 * 那条路径会穿过 nginx 打到后端，才代表"用户真能用"。
 */
export function probePreview(projectId: string, path = '/'): Promise<boolean> {
  return probeHost(`p-${projectId}.${config.previewDomain}`, path)
}

export function waitForPreview(projectId: string, timeoutMs: number, path = '/'): Promise<boolean> {
  return waitForHost(`p-${projectId}.${config.previewDomain}`, timeoutMs, path)
}
