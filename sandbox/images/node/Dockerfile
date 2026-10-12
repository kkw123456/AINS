FROM node:22-bookworm-slim

# 非 root：容器里跑的是生成出来的代码（§2.2）
RUN npm install -g pnpm@11.5.1 \
 && useradd -m -u 10001 -s /bin/bash sandbox

# 静态站预览服务器。放在镜像里而不是工作区，是为了 **agent 改不动它** ——
# 写在种子里的 server 文件会被 agent 当成项目代码改掉或删掉，预览就跟着没了。
# 它为什么不用 `vite preview`，见文件头的注释。
COPY serve-static.mjs /usr/local/bin/serve-static
RUN chmod 0755 /usr/local/bin/serve-static

# nginx：组合出来的项目是「一个容器里 nginx 前置 + 后端进程」。
#
# ⚠️⚠️ **新加的步骤一律往后加**，别插在上面那些慢步骤前面。
# Docker 的层缓存按「父层 + 指令原文」命中，插在前面会让 npm/pip/mvn 那些
# **要联网装依赖**的层整层失效、重新联网 —— 实测就这么踩过：java 那次重跑
# Maven 预热，卡在下载上 13 分钟没动（/opt/m2 停在 40M）。
# 慢的、要联网的放最前，新的往后加。
#
# 只装**二进制**、不带配置：nginx 的配置是**项目代码**（agent 可能真要加路由），
# 由平台生成到工作区、用 `nginx -c /workspace/nginx.conf` 启动。
# 烤一份配置进镜像反而会让它成为"agent 改不动的黑盒"。
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ 必须补这一条：nginx 装在 `/usr/sbin/nginx`，而 Debian 的 `/etc/profile`
# 给**非 root** 设的 PATH 里**没有 /usr/sbin**（root 的才有 —— 所以自己以 root
# 手测很容易漏掉）。我们的进程是 uid 10001，不补的话跑 `nginx` 就是 command not found，
# 而现象只是"容器起不来"。
# 和 go 那个 PATH 坑同理：`bash -lc` 会重读 profile 覆盖 ENV PATH，所以只能落 profile.d。
RUN printf 'export PATH=$PATH:/usr/sbin\n' > /etc/profile.d/usr-sbin.sh

# ★★ 前端依赖走镜像源 —— **这是"带前端的项目能不能在十几秒内建起来"的分水岭**。
#
# 不配它：`pnpm install` 直连 registry.npmjs.org。实测在这台机器上单条请求能挂到
# **70 秒**（`Request took 69867ms`，还伴着 error(23) 重试），整轮安装 1 分 20 秒起步，
# 而 `/sandboxes/:id/wait` 的就绪超时是 60~90 秒 —— 项目建出来就是"起不来"，
# 而且看起来像平台坏了。装上镜像源之后冷装 4.6 秒、稳定。
#
# 和 java（阿里云 Maven）/ go（goproxy.cn）是同一个决定、同一个理由：
# 这台机器到国际出口的 npm 源被中间人劫持过（自签证书），不该赌它什么时候好。
#
# ⚠️ 写进 **sandbox 用户的 ~/.npmrc**，不是工作区里的 .npmrc：
#    这是**工具链配置**（环境），不是项目代码。放进工作区会让它出现在文件树、
#    进快照、被 agent 当成"项目的配置"改掉。也别写 /usr/local/etc/npmrc ——
#    实测 pnpm **不读**那个全局文件（registry 仍然是 npmjs）。
#
# ⚠️ 还有一件试过但**没用**的事，写在这儿免得后人重复踩：
#    想在镜像里预热 pnpm store（`pnpm install` 一遍把包落进 store）来省掉联网。
#    **不行** —— pnpm 的 store 必须和项目在同一个文件系统上才肯用，而工作区是
#    bind mount（另一个 fs），于是它**无视 store-dir 配置**，每次都在
#    `/workspace/.pnpm-store` 就地建一个。所以预热出来的 72MB store 根本不会被读。
#    （好消息：那个工作区内的 store **在容器重建后还在**，所以第二次起容器是 ~1 秒。）
RUN printf 'registry=https://registry.npmmirror.com\n' > /home/sandbox/.npmrc \
 && chown sandbox:sandbox /home/sandbox/.npmrc

USER sandbox
WORKDIR /workspace
ENV NODE_ENV=development \
    PNPM_HOME=/home/sandbox/.local/share/pnpm \
    PATH=/home/sandbox/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
