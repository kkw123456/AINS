#!/usr/bin/env node
/**
 * 静态站预览服务器：把一个目录（通常是 dist/）伺服出去。
 *
 * 用法：serve-static <目录相对路径>      端口取 $PORT
 *
 * 为什么不用 `vite preview` / `http-server`：
 *  - `vite preview` 是**开发用**服务器，§1.3 说预览应当是「构建产物 + 生产形态的启动命令」；
 *  - `vite preview` 在沙箱里会**自己退出**（实测：同镜像的 node-web 活了 46 分钟，
 *    而 vite preview 在 18 分钟时 exit 1，日志里只有 pnpm 的 [ELIFECYCLE]，没有报错）。
 *  - 生成出来的项目用什么框架都有可能，预览这一层不该依赖哪个框架的 CLI。
 *
 * 放在镜像里而不是工作区：**agent 改不动它**。写在种子里的 server 文件会被 agent
 * 当成项目代码改掉或删掉，预览就跟着没了。
 *
 * 这是 S3 之前的过渡：§4 说静态实例最终由**边缘直接读产物目录**，那时这个进程就退休了。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? 'dist')
const port = Number(process.env.PORT || 8080)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 路径 jail：不许越出产物目录（生成的代码是"任意代码"，按最坏情况防）
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(root, rel)
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    let info = await stat(file).catch(() => null)
    if (info?.isDirectory()) {
      file = join(file, 'index.html')
      info = await stat(file).catch(() => null)
    }

    // SPA 兜底：没有扩展名又找不到的路径（比如 /settings）回 index.html 交给前端路由。
    // 带扩展名的（/a.js）**不兜** —— 那多半是真的缺文件，兜了会变成"JS 语法错误"这种难查的问题。
    if (!info && !extname(rel)) {
      file = join(root, 'index.html')
      info = await stat(file).catch(() => null)
    }

    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404')
      return
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(await readFile(file))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e))
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`webgen serve-static ${root} on http://0.0.0.0:${port}`)
})
