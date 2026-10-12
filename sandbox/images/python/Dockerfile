FROM python:3.12-slim-bookworm

# 依赖预热：常用框架装进镜像，新建项目就不必等 pip（§2.3）
#
# ⚠️⚠️ **这一条一个字都别改**（连空格都别动）。
# Docker 的层缓存按「父层 + 指令原文」命中：这是要联网装几十 MB 的一条，
# 而本机到 files.pythonhosted.org 和 mirrors.aliyun.com **都会读超时**（都实测踩过）。
# 它现在能用的唯一原因就是**命中旧缓存** —— 改了哪怕一个字符，这层就会重新联网然后失败。
# 要加镜像源之类的，等真需要重装时再说；**新步骤一律往后加**。
RUN pip install --no-cache-dir fastapi 'uvicorn[standard]' \
 && useradd -m -u 10001 -s /bin/bash sandbox

# nginx：组合项目要「一个容器里 nginx 前置 + 后端进程」。
# 只装二进制，配置由平台生成到工作区（理由见 node/Dockerfile 那段）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ 必须补这一条：nginx 在 /usr/sbin，而 Debian 的 /etc/profile 给**非 root** 设的
# PATH 里没有 /usr/sbin（root 的才有）。uid 10001 下跑 `nginx` 会 command not found，
# 现象只是"容器起不来"。原因和 go 那个 PATH 坑一样，只能落 profile.d。
RUN printf 'export PATH=$PATH:/usr/sbin\n' > /etc/profile.d/usr-sbin.sh

# ★★ 企业级新增依赖（S4 工程化模板）——**一条独立的新层，绝不动上面那条 fragile 的 pip 层**。
#
# 上面 `pip install fastapi ...`（L10）必须逐字不动（改了会重新联网然后读超时）；
# 这条是**新增**的一层，只失效它自己。走**阿里云镜像**：实测 pip 直连
# files.pythonhosted.org 会读超时，但走 aliyun 的 simple 索引秒过（S0-a spike 实测）。
#
# 新步骤一律往后加（见 node/Dockerfile 那段解释）：Docker 层缓存按「父层 + 指令原文」命中。
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
      sqlalchemy pydantic-settings alembic pymysql

# redis 单独**另起一层**（很小的纯 py 包）：上面那层已经建好了，别去动它的字面量
# （改了会失效重建、又要联网装那几十 MB）。走清华源 —— 阿里云源这两次都读超时了。
RUN pip install --no-cache-dir --retries 10 --timeout 120 -i https://pypi.tuna.tsinghua.edu.cn/simple redis

# MinIO 客户端（S4 对象存储 / 「文件系统」）——同样单独一层，走清华源。
RUN pip install --no-cache-dir --retries 10 --timeout 120 -i https://pypi.tuna.tsinghua.edu.cn/simple minio

USER sandbox
WORKDIR /workspace
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
