# Java 模板是 **Spring Boot**（企业级骨架），所以直接用官方 maven 镜像：
# Maven + JDK 21 一套齐活，仓库路径也是标准布局，不用自己叠。
# 比 eclipse-temurin 多一层 Maven，镜像大一些，但省掉"沙箱里现装构建工具"这件事。
FROM maven:3.9-eclipse-temurin-21

# 覆盖全局 settings：本地仓库指向 /opt/m2，中央仓库走阿里云镜像。
# 本机 registry.npmjs.org 被中间人劫持过（自签证书），Maven Central 走同一条国际出口，
# 没必要赌它没事。
COPY settings.xml /usr/share/maven/conf/settings.xml

# ★★ 依赖预热（§2.3「常用框架装进镜像」）——**这一步是这个模板能不能用的分水岭**。
#
# Spring Boot 首次构建要联网拉上百 MB 依赖。沙箱只有 1 CPU / 1GB，
# 现拉一次少说几分钟，必然撞上 AGENT_VERIFY_TIMEOUT_MS（默认 120s），
# 于是 verify 永远失败、agent 反复"修"一个根本不是它写坏的构建。
#
# 注意不是声明式的 `dependency:go-offline` —— 那个会漏掉插件（实测漏
# spring-boot-maven-plugin 的 repackage 相关件），必须**真把一个可运行骨架
# build 一遍**，把整条构建路径都落进 /opt/m2。
#
# ⚠️⚠️ **上面这三条指令一个字都别改**（含 COPY 的路径）。
# 这层要联网下上百 MB，而本机到 Maven 镜像的下载会**卡死**（实测：/opt/m2 停在 40M
# 十几分钟不动）。它现在能用的唯一原因就是**命中旧缓存**。
# 一旦改了 COPY 的路径或指令原文，这层就失效重建 —— 然后就卡在那儿下不完。
# 新步骤（比如装 nginx）一律**往后加**。
COPY warm /opt/warm
RUN mvn -B -ntp -q -f /opt/warm/pom.xml package -DskipTests \
 && rm -rf /opt/warm

RUN useradd -m -u 10001 -s /bin/bash sandbox \
 && chown -R sandbox:sandbox /opt/m2

# nginx：组合项目要「一个容器里 nginx 前置 + 后端进程」。
# 只装二进制，配置由平台生成到工作区（理由见 node/Dockerfile 那段）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light \
 && rm -rf /var/lib/apt/lists/*

# nginx 在 /usr/sbin。Ubuntu（这个基座）的 /etc/profile 对非 root 也带 /usr/sbin，
# 所以这条对这个镜像是冗余的 —— 但四个语言镜像保持一致，免得以后换基座时漏掉。
RUN printf 'export PATH=$PATH:/usr/sbin\n' > /etc/profile.d/usr-sbin.sh

USER sandbox
WORKDIR /workspace

# MAVEN_ARGS 是 Maven 3.9 起支持的环境变量，会拼在每个 mvn 命令前面 ——
# 这样 agent 随手敲 `mvn package` 也带着 -B -ntp，不用教它。
#
# JAVA_TOOL_OPTIONS：沙箱内存是**硬上限**。不设 MaxRAMPercentage 的话 JVM 按宿主
# 总内存算堆，一上来就申请超限内存被 OOM 杀掉，看起来只是"应用起不来"。
ENV MAVEN_ARGS="-B -ntp" \
    MAVEN_CONFIG=/home/sandbox/.m2 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC"
