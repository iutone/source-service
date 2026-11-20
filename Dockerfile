# IUTone 自建源服务（docs/remote-source/SERVER.md §14）。构建上下文是这个目录：
#   docker build -t iyt-source-server .
# 基础镜像自带 Node 24、pnpm、ffmpeg、/opt/venv（Python，阿里云 PyPI 源）、tini，以 aisandbox 用户运行。
FROM registry.cn-beijing.aliyuncs.com/mxc/base

USER root
RUN mkdir -p /app /data && chown aisandbox:aisandbox /app /data
USER aisandbox
WORKDIR /app

# yt-dlp（带 EJS 解题脚本，用 Node 解签名）和 PO Token 插件，装进基础镜像的 /opt/venv：运行用户可写，每日更新也在这里。
RUN uv pip install --python /opt/venv/bin/python -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

COPY --chown=aisandbox:aisandbox . .

# pnpm 版本要和 package.json 的 devEngines 一致（不一致直接报错）。
RUN npm exec --yes --registry=https://registry.npmmirror.com pnpm@11.4.0 -- install --prod --frozen-lockfile --registry=https://registry.npmmirror.com

ENV IYT_DATA=/data \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    YTDLP_UPDATE="/opt/venv/bin/python -m pip install -q -U yt-dlp[default] bgutil-ytdlp-pot-provider" \
    YTDLP_ARGS="--js-runtimes node" \
    NODE_ENV=production
VOLUME /data
EXPOSE 8090
CMD ["node", "packages/cli/src/main.ts", "serve"]
