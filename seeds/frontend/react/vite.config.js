import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ⚠️ outDir 必须是 `dist`：容器里 nginx 的 `root` 写死指向 /workspace/dist
// （见生成的 nginx.conf）。这里改了而 nginx.conf 没跟着改，现象是
// 「构建成功、容器也活着，但打开是一片 404」—— 很容易往别处查。
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
})
