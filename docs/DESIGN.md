# 在线 Web 应用生成平台 · 设计方案

> **定位**：在网页上描述需求 → 平台在沙箱里生成并真的跑起来一个项目 → 右侧实时预览 → 边聊边改 → 发布，拿到一个可访问地址。
>
> **性质**：独立仓库、独立部署。与 ai-desktop 及其模板、构建链、nginx、部署机**无关**；生成物也不进那套体系。

---

## 0. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 部署形态 | **单机 Docker 起步**（compose），起手即分三进程 |
| 2 | 用户面 | 先自己/团队用，**不做登录，但 `owner` 字段从第一天就在** |
| 3 | 预览地址 | **子域名**（`p-<id>.preview.<domain>`）；**本地开发用 `p-<id>.localhost`**（浏览器原生解析到回环，零配置）；无域名再用 `nip.io`；**不走路径前缀** |
| 4 | 生成引擎 | **Claude Agent SDK**，收敛在 `AgentRunner` 接口后（将来可换模型） |
| 5 | 运行时 | **不限语言**——**模板决定镜像**。每项目一个**编辑容器**；另有预览 / 生产实例，见 §1.3 |
| 6 | 真正的边界 | 不是"语言"，是**要不要持久化状态 / 多服务编排** |
| 7 | 产物目录 | 项目工作区落在**宿主目录** `$WEBGEN_DATA_DIR/<id>/`（**不在仓库内**，WSL 下必须落 ext4，见 §4.1）；容器只是执行器（可随时重建）；**浏览/导出不依赖沙箱存活** |
| 8 | 部署拓扑 | **架构按多节点设计，部署从单节点起步**：orchestrator 无状态、executor 按节点注册、沙箱走 scheduler、工作区项目粘性（HA-0 本地目录即权威副本；**对象存储从 HA-1 才引入**） |
| 9 | 高可用 | **架构按 HA-1 设计**（应用层多副本 + 状态单点带备份 + 发布与生成平面解耦）；HA-2 只在有明确 SLA 时做 |
| 10 | 编辑 / 运行 | **两个平面严格分离，但不是"每项目两容器"**：静态站运行侧 **0 个专属容器**（由共享静态伺服 / CDN 承担）；服务型才有生产实例且只在发布后存在；编辑容器按需开、闲时停 |
| 11 | 预览语义 | 预览与运行统一为**「实例」**（静态实例 / 服务实例，由模板声明）。静态零冷启动；服务实例有冷启动，但**生产实例常驻、不参与回收** |
| 12 | 任意服务网站 | **核心目标**：SSR / API / 带后端的站点都要能生成并跑起来。依赖服务用**共享 MySQL、每项目一个 database + 独立 role** |
| 13 | 资源上限 | **单项目资源上限 + 项目数上限，S0 就落地**（不是"以后加"）。超限必须显式失败并说明原因，不静默降级 |

---

## 1. 架构总览

```
        ┌──────────────── Web (React) ────────────────┐
        │  首页：一句话新建        工作台：聊天|预览|代码 │
        └───────────────────┬─────────────────────────┘
                    HTTP / SSE / WS
                            │
        ┌───────────────────▼─────────────────────────┐
        │  orchestrator（业务后端）                     │
        │  · 项目/会话/快照/发布 元数据                  │
        │  · Agent 循环（plan → write → verify → repair）│
        │  · 计量（token / 沙箱时长）                    │
        │  ★ 不持有 docker socket                      │
        └───────┬─────────────────────┬───────────────┘
                │ 受限 API             │ 发布
        ┌───────▼──────────┐  ┌───────▼────────────────┐
        │ executor         │  │ 静态托管 / 生产容器      │
        │ ★ 唯一持 docker   │  │ sites/<slug>/<ver>/     │
        │   socket 的进程   │  │ current → 原子切换       │
        │ 建/删沙箱·exec·   │  └────────────────────────┘
        │ 查路由            │
        └───────┬──────────┘
                │ docker
        ┌───────▼──────────────────────────────────────┐
        │ 每项目一个沙箱容器（镜像由模板决定）           │
        │ 任意语言工具链 · 工作区 bind mount · 反代出口  │
        └───────┬──────────────────────────────────────┘
                │
        ┌───────▼──────────────────────────────────────┐
        │ edge（Traefik）：按 host 路由到容器端口/产物目录 │
        │  *.preview.<domain>  /  *.apps.<domain>      │
        └──────────────────────────────────────────────┘
```

**为什么三进程分家**：谁持有 docker socket，谁就等于持有宿主 root。把它关进一个只有这几个接口的小服务里，是这套架构里性价比最高的一条安全设计。三者同机不同容器；将来上 K8s 只是把 orchestrator 多跑几份，业务代码不改。

> 单机时 **agent 循环与 orchestrator 同进程**；分布式时拆成独立可伸缩的 agent-runner worker（§1.1）。**接口不变，只是部署形态不同**——别在单机版里写成两个进程，也别在分布式版里把 agent 循环留在 orchestrator 内。

### 1.1 分布式就绪（多节点）

**架构按多节点设计，部署可以一台机器起步。** 节点数 = 1 时跑的是同一套代码；加节点 = 加一台机器，不改架构。

```
                    ┌──────── 边缘（Traefik × N）────────┐
                    │  动态路由表：p-<id> → 沙箱所在节点   │
                    └───────────────┬───────────────────┘
                                    │
            ┌───────────────────────┴────────────────────────┐
            │  orchestrator × N —— 无状态                    │
            │  API / SSE / 调度 / 发布 / 计量                 │
            └───────────────────────┬────────────────────┘
                                    │
          ┌─────────────────────────▼──────────────────────┐
          │ MySQL：元数据 + 队列 + 任务表                 │
          │ （Redis 只在 HA-1 起才引入，做跨实例广播）        │
          └─────────────────────────┬──────────────────────┘
                                    │
            ┌───────────────────────▼────────────────────┐
            │  agent-runner worker × N（跑 Agent 循环）    │
            └───────────────────┬────────────────────────┘
                                │ 按节点路由
        ┌───────────────┬───────┴────────┬───────────────┐
        │  node A       │   node B       │   node C      │
        │  executor     │   executor     │   executor    │
        │  + docker     │   + docker     │   + docker    │
        │  workspaces/  │   workspaces/  │  workspaces/  │
        └───────────────┴────────────────┴───────────────┘
```

**单机 → 分布式，六处必须改：**

| 关注点 | 单机做法 | 分布式做法 |
|---|---|---|
| 元数据 | SQLite | **MySQL**，orchestrator 完全无状态 |
| 任务队列 | 进程内数组 | **MySQL `SKIP LOCKED`**——一期即用，**不引入 Redis** |
| SSE 事件 | 进程内 EventEmitter | **Redis Pub/Sub 广播**（用户可能连在另一个实例上）——**HA-1 起才需要** |
| 沙箱调度 | 直接本机 docker | **scheduler 选节点**（容量 + 项目粘性） |
| 工作区 | 本地目录（**它自己就是权威副本**） | **项目粘性亲和**：节点本地盘只是缓存，**对象存储是权威副本**——**HA-1 起**（§1.2 第 2 条） |
| 预览路由 | Traefik docker provider | **Traefik 动态配置 provider**（redis / etcd / file），由 orchestrator 按节点写路由 |

**四条硬约束：**

1. **orchestrator 不许有本地状态**。会话、沙箱归属、构建状态全进 MySQL / Redis，任意实例都能处理任意请求。
2. **项目粘性**：一个项目固定跑在一个节点上（工作区在节点本地盘）。这是最省事的做法；但必须留"迁出"能力——节点下线/故障时，把工作区同步到对象存储，在别的节点恢复。**粘性 ≠ 不能迁。**
3. **边缘按节点写路由**：`p-<id>` 指向"该沙箱所在的**节点 IP:端口**"，不是边缘本地。跨节点 docker 网络默认不通，沙箱端口要 publish 到节点的一段高位端口。
4. **镜像分发**：每台节点都要有沙箱镜像 → **私有 registry + 节点预拉**。这是"任意语言"在分布式的真实代价（几 GB × N）。

**不建议因为"要分布式"就直接上 K8s。** 沙箱这种"跑任意代码 + 长时 + 交互式"的负载在 K8s 上要配 gVisor / Kata 才真有隔离意义，运维成本高一个量级。**2~10 台用自建编排（executor + scheduler + Traefik）更可控**；规模再上去再迁，届时 executor 接口不变。

**分布式的代价（要认）：**
- **隔离面放大**：每台节点都能跑到陌生代码 → 每台都要按最坏情况加固
- **调试复杂度上升**：一次生成可能横跨 3 台机器
- **成本线性**：镜像、闲置容器、运维工时都 × N

### 1.2 高可用（HA）

**先定"什么算可用"——不定义就没法设计。**

| | 可用性要求 | 结论 |
|---|---|---|
| **用户已发布的站点** | 最高。这是用户的东西在线上跑 | **必须与生成平面彻底解耦** |
| 生成 / 编辑能力（沙箱、agent） | 可容忍短时中断 | 能自愈即可，不必强一致 |

**HA 的第一步是无状态化，不是加机器。状态在哪，单点就在哪。**

| 组件 | 单点？ | HA 做法 | 一期建议 |
|---|---|---|---|
| 边缘 Traefik | 是 | 多实例 + VIP / 云 LB；**路由表必须外置**（redis / etcd）——多实例下 docker provider 各看各的，不共享 | 多机就多实例，否则单实例 + 快速重启 |
| orchestrator | 否 | 无状态 × N + LB + 健康检查 | 已就绪（§1.1） |
| agent-runner | 否 | 队列消费 × N + **按项目分布式锁** + 任务幂等 / 超时重投 | **必做**（见下） |
| MySQL | 是 | 主从 + 自动 failover（Patroni / Orchestrator / MHA / 云 RDS） | 托管，或主从 + 每日备份 |
| Redis | 是 | Sentinel / Cluster | **一期直接不用**——队列放 MySQL；跨实例广播到 HA-1 再说 |
| 节点 executor | 是 | 心跳；失联 → 该节点的项目标记"需迁移" | 心跳 + drain |
| 工作区 | 是 | **对象存储为权威副本**，节点本地盘只是缓存 | **HA-1 起做**；HA-0 时本地目录即权威 |
| 发布产物 | 是 | 静态 → 对象存储 + CDN；常驻服务 → 独立于沙箱的生产集群 | **必做**（见下） |
| 镜像 registry | 是 | HA registry，或每节点预拉 | 每节点预拉 |

**四条 HA 特有、不做就一定出事的：**

1. **同一个项目的 agent 循环必须串行。** worker 变多之后，"两个 worker 同时改同一个工作区"从不可能是变成了必然——结果是互相覆盖、代码静默损坏。要**按 projectId 加分布式锁**（Redis 锁，或队列按 key 分区单并发）。这是 HA 给这套架构带来的**新**问题，不是旧问题的放大。

2. **工作区以对象存储为权威副本，节点本地盘只是缓存**（**HA-1 起**；HA-0 单机时本地目录本身就是权威副本）。§1.1 写的"本地盘 + 定期备份"在 HA 下不够：节点一挂，最近一次备份之后的所有改动全丢。改成——**每个 agent 回合通过后推对象存储**；任何节点接到这个项目先拉工作区。副作用全是好的：节点随时可死、项目可在任意节点复活、drain 简化成"推完就下线"。

3. **已发布站点与生成平面解耦。** 用户的东西在线上跑，不能因为生成平台某台节点挂了就下线。
   - 静态产物 → 对象存储 + CDN，**与平台无关**，天然 HA
   - 常驻服务 → 跑在独立于沙箱的**生产集群**；实例挂了要从快照在别处自愈重建

4. **队列放 MySQL，一期不引入 Redis**（`SELECT … FOR UPDATE SKIP LOCKED`）。拿 Redis 当队列唯一存储会丢消息；开 AOF + Sentinel 又多一个单点。放 MySQL：少一个组件、少一个单点，任务表与元数据同库、天然事务。**等 HA-1 真需要跨实例广播时再加 Redis。**

**降级与自愈的基本功（HA 落地时一起做）：**

- **心跳**：executor 定期上报；失联超时 → 该节点沙箱标记"需迁移"、路由摘除
- **drain**：节点维护 / 下线时先停止接新沙箱，把现有沙箱（工作区推对象存储后）迁走再下线
- **优雅退出**：orchestrator 收 SIGTERM 先停止接新请求、等在跑的响应写完；worker 把手里那轮跑完，或标记重投
- **幂等**：任务重投必须幂等——同一次生成跑两遍不能产生两份提交（靠项目锁 + 回合序号）

**分级落地，别一步到位：**

| 级别 | 内容 | 适用 |
|---|---|---|
| **HA-0** | 单机（就是现在这版）。RTO = 人工恢复 | 开发 / 自用 |
| **HA-1** | orchestrator × N + worker × N + MySQL 主从（手动 failover）+ 工作区推对象存储 + 发布解耦 | **2~10 台，推荐起点** |
| **HA-2** | MySQL 自动 failover、Redis / 队列 HA、边缘多实例 + LB、节点自动迁移 | 有明确 SLA 才做 |

**架构按 HA-1 设计，HA-2 只在真有 SLA 时做。** 不建议自建主从自动切换集群（Patroni / Orchestrator + etcd / consul 那一类）——那是在运维一个比这个平台本身还复杂的系统，除非有专职 SRE；**有云托管就用云托管**。

### 1.3 两个平面：编辑 / 运行

不是"每个项目建两个容器"，而是**两个平面、生命周期完全不同**。

| | 编辑平面（工作） | 运行平面（线上） |
|---|---|---|
| 谁在跑 | 用户的 agent + 编辑器 | 用户**已发布**的版本 |
| 内容 | 源码 + dev 依赖 + 工具链 + dev server | 只剩构建产物 + 运行时 |
| 生命周期 | **按需开、闲时停**（跟"有人在编辑"绑定） | **发布后常驻**（跟"有版本在线"绑定） |
| 谁能改 | agent 随便改 | **只读**，只能靠"重新发布"更新 |
| 镜像 | 沙箱镜像（带工具链，大） | **产物镜像**（不含源码 / dev 依赖 / 工具链，小） |
| 位置 | 沙箱集群 | **独立的生产集群**（见 §1.2） |

**所以容器数不是 2 × 项目数：**

| 项目形态 | 编辑容器 | 运行容器 |
|---|---|---|
| 纯静态站（大多数） | 1 个，**编辑时才开** | **0 个专属**——由共享静态伺服 / 对象存储 + CDN 承担（§4），每项目单起一个才是浪费 |
| 常驻服务（SSR / API） | 1 个，**编辑时才开** | 1 个，**发布后才有**；只保留 `current` + 上一个版本，不是每次发布留一个 |

**为什么不让运行容器兼任编辑容器（省一个）——三条都不能让步：**

1. agent 能随意改代码 / 装依赖 / 删文件 → **线上跟着变**，不可接受
2. 编辑容器会被回收、会重启（WSL 那边更明显，见 §4.1）→ **线上跟着断**
3. 暴露面不同：编辑容器跑的是**未经审查的 AI 生成代码**，运行容器跑的是**已发布的固定版本**

**发布语义 = 换指针。** `slug → version`，回滚就是切回去——静态站不需要重启任何东西；常驻服务则是起新版本的运行容器、切流量、停旧的。

#### 「几个容器」要看常驻，不是看角色

**角色上最多三个，但常驻的只有一个。**

| 时候 | 静态项目 | 服务型项目 |
|---|---|---|
| **没人在用** ← 这就是常驻 | **0** | **1** |
| 有人看预览 | 0 | 2 |
| 有人编辑 | 1 | 3 |

> 服务型按「**已发布**」算。未发布的服务型项目没有生产实例，各行各减 1（没人在用时是 0）。

- 只有"正在改 / 正在看"的那一刻才会同时有 2~3 个——那是正在用，不是常态
- **只有生产实例永不回收**；编辑容器与预览实例都是按需起、闲置停

**两个"为什么不合并"（都别让步）：**

1. **编辑容器不能当运行容器**：里面跑的是 agent **还没审过**的代码，agent 会装依赖、删文件、重启进程——当线上用，用户的站就跟着每一次折腾一起抖。
2. **预览实例不能直接用编辑容器的 dev server**：预览实例跑的是**构建产物 + 生产启动命令**（与生产同形态），所以"所见即所发"成立。用 dev server 当预览，SSR 项目会出现 NODE_ENV / 路由差异，**预览好好的、上线不一样**——这个坑对服务型项目特别深。

### 仓库结构

```
webgen/
├── apps/web/                    # React + Vite 前端
├── services/orchestrator/       # Node22 + TS + Fastify
├── services/executor/           # ★ 唯一持 docker socket
├── packages/agent-core/         # AgentRunner 接口 + Claude SDK 实现
├── packages/shared/             # 类型、常量
├── packages/db/                 # schema / 迁移
├── sandbox/images/{node,python,go,java}/   # 沙箱镜像
├── templates/{node-web,fastapi,go-web,java-web,vue-static}/
├── infra/docker-compose.yml     # traefik + orchestrator + executor + mysql
├── infra/traefik/               # 动态路由配置
└── docs/DESIGN.md               # 本文件
```

> 加一门语言 = 加一个 `sandbox/images/<lang>/Dockerfile` + 一个 `templates/<name>/`。
> executor 里**没有任何语言知识**（§2.1），模板决定镜像。
> Java 走 Spring Boot，镜像里必须**预热 Maven 依赖**，理由见 README。

> ⚠️ **工作区不在仓库内**：落在 `$WEBGEN_DATA_DIR/<projectId>/`（默认 `~/webgen-data`）——WSL 下必须落 ext4，放 `/mnt/d` 会慢一个量级（§4.1）。仓库里不出现 `data/`。

**技术选型**（可替换，但建议）：
- orchestrator：Node 22 + TypeScript + Fastify（与 Agent SDK 的 TS 版同语言，省一层摩擦）
- 元数据：MySQL（compose 内；**S0 起就用它**，别先上 SQLite 再迁一道）
- edge：**Traefik**（docker provider：容器带 label 即自动生成路由，省掉自己维护路由表）
- 前端：React + Vite + Tailwind

---

## 2. 沙箱（最硬的一块）

沙箱 = **编辑平面**。它与运行平面（§1.3）严格分离——沙箱里怎么折腾都影响不到线上那一份。

### 2.1 接口

```
POST   /sandboxes                       {projectId, template} → {sandboxId, port}
DELETE /sandboxes/:id
POST   /sandboxes/:id/exec              {cmd, cwd?, timeoutMs} → {code, stdout, stderr}
GET    /sandboxes/:id/route             → edge 用的反代目标（含节点地址）

GET    /workspaces/:projectId/files     ?path=   → 节点上的工作区文件树
GET    /workspaces/:projectId/file      ?path=   → 单文件内容
PUT    /workspaces/:projectId/file               → 写回
GET    /node/info                                → 注册 / 心跳：节点 id、容量、磁盘、已拉镜像
POST   /node/drain                               → 停止接新沙箱（维护 / 下线前）
```

executor **不接受任意 docker 命令**，只有这几类。注意工作区文件接口**走 executor、不走沙箱容器**——沙箱停着也能读写文件。分布式下这是必须的：orchestrator 与持有工作区的节点往往不是同一台机器。

`template` 由 executor 解析成：

```jsonc
// templates/fastapi/template.json
{
  "image": "webgen/python:3.12",   // 机器上预拉
  "seed": "./seed",                // 建沙箱时铺进工作区
  "runCommand": "uvicorn app:app --host 0.0.0.0 --port $PORT",
  "port": 8000
}
```

**别把 node 写死在 executor 里**——加语言就只是加一个模板目录 + 一个镜像。

### 2.2 容器约束

| 项 | 设置 |
|---|---|
| 用户 | 非 root |
| 挂载 | 工作区 **bind mount** 到宿主 `$WEBGEN_DATA_DIR/<id>/`——**这是刻意开的唯一宿主挂载**（产物要能直接浏览/导出）；除此之外**不挂宿主的家目录 / 源码 / 配置**，不传 docker socket |
| 限额 | `--cpus` `--memory` `--pids-limit`（防 fork bomb）+ 磁盘配额；**`MemorySwap` 必须显式等于 `Memory`（禁 swap）**——只设 `--memory` 时 Docker 会默认给等量 swap，越限的进程会去刷 swap 而不是被 OOM 杀掉，既拖垮宿主又让失败原因无法识别 |
| 网络出口 | 允许到包源（npm / pypi / go proxy / maven，或统一走内部镜像源）；**默认禁止访问内网网段**，但**按白名单放行依赖服务地址**（本项目的 MySQL / Redis）——这两条必须同时说，否则要么沙箱连不上自己的库，要么沙箱能扫内网 |
| 生命周期 | 闲置 N 分钟自动停，访问时冷启 |
| 镜像 | 提前拉到机器上（本地 registry），否则首次用某语言要等几分钟拉镜像 |

### 2.3 镜像家族

```
webgen/node:22      webgen/python:3.12    webgen/go:1.23
webgen/php:83       webgen/java:21        ...
```

**不造万能镜像**——几 GB 的镜像冷启动直接废掉。按模板选、预拉。

**依赖预热（S0 必做）**：把常用模板的 `node_modules` / pip 缓存打进镜像，或挂共享只读缓存卷。不做的话每次新建项目 `install` 好几分钟，体验直接废。

### 2.4 资源上限（S0 就要有）

两类上限，**从 S0 起就是硬约束**，不是"以后再补的护栏"。

**① 单项目资源上限**——由 executor 建容器时强制：

| 维度 | 默认 | 说明 |
|---|---|---|
| CPU | 1 核 | 构建时可临时放宽（构建是 CPU 大户） |
| 内存 | 1 GB（构建 2 GB） | **默认值写在 `template.json`**：Java / Next.js 这类吃内存的要更高 |
| pids | 256 | 防 fork bomb |
| 磁盘 | 2 GB / 项目 | 含 `node_modules` 与产物 |
| DB | 每项目 1 个库，连接数 ≤ 10 | 库大小上限另计 |

- 项目级可调，**但有天花板**——否则"可调"等于没上限
- **超限必须显式失败**：OOM 时容器会被内核杀掉，平台要能识别这是"内存超限"并在界面上说清楚，而不是甩给用户一句莫名的"构建失败"

**② 项目数上限**——由 orchestrator 计数：

- 全局上限（一期没鉴权，先按平台总数；有 `owner` 后改成按人）
- **服务型项目单独一条更严的上限**（常驻成本高）：如"线上常驻的服务型项目 ≤ N 个"
- 超限**拒绝创建并说明原因**，不许默默排队或静默降级

**为什么这两条必须在 S0：** 服务型项目一上来就是"每项目一个常驻进程 + 一个库"，没有上限的话，**你自己在测试阶段生成十几个服务型网站就能把这台机器打满**。限额不是给生产用的护栏，是**让你本地能安心试的护栏**。

---

## 3. 生成引擎

### 3.1 接口收敛

```ts
interface AgentRunner {
  run(projectId: string, prompt: string): AsyncIterable<AgentEvent>
  // AgentEvent: delta | thinking | tool | verify | error | done
}
```

唯一实现是 Claude Agent SDK（自带读写文件 / 跑命令 / 子代理 / 上下文压缩的工具循环）。将来换模型 = 加一个实现，业务层不动。

主力模型：规划与疑难修复用 Opus 5.5；常规改文件用 Sonnet 5.5（成本差一个量级）。

### 3.2 verify 闭环（决定交付质量）

```
loop (最多 N 轮):
  模型改代码
  → 跑 typecheck / build / 启动探针
  → 通过？ 结束
  → 失败？ 把真实报错回灌，继续
```

**没有闭环 = 交付一堆"看起来对、跑不起来"的代码。** 每个回合结束前必须 verify。

### 3.3 上下文管理（决定能不能改第二版）

绝不把整个项目塞进 prompt。给模型的是：

- 文件树
- 本次相关文件（按需读取）
- 最近一次 verify 报错
- 项目变大后：基于 git 历史生成的结构摘要缓存

这是长会话不炸上下文的唯一办法，也是"改第二版、第三版还能改对"的关键。

### 3.4 首轮策略

先出一版"结构对、能跑起来、样式丑"的骨架，别在对话里空谈。跑起来才有可迭代的对象。

---

## 4. 预览与运行：统一为「实例」

预览和发布**是同一种东西**——"一个可访问的版本"。统一抽象成**实例**，按项目形态分两类：

| 实例类型 | 伺服什么 | 冷启动 | 适用 |
|---|---|---|---|
| **静态实例** | 一个产物目录（静态文件） | **无**（边缘直接读文件） | 纯前端 / SSG |
| **服务实例** | 一个跑着的容器（+ 依赖服务） | 有（1~5 秒） | SSR / API / **带后端的任意服务网站** |

**由 `template.json` 声明属于哪一种**——这是模板的责任，不是运行时的特判。

> ⚠️ **边缘必须能直接读到产物。** Traefik 是纯反代，**不伺服静态文件**（它的 file provider 读的是*路由配置*文件，不是静态资源）。所以"静态实例 0 容器"要么靠**一个共享的静态伺服**（如一个 nginx 容器挂产物根，Traefik 按 Host 映射子目录），要么把边缘换成 nginx / Caddy。准确说法是 **0 个「专属」容器**——每项目单独起一个静态服务才是浪费。
>
> 推论：**静态产物必须放在边缘可达的位置**（共享存储 / 对象存储）。分布式下产物在节点本地盘、边缘在另一台机器，边缘就伺服不到。

**"能直接看"的保证，分两档说清楚（别含糊）：**

| | 静态项目 | 服务项目 |
|---|---|---|
| 预览怎么伺服 | 边缘直接指向产物目录，**不经过容器** | 指向容器端口；容器冷了就按需拉起 |
| 编辑容器被回收后 | **照样打开，零等待** | 预览实例跟着没了 → 冷启 1~5 秒（骨架屏） |
| 生产侧 | 对象存储 + CDN，**0 个专属容器** | **生产实例常驻** |
| 一句话 | **看永远不用等，改才用等** | **看可能要等一下，但线上永远不停** |

**关键：生产实例不参与闲置回收。** 用户已发布的站，不能因为"没人访问"就被停掉——这是 §1.2「已发布站点与生成平面解耦」的具体落地。**可回收的只有编辑容器和预览实例。**

**发布 = 换指针 / 切流量：**

- 静态：让 `slug` 指向某个产物版本（毫秒级，不重启任何东西）
- 服务：起新版本生产实例 → 健康检查通过 → 切流量 → 停旧版本（保留上一个供回滚）

**自动的一步 vs 显式的一步**：每次 agent 回合通过 verify → 自动构建 → 原子替换当前**预览**实例指向的版本。所以"部署到预览"是自动的；**"发布到线上"才是显式动作**。

**S0 → S3 的迁移约定**：S0 的预览**先用 dev server**（验证沙箱链路更快），但**预览域名 `p-<id>` 从第一天就定死**。S3 只把该域名背后的指向从 dev server 换成构建产物——**前端代码与用户可见的地址零改动**。

**实时视图（可选，仅开发期）**：`d-<id>.preview.<domain>` 指向编辑容器的 dev server，要 HMR 时用；容器停了就没，不影响预览。

- 无域名时用 `p-<id>.<wsl-ip>.nip.io`；**不走路径前缀**
- 新项目还没构建成功过时，预览区显示"生成中"骨架屏，而不是空白或报错
- **路径前缀（`/preview/<id>/`）是死路**：生成的静态站里写的是绝对路径 `/assets/index.js`，挂到前缀下必然 404；而"任意 web"无法保证每个项目都配了 `base`。这是死路，不是次优选。

### 4.1 本机开发（默认）

**环境：WSL2**（Docker 跑在 WSL 内，不用 Docker Desktop 的 Windows 后端）——网络与文件语义和 Linux 生产一致，少一层翻译。

**预览域名用 `*.localhost`**：Chrome / Edge / Firefox / Safari 都会把 `*.localhost` 直接解析到回环地址，**不需要改 hosts、不需要 `nip.io`、不依赖外网 DNS**。

```
浏览器  http://p-abc123.localhost:8088/   ← 宿主机唯一入口，只暴露这一个端口
   │       Host: p-abc123.localhost
   ▼
edge（Traefik，compose 内 listen 80，映射 8088:80）
   │       HostRegexp(`^p-[a-z0-9-]+\.localhost$`)
   │         ├─ 静态实例 → 产物目录（静态文件，不需要任何容器）
   │         └─ 服务实例 → 预览容器:PORT
   ▼
产物目录 或 预览容器
```

配置全部走环境变量，本地/线上同一套代码：

```env
# .env.local（本机）
PREVIEW_DOMAIN=localhost
PREVIEW_SCHEME=http
PREVIEW_PORT=8088          # 宿主机只开这一个口
```

线上换成 `PREVIEW_DOMAIN=preview.example.com` + `PREVIEW_SCHEME=https` + `PREVIEW_PORT=443` 即可，Traefik 规则不变。

**容器内部不要用这个域名探测。** `*.localhost` 只在宿主机的浏览器里解析，容器内的 DNS 不认识它。服务端做"是否起来了"的探针，一律走 compose 内部地址 `http://sandbox-<id>:<PORT>`，**不要走预览域名**。

**WSL2 上的四个坑（都很实在）：**

1. **工作区不能放 `/mnt/d`。** 仓库源码放 Windows 盘没问题，但 `data/workspaces/` 以及里面的 `node_modules` **必须落 WSL 的 ext4**——跨 9P 文件系统读写会让 `pnpm install` 和构建慢一个量级。用 `WEBGEN_DATA_DIR`（默认 `~/webgen-data`）指向 ext4，**别让它默认落在仓库目录里**。
2. **WSL 空闲会回收整个 VM，容器跟着全停。** 对"沙箱"这种长驻负载是致命的（用户回来发现项目全没了）。要么在 `.wslconfig` 里关掉或延长回收（`[wsl2] vmIdleTimeout=-1`），要么**把"沙箱可随时重建"当成常态**——这也正是 §1.2 里工作区以对象存储为权威副本的另一个理由。
   > **本机实测（2026-10-09）**：检查时 `wsl -l -v` 显示 `Ubuntu-24.04  Stopped`，而里面明明有 5 个容器在跑——**空闲关 VM 在这台机器上是真的会发生的**。要跑长驻沙箱，必须显式设 `vmIdleTimeout`。
3. **Windows 侧浏览器靠 localhost 转发接进来。** 容器发布在 WSL 内的 `0.0.0.0:8088`，Windows 的 Chrome 解析 `p-xxx.localhost` → `127.0.0.1`，靠 WSL2 的 localhost 转发落到 WSL。转发偶尔不稳（或 Windows 防火墙拦），兜底两条：Windows 11 切 **mirrored 网络模式**，或直接用 WSL 的 IP + `nip.io`（`p-abc123.<wsl-ip>.nip.io`）。**别在这上面卡死——域名后缀是环境变量，换一行的事。**
   > **本机实测（2026-10-09）**：`.wslconfig` 已开 `networkingMode=mirrored`，在 WSL 内起一个 `0.0.0.0:18088` 的服务，**从 Windows 侧 `curl http://p-test.localhost:18088/` 返回 200**。所以这条坑在本机**不成立**——`*.localhost` 解析与端口可达都已实测通过，预览链路的关键假设被验证。
4. **`.wslconfig` 要给够资源。** WSL2 默认吃宿主机一半内存；同时跑多个容器 + 依赖安装 + 构建很容易 OOM。显式给：`memory=8GB`、`processors=4`（按机器调），`swap` 也给一点。

#### 本机实测环境（2026-10-09）

| 项 | 实际值 |
|---|---|
| 发行版 / 初始化 | Ubuntu 24.04.4 LTS，systemd |
| Node / pnpm / npm | v24.21.0 / 11.5.1 / 11.19.0（**比设计里的 22 更新，直接用 24**） |
| Docker / Compose | 29.1.3（overlayfs, cgroup v2）/ 2.40.3，守护进程常驻 |
| 镜像加速 | 已配 `docker.m.daocloud.io` + `docker.1ms.run`（拉镜像不用等） |
| 资源 | 28 核 / 15 Gi 内存 / 937 G 可用（宿主 31.8 G，WSL 取一半） |
| 网络 | `networkingMode=mirrored` —— **`p-*.localhost` 从 Windows 侧实测 200** |
| `.wslconfig` | 已加 `[wsl2] vmIdleTimeout=-1`（禁空闲关 VM）+ `[experimental] autoMemoryReclaim=gradual`。⚠️ 本机 WSL（2.7.11）**只认 `[experimental]` 段的 `autoMemoryReclaim`**，写到 `[wsl2]` 会告警 |
| 数据目录 | `WEBGEN_DATA_DIR=/root/webgen-data`（ext4，**不在 `/mnt/d`**） |
| 已预热镜像 | `node:22-bookworm-slim`、`python:3.12-slim`、`mysql:8.4` |

**端口占用（本机）**：`8000` 被 `glitchtip-web-1` 占 → **orchestrator 用 `8800`**；edge `8088` / executor `8100` / MySQL `13306` / web `5173`。同时跑着 glitchtip(web/postgres/valkey) + aioncore + aionui 五个容器，**改 `.wslconfig` 需要 `wsl --shutdown`，会中断它们**。

#### S0 实施记录（2026-10-09，验收 18 项全过）

落地时踩到的坑，都已修在代码里。**这些比设计本身更值钱**，重踩一次要花半天：

| # | 症状 | 根因 | 处置 |
|---|---|---|---|
| 1 | 预览一直 404，Traefik 日志刷 `client version 1.24 is too old. Minimum supported API version is 1.44` | Docker 29 的 daemon 最低只收 API 1.44，**Traefik v3.5 的内嵌客户端谈不了** | 升到 **`traefik:v3.6`**。给 v3.5 设 `DOCKER_API_VERSION` 无效 |
| 2 | MySQL 容器绑不上 3306，报 "address already in use"，但 WSL 里 `ss` 看不到任何占用 | `networkingMode=mirrored` 让 WSL 与 Windows **共享端口空间**——Windows 上那个原生 MySQL 占着 3306 | 容器换 **13306**。别去动用户已有的服务 |
| 3 | `curl 127.0.0.1:8088` 拿到一个无关的 nginx 页面，一度误判成"路由通了" | WSL 从 Windows 继承了 `HTTP_PROXY=127.0.0.1:7890`；curl 的 `no_proxy` 里 `127.*` 这种通配**不生效** | 所有本机探针显式 `--noproxy '*'` |
| 4 | 吃内存的进程既不 OOM 也不报错，只是卡到超时 | `Buffer.alloc` / `bytes(n)` 走 calloc+mmap 拿到内核**零页**，不真写就不占 RSS（在这上面来回错了三次） | 测试要 `fill(1)` 真写；**产品侧另加 `MemorySwap = Memory` 禁 swap** |
| 5 | `wait` 返回"就绪"后预览仍可能 404 | "容器里进程活着" ≠ "edge 路由生效" | **`wait` 加一层 edge 探针**（`preview-probe.ts`，用 `node:http` 手写 Host 头），语义改成「**预览地址能打开**」 |
| 6 | `pnpm install` 报 `[ERR_PNPM_IGNORED_BUILDS]` | pnpm 11 要求显式声明构建脚本 | `pnpm-workspace.yaml` 的 `allowBuilds`：`esbuild: true`；dockerode 的 ssh 系依赖（cpu-features/protobufjs/ssh2）置 `false` |
| 7 | orchestrator 起不来，报"找不到过滤的包" | `cd X && (A) & (B) &` —— `&` 把整个 `cd X && (A)` 一起后台化了，B 跑在调用者目录 | `scripts/dev.sh` 用正经的分组写法 |
| 8 | typecheck 报 `Unexpected keyword or identifier` | 块注释里写了 `sandbox/images/*/Dockerfile`，那对 `*/` **提前闭合了注释** | 改成 `<语言>` |

**实测数据**：建项目 → 预览可访问 **1~2 秒**（目标 15 秒，靠镜像预热 + 零依赖模板）；删沙箱后容器/挂载/路由三样即刻回收，**工作区保留、文件照读**。

---

## 5. 快照、产物与发布

### 5.1 快照 = git commit

每个项目工作区就是一个私有 git 仓库，**每次构建通过就自动 commit**。一次拿三样：

- 版本回滚（checkout）
- 改动 diff（UI 展示"这轮改了哪些文件"）
- 上下文摘要（基于 git 历史）

### 5.2 发布分两叉

```
开发沙箱（一项目一容器，agent 随便折腾）
        │ 点发布（从某个快照）
        ▼
  ┌─ 静态产物 → 上传 sites/<slug>/<version>/ → current 软链原子切换
  └─ 常驻服务 → 只读镜像 + 该快照代码 起「生产容器」，带版本号
               回滚 = 切到上一个生产容器
```

**开发沙箱与生产容器严格分离**——用户在沙箱里怎么折腾都动不到线上那份。

### 5.3 产物目录（浏览 / 导出）

**两层目录，都能看：**

| 层 | 位置 | 内容 |
|---|---|---|
| **工作区（源代码）← 默认视图** | 节点上 `$WEBGEN_DATA_DIR/<id>/`——**HA-0 时它自己就是权威副本**；HA-1 起对象存储才是权威、本地盘是缓存（§1.2） | 模型写出来的全部源码，含 `.git`（快照历史） |
| 构建产物（第二视图，构建后才存在） | `<workspace>/<artifactDir>`（模板声明，通常 `dist/`） | 构建结果，发布时从这里取 |

> 打开项目默认落在**源代码**视图：排除 `node_modules` / `.git` / 缓存后，工作区就是一份干净的源码树，能读、能改、能 diff、能导出。

**关键约束：文件读写在沙箱之外完成，但走 executor。**
`orchestrator` 调**该节点 executor 的 `/workspaces/*` 接口**（见 §2.1），由 executor 直接读节点上的目录——**不经过沙箱容器**，所以沙箱处于 cold / stopped 状态时照样能浏览、编辑、diff、导出。这也是"容器只是执行器、可随时重建"的必然结果。

> 单机时这条看起来绕（orchestrator 自己也能读），**但分布式下绕不开**：orchestrator 与持有工作区的节点往往不是同一台机器。所以**从 S0 起就走 executor 的文件接口**，别图省事直读本地目录——那是以后要还的债。

**能力清单：**

- 文件树（含体积、mtime），大目录懒加载
- 单文件内容查看 + 编辑（写回宿主目录）
- **两个快照之间的 diff**（`git diff <from> <to>`）——同时也是"这轮 agent 改了哪些文件"的答案
- 构建产物清单（`dist/` 树 + 每个文件体积 + 总体积）
- **导出 zip**（整个工作区，或只要构建产物）

**注意**：工作区里有 `node_modules`（可能几万文件）。文件树必须默认排除 `node_modules` / `.git` / 缓存目录，并**限制单文件读取大小**，否则一次列目录就能把服务打挂。

**写入互斥（不做 last-write-wins）**：编辑器写入与 agent 回合改的是**同一份文件**，二者必须互斥——**agent 回合进行中，编辑器写入被拒绝并提示"正在生成中"**（反向同理）。last-write-wins 会让用户手改被静默覆盖，事后极难排查。

---

## 6. 一期边界

| 支持 | 一期 | 说明 |
|---|---|---|
| 任意语言的前端 / SSG | ✅ | node / python / go / php / java…，模板决定镜像 |
| **任意服务网站**（SSR / API / 带后端） | ✅ **核心目标** | 预览与生产都是"服务实例"（§4）；**生产实例常驻不回收** |
| **依赖服务**（DB / 缓存 / 对象存储） | ✅ | **共享 MySQL，每项目一个 database + 独立 role**；**共享 Redis** 按 key 前缀隔离；**共享 MinIO** 每项目一个 bucket。**不每项目起一个 MySQL/Redis/MinIO 容器**（贵一个量级）。（S4 起 Redis/MinIO 已落地，见变更记录） |
| 外部中间件（Kafka / ES / MQ） | ❌ 二期 | |
| GPU、多服务编排（每项目一套 compose） | ❌ | 一旦要，就退回"运维 N 个陌生人的服务" |
| 公网多租户 / 计费 / 自定义域名 | ❌ 二期 | |

---

## 7. 数据模型

```
users          id, email, plan, quota
projects       id, owner, name, slug, template, status, preview_port, live_url, created_at
conversations  id, project_id, ...
messages       id, conversation_id, seq, role, blocks(JSON), usage(JSON)
snapshots      id, project_id, label, git_ref, created_at, created_by('auto'|'user')
instances      id, project_id, role('edit'|'preview'|'production'), version, kind('static'|'service'),
               container_id, node_id, port, state, health, last_used_at
               -- 编辑容器也是 instance（role='edit'），与预览/生产共用一套生命周期代码
deployments    id, project_id, snapshot_id, instance_id, url, active, created_at
project_services id, project_id, kind('postgres'|'redis'), db_name, role_name, created_at
project_env    id, project_id, key, value_encrypted, scope('build'|'runtime'), updated_at
usage_events   id, project_id, kind('token'|'sandbox_ms'|'instance_ms'), amount, at
```

### 7.1 MySQL 注意事项（换成 MySQL 带来的一串连带影响）

- **必须 8.0+**：队列用的 `SELECT … FOR UPDATE SKIP LOCKED` 是 **8.0.1 才有的**；5.7 没有，会退化成锁表——一期不上 Redis 的前提就是这一条。
- **建库必须显式指定字符集**：`CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`。不写会踩默认字符集的老坑，中文和 emoji 都出事。
- **DDL 不支持事务回滚**：`CREATE / ALTER TABLE` 会隐式提交。平台**自身的 schema 迁移失败后回不去**——迁移脚本要写成可重入的，别指望事务兜底（这是 MySQL 比 PG 差的一处，认了）。
- **连接是线程，不是进程**：§2.4 那条"每项目连接数 ≤ 10"在多项目下会**累加**，几十个项目就能顶到 `max_connections`。要么平台侧统一走连接池 / 代理（ProxySQL），要么把每项目压到 3~5。
- **`lower_case_table_names` 跨平台不一致**：Linux 默认 0（大小写敏感）、Windows 默认 1。**WSL 本地与生产 Linux 可能不同**，表名大小写会突然报错 → **约定全小写表名**，别依赖这个开关。
- **每项目一个 database + 独立 user**（MySQL 里 database ≈ schema，比 PG 更直接）：
  ```sql
  CREATE DATABASE p_<projectId> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  CREATE USER 'p_<projectId>'@'%' IDENTIFIED BY '<随机>';
  GRANT ALL PRIVILEGES ON p_<projectId>.* TO 'p_<projectId>'@'%';   -- 只能碰自己那个库
  ```
  连接串注入成 `DATABASE_URL=mysql://p_xxx:<pwd>@mysql:3306/p_xxx`。

---

## 8. 接口清单

```
GET    /api/templates
GET    /api/projects
POST   /api/projects                    {template, prompt} → 建项目+沙箱+首轮生成
GET    /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/messages       {text}
GET    /api/projects/:id/stream         SSE：delta/thinking/tool/verify/error/done
GET    /api/projects/:id/files?path=            文件树（体积 / mtime，默认排除 node_modules、.git）
GET    /api/projects/:id/files/content?path=    单文件内容
PUT    /api/projects/:id/files/content          写回（宿主目录，不经沙箱）
GET    /api/projects/:id/diff?from=&to=         两个快照之间的改动
GET    /api/projects/:id/artifacts              构建产物清单（dist/ 树 + 体积）
GET    /api/projects/:id/export?scope=workspace|artifacts   → zip 下载
GET    /api/projects/:id/env                    环境变量 / 密钥（脱敏返回）
PUT    /api/projects/:id/env                    写入（含自动生成的连接串）
GET    /api/projects/:id/services               该项目的依赖服务与连接信息
POST   /api/projects/:id/services               {kind:'postgres'|'redis'} → 建库 / 建 role
GET    /api/projects/:id/instances              预览 / 生产实例状态（version、health）
POST   /api/projects/:id/snapshots      {label}
POST   /api/projects/:id/rollback       {snapshotId}
POST   /api/projects/:id/build
POST   /api/projects/:id/deploy         {snapshotId?}
GET    /api/projects/:id/deployments
GET    /api/projects/:id/preview-url    → {url, kind:'static'|'service', state:'ready'|'cold'|'none'}
POST   /api/projects/:id/editor/start   冷启动编辑容器（§4 的"点编辑才开"）
POST   /api/projects/:id/editor/stop    停止编辑容器（闲置也会自动停）
```

---

## 9. 前端

- **首页**：一句话输入框 + 模板选择；项目卡片（缩略图、在线地址、最近改动时间）
- **工作台**（三栏，可拖拽）：
  - 左｜对话（思考 / 命令折叠，verify 失败高亮）
  - 中｜预览 iframe（设备宽度切换、刷新、冷启动骨架屏）
  - 右｜代码（文件树 + 编辑器 + **本轮 diff**），顶部可切「源码 / 构建产物」两个根；「导出 zip」放这栏
- **顶部**：版本时间线（每个快照一个点，可回滚）+ 发布按钮 + 在线地址

---

## 10. 安全模型

| 项 | 措施 |
|---|---|
| docker socket | 只有 executor 持有；对外只暴露建 / 删沙箱、exec、查路由、工作区文件、节点注册 |
| 容器 | 非 root；**除工作区 bind mount 外不挂任何宿主目录**；不传 docker socket |
| 网络 | 禁内网网段、出口限速、磁盘限额 |
| 资源 | CPU / 内存 / pids 硬上限 + 构建超时 + 闲置回收 |
| 模型产物 | 发布时注入 CSP；禁生成指向未知外域的 `<script src>` |
| 审计 | 何时、对哪个项目跑了哪条命令（一期无登录，先记客户端 IP） |
| 前提 | **生成器进程不得持有任何生产凭据** |

**心法**：这是"任意代码执行即服务"，按最坏情况设计——**假设生成的代码就是恶意代码**。

---

## 11. 落地切片

| 片 | 内容 | 验收 |
|---|---|---|
| **S0** ✅ | executor + 沙箱镜像 + 模板解析 + edge 反代（**不接模型、不做前端**）。**预览先用 dev server**，但域名 `p-<id>` 从第一天定死，S3 只换指向（见 §4） | ① `curl` 建项目 → 沙箱内装依赖并跑起来（node 模板走 `pnpm dev`，python 模板走 `uvicorn`）<br>② 浏览器打开 `p-<id>.<host>/` 看到页面<br>③ 建到能看 **< 15 秒**（含预热）<br>④ 沙箱**停止**状态下，仍能从宿主目录列出并读取工作区文件（证明文件链路不依赖沙箱）<br>⑤ `DELETE` 后容器 / 挂载 / 路由三样回收干净<br>⑥ **至少两套语言的模板跑通**（node + python）——否则"任意环境"只是嘴上说的<br>⑦ executor 启动即**完成节点注册**（带容量与磁盘），沙箱创建一律走 **scheduler 接口**——即使眼下只有 1 个节点，代码路径也必须是分布式的<br>⑧ **资源上限生效**：跑一个吃满内存的沙箱，容器被限额终止且平台能识别为"超限"；项目数超上限时创建被**明确拒绝**（不是排队、不是静默降级） |
| **S1** | Agent 循环 + verify 闭环 | 一句话生成能跑的应用，且自动修到构建通过 |
| **S2** | Web 工作台（三栏） | 全流程在浏览器走通 |
| **S3** | 快照 / 回滚 + 发布（静态实例 + 服务实例） | 发布原子生效、一键回滚；服务型项目的**生产实例常驻** |
| **S4** | **依赖服务**：共享 MySQL 每项目一库 + 独立 role、连接串注入、Redis 隔离 | 生成一个带数据库的服务型网站；重启后数据还在，且**碰不到别人的库** |
| **S5** | 鉴权 / 多租户 / 计量 / 审计（**限额已在 S0 落地**） | 多租户隔离生效，用量可查 |
| **S6** | 沙箱升级（microVM 或托管沙箱）+ 冷启动优化 | 隔离等级提升，业务代码不改 |
| **S7** | **高可用加固（HA-1）**：orchestrator / worker 多副本、按项目分布式锁、工作区推对象存储、发布与生成平面解耦 | 杀掉一台 worker 或一个节点：进行中的生成不损坏、已发布站点不受影响 |

**S0 是关键路径**：验证整个平台最大的不确定性——"起沙箱 → 跑起来 → 反代出去 → 回收干净"这条链路本身。
**在 S0 跑通前不要碰 UI 和 Agent 循环。**

> **S0 已完成（2026-10-09）**：`scripts/smoke.sh` 18 项全过。跑法见仓库 `README.md`；落地踩坑见 §4.1 的「S0 实施记录」。

---

## 12. 主要风险

1. **安全**：这是"任意代码执行即服务"。沙箱逃逸 = 机器被拿下。隔离方案必须先定、按最坏情况设计。
2. **成本失控**：每项目一容器（可能是常驻服务）+ 模型 token。**第一天就要计量与限额**，否则一个用户开 50 个项目就能烧穿一个月预算。建议沙箱闲置自动停机、访问时冷启。
3. **二次迭代质量**：用户第三天回来改第一版能不能改对，取决于上下文管理与 verify 闭环——这是留存的分水岭，也是 S1 要做扎实的意义。
4. **镜像与冷启动**：语言越多、镜像越多越大；不预拉就得等。这是"任意环境"的真实代价。
5. **预览域名与证书**：泛解析 DNS + 泛域名 TLS 是硬前置，别等到 S2 才发现没域名。

---

## 13. 待定项

1. **仓库目录**（本文件所在位置即为默认）
2. 是否有可用域名（没有就走 `nip.io`）
3. 生产环境有没有可用的 Docker 主机（本机验证已定 WSL2，见 §4.1）

## 14. 架构自查结论（2026-10-09）

自查发现的 12 个问题。A 类（会让设计不成立的）与 B 类（自相矛盾）已在正文修正；C 类六条已拍板，结论如下：

| # | 问题 | 结论 |
|---|---|---|
| **C1** | 「对象存储」没有落地形态 | **HA-0 用本地目录**（它自己就是权威副本）；**对象存储从 HA-1 才引入** |
| **C2** | Redis 要不要 | ~~**一期不用**——队列放 MySQL；跨实例 SSE 广播到 HA-1 再加~~ → **已被 S4 覆盖**（2026-10-12，用户确认）：引入共享 Redis 做缓存/会话，**队列仍放 MySQL**（`SKIP LOCKED` 前提不变），key 前缀约定隔离 |
| **C3** | 编辑器写文件 vs agent 回合的并发 | **互斥**（agent 回合中拒绝编辑器写入，反向同理）；**不做 last-write-wins** |
| **C4** | `sandboxes` 与 `instances` 两表重叠 | **合成一张** `instances`，`role: 'edit' \| 'preview' \| 'production'` |
| **C5** | 缺「启动 / 停止编辑容器」接口 | **补** `POST /api/projects/:id/editor/start`、`/stop` |
| **C6** | S0 的预览是 dev server 还是构建产物 | **S0 用 dev server**；`p-<id>` 域名从第一天定死，S3 只换指向 |

---

## 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-09 | 初稿。确定：单机 Docker、不限语言（模板决定镜像）、子域预览、Claude Agent SDK、一期边界与 S0~S5 切片。 |
| 2026-10-09 | 增补「产物目录」：工作区改为宿主 bind mount（`data/workspaces/<id>/`），文件读写不依赖沙箱存活；新增 §5.3、文件/diff/产物/导出接口与 S0 验收项。 |
| 2026-10-09 | 本地开发定为 `*.localhost`（浏览器原生解析到回环，零 DNS 配置），宿主机只暴露一个端口；新增 §4.1，域名/协议/端口全部走环境变量。 |
| 2026-10-09 | 增补分布式：新增 §1.1（多节点拓扑、六处改造、四条硬约束、不建议直接上 K8s）；executor 增工作区文件接口与节点注册；文件链路改为经 executor（分布式下 orchestrator 与节点常不同机）；S0 增节点注册与 scheduler 验收项。 |
| 2026-10-09 | 增补高可用：新增 §1.2（可用性目标分层、组件 HA 矩阵、四条 HA 特有问题、降级与自愈、HA-0/1/2 分级）；新增决策 9；executor 增 drain；工作区改为「对象存储权威副本」；新增切片 S6。 |
| 2026-10-09 | 本地环境定为 WSL2；§4.1 增「WSL2 的四个坑」：工作区必须落 ext4（不能 `/mnt/d`）、WSL 空闲回收 VM、localhost 转发不稳的兜底、`.wslconfig` 资源配额。 |
| 2026-10-09 | 明确「编辑 / 运行两个平面」：新增 §1.3 与决策 10。容器数不是 2 × 项目数——静态站运行侧 0 容器，常驻服务才有运行容器且只在发布后存在；运行容器用只读产物镜像。 |
| 2026-10-09 | 预览语义改为「**伺服产物而非容器**」（决策 11，重写 §4）：主预览永远可用、零冷启动，且与发布是同一份文件；dev server 降级为可选的"实时视图"通道。 |
| 2026-10-09 | 确定「**任意服务网站**」是核心目标（决策 12）：§4 重写为「预览与运行统一为**实例**」（静态实例 / 服务实例，模板声明），分档说明"能直接看"的保证——**生产实例不参与闲置回收**；§6 把 SSR/API 与依赖服务提到核心；§7 增 `instances`/`project_services`/`project_env`；§8 增 env/services/instances 接口；切片新增 S4 依赖服务（S4~S6 顺移为 S5~S7）。 |
| 2026-10-09 | 资源上限提前：新增决策 13 与 §2.4（单项目 CPU/内存/pids/磁盘/DB 连接数 + 项目数上限，含"服务型项目单独更严"）。S0 增验收项 ⑧；S5 的"限额"移出（已在 S0 落地）。 |
| 2026-10-09 | §1.3 增「几个容器要看常驻，不是看角色」：角色最多三个，**常驻只有一个**（静态 0 / 服务型已发布 1）；并记下两条"不合并"的理由。 |
| 2026-10-09 | 架构自查。**A 类**：指出「静态实例 0 容器」在 Traefik 下不成立（需共享静态伺服或换边缘）、静态产物必须落在边缘可达位置、「禁内网」与「连共享 Pg」冲突（改为白名单放行依赖服务）。**B 类**：修掉 8 处自相矛盾（宿主挂载、工作区路径统一为 `$WEBGEN_DATA_DIR/<id>/`、§1.1 工作区表述、接口数量、审计"谁"、决策 5 措辞、agent 循环位置、待定项过时）。**C 类**：六条已拍板并落地（§14）。 |
| 2026-10-09 | C 类落地：对象存储 HA-1 才引入、一期不用 Redis（队列放 MySQL）、编辑器写入与 agent 回合互斥、`sandboxes` 并入 `instances`、补 editor start/stop 接口、S0 用 dev server 且 `p-<id>` 域名当天定死。 |
| 2026-10-09 | **S0 落地完成**（18 项验收全过）。§4.1 增「S0 实施记录」8 条踩坑（traefik 必须 v3.6、mirrored 下端口与 Windows 冲突、代理拦截 curl、calloc 零页误导 OOM 测试、wait 语义改为"预览可打开"、pnpm allowBuilds、`&` 的后台化陷阱、注释里的 `*/`）；§2.2 限额增「MemorySwap 等于 Memory 禁 swap」；§11 标记 S0 已完成。 |
| 2026-10-09 | 数据库改 MySQL：正文 Postgres 全量替换；补 §7.1「MySQL 注意事项」——**必须 8.0+**（队列依赖 `SKIP LOCKED`）、建库显式 utf8mb4、**DDL 不可回滚**、**连接是线程**（每项目连接数会累加，需池/代理）、`lower_case_table_names` 跨平台不一致（约定全小写表名）、每项目一库一 user 的建法。S0 不再用 SQLite 过渡。 |
| 2026-10-09 | 本机环境勘探并固化（§4.1「本机实测环境」）：工具链已齐无需安装；`p-*.localhost` 从 Windows 侧实测可达（mirrored 网络，§4.1 坑 3 不成立）；端口 8000 被 glitchtip 占 → orchestrator 改 8800；`.wslconfig` 加 `vmIdleTimeout=-1`（坑 2 实测会发生）+ `autoMemoryReclaim`（**只认 `[experimental]` 段**）；预热 `node:22-bookworm-slim`/`python:3.12-slim`/`mysql:8.4`。 |
| 2026-10-12 | **S4「工程化模板」落地**：四门语言种子升级为企业级分层工程；工作区布局改为 `backend/`+`frontend/`+`deploy/`（老项目用 `projects.layout_version` 冻结旧 spec，不迁移）；**接入了共享 Redis 与 MinIO**（覆盖 §14-C2「一期不用 Redis」——用户确认，队列仍放 MySQL，`SKIP LOCKED` 前提不变）；数据段改为**多选**（`Stack.data` 由单值变数组），MySQL 每项目一库一账号 + 连接串注入 + 删项目连库一起删；老模板（node-web/fastapi/go-web/java-web）**收敛成组合预设**。**Java 的 MySQL/Redis/MinIO 降级**（镜像无法增量拉 Maven 依赖，见 §4.1/README）。§7 的 `project_services`/`project_env` 与 §8 的 env/services 接口落地（`key` 列改名 `env_key`，MySQL 保留字）。§10 记：Redis/MinIO 是**约定隔离**（同实例共享凭证），不是强制。 |
