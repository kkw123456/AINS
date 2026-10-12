# ★ 从 alpine 换成 Debian —— **这是"动态组合"能不能成立的前提**。
#
# 组合出来的项目镜像要把 node 从 `webgen/node`（Debian/glibc）COPY 进来，而 node 的
# 二进制是**动态链接 glibc** 的（实测 `libdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2`），
# 拷进 musl 的 alpine 直接跑不起来。反过来没问题：go 编译器本身是静态的
# （实测 `Not a valid dynamic program`），可以拷进任何 glibc 镜像。
#
# 所以规则是「基座 = 后端的镜像」，而这条要求**所有基座都是 glibc**。
# 代价：镜像 333MB → 1.2GB。不换的话 "go 后端 + Vue 前端" 这个组合做不出来。
FROM golang:1.25-bookworm

# ⚠️ `bash -lc` 是**登录 shell**，它会重读 /etc/profile，而 Debian 的 /etc/profile
# **会把 PATH 整个重置掉** —— base 镜像 ENV 里的 /usr/local/go/bin 就没了，
# 实测 `bash -lc "go version"` 报 command not found。
# 光写 ENV PATH 治不了这个，必须落在 /etc/profile.d/ 里（profile 之后才 source 它）。
# （alpine 时代踩过同一个坑，换成 Debian 一样 —— 别以为换了发行版就没事。）
RUN useradd -m -u 10001 -s /bin/bash sandbox \
 && printf 'export PATH=/usr/local/go/bin:$PATH\n' > /etc/profile.d/go-path.sh

# nginx：组合项目要「一个容器里 nginx 前置 + 后端进程」。
# 只装二进制，配置由平台生成到工作区（理由见 node/Dockerfile 那段）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ 必须补这一条：nginx 在 /usr/sbin，而 Debian 的 /etc/profile 给**非 root** 设的
# PATH 里没有 /usr/sbin（root 的才有）。uid 10001 下跑 `nginx` 会 command not found，
# 现象只是"容器起不来"。和上面 go 的 PATH 坑同一个原因。
RUN printf 'export PATH=$PATH:/usr/sbin\n' > /etc/profile.d/usr-sbin.sh

USER sandbox
WORKDIR /workspace

# GOTOOLCHAIN=local：go.mod 里写了比镜像新的版本时**直接报错**，不让 go 偷偷去下工具链
#   （那会让"起容器"变成一次不受控的网络下载）。
# GOPROXY 走国内代理再回落官方：本机 registry.npmjs.org 被中间人劫持过（自签证书），
#   go 这边没必要赌同一件事不会发生。
# CGO_ENABLED=0：纯静态二进制，不依赖 gcc。
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOFLAGS=-mod=mod \
    GOPATH=/home/sandbox/go \
    GOCACHE=/home/sandbox/.cache/go-build \
    GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct

# ★★ 预热 Go 构建缓存 —— 和 java 那份 Maven 预热是同一件事、同一个理由。
#
# Go 1.20 起**标准库不再预编译**：第一次 `go build` 要把用到的 stdlib 包现编一遍。
# 实测在 1 CPU 沙箱里这一段是 **27 秒**，而且 GOCACHE 在**容器自己的文件系统**上，
# 容器一重建（agent 每轮生成最多重建 4 次）就全丢，下次再付 27 秒。
# 这就是"带 go 后端的项目建起来要 40 秒"的全部原因。
#
# `go build std` 把整个标准库编进缓存：实测 44 秒、159MB，之后**任何**只依赖
# 标准库的项目构建 0.4 秒。一次性成本换掉每次重建 27 秒。
# （不用"只编种子用到的那几个包"——agent 随时会 import 别的，编全了才稳。）
#
# ⚠️ 这一步**不联网**，所以放在最后、也不怕它失效重建。
RUN GOCACHE=/home/sandbox/.cache/go-build go build std \
 && chown -R sandbox:sandbox /home/sandbox/.cache

# ★★ 预热「企业级」模块（S4）：chi / zap / sqlx / go-sql-driver / go-redis。
#
# 排在 stdlib 预热**之后**（新的往后加，见上面那条注释）：只失效它自己，
# 不动上面那条已经建好的 stdlib 层。warm 模块的 go.mod/go.sum 已把版本钉死
# （go-redis 固定 v9.7.3 —— 更新的 v9 要 go 1.26，而镜像是 1.25 + GOTOOLCHAIN=local）。
# `go mod download` 把这些模块拉进 GOMODCACHE，之后项目 `go build` 就是纯本地命中。
COPY --chown=sandbox:sandbox warm /home/sandbox/warm
RUN cd /home/sandbox/warm && GOFLAGS=-mod=mod go mod download \
 && go build ./... \
 && rm -rf /home/sandbox/warm
