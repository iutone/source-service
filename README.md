# iyt-source-server

IUTone 自建源的参考服务端：把视频源部署在自己局域网里的服务上，App（iPhone / iPad / Mac / Apple TV）按统一接口接入。
接口规范与设计：[docs/remote-source/SERVER.md](../docs/remote-source/SERVER.md)；App 一侧：[APP.md](../docs/remote-source/APP.md)。

本仓库只带一个示例源「本地视频目录」（`sources/folder`），不附带任何平台的源配置。

## 本机运行

```bash
pnpm install
pnpm dev        # 读 data/config.yaml（第一次会写一份空的），改代码自动重启
```

打开 `http://<本机局域网地址>:8090/debug`：服务状态、各源登录（二维码 / 设备码）、浏览、搜索、历史、在页面里播放解析出的流、
接口控制台、请求日志。只对局域网开放。

```yaml
# data/config.yaml
name: 客厅 NAS
port: 8090
sources:
  - id: videos
    plugin: "@iyt-source/folder"
    options: { path: ./media }      # 一级目录是频道，频道下的目录是节目
```

## 命令

| 命令 | 说明 |
|---|---|
| `node packages/cli/src/main.ts serve [--config <路径>]` | 启动；也可用 `$IYT_CONFIG`、`$IYT_DATA`、`$IYT_PORT` |
| `node packages/cli/src/main.ts check http://<地址>:8090` | 一致性检查：按 App 的顺序走一遍接口 |
| `node packages/cli/src/main.ts plugins add <包>` | 把第三方源装进 `<数据目录>/plugins` |
| `pnpm test` / `pnpm typecheck` | 测试 / 类型检查 |

Node 22.18+ 直接运行 `.ts`（类型擦除），没有构建步骤。平台请求遵守 `HTTPS_PROXY` / `NO_PROXY`。

## Docker（NAS）

```bash
docker build -t iyt-source-server .      # Dockerfile 在本目录，基础镜像 registry.cn-beijing.aliyuncs.com/mxc/base
docker compose up -d --build              # 或连同可选的 PO Token sidecar 一起起
```

必须 `network_mode: host`，否则 Bonjour 广播出不去。镜像带 Python + yt-dlp（每天自动更新）和 ffmpeg。

## 写一个源

插件包默认导出一个工厂函数 `(options, env) => SourcePlugin`（`@iyt-source/kit` 的 `plugin.ts`）：有哪些模块
（`feed`、`search`、`detail`、`playback`、`account`、`history` …），manifest 的 `features` 就声明哪些。
需要请求头的流用 `ctx.media.proxy(...)` 交给媒体网关，播放列表会被改写；本地文件用 `ctx.media.file(...)`。
抛 `SourceError(code, message)` 给 App 看得懂的错误。参考 `sources/folder`。
