# IUTone 自建源服务（docs/remote-source/SERVER.md §14）。在 source-server/ 目录构建：
#   docker build -f docker/Dockerfile -t iyt-source-server .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider \
 && npm install -g pnpm@11.4.0

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY sources ./sources
RUN pnpm install --prod --frozen-lockfile

ENV IYT_DATA=/data \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    YTDLP_UPDATE="/opt/venv/bin/pip install -q -U yt-dlp[default] bgutil-ytdlp-pot-provider" \
    YTDLP_ARGS="--js-runtimes node" \
    NODE_ENV=production
VOLUME /data
EXPOSE 8090
CMD ["node", "packages/cli/src/main.ts", "serve"]
