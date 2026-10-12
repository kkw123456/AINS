import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 端口 5173 是 DESIGN §4.1 定死的（8000 被 glitchtip 占着，后端在 8800）。
 * strictPort：被别人占了就**显式失败**，别静默换一个口——那样文档里写的地址就不对了。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // 绑 0.0.0.0：WSL 里跑，Windows 侧的浏览器要能访问到
    host: true,
    // ⚠️ 仓库在 /mnt/d（9P），**inotify 事件不跨这个边界**——不开轮询的话
    // Vite 会一直吐旧模块，改代码在浏览器里完全没反应（实测踩过：改了模板默认值，
    // 刷新十几次都还是旧的）。这是 bug 不是性能取舍，别为了省点 CPU 关掉它。
    watch: { usePolling: true, interval: 300 },
    proxy: {
      // orchestrator **没有 CORS**，所以浏览器侧一律走同源代理，不打它的 8800。
      // SSE（/api/projects/:id/stream）也走这条——http-proxy 默认不缓冲流式响应。
      '/api': {
        target: 'http://127.0.0.1:8800',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // shadcn 生成的组件一律用 `@/lib/utils` 这种绝对路径，所以要铺这个别名。
      // tsconfig.json 里的 paths 也要同步（那管类型检查，这个管打包）。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // @webgen/shared 的 exports 直接指向 src/index.ts（全仓没有构建步骤）。
      // 前端只 import type 它，走别名让 TS 和 Vite 都能解析到源码。
      '@webgen/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
})
