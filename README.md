# webgen

在线 Web 应用生成平台。设计方案见 [`docs/DESIGN.md`](docs/DESIGN.md)。

**当前进度：S4** —— 工程化模板（企业级分层种子 + 数据服务 MySQL/Redis/MinIO）。
已完成 S0（沙箱链路）、S1（Agent 闭环）、S2（Web 工作台）、S3（快照/回滚/发布）、
S3.5（动态组合技术栈 + 每项目一个镜像）。

## 结构

```
apps/web/               React + Vite 前端（工作台）
services/executor/      ★ 唯一持有 docker socket 的进程
services/orchestrator/  业务后端（无状态）+ 生成会话中心
packages/agent-core/    AgentRunner 接口 + Claude 实现 + 沙箱工具
packages/shared/        类型 / 常量 / 模板契约
packages/db/            schema / 迁移
sandbox/images/         沙箱镜像
templates/              项目模板（模板决定镜像）
infra/                  compose / traefik /（S3）发布站点的静态伺服配置
scripts/                验收脚本
```

## 发布（S3）

**发布是显式动作**：agent 每通过一次构建会自动打一个快照（`created_by=auto`），但**不会自动上线**。
在「版本与发布」里挑一个版本点发布，或者直接把当前这版发出去。

线上地址是 **`<slug>.site.localhost:8088`**（`slug` 可以在同一个面板里改）。
预览地址 `p-<id>` 完全不受影响 —— 它显示的是**工作区当前那份**，线上是你**发布的那份**，
两者刻意分开（§1.3「编辑容器不能当运行容器」）。

### 编辑容器 / 预览容器 / 生产容器是三个东西

S3 之前编辑容器**就是**预览容器（同一个容器、同一个 `p-<id>`），§1.3 那条是被违反的。
现在三个平面各有各的地址与生命周期：

| | 域名 | 容器 | 起停 |
|---|---|---|---|
| **编辑** | `d-<id>.<域名>` | `webgen-sbx-<id>` | 建项目时起；agent 每轮 verify 会重建它 |
| **预览**（服务型） | `p-<id>.<域名>` | `webgen-prev-<id>` | 建项目时起；每轮构建通过后换成新版本 |
| **预览**（静态） | `p-<id>.<域名>` | **没有容器** | 构建通过后把产物铺到 `previews/<id>/current`，共享静态伺服直接读 |
| **生产** | `<slug>.site.<域名>` | `webgen-prod-<slug>-v<n>` | 发布时起，**常驻不回收** |

**所以停掉编辑容器不会影响预览** —— `d-<id>` 404、`p-<id>` 照样 200。
`scripts/smoke.sh` 里就有一条断言在守这个性质。

> 建项目时两（服务型）/一（静态）个容器一起起，是因为**现在还没有闲置回收**：
> 预览容器闲着也不会被停，"按需起"省不下什么，反而让新项目一开始就没有预览。
> 等闲置回收落地（§1.3 那张常驻容器数表：服务型 没人在用 1 / 看预览 2 / 编辑 3），
> 把建项目时那次 `preview/start` 去掉、改成 `/preview-url` 报 cold 时惰性起即可
> —— `POST /api/projects/:id/preview/start` 已经就位。

| | 静态项目 | 服务型项目 |
|---|---|---|
| 线上是什么 | `sites/<slug>/v<n>/` + `current` 软链 | `releases/<slug>/v<n>/` 起一个**常驻生产容器** |
| 发布怎么生效 | 原子翻软链，**毫秒级、无窗口** | 起新容器 → 健康检查 → 切流量 → 停旧版本 |
| 发布失败时 | 基本不会失败（就是拷文件） | **线上完全不受影响**（新容器撤掉，旧的原样在跑） |
| 回滚 | 翻软链回到任一历史版本 | 把停着的那个容器**重新拉起来**（不是重建） |
| 保留 | **所有版本都留**（产物很小） | **只留 current + 上一个**（每个版本都是一个常驻容器） |

> 为什么服务型回滚是"拉起来"而不是"重建"：§4 说的是「停旧版本（**保留上一个供回滚**）」。
> 删掉容器再重建，会重新跑一遍构建、产物可能和当时不一样 —— 那不是"回到那一版"。
> 所以发布新版时对旧容器是 `stop` 而不是 `remove`。

> ⚠️ **「发布原子生效」对两种形态的含义不同**，别混为一谈：静态是真的原子；
> 服务型只能做到"失败时线上不受影响 + 健康通过后尽快切完"，中间有一个短暂窗口。
> 原因是 docker provider 的 label **在容器创建后不可改**，不存在"改路由指向另一端"这种操作。

> ⚠️ **静态项目只能发布当前这一版**：产物就是工作区里现在这份 `dist/`，而工作区一直在被 agent 改。
> 允许发旧快照的话，会"记成旧版本号、发出去的却是新产物"，版本记录就在撒谎。
> 要退回去用**回滚**（历史版本的产物还在磁盘上）。

> ⚠️ 发布返回之前会**探一次线上地址**。少了这一步，"发布成功"就只是"文件拷过去了"的同义词：
> 容器健康 ≠ Traefik 已经把 label 收进路由表，刚发完就去点的人会看到 404。
> 这个坑预览那边当年踩过（见 `preview-probe.ts` 的注释），发布这边同理。

### 静态伺服为什么是一个共享容器

`infra/sites/nginx.conf.template` + compose 里的 `sites` 服务（`nginx:alpine`）。
DESIGN 决策 10 说静态站运行侧 **0 个「专属」容器**（§4 的常驻容器数表也是按这个写的：
静态项目没人在用时 0 个容器）。Traefik 是纯反代、**不伺服静态文件**，所以必须有东西来伺服，
但**不该每站一个** —— 一个 nginx 按 Host 映射到 `sites/<slug>/current` 就够了。

**这里有个必须记住的坑**：共享 nginx 用 `HostRegexp` 兜住所有动态 host，而服务型的容器用精确
`Host(...)`。Traefik 默认按**规则字符串长度**算优先级，正则那条恰好更长，不显式压下去就会
抢走所有请求 —— 症状是"服务型预览打不开、打开的是静态站的 404"。所以共享 nginx 的兜底 router
写了 **`priority: 1`**，服务型生产容器写了 **`priority: 100`**。**这两个数字不是调优，是正确性。**

改完 `nginx.conf.template` 要 `docker compose up -d --force-recreate sites` ——
官方镜像的 envsubst 只在**容器启动时**跑，改了模板不重建是不会生效的（踩过）。

## 模板与镜像

**模板决定镜像**——加一门语言 = 加一个 `sandbox/images/<lang>/Dockerfile` + 一个 `templates/<name>/`。executor 里没有任何语言知识。

| 模板 | kind | 镜像 | 跑法 |
|---|---|---|---|
| `node-web` | service | `webgen/node:22` | `node server.mjs`（零依赖 http） |
| `fastapi` | service | `webgen/python:3.12` | `uvicorn`（镜像里预热了 fastapi） |
| `go-web` | service | `webgen/go:1.25` | `go build` → 跑二进制（只用标准库） |
| `java-web` | service | `webgen/java:21` | **Spring Boot 企业级骨架**：`mvn package` → `java -jar target/app.jar` |
| `vue-static` | **static** | `webgen/node:22` | `pnpm install && pnpm build` → `serve-static dist`，**产物在 `dist/`** |
| `broken-fixture` | service | `webgen/node:22` | 故意崩掉的测试件，只给 `smoke-repair.sh` 用 |

`vue-static` 是唯一的 `static` 模板，工作台左栏的「构建产物」根只有在它下面才有内容
（`artifactDir: dist`）——其余模板是服务型，按 `parseTemplate` 的规定不允许有 `artifactDir`。

### 静态模板为什么不用 `vite preview`

`runCommand` 是 `serve-static dist`（镜像里 `/usr/local/bin/serve-static`，见
`sandbox/images/node/serve-static.mjs`），两个理由：

1. **`vite preview` 在沙箱里会自己退出。** 实测：同镜像的 `node-web`（普通 node http 进程）
   连续存活 46 分钟，而 `vite preview` 在 18 分钟时 `exit 1`，日志里只有 pnpm 的
   `[ELIFECYCLE] Command failed`，**没有任何报错**。同一现象会让 agent 生成的任何
   Vite 项目预览中途消失。
2. **§1.3 要求预览跑的是「构建产物 + 生产形态的启动命令」**，`vite preview` 是开发用服务器。

放在镜像里而不是种子里，是为了**让 agent 改不动它**——写在种子里的 server 文件会被
agent 当成项目代码改掉或删掉，预览就跟着没了。

> 这是 S3 之前的过渡：§4 说静态实例最终由**边缘直接读产物目录**，届时这个进程退休。

### Java（Spring Boot）的两个前提，动它之前先读

1. **`sandbox/images/java/warm/pom.xml` 必须和 `templates/java-web/seed/pom.xml` 的依赖保持一致。**
   镜像构建期会拿 warm 工程真跑一次 `mvn package`，把 spring-boot 那一大坨（上百 MB）落进
   `/opt/m2`。预热之后 1 CPU / 1GB 的沙箱里打包只要 **6 秒**；没有预热则要联网拉几分钟，
   必然撞上 `AGENT_VERIFY_TIMEOUT_MS`（默认 120s）——**表现是 agent 反复"修"一个根本没坏的东西**。
   改了 seed 的依赖就同步改 warm，然后重建镜像。
2. **`@ExceptionHandler(Exception.class)` 兜底会吃掉 404。** Spring 对找不到的静态资源
   （浏览器自动要的 `/favicon.ico` 就是）抛 `NoResourceFoundException`，必须单独接一条，
   否则 404 全变成 500。seed 里已经处理了，别在生成出来的项目里把它删掉。

> ⚠️ **服务型项目默认上限只有 5 个**（`MAX_SERVICE_PROJECTS`）。上面有 **5 个服务型模板**，
> 意味着**每个模板各建一个就满了**。调大 `.env` 里的 `MAX_SERVICE_PROJECTS` 再开发。

## 组合的技术栈（S3.5）

除了「挑一个模板」，还可以**按组合建**：前端（Vue / React / 无）× 后端（Node / Python / Go / Java）
× 数据（SQLite / 无）。选三段，平台当场把它们组装成一个**项目专属镜像**和一个容器。

```bash
curl -X POST localhost:8800/api/projects -H 'content-type: application/json' \
  -d '{"stack":{"frontend":"vue","backend":"go","data":"sqlite"},"prompt":"做一个记账本"}'
```

组合项目在 `projects.template` 那一列里写的是**组合名**（`stack-go-vue-sqlite`，见
`packages/shared/src/stack.ts` 的 `stackTemplateName`）。这一点是刻意的：下游有十来处
（重启编辑容器、刷预览、verify 重建、回滚后重建…）都是"拿一个字符串模板名去 executor 要东西"，
让组合复用一个自解释的字符串，这些地方**一行都不用改**。

### 一个容器，nginx 在前面

`specFor()` 推导出来的 `spec.port` 是 **nginx 的 8080**（Traefik 只路由这一个口），
后端在容器内的 3001 上听、只有 nginx 认识它。启动脚本（`services/executor/src/docker/script.ts`）：

```sh
set -eo pipefail
flock 9                                     # ← 见下面"那把构建锁"
<buildCommand>                              # pnpm build / go build / mvn package
flock -u 9
nginx -t -c /workspace/nginx.conf && nginx -c /workspace/nginx.conf && exec <后端>
```

**后端放前台**（`exec`）：它一崩容器就退出，`/sandboxes/:id/wait` 会走"容器没起来 + 带出退出前的日志"
那条分支，把真实原因给到 agent。反过来（nginx 放前台）后端崩了只会一直回 502，失败信息就淹了。

`nginx.conf` 是**写在工作区里的项目代码**（agent 加一条路由是完全正当的需求），
不是烤进镜像的黑盒。所以它进快照、能 diff、能回滚。

### 和 `docs/DESIGN.md` 的四处偏离

这是**有意的**，不是漏看文档。记在这儿免得后来的人以为文档过时了：

| 文档原话 | 这里的实际做法 | 为什么 |
|---|---|---|
| §2.3「**不造万能镜像**，按模板选、预拉」 | 每项目一个组合镜像 | 组合是动态的，预建是**乘法**（前端 × 后端 × 数据）。而镜像里**一条 `RUN` 都没有**（见下），构建 0.3 秒，不是"几 GB 镜像冷启动"那个场景 |
| §2.3 依赖预热**在镜像构建期**做 | 基础镜像里预热（nginx / Maven / Go 缓存 / pip），**项目层不预热** | 项目层没有任何联网步骤 |
| §4.1「建项目 → 预览可访问 1~2 秒」 | 见下面的实测表，**前端组合 7~33 秒** | 守住的是三条硬超时（最紧的 `smoke-s2.sh` 是 60 秒），15 秒那条在 `smoke.sh` 里只 `echo` 警告 |
| §1.3 生产用**产物镜像**（不含工具链，小） | 生产容器和沙箱**共用同一个镜像** | 换来的是"预览是什么样、线上就是什么样" |

**不在这一轮的**：§6 把「多服务编排（每项目一套 compose）」划到二期 —— 这里做的**不是那件事**，
方向正好相反：把所有东西收进**一个**容器。容器数量比现状还保守。

### 镜像怎么拼：基座 + 多阶段 COPY

规则一句话：**基座 = 后端语言的镜像；有前端就 `COPY --from=webgen/node:22` 把 node 拷进来。**

这条成立的前提是**所有基座都是 glibc** —— node 的二进制**动态链接 glibc**，
拷进 musl 的 alpine 跑不起来（实测 `libdl.so.2 => /lib/x86_64-linux-gnu/…`）。
所以 `sandbox/images/go/` 从 alpine 换成了 `golang:1.25-bookworm`（代价：镜像 333MB → 1.4GB）。
反过来没问题：go 编译器本身是静态的（实测 `Not a valid dynamic program`）。

⚠️ 拷 node 工具链时**必须整目录拷**（`/usr/local/bin` 整个），不能逐个文件 ——
`COPY --from` 对单个文件路径会把**符号链接解引用成实体文件**，而 `/usr/local/bin/pnpm`
正是个软链，解引用之后它按自己的位置去找 `../dist/pnpm.mjs`，算出 `/usr/local/dist/pnpm.mjs`
——**pnpm 直接不可用**。

### 实测数字（1 CPU / 768MB 沙箱，热层缓存）

| 组合 | POST（含起容器） | 到预览可访问 |
|---|---|---|
| 任意后端 + 无前端 | 1.3~1.7 秒 | **0.5~1.5 秒**（java 18~21 秒，Spring Boot 打包 + JVM 启动） |
| node + Vue / React | 1.8 秒 | **5.6~7.6 秒** |
| python + Vue / React | 1.3~13 秒 | **9~16 秒** |
| go + Vue | 10~14 秒 | **14~17 秒** |
| java + Vue | 1.8~18 秒 | **27~32 秒** |

> ⚠️ 这是**热层缓存**下的数字。第一次跑到某个组合要现场提交镜像层（POST 那一列会是 10~18 秒），
> 之后同组合的项目命中 Docker 层缓存（0.3 秒）。`scripts/build-images.sh` 会把 8 种组合各建一次垫上。
>
> ⚠️ 也会见到**离群的慢**（实测有一次 node+vue 花了 142 秒）：宿主忙、或到 npm 镜像的
> 某一次请求卡住。共用 pnpm store（见"四个坑"第 1 条）之后这条路上的联网只剩"store 里没有的包"，
> 所以复现率很低 —— 但它是**会**发生的，别把单次测量当基准。

POST 那一列的波动主要是**项目镜像第一次构建**（同一个组合的后续项目命中 Docker 层缓存，
0.3 秒）。`scripts/build-images.sh` 末尾会把 8 种组合各建一次垫上缓存。

### 四个"踩过才知道"的坑

1. **前端依赖必须能"离网"装。** 这一条踩得最深，值得写全：

   - 直连 `registry.npmjs.org` 时，实测单条请求能挂到 **70 秒**（日志里 `Request took 69867ms`，
     还伴着 `error(23)` 重试），整轮安装 1 分 20 秒起 —— 就绪超时是 60~90 秒，项目直接"起不来"。
     所以 node 镜像里写了 `~/.npmrc` → `registry=https://registry.npmmirror.com`
     （和 java 走阿里云、go 走 goproxy.cn 同一个决定）。**但镜像源只把 1 分 20 秒变成几秒，
     它治不了抖动** —— 换完之后仍然实测到 56 秒一次的静默停顿，于是"建到能看"在
     7 秒到 90 秒之间随机跳。**只靠镜像源是不够的。**
   - **在镜像里预热 pnpm store 是没用的**（试过，白做）：pnpm 只肯用**和项目同一个文件系统**上的
     store，而工作区是 bind mount（另一个 fs）—— 于是它**无视 `store-dir` 配置**，
     每次都在 `/workspace/.pnpm-store` 就地另开一个。镜像里那份它根本不看。
   - **真正管用的是 `scripts/warm-pnpm-store.sh`**：在**数据盘**上预热一份共用 store
     （`<WEBGEN_DATA_DIR>/pnpm-store`），每个容器把它挂成 `/workspace/.pnpm-store`。
     同盘 → 硬链成立 → `pnpm install` **不联网、秒级**。
     `scripts/build-images.sh` 末尾会自动跑它；单独跑也行。
2. **Go 构建缓存要在镜像里预热。** Go 1.20 起标准库不再预编译，第一次 `go build` 现编一遍，
   1 CPU 下 **27 秒**，而 `GOCACHE` 在容器自己的文件系统上、容器一重建就全丢。
   所以 go 镜像末尾有一条 `go build std`（44 秒 / 159MB，一次性），之后**任何**纯标准库项目构建 0.4 秒。
3. **构建必须跨容器串行。** 同一个项目的编辑容器（`d-<id>`）和预览容器（`p-<id>`）
   **共享同一个工作区**，两个容器的启动脚本都会跑构建 —— 它们几乎同时起来，
   于是两个进程同时往同一个 `node_modules` / `dist` / `target` 里写。
   实测后果：预览那次 `pnpm install` 要等 **75 秒**（争用同一个 pnpm store 锁），
   而 agent 每轮生成最多重建 4 次沙箱。所以启动脚本用 `flock` 串行化，
   锁文件只能放在**工作区里**（那是两个容器唯一共享的路径）。
4. **就绪探针必须走 `/health`，不能探 `/`。** 组合项目的 `/` 是 nginx 从磁盘伺服的前端产物，
   **后端根本没起来它也是 200** —— 拿 `/` 当就绪判据会得到"预览就绪"但点开是 502 的假阳性
   （实测就是这么骗过 `/api/projects/:id/wait` 的）。现在 spec 的 `healthPath` 会落成
   `webgen.healthPath` 容器 label，`/sandboxes/:id/wait` 默认探它。

### 种子是拼出来的

`seeds/backend/<lang>/` + `seeds/frontend/<vue|react>/` + 一份生成的 `nginx.conf`，
按选择拼进空工作区（`services/executor/src/workspace/seed.ts` 的 `seedWorkspaceFromStack`）。
三个片段的落点**故意错开**（后端在根上放 `server.mjs`/`app.py`/`main.go`/`pom.xml`，
前端放 `package.json` + `vite.config.js` + `src/`），加新片段时要继续守住这条。

数据层：选了 SQLite 就注入 `WEBGEN_DATA_DIR=/workspace/data`，工作区是 bind mount，
**所以容器删了重建数据还在**。选与没选的区别是看得见的 —— `/api/visits` 会把 `storage` 字段一起返回。

> ⚠️ **已知的不一致**：Node 用内置的 `node:sqlite`、Python 用标准库 `sqlite3`（都是**真 SQLite**，
> 零依赖）；Go 和 Java 用的是同一个目录下的普通文件（`storage: "file"`）。
> 原因是这两家的 SQLite 驱动要联网拉，而"建项目"这条路上**一行网络请求都不能有**。
> 要补上：Go 加 `go get modernc.org/sqlite`（注意要挑支持 go 1.25 的版本）、
> Java 加 `org.xerial:sqlite-jdbc` 并**同步改 `sandbox/images/java/warm/pom.xml`**、
> 重建镜像 —— 后者会重新联网拉 Maven 依赖，那一步实测会卡死，想清楚再做。

### 发布组合项目：和建沙箱是**两条**解析 spec 的路

组合项目的 `template` 列写的是组合名，所以任何"拿模板名去磁盘上找目录"的地方都会挂。
目前有三处，都在 executor 侧，共用 `workspace/seed.ts` 的 `resolveSpec({template|stack}, projectId)`：

| 入口 | 谁调它 |
|---|---|
| `POST /sandboxes` | 建/重建沙箱（编辑 + 预览） |
| `POST /production`、`POST /production/:slug/:v/health` | **发布**：起生产容器 + 等它健康 |
| `GET /templates/:name?projectId=` | 前端拿完整 spec（`artifactDir` 等） |

⚠️ 发布这条路**最容易漏** —— 它的现象是"预览和生成全都好，**只有发布**报
`模板不存在：stack-go-vue-sqlite`"，而且只在点发布那一刻才出现。加新的 spec 入口时
一定走 `resolveSpec`，别自己拼。

⚠️ 还有一条只在发布路径上才踩得到的：**生产容器的发布目录必须 chown 给 uid 10001**。
`materializeRelease` 是 executor 以 root 铺的、只调到"谁都能读"，而容器的启动脚本
**要在工作区里构建**（写 `node_modules` / `dist` / `target`）—— 没有写权限就起不来，
健康检查一路超时，最后整个发布回滚。模板项目里 `node-web` 那种没有构建步骤的能过，
所以这个坑一直到组合项目才露出来。

### 项目镜像的生命周期

- 名字是 `webgen-app/<projectId>:<recipeHash>`。**前缀故意不是 `webgen/`** ——
  `NodeInfo.images` 按那个前缀过滤（`routes/node.ts`），`smoke.sh` 有条断言在看它，
  前端的 `lib/stacks.ts` 也靠 `^webgen\/([^:]+)` 推语言。换个前缀，这三处全都不用动。
- `buildImageFor` **幂等**：镜像在就直接返回。所以"每轮生成重建 4 次沙箱"不会 build 4 次。
- **删项目会删镜像**（`DELETE /images/:projectId`，在容器都删完之后调用）。
  不删的话会线性堆积：一个项目一个，改过组合还会多一个旧 tag。
- **改组合 = 删了重建**（改 tag 会让旧镜像变成孤儿）。目前没有"原地改组合"的界面。

## 跑起来

```bash
cp .env.example .env      # 生成引擎那几项按需改（见下）
pnpm install
pnpm up                   # traefik :8088 + mysql :13306
pnpm images               # 构建沙箱镜像 + 预热共用的 pnpm store（末尾自动跑，见下）
bash scripts/dev.sh       # executor :8100 + orchestrator :8800 + web :5173
```

界面在 **http://localhost:5173**（Vite 把 `/api` 代理到 orchestrator——它没有 CORS，所以浏览器侧一律同源）。

### 有哪几个页面

| 路径 | 干什么 |
|---|---|
| `/` | **只做创建**：一句话 + 技术栈 → 生成，然后直接进工作台。项目列表**不在这儿**。创建框里有「按技术栈 / 按模板」两个模式：前者是**三段各选一个**的组合（前端 × 后端 × 数据，默认），后者是老的一套模板走天下。 |
| `/projects` | 项目管理：卡片（实时缩略图）+ 搜索 + 排序（最近改动 / 创建时间 / 名称） |
| `/containers` | 容器管理：所有项目的编辑 / 预览 / 生产实例拉平成一个列表 + 节点容量与磁盘 |
| `/templates` | 模板管理：分组展示 + **完整 spec**（image / 命令 / artifactDir / limits / deps） |
| `/p/:id` | 工作台（三栏：**文件 · 中间 tab 区 · 对话**），顶栏有「版本与发布」 |

前四个共用一个顶部导航；**工作台不用它** —— 三栏布局已经把横向空间吃满，再加一条导航会挤掉预览区。

**工作台的三栏**（与 DESIGN §9 原稿故意不同，别照着文档改回去）：

- **左 = 文件**：文件树 + 本轮改动列表。只负责"找东西"，点一下在中间打开。
- **中 = tab 区**：**预览 tab 钉在最左**（不随其余 tab 滚动、不可关），
  右边是可横向滚动、可逐个关闭的文件/diff tab。**生成中只有预览这个 tab 显示骨架屏**，
  tab 栏照常能切去看代码。
- **右 = 对话**：思考/命令折叠、verify 失败高亮。

> ⚠️ 三栏的两侧是**定宽**的，所以 `Split` 会按容器实际宽度把它们**夹住**：
> 两侧加起来超过视口时先收对话栏再收文件栏，保证中间至少留 320px。
> 不夹的话（默认 460+380，拖到上限是 720+900=1620）窄窗口下整行会横向溢出，
> **最右边的对话栏直接被推出屏幕** —— 实测复现并修过。

> 模板页是**只读**的：模板定义在仓库里的 `templates/<name>/template.json`，
> 加一个模板 = 加一个目录 + 在 `scripts/build-images.sh` 里加一个镜像。界面上不做增删改。

## 数据服务（S4）

生成出来的应用能连**它自己的**数据库、缓存、对象存储 —— 都是**共享实例**，按项目隔离。

在首页「按技术栈」的数据段多选（或点快捷预设，默认就带 MySQL + Redis）：

| 选了 | 得到什么 | 隔离方式 |
|---|---|---|
| **SQLite** | 工作区里的一个文件（`WEBGEN_DATA_DIR`），容器重建也不丢 | 文件就在项目工作区里 |
| **MySQL** | 共享实例里**每项目一库一账号**，连接串自动注入 `DATABASE_URL` | **独立账号**，只能碰 `p_<id>` 这个库（§7.1） |
| **Redis** | 共享实例 + `REDIS_URL` / `REDIS_KEY_PREFIX=<id>:` | **key 前缀**约定隔离（不是强制，§10 记了） |
| **MinIO** | 共享对象存储 + `S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET=p_<id>` | **每项目一个 bucket**（凭证共享，约定隔离） |

- 建项目时**先供给、再起容器**（连接串要经 `spec.env` 在容器起来时就在）。
- **删项目连库一起删**：`DROP DATABASE p_<id>` + `DROP USER`（幂等，失败只进 warnings）。
- ⚠️ **Redis 的 key 与 MinIO 的 bucket 目前不随项目删除**（orchestrator 侧没有 Redis/S3 客户端，
  平台不主动清）；它们是约定隔离、按前缀/bucket 名归属各项目，残留不影响别的项目。
- 供给结果在 `GET /api/projects/:id/services`（脱敏）可查；平台账号需要的全局权限由 `scripts/grant-mysql.sh` 一次性授予。

> ⚠️ **Java 暂不支持 MySQL/Redis/MinIO**：本机 Maven 增量下载会卡死（spike 900s 超时），
> 所以 Java 镜像里只有预热的 Spring Boot、没有那些驱动。Java 项目的存储降级为**文件 / 内存**
> （`storage:"file"` / `"memory"`）。要补上得先解决镜像预热（见下）。

### 种子是**企业级分层工程**

四门语言的后端种子都分层（config / logger / routes(handler) / service / store …）、有启动时配置校验、
结构化日志、统一错误体、优雅退出、单测、README、`.env.example`。统一接口契约：
`/health`（纯文本 `ok`）、`/api/hello`、`/api/visits`（`{visits, storage, cache}`）、`/api/files`（MinIO）。

### 镜像与依赖预热（为什么要那么小心）

组合项目的镜像里**一条 `RUN` 都没有**（纯本地拷层），所以"建项目"这条路上不联网。语言的依赖靠**预建基础镜像**：

- **Node / Go**：依赖在**项目构建期**装（`pnpm install` 走 npmmirror；`go build` 命中镜像里预热的模块缓存）——安全。
- **Python / Java**：依赖必须**预先烤进镜像**，而那两个联网层是脆弱的（改了就要重新下载：
  本机实测 pip 会读超时、maven 卡在 40M）。**加新步骤一律往后加、单独插层**，绝不动已有层的字面量。

> **建得有多快**（本机实测，1 CPU 沙箱）：几条硬性前提 ——
> `pnpm install` 必须带 **`--prefer-offline`**（走预热好的 store，否则会卡在 npmmirror 的重试上几分钟）；
> Node 后端种子带 **`pnpm-lock.yaml`** 钉版本（否则每次都要联网解析）；
> Go 组合要求**镜像里预先把依赖编进 GOCACHE**（只 `go mod download` 不够 —— 项目构建期现编依赖会 OOM）。
> 做了这些之后：任意后端 + 无前端 ≈ 2~50 秒、带前端 ≈ 68~96 秒就绪。**都超过 DESIGN「15 秒」那条**
> （java 本来就超）—— 这是本机 registry / 单核所限，不是流水线能修的。

## 验收

```bash
bash scripts/smoke.sh                      # S0：沙箱链路（18 项）
bash scripts/smoke-s1.sh "做一个个人主页…"    # S1：一句话生成
bash scripts/smoke-repair.sh               # S1：自动修复闭环（用故意崩掉的模板）
bash scripts/smoke-s2.sh                   # S2：工作台要用的接口（14 项，不花钱）
bash scripts/smoke-s2.sh --mutex           # 额外验「生成中拒绝写文件」（会花模型钱）
bash scripts/smoke-s3.sh                   # S3：快照 / 发布 / 回滚 / 级联删除（22 项，不花钱）
bash scripts/smoke-stack.sh                # S3.5/S4：组合建到能看 + 数据服务 + 发布（不花钱）
bash scripts/smoke-stack.sh 2              # 传个数字只跑前 N 种组合，调脚本时省时间
bash scripts/smoke-data.sh                 # S4：MySQL 每项目一库一账号 / Redis 前缀 / MinIO bucket（不花钱）
python3 scripts/show-agent.py <projectId>  # 看某个项目的生成事件
```

**S2 的浏览器验收**（「全流程在浏览器走通」这句验收标准的落地）：

> 栏位顺序是 **代码（左）· 预览（中）· 对话（右）**，与 DESIGN §9 原稿的「对话左、代码右」
> **故意相反**，按使用者要求调整过。别再照文档改回去。

1. 打开 `http://localhost:5173` → 选模板、说一句话 → 进工作台。
2. **右栏**：思考 / 命令折叠块随流出现，verify 失败会红边高亮并自动展开报错。
3. **中栏**：生成期间是骨架屏；完成后 iframe 出来；可切 375/834/1280 宽度、可刷新。
4. **左栏**：文件树（`node_modules` 不会出现）；点文件看内容**且带语法高亮**（Go/Java/YAML/XML/Vue 都有）；
   切「本轮 diff」看这轮改了哪些文件。
5. 手改一个文件保存 → 预览刷新后能看到；**生成中保存按钮是禁用的**（后端也会 409）。
6. 「导出 zip」下载下来能解开，里面没有 `node_modules`。
7. 刷新 `/p/:id` → 对话和预览都重建出来（验证 SSE 重连）。
8. 顶栏右侧切主题（浅色 / 深色 / 跟随系统）——**默认深色**。

## 接口

```
POST   /api/projects                {template, name?, prompt?}  → 带 prompt 就直接开生成
                                    {stack:{frontend,backend,data}, name?, prompt?}  → 按组合建（S3.5）
                                      template 与 stack 二选一；组合项目的 template 列写组合名
GET    /api/projects                → 含 updatedAt / instance
GET    /api/projects/:id            → 含 instances 与完整 spec（前端靠 spec.artifactDir 切两个根）
DELETE /api/projects/:id
POST   /api/projects/:id/messages   {text}      → 202，后台跑
GET    /api/projects/:id/stream                 → SSE：reset + delta/thinking/tool/session/verify/error/done
GET    /api/projects/:id/agent                  → 一次性拿全量事件与消息
POST   /api/projects/:id/wait                   → 等预览真能打开
GET    /api/projects/:id/preview-url            → {url, kind, state:'none'|'cold'|'ready'}
POST   /api/projects/:id/editor/start|stop
GET    /api/projects/:id/files · ?dir=          → 文件树（带 depth，已排除 node_modules/.git）
GET    /api/projects/:id/file · /logs
PUT    /api/projects/:id/file                   {path, content} → 生成中返回 409（§14 C3）
GET    /api/projects/:id/diff                   → 本轮 agent 改了哪些文件（before/after 原文）
GET    /api/projects/:id/export?scope=workspace|artifacts  → zip 下载
GET    /api/templates · /api/nodes
```

S3 加的：

```
PATCH  /api/projects/:id                        {slug}  → 改线上地址前缀（校验 + 目录跟着改名）
GET    /api/projects/:id/snapshots              → 版本时间线
POST   /api/projects/:id/snapshots              {label} → 手动打快照（生成中 409）
POST   /api/projects/:id/rollback               {snapshotId} → 把**工作区**退回某版
POST   /api/projects/:id/deploy                 {snapshotId?} → 发布（不传就用最新快照）
GET    /api/projects/:id/deployments            → 发布记录 + 当前线上
POST   /api/projects/:id/deployments/:v/activate → 把**线上**切回某版（回滚）
GET    /api/projects/:id/instances              → 编辑/预览/生产三类实例 + 生产容器列表
```

S4 加的（依赖服务 / 环境变量，§8）：

```
GET    /api/projects/:id/env                    → 环境变量 / 密钥（**脱敏**返回，连接串永不回明文）
PUT    /api/projects/:id/env                    {key,value,scope} → 写入（加密落库；重启容器后生效）
GET    /api/projects/:id/services               → 依赖服务与（脱敏的）连接信息
POST   /api/projects/:id/services               {kind:'mysql'|'redis'|'minio'} → 按需供给
```

> 生成出来的应用**自己**也有一组接口（种子里：`/health`、`/api/hello`、`/api/visits`、`/api/files`），
> 那是打在**预览/线上域名**上、经 nginx 转发的，不是平台接口。

> 两个「回滚」是**两个不同的接口**，别混：`/rollback` 动工作区（"我要从这个版本继续改"），
> `deployments/:v/activate` 动线上（"让用户看到这个版本"）。混成一个的话，
> 用户点完不知道自己的改动去哪了。

executor 侧的发布/快照接口（不对外，orchestrator 调）：
`/workspaces/:id/snapshot|snapshots|checkout`、`/projects/:id/publish/{static,preview,release}`、
`/publish/site/:slug/{activate,rename}`、`/production`（起/停/查/健康检查）。

预览：`http://p-<projectId>.localhost:8088/`

## 生成引擎的接入（本机）

本机 claude 走一个本地代理，代理管真实凭据，客户端把 BASE_URL 指过去即可：

```env
ANTHROPIC_BASE_URL=http://127.0.0.1:15721
ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED
IS_SANDBOX=1        # claude 拒绝以 root 运行（WSL 里默认是 root）
```

**agent 只有 `mcp__sandbox__*` 这几个工具**——它自带的 Read/Write/Bash 全被禁用，
因为那些会跑在**跑 agent 的这台机器**上，而生成出来的代码必须只在沙箱里执行。
真正的路径 jail / 命令白名单 / 资源限额都在 executor 那一侧。

