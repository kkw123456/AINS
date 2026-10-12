import { createHash } from 'node:crypto'
import {
  APP_PORT,
  BACKEND_IMAGE,
  DATA_DIR,
  EDGE_PORT,
  FRONTEND_IMAGE,
  stackDeps,
  type Backend,
  type Stack,
} from '@webgen/shared'
import type { TemplateSpec } from '@webgen/shared'

/**
 * 从一份**组合**推导出：Dockerfile、镜像 tag、TemplateSpec、nginx 配置。
 *
 * ★ 这是整件事的核心取舍：**不换流水线，只换"模板从哪来"**。
 * 下游（createSandbox / 发布 / 快照 / 实例）全都只认 `TemplateSpec`，
 * 所以它们一行都不用改 —— 组合只是在更上游把 spec 算出来。
 *
 * 全是纯函数，没有副作用，方便单独验证。
 */

/**
 * 工作区**布局版本**（S4）：
 *   1 = 旧的扁平布局（种子铺在工作区**根**）
 *   2 = 新的分层布局（`backend/` + `frontend/` + `deploy/`）
 *
 * 老项目（`projects.layout_version=1`）走 1，spec/种子/nginx 都回落到老路径；
 * 新项目走 2。**不迁移工作区**，只让两套布局并存（见 db 的迁移注释）。
 */

/** nginx 配置在工作区里的位置，随布局变 */
function nginxConfPath(layout: number): string {
  return layout >= 2 ? '/workspace/deploy/nginx.conf' : '/workspace/nginx.conf'
}

/** 前端产物目录（nginx 的 root），随布局变 */
function frontendDist(layout: number): string {
  return layout >= 2 ? '/workspace/frontend/dist' : '/workspace/dist'
}

/** 后端工作目录的前缀命令（`cd` 必须在 `exec` 之前，见 specFor） */
function cdBackend(layout: number): string {
  return layout >= 2 ? 'cd /workspace/backend && ' : ''
}

/** 组合的稳定摘要。**组合变了它就变**，用来判断"要不要重建镜像"。 */
export function recipeHash(stack: Stack): string {
  // 数据段**排序**后再入摘要：`["redis","mysql"]` 和 `["mysql","redis"]` 是同一门组合，
  // 不该产出两个镜像 tag。
  const canonical = JSON.stringify({
    f: stack.frontend,
    b: stack.backend,
    d: [...stack.data].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/**
 * 项目镜像的 tag。
 *
 * ⚠️ 前缀**故意不是 `webgen/`**：`NodeInfo.images` 按那个前缀过滤（见 routes/node.ts），
 * 而 `scripts/smoke.sh` 有条断言在检查那个列表；前端的 `lib/stacks.ts` 也靠
 * `^webgen\/([^:]+)` 从镜像名推语言。换个前缀，这三处全都不用动。
 */
export function imageTagFor(projectId: string, stack: Stack): string {
  return `webgen-app/${projectId}:${recipeHash(stack)}`
}

/**
 * node 的工具链要从 `webgen/node` 里拷过来（前端构建要用）。
 *
 * ⚠️⚠️ **必须整目录拷，不能逐个文件拷** —— `COPY --from` 对**单个文件路径**会把
 * 符号链接**解引用成实体文件**。而 `/usr/local/bin/pnpm` 正是一个软链
 * （指向 `../lib/node_modules/pnpm/bin/pnpm.mjs`）：解引用之后它变成放在
 * `/usr/local/bin/` 下的那个 shim 文件本身，于是它按自己的位置去找 `../dist/pnpm.mjs`
 * —— 算出 `/usr/local/dist/pnpm.mjs`，**pnpm 直接不可用**（实测踩到）。
 * 拷**目录**时 Docker 会原样保留软链。
 *
 * 代价是把 node 镜像的 `docker-entrypoint.sh` 也捎进来了（无害：它只在该镜像
 * 自己是 entrypoint 时才跑，而我们从后端镜像继承 entrypoint）。
 */
const NODE_COPY_SOURCE = FRONTEND_IMAGE

/**
 * 生成项目的 Dockerfile。
 *
 * **规则：基座 = 后端的镜像；有前端就 COPY node 进来。**
 * 这条成立的前提是所有基座都是 **glibc**（node 的二进制动态链接 glibc，
 * 拷进 musl 的 alpine 跑不起来）—— 所以 `webgen/go` 已经从 alpine 换成了 Debian。
 *
 * 这里**不装任何包、不联网**：nginx 已经在语言基础镜像里了（那是为了不把包管理器的
 * 网络抖动带进"建项目"这条路上）。所以这个 build 是纯本地拷层，秒级。
 */
export function dockerfileFor(stack: Stack): string {
  const lines: string[] = [
    '# ⚠️ 由平台生成，别手改 —— 改的是 packages/shared 的 stack.ts /' ,
    '#    services/executor/src/images/recipe.ts。',
    `# 组合：后端=${stack.backend} 前端=${stack.frontend ?? '无'} 数据=${stack.data.length ? stack.data.join('+') : '无'}`,
    '# 镜像 tag 里带组合摘要，所以组合一变 tag 就变、镜像会重建。',
    '',
    `FROM ${BACKEND_IMAGE[stack.backend]}`,
  ]

  // ★ 只有**需要构建的前端**（vue/react）才拷 node 工具链。纯静态页（static）不构建，
  //   也就不需要 node —— 少拷两层，镜像更小、容器起得更快。
  if (stack.frontend && stack.frontend !== 'static') {
    lines.push(
      '',
      `# 前端构建要 node：从 ${NODE_COPY_SOURCE} 拷工具链（**本地层拷贝，不联网**）。`,
      '# ⚠️ 整目录拷（保软链），**别拆成逐个文件** —— 见上面 NODE_COPY_SOURCE 的说明。',
      `COPY --from=${NODE_COPY_SOURCE} /usr/local/bin /usr/local/bin`,
      `COPY --from=${NODE_COPY_SOURCE} /usr/local/lib/node_modules /usr/local/lib/node_modules`,
    )
  }

  lines.push(
    '',
    '# 不写 USER/WORKDIR：基座镜像已经在末尾设好了（uid 10001 + /workspace），',
    '# 而 COPY 一律以 root 执行，不受 USER 影响。',
    '',
  )
  return lines.join('\n')
}

/**
 * 项目自己的 nginx 配置，**写进工作区**（是项目代码，agent 可以改）。
 *
 * 为什么不烤进镜像：那样它就成了 agent 改不动的黑盒，而"加一条路由"是完全正当的需求。
 * 当然代价是 agent 也可能改坏它 —— 那是项目自己的事，verify 会拦住。
 *
 * ⚠️ 这几条 pid/log/temp 路径**必须**指向 /tmp：容器里的进程是 uid 10001，
 * 而 nginx 默认要写 /var/log/nginx、/run，那些是 root 属主 —— 不改就 permission denied 起不来。
 */
export function nginxConfFor(stack: Stack, layout = 2): string {
  const hasFe = Boolean(stack.frontend)
  // 纯静态页的产物就是 `frontend/` 本身（没有构建、没有 dist）；vue/react 是 `frontend/dist`。
  const root = stack.frontend === 'static' ? '/workspace/frontend' : frontendDist(layout)
  return `# 由平台生成。改它之前先想清楚：这是给"用户看到的那一份"做入口的。
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events { worker_connections 256; }

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log off;
  sendfile on;

  # 非 root（uid 10001）跑，这些默认路径都是 root 属主，必须挪到 /tmp
  client_body_temp_path /tmp/nginx-client-body;
  proxy_temp_path       /tmp/nginx-proxy;
  fastcgi_temp_path     /tmp/nginx-fastcgi;
  uwsgi_temp_path       /tmp/nginx-uwsgi;
  scgi_temp_path        /tmp/nginx-scgi;

  server {
    listen ${EDGE_PORT};
${hasFe ? `    root ${root};\n    index index.html;\n` : ''}
    # 后端在容器内的另一个端口上，只有 nginx 认识它 —— 对外只有一个口（${EDGE_PORT}）
    location /api/ {
      proxy_pass http://127.0.0.1:${APP_PORT};
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }

    # 健康检查也走 nginx：**用户看到的那条路径能不能打开**才是它要证明的事，
    # 光证明"容器里的进程活着"不够（§4.1 踩过：容器起了但路由没生效）
    location = /health {
      proxy_pass http://127.0.0.1:${APP_PORT}/health;
    }

${hasFe
  ? `    # 前端产物；带扩展名的缺文件老实 404，不兜成 index.html（否则会变成难查的 JS 语法错误）
    location / {
      try_files $uri $uri/ /index.html;
    }`
  : `    # 没有前端：整个站点就是后端（API / SSR）
    location / {
      proxy_pass http://127.0.0.1:${APP_PORT};
      proxy_set_header Host $host;
    }`}
  }
}
`
}

/** 后端的启动命令。它听**内部**端口（对外那个口归 nginx）。命令里已 `cd` 到后端目录，用相对路径。 */
function backendRunCommand(backend: Backend, layout: number): string {
  const v2 = layout >= 2
  switch (backend) {
    case 'node':
      return v2 ? 'node dist/server.js' : 'node server.mjs'
    case 'python':
      return v2
        ? 'uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT'
        : 'uvicorn app:app --host 127.0.0.1 --port $APP_PORT'
    case 'go':
      return '/tmp/app'
    case 'java':
      return 'java -jar target/app.jar --server.port=$APP_PORT'
  }
}

/**
 * 后端的**构建**命令。没有编译步骤的后端返回 undefined。
 *
 * 这几条和模板目录下各 template.json 里的 buildCommand 是同一件事 ——
 * 组合项目走的是这条推导路径，模板项目走的是读 JSON 那条，两边别改岔。
 * （go 的产物放 /tmp 不放工作区：工作区会被快照/git 管，构建产物不该进去。）
 */
function backendBuildCommand(backend: Backend, layout: number): string | undefined {
  const cd = cdBackend(layout)
  const v2 = layout >= 2
  switch (backend) {
    case 'node':
      // 新布局的 Node 后端是 **TypeScript 工程**（tsc 编到 dist/），所以要装依赖 + 构建。
      // 老布局（v1）的 node 种子是零依赖单文件，没有构建步骤。
      return v2 ? `${cd}pnpm install --prefer-offline && pnpm run build` : undefined
    case 'python':
      return undefined
    case 'go':
      // 新布局入口在 `cmd/server`；老布局 main 就在根。
      return `${cd}go build -o /tmp/app ${v2 ? './cmd/server' : '.'}`
    case 'java':
      return `${cd}mvn -q package -DskipTests`
  }
}

/**
 * 从组合推导出 TemplateSpec。**下游只认这个**，所以组合支持的每一样东西
 * 最终都收敛到它身上。
 */
export function specFor(stack: Stack, image: string, layout = 2): TemplateSpec {
  // ★ 构建命令是**两段拼起来的**，不是二选一：
  //   前端要 `pnpm install && pnpm build`（产出 dist/）——**纯静态页除外，它不构建**；
  //   后端要各自的编译（go build / mvn package）—— 组合项目两件事都要做。
  //   曾经只写前端那一段，症状是 go/java 项目"前端好好的、后端 /api 全 502"，
  //   因为 target/app.jar 和 /tmp/app 根本没被构建出来。
  // 用 `&&` 串：前一段失败就整条失败，容器直接退出把真实错误带出来，别硬撑。
  const frontendBuild =
    stack.frontend && stack.frontend !== 'static'
      ? layout >= 2
        ? 'cd /workspace/frontend && pnpm install --prefer-offline && pnpm build'
        : 'pnpm install --prefer-offline && pnpm build'
      : null
  const buildSteps = [frontendBuild, backendBuildCommand(stack.backend, layout)].filter(
    (s): s is string => Boolean(s),
  )

  const conf = nginxConfPath(layout)

  return {
    // 组合出来的项目永远是服务型：容器里跑着 nginx + 后端进程。
    // 纯静态站（没有后端）走的是另一条路 —— 那是 vue-static 那种模板，
    // 由共享静态伺服承担（§4：静态实例 0 个专属容器），不需要每项目一个镜像。
    kind: 'service',
    image,
    // ★ 对外端口是 **nginx 的**；Traefik 只路由这一个口
    port: EDGE_PORT,
    buildCommand: buildSteps.length > 0 ? buildSteps.join(' && ') : undefined,
    // nginx 先起（不带 daemon off，它自己 daemon 化后立即返回），
    // 然后 `cd` 到后端目录、`exec` 后端 —— **后端在前台**：它一崩容器就退出，
    // `/sandboxes/:id/wait` 会走"容器没起来 + 带出退出前的日志"那条分支，
    // 把真实原因给到 agent。反过来（nginx 前台）后端崩了只会一直回 502，失败信息就淹了。
    // ⚠️ `cd` 必须在 `exec` 之前，且**不能**塞进 backendRunCommand（否则成了 `exec cd`，非法）。
    runCommand:
      `nginx -t -c ${conf} && ` +
      `nginx -c ${conf} && ` +
      `${cdBackend(layout)}exec ${backendRunCommand(stack.backend, layout)}`,
    healthPath: '/health',
    // 组合项目的后端听**内部口**（APP_PORT=3001），`port` 那个 8080 是 nginx 的。
    // 提示词据此告诉 agent 后端要监听哪个口（否则会绑到 8080、和 nginx 撞）。
    backendPortEnv: APP_PORT,
    // ★ 选了 sqlite 才注入 WEBGEN_DATA_DIR。**不注入就是"没有本地文件存储"** ——
    //   种子看到它没定义就退回内存态，重启归零。mysql/redis 的连接串不走这里，
    //   它们是**供给之后**由平台（orchestrator）按项目注入的（见 S4 的数据服务）。
    env: stack.data.includes('sqlite') ? { WEBGEN_DATA_DIR: DATA_DIR } : {},
    limits: {
      cpus: 1,
      memoryMb: stack.backend === 'java' ? 1024 : 768,
      buildMemoryMb: 2048,
      diskMb: 2048,
      pids: 256,
    },
    // S4 起第一次有执行语义：选了 mysql/redis 就会被供给。
    deps: stackDeps(stack),
  }
}
