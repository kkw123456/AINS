---
name: create-portal
description: '在 monorepo 中创建新的 portal 子项目（app）。当用户说"新建项目"、"创建应用"、"create a new portal app"时调用。'
argument-hint: '<project-name> [base-path]'
user-invocable: true
---

# Create Portal — 新建 portal 子项目

基于 `apps/portals/portal` 的标准模板，在 monorepo 中快速创建一个新的 portal 前端应用。

## 硬性规则

1. **统一命名空间。** package name 必须是 `@ai-desktop/<project-name>`
2. **统一版本。** vue 3.5.40、vue-router 4.4.5、element-plus 2.14.3、typescript 5.6.3、vite 8.1.3（构建插件统一由 `@ai-desktop/app-vite` 提供，不再在应用内重复声明版本）
3. **统一 Vite 配置。** `vite.config.ts` 直接 `export default createViteConfig({ ... })`（来自 `@ai-desktop/app-vite`），禁止在应用内重复声明 vue / AutoImport / gzip / UnoCSS / 字体 / 环境注入等插件
4. **统一 TS 配置。** 必须 `extends "../../../tsconfig.base.json"`
5. **二级目录部署。** 生产环境 `base` 为 `/<project-name>/`，由 `.env` 的 `VITE_PUBLIC_PATH` 控制、`createViteConfig` 自动读取，无需手写 base
6. **Element Plus CSS。** 使用 `element-plus/theme-chalk/index.css`（2.14+ 路径）
7. **不复制业务代码。** 只搭建骨架（目录结构 + 配置文件 + 最简入口），不拷贝 portal 的业务页面和组件
8. **公共 env 收敛根 `env/`。** `VITE_API_URL` / `ENV` / `VITE_AUTH_URL` 等跨应用一致键已在仓库根 `env/` 共享层，新应用勿重复写；应用目录 `.env*` 只放本应用独有键（`VITE_PUBLIC_PATH` / `VITE_APP_CODE` 等），`createViteConfig` 自动做两级合并

## 执行流程

### 1. 确认参数

向用户确认（如果信息不全）：

| 参数 | 示例 | 说明 |
|------|------|------|
| `project-name` | `my-app` | kebab-case，同时用作目录名、package name、base path |
| `port` | `5173` | Vite dev server 端口，默认自动分配 |
| `with-tailwind` | `false` | 是否需要 Tailwind CSS |
| `with-pxtorem` | `false` | 是否需要移动端 rem 适配 |
| `proxy-target` | `http://localhost:3001` | 后端代理目标，不需要可为空 |

### 2. 创建目录结构

```
apps/portals/<project-name>/
├── .env                          # 应用独有基础变量（VITE_PUBLIC_PATH / VITE_APP_CODE 等）
├── .env.development              # 应用独有开发覆盖（公共键 VITE_API_URL/ENV/AUTH 在仓库根 env/ 共享层）
├── .env.production               # 应用独有生产覆盖
├── .env.development.local        # 本地开发覆盖（不提交，可写 VITE_AUTH_URL 指向本地门户 localhost:8080/login）
├── .gitignore                    # Git 忽略规则
│                                 # （不写 index.html：由 app-vite 按标准模板自动生成，见 3.9）
├── package.json                  # 包信息与依赖
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 构建配置
└── src/
    ├── main.ts                   # 应用入口
    ├── App.vue                   # 根组件
    ├── vite-env.d.ts             # Vite 类型声明
    ├── router/
    │   └── index.ts              # 路由（空路由占位）
    ├── api/                      # API 接口（空目录，.gitkeep）
    └── styles.scss               # 全局样式
```

### 3. 写入文件

按以下模板依次创建，**`{{PROJECT}}`** 替换为用户输入的 project-name，**`{{PORT}}`** 替换为端口。

#### 3.1 `package.json`

```json
{
  "name": "@ai-desktop/{{PROJECT}}",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port={{PORT}}",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "deploy:65": "deploy-project --host 10.9.40.65 --username root --dir dist --serverDir /data/bigdata/{{PROJECT}}/",
    "build:deploy:65": "npm run build && npm run deploy:65"
  },
  "dependencies": {
    "@ai-desktop/app-api": "workspace:*",
    "@ai-desktop/app-auth": "workspace:*",
    "@ai-desktop/app-vite": "workspace:*",
    "@element-plus/icons-vue": "2.3.2",
    "element-plus": "2.14.3",
    "pinia": "2.2.4",
    "vue": "3.5.40",
    "vue-router": "4.4.5"
  },
  "devDependencies": {
    "@types/node": "26.1.1",
    "sass": "1.101.3",
    "typescript": "5.6.3",
    "vite": "8.1.3",
    "vue-tsc": "2.2.0"
  }
}
```

#### 3.2 `tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "paths": {
      "@/*": ["src/*"]
    },
    "noEmit": true,
    "strict": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts"]
}
```

#### 3.3 `vite.config.ts`

```ts
import { createViteConfig } from '@ai-desktop/app-vite'

export default createViteConfig({
  override: {
    css: {
      preprocessorOptions: {
        scss: { api: 'modern-compiler' },
      },
    },
    server: {
      host: '127.0.0.1',
      port: {{PORT}},
      strictPort: true,
      // proxy: { '/api': { target: 'http://localhost:xxxx', changeOrigin: true } }
    },
  },
})
```

> base 已由 `createViteConfig` 自动读取应用 `.env` 的 `VITE_PUBLIC_PATH`（`/<project-name>/`），`@` 别名也内置，无需在应用内手写。
> **有后端代理**：取消 proxy 注释，填入 target 地址。
> **需要 Tailwind**：`createViteConfig({ uno: false })` 关闭 UnoCSS，再追加 `tailwindcss` + `autoprefixer` 到 devDependencies，创建 `postcss.config.js` / `tailwind.config.js`。
> **共享配置能力**（由 `@ai-desktop/app-vite` 提供，无需应用内声明）：vue / vueSetupExtend / AutoImport（vue、vue-router、pinia）/ gzip 压缩（vite-plugin-compression2）/ UnoCSS / 门户字体 CDN / 两级 env 合并（根 `env/` 共享层 + 应用 `.env`）与 `window.__ENV__` 注入。可用 `autoImports: false`、`compression: false` 等按需关闭；如需把第三方静态资源外部化 + 本地 vendor 注入，用 `externals` / `copyVendorAssets`（详见 CLAUDE.md）。

#### 3.4 `.env`（应用独有键；`VITE_API_URL`/`ENV`/`VITE_AUTH_URL` 已在根 `env/` 共享层，勿重复）

```env
# 前端访问前缀（同时被 createViteConfig 用作 base）
VITE_PUBLIC_PATH = /{{PROJECT}}/

# 应用编码（后端按 appCode 拉品牌标题/副标题，并写入自动生成的 index.html 的 app-entry meta；业务方确认后填入）
# VITE_APP_CODE = xxxx

# 可选：仅当需要首屏静态标题/主题色/loading logo 时补（缺省标题留空、主题色 #1677ff、无 logo）
# VITE_APP_TITLE = {{PROJECT_TITLE}}
# VITE_THEME_COLOR = #1677ff
# VITE_APP_LOGO = /logo.png
```

#### 3.5 `.env.development`

```env
# port 端口号（dev 脚本已用 --port，此处仅留档，可删）
VITE_PORT = {{PORT}}
```

#### 3.6 `.env.production`

```env
# 前端访问前缀（与 .env 同值）
VITE_PUBLIC_PATH = /{{PROJECT}}/
```

#### 3.7 `.env.development.local`

```env
# 本地开发覆盖（不提交）：把 SSO 登录页指向本地门户
# VITE_AUTH_URL = http://localhost:8080/login
# 后端代理目标：VITE_PROXY_TARGET_URL = http://127.0.0.1:9999
```

#### 3.8 `.gitignore`

```gitignore
# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# build output
/dist

# env files (local only)
.env.local
.env.*.local

# IDE
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# TypeScript
*.tsbuildinfo
```

#### 3.9 入口 HTML（无需手写）

**不生成 `index.html`**：`createViteConfig` 在配置加载阶段检测到应用没有该文件时，会按 `@ai-desktop/app-vite` 的标准模板自动落盘一份（含 app-entry meta / PWA + iOS 图标 / 首屏 loading 骨架），并已在根 `.gitignore` 忽略，不必也不应提交。

- 要改标题或主题色：在 `.env` 里补 `VITE_APP_TITLE` / `VITE_THEME_COLOR`（可选，缺省标题留空由 AppLayout 按 appCode 拉后端标题，主题色 `#1677ff`）。
- 要引入不进 bundle 的外部脚本（如 tinymce）：在 vite.config.ts 里用 `indexHtml.headTags` / `bodyTags` 传 HTML 片段，路径写根绝对 `/xxx` 由 vite 补 base：
  ```ts
  createViteConfig({ indexHtml: { headTags: ['<script src="/tinymce/tinymce.min.js"></script>'] } })
  ```
- 要完全自定义：手写 `apps/portals/{{PROJECT}}/index.html`（生成器检测到无生成标记即永不覆盖），并按需 `git add -f` 强制入库。自定义文件里的资源路径写根绝对 `/xxx`，由 vite 补 base，**勿手写 `/{{PROJECT}}/` 前缀**（dev 下会被再 rebase 成双前缀）。
- **PWA 同样自动生成**（`pwa` 选项默认开）：`public/manifest.webmanifest` + 一整套图标。想让图标清晰，放一张 **≥512×512 的方形 PNG** 到 `apps/portals/{{PROJECT}}/public/pwa-icon.png`；不放则回退到 `app-logo.png`/`ai-logo.png`/`logo.png`（放大到 512 会糊，构建时会有告警）。生成物已被 gitignore，源图需入库。**不要手写 manifest**（除非确实要接管，那时删掉它的生成标记即可）。

#### 3.10 `src/main.ts`

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/theme-chalk/index.css'
import { initAuth, hasAuth } from '@ai-desktop/app-auth'
import App from './App.vue'
import router from './router'
import './styles.scss'

// 从 URL 参数初始化门户登录态（access_token + tenantId）
initAuth()

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
```

> 如需在应用入口校验登录态，可在 `initAuth()` 后调用 `hasAuth()` 判断，未登录时跳转登录页。
>
> API 调用统一从 `@ai-desktop/app-api` 的 barrel 导入：
> ```ts
> import { sysUserApi, sysMenuApi } from '@ai-desktop/app-api'
> import type { RegisterUserDTO } from '@ai-desktop/app-api'
> ```
> HTTP 请求实例：`import { http } from '@ai-desktop/app-api'`，可按需在 `src/api/` 中封装拦截器。

#### 3.11 `src/App.vue`

```html
<template>
  <router-view />
</template>

<script setup lang="ts">
// App root
</script>
```

#### 3.12 `src/router/index.ts`

```ts
import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  // TODO: add routes
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
```

#### 3.13 `src/vite-env.d.ts`

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
```

#### 3.14 `src/styles.scss`

```scss
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  height: 100%;
  font-family: 'Alibaba PuHuiTi 3.0', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

#app {
  width: 100%;
  height: 100%;
}
```

#### 3.15 `src/api/.gitkeep`（空文件占位）

### 4. 安装依赖并验证

```bash
cd apps/portals/{{PROJECT}}
pnpm install          # 安装依赖
pnpm dev              # 启动验证（应看到空白 Vue 页面）
```

### 5. 确认结果

- [ ] `pnpm dev` 正常启动，无编译错误
- [ ] 浏览器打开 `http://127.0.0.1:{{PORT}}` 看到空白页面（无报错）
- [ ] `package.json` 中 `name` 为 `@ai-desktop/<project-name>`，依赖含 `@ai-desktop/app-vite: workspace:*`
- [ ] `vite.config.ts` 用 `@ai-desktop/app-vite` 的 `createViteConfig` 组装，`base` 自动取自应用 `.env` 的 `VITE_PUBLIC_PATH`（`/<project-name>/`）
- [ ] `tsconfig.json` 正确 extends base

## 反模式

| 不要 | 要 |
|------|-----|
| 拷贝 portal 的业务页面和组件 | 只搭骨架，`src/` 下从零开始 |
| 使用不同版本的 vite/vue | 严格使用模板中的版本号 |
| 在 vite.config.ts 里重复声明 vue/AutoImport/压缩等插件 | 用 `@ai-desktop/app-vite` 的 `createViteConfig` |
| 在应用 `.env*` 重复写 `VITE_API_URL`/`ENV`/`VITE_AUTH_URL` | 已收敛到仓库根 `env/` 共享层，应用目录只放独有键 |
| 忘记设置 `base` | 生产路径必须是 `/<project-name>/` |
| 在 package.json 中添加不必要的依赖 | 按需添加，从最小集开始（构建插件由 app-vite 提供，不必列在应用里） |
| 创建非 kebab-case 的目录名 | 目录名 = package name 后缀 = base path |
