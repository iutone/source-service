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

## 部署到 NAS（Docker）

### 拉取镜像

镜像由服务端构建服务构建（source-service 仓库的 `main`），公开拉取、不用登录：

```bash
docker pull registry.cn-beijing.aliyuncs.com/mxc/iutone:latest
```

镜像里有 Node、Python + yt-dlp（启动后每天自动更新）和 ffmpeg，数据都在 `/data`。也可以自己构建：
`docker build -t iyt-source-server .`（Dockerfile 在本目录，基础镜像 `registry.cn-beijing.aliyuncs.com/mxc/base`）。

### 启动

```bash
docker run -d --name iutone --restart unless-stopped --network host \
  -v /share/Container/iutone/data:/data \
  -e HTTPS_PROXY=http://<代理地址>:7890 -e HTTP_PROXY=http://<代理地址>:7890 \
  -e NO_PROXY=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,.local \
  registry.cn-beijing.aliyuncs.com/mxc/iutone:latest
```

- **必须 `--network host`**：App 靠 Bonjour（mDNS）发现服务，桥接网络里广播出不去。端口默认 8090，配置里的 `port` 可改。
- **数据目录** `/data`：`config.yaml`、各源的登录态和观看进度、装的插件都在这里，升级镜像不丢。第一次启动会写一份空配置，
  这时只有调试页，没有任何源。
- **视频目录**默认不挂、也不开「本地视频」源。要用时加 `-v /share/video:/media/videos:ro`，再在配置里加上 `folder` 源。
  群晖、威联通的共享文件夹常是符号链接，挂载真实路径（`readlink -f`）。
- **代理**：服务去平台取数据、yt-dlp 取流都走 `HTTPS_PROXY` / `HTTP_PROXY`（大小写两种都认）。`NO_PROXY` 一定要带上局域网
  网段，否则访问局域网里的东西也会绕到代理上。App 访问这个服务不走代理，只连局域网。
- 用 compose 的话见 `docker-compose.yml`（同样是 host 网络，带一个可选的 PO Token 服务）。

### 配置源

改 `<数据目录>/config.yaml`，然后 `docker restart iutone`：

```yaml
name: 客厅 NAS              # App 里显示的服务名
port: 8090
sources:
  - id: youtube
    plugin: ./repo/source-plugins/youtube              # 相对数据目录；镜像不带平台的源
    options: { language: zh-CN }
  # 可选：本地视频目录（要先挂载视频目录）。一级目录是频道，频道下的目录是节目
  # - id: videos
  #   plugin: "@iyt-source/folder"
  #   options: { path: /media/videos, name: 本地视频 }
```

镜像里只有示例源 `folder`。平台的源（比如 YouTube）是单独的插件，放进数据目录、在配置里写路径加载；插件
`import` 的 `@iyt-source/kit`、`@iyt-source/protocol` 链接到镜像里的 `/app/packages/kit`、`/app/packages/protocol`。

### 检查

- 浏览器打开 `http://<NAS 地址>:8090/debug`：每个源的状态、登录（扫码 / 设备码）、浏览、搜索、在页面里播放、请求日志。
  只对局域网开放。
- 一致性检查：`docker exec iutone node packages/cli/src/main.ts check http://127.0.0.1:8090`。
- 日志：`docker logs -f iutone`。

### 代理节点注意事项（YouTube）

- **取流在服务端**：App 播放时只连这台服务，视频由服务里的 yt-dlp 从 YouTube 取、经服务转发。能不能播只看**服务的
  出口节点**，和电视、手机自己走什么代理无关（设备的代理只影响封面、头像这类直接从 `i.ytimg.com` 加载的图片）。
- **机房 IP 会被要求验证**：YouTube 会对一些机房 IP 要求「确认不是机器人」，这时所有视频都取不到流，App 里提示
  「YouTube 暂时拦下了服务的网络（要求验证不是机器人）」。这和账号无关，电视上登录 YouTube 也解决不了。
- **按节点实测，别交给自动测速**：同一家代理商，有的节点被拦、有的不被拦。自动测速只看延迟，可能正好挑中被拦的。
  切到候选节点后，在容器里实际取一次流：

  ```bash
  docker exec iutone /opt/venv/bin/yt-dlp --js-runtimes node --no-cache-dir -J --skip-download \
    'https://www.youtube.com/watch?v=<任一公开视频>' > /dev/null && echo 可用
  ```

  报 `Sign in to confirm you're not a bot` 就是这个节点被拦了。在能用的节点里挑延迟低、速度快的，把 YouTube 的分流组
  **固定**到它（OpenClash / Clash 打开「记住节点选择」，`profile.store-selected: true`，重启后不变）。
- **节点会变**：以后又出现上面的提示，就按同样的办法重新测、换一个节点。
- **流量**：视频经服务转发，YouTube 的视频流量全走服务的代理，用流量额度充足的那家，别用流量少的。
- **PO Token**：`docker-compose.yml` 里的 `bgutil-pot` 能让 yt-dlp 带上 PO Token，YouTube 更信任一些。它是 GPL-3.0，
  所以不打进镜像，按需单独跑。节点 IP 本身信誉太差时它也救不回来，先换节点。

## 写一个源

插件包默认导出一个工厂函数 `(options, env) => SourcePlugin`（`@iyt-source/kit` 的 `plugin.ts`）：有哪些模块
（`feed`、`search`、`detail`、`playback`、`account`、`history` …），manifest 的 `features` 就声明哪些。
需要请求头的流用 `ctx.media.proxy(...)` 交给媒体网关，播放列表会被改写；本地文件用 `ctx.media.file(...)`。
抛 `SourceError(code, message)` 给 App 看得懂的错误。参考 `sources/folder`。
