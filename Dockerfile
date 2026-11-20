# IUTone 自建源服务（docs/remote-source/SERVER.md §14）。构建上下文是这个目录：
#   docker build -t iyt-source-server .
# 基础镜像按服务端构建规范用 mxc/base；不假设它装了什么，缺的这里补上（以 root 运行，和其他服务一样）。
FROM registry.cn-beijing.aliyuncs.com/mxc/base

USER root
WORKDIR /app

# 系统依赖：python3 + venv（yt-dlp）、ffmpeg（转封装、ffprobe）、curl / xz（下载 Node）。已有的不装。
RUN set -eux; \
    missing=""; \
    command -v python3 >/dev/null 2>&1 || missing="$missing python3"; \
    python3 -c 'import venv, ensurepip' >/dev/null 2>&1 || missing="$missing python3-venv"; \
    command -v ffmpeg >/dev/null 2>&1 || missing="$missing ffmpeg"; \
    command -v curl >/dev/null 2>&1 || missing="$missing curl ca-certificates"; \
    command -v xz >/dev/null 2>&1 || missing="$missing xz-utils"; \
    if [ -n "$missing" ]; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Node 22.18+（直接运行 .ts 要类型擦除）：基础镜像的太旧就换成 Node 24，从 npmmirror 下载。
ARG NODE_VERSION=24.11.1
RUN set -eux; \
    ok=$(node -e 'const [a, b] = process.versions.node.split(".").map(Number); console.log(a > 22 || (a === 22 && b >= 18) ? 1 : 0)' 2>/dev/null || echo 0); \
    if [ "$ok" != 1 ]; then \
      case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)"; exit 1 ;; esac; \
      curl -fsSL "https://cdn.npmmirror.com/binaries/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1; \
    fi; \
    node --version; npm --version

# yt-dlp（带 EJS 解题脚本，用 Node 解签名）和 PO Token 插件，装进 /opt/venv；每日更新也在这里。
RUN set -eux; \
    [ -x /opt/venv/bin/python ] || python3 -m venv /opt/venv; \
    /opt/venv/bin/python -m pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple -U "yt-dlp[default]" bgutil-ytdlp-pot-provider; \
    /opt/venv/bin/yt-dlp --version

COPY . .

# pnpm 版本要和 package.json 的 devEngines 一致（不一致直接报错）。
RUN npm exec --yes --registry=https://registry.npmmirror.com pnpm@11.4.0 -- install --prod --frozen-lockfile --registry=https://registry.npmmirror.com

RUN mkdir -p /data
ENV IYT_DATA=/data \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    YTDLP_UPDATE="/opt/venv/bin/python -m pip install -q -U -i https://mirrors.aliyun.com/pypi/simple yt-dlp[default] bgutil-ytdlp-pot-provider" \
    YTDLP_ARGS="--js-runtimes node" \
    NODE_ENV=production
VOLUME /data
EXPOSE 8090
CMD ["node", "packages/cli/src/main.ts", "serve"]
