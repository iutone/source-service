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
  registry.cn-beijing.aliyuncs.com/mxc/iutone:latest
```

要让服务单独走一个代理时再加（见下面「代理」）：

```bash
  -e HTTPS_PROXY=http://<代理地址>:7890 -e HTTP_PROXY=http://<代理地址>:7890 \
  -e NO_PROXY=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,.local \
```

- **必须 `--network host`**：App 靠 Bonjour（mDNS）发现服务，桥接网络里广播出不去。端口默认 8090，配置里的 `port` 可改。
- **数据目录** `/data`：`config.yaml`、各源的登录态和观看进度、装的插件都在这里，升级镜像不丢。第一次启动会写一份空配置，
  这时只有调试页，没有任何源。
- **视频目录**默认不挂、也不开「本地视频」源。要用时加 `-v /share/video:/media/videos:ro`，再在配置里加上 `folder` 源。
  群晖、威联通的共享文件夹常是符号链接，挂载真实路径（`readlink -f`）。
- **代理（可选）**：不设就直接联网。路由器或旁路由已经给 NAS 做了透明代理（网关 / DNS 指过去）的，什么都不用加。
  只有要让服务单独走某个代理时才设 `HTTPS_PROXY` / `HTTP_PROXY`（大小写两种都认）：服务去平台取数据、yt-dlp 取流都会走它，
  这时 `NO_PROXY` 一定要带上局域网网段，否则访问局域网里的东西也会绕到代理上。App 访问这个服务不走代理，只连局域网。
- 用 compose 的话见 `docker-compose.yml`（同样是 host 网络，带一个可选的 PO Token 服务）。

### 配置源

改 `<数据目录>/config.yaml`，然后 `docker restart iutone`：

```yaml
name: 客厅 NAS              # App 里显示的服务名
port: 8090
sources:
  - id: youtube
    plugin: /app/plugins/youtube                       # 镜像自带，配置里加上才启用
    visibility: auto                                   # App 里直接显示
    options: { language: zh-CN }
  - id: ted
    plugin: /app/plugins/ted                           # TED 演讲（中文标题、多语字幕），国内直连
  - id: open163
    plugin: /app/plugins/open163                       # 网易公开课，国内直连；没写 visibility：App 里可添加
    # visibility: hidden                               # 暂时不给 App 看
  # 国内平台（要扫码登录，App 里可添加）：youku / bilibili / tencent / iqiyi / mgtv
  - id: bilibili
    plugin: /app/plugins/bilibili
  # 可选：本地视频目录（要先挂载视频目录）。一级目录是频道，频道下的目录是节目
  # - id: videos
  #   plugin: "@iyt-source/folder"
  #   options: { path: /media/videos, name: 本地视频 }
```

镜像里带示例源 `folder` 和这些插件：优酷、哔哩哔哩、腾讯视频、爱奇艺、芒果TV（`/app/plugins/<id>`，要扫码登录），YouTube（`/app/plugins/youtube`）、TED（`/app/plugins/ted`）、网易公开课（`/app/plugins/open163`），
默认配置一个源也不启用，在 `sources` 里加上才有。

每个源的 `visibility` 决定它在 App 里怎么出现：`auto` 直接列进 App 的切换站点；`discoverable`（默认）列在 App 的
「可添加的源」里，家里谁要谁加；`hidden` 不给 App 看（调试页还看得到）。源多了以后，常用的设 `auto`，其余留默认。也可以在调试页「服务与源」里直接切换，改了马上生效并写回配置文件。TED 和网易公开课国内能直连：服务设了全局代理时，把它们加进 `NO_PROXY`
（`.ted.com,.tedcdn.com,.163.com,.126.net,.netease.com`），免得代理节点不放行。
其他平台的源是单独的插件，可以放进数据目录、在配置里写路径加载，或 `iyt-source plugins add` 装进 `/data/plugins`。

### 检查

- 浏览器打开 `http://<NAS 地址>:8090/debug`：每个源的状态、登录（扫码 / 设备码）、浏览、搜索、在页面里播放、请求日志。
  只对局域网开放。
- 一致性检查：`docker exec iutone node packages/cli/src/main.ts check http://127.0.0.1:8090`。
- 日志：`docker logs -f iutone`。

### 代理节点注意事项（YouTube）

- 不管代理是设在服务上还是路由器上，下面都一样适用。
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

### 多个出口自动切换（出口池）

YouTube 会按出口 IP 单独限流某些接口：字幕（`/api/timedtext` 返回 429，App 里「YouTube 暂时限制了这台服务取字幕」）、
yt-dlp 的「不是机器人」验证；同一个出口的播放、浏览往往不受影响。与其每次手动换节点，可以给服务几个固定出口，
被限时它自己换下一个用，冷却一段时间后再试回来。

1. **在代理软件里开几个固定出口**：每个出口一个端口、绑一个节点，节点选不同地区或线路。以 mihomo / Clash Meta
   （OpenClash 用的内核）为例，在配置里加几个选择组和对应的监听端口：

   ```yaml
   proxy-groups:
     - { name: IYT 1, type: select, use: [<你的订阅>] }
     - { name: IYT 2, type: select, use: [<你的订阅>] }
   listeners:
     - { name: iyt-1, type: mixed, port: 7901, listen: 0.0.0.0, proxy: IYT 1 }
     - { name: iyt-2, type: mixed, port: 7902, listen: 0.0.0.0, proxy: IYT 2 }
   ```

   OpenClash 每次启动会重新生成配置，所以写在「覆写设置」的自定义脚本里（`openclash_custom_overwrite.sh`）。
   然后在控制台给每个 `IYT n` 组选一个节点，并打开「记住节点选择」。代理跑在虚拟机里时，记得把这几个端口也转发出来。
2. **挑节点**：先在容器里实测哪些节点能取字幕（拿一条字幕地址，经各个出口请求，200 可用、429 被限），被限的不要用：

   ```bash
   docker exec iutone curl -s -o /dev/null -w '%{http_code}\n' -x http://<代理地址>:7901 '<字幕地址>'
   ```
3. **在服务配置里列出出口**（`config.yaml`），然后 `docker restart iutone`：

   ```yaml
   exits:
     cooldownMinutes: 30          # 被限后冷却多久
     pools:                        # 用途 → 出口，按顺序用
       subtitles: [http://<代理地址>:7901, http://<代理地址>:7902]
       ytdlp:     [http://<代理地址>:7902, http://<代理地址>:7901]
   ```

   - `subtitles`：字幕文件；`ytdlp`：yt-dlp 取格式（视频分片会跟着解析时的出口走）。没列的用途照旧走 `HTTPS_PROXY`。
   - 两个用途的顺序可以错开，把请求分散到不同出口。
4. **看状态**：调试页「请求日志」上方的「出口」表：每个出口可用还是冷却到几点、被限次数、最近一次被限的原因。
   日志里会有「出口被限，冷却」「这个用途的出口都在冷却」「出口恢复」。某个出口总是被限，就在代理控制台给它换个节点，
   不用改服务配置。

### 常见问题：让 AI 帮你查日志

遇到播放失败、字幕取不到、App 里一直加载、源不显示，可以把下面的命令交给能执行命令的 AI 助手（比如 Claude Code），
让它登录 NAS 自己查。先告诉它：NAS 的地址和登录方式（SSH 用户、密钥）、容器名（默认 `iutone`）、出问题的大概时间和
现象（哪个视频、App 里的提示）。

- **服务日志**（JSON 一行一条，`level` / `message` 和相关字段）：

  ```bash
  docker logs --since 30m iutone 2>&1 | tail -200
  docker logs --since 30m iutone 2>&1 | grep -E '"level":"(warn|error)"'
  ```

  QNAP 的 Container Station 里 `docker` 不在 PATH：先 `export PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:$PATH`。
- **请求日志**（最近 300 个请求：路径、状态码、耗时、错误码和原因、来自哪台设备）：

  ```bash
  curl -s http://127.0.0.1:8090/debug/api/log
  ```
- **出口状态**：`curl -s http://127.0.0.1:8090/debug/api/exits`
- **复现一次**：解析一个视频，看返回的 `diagnostics`（用的哪个出口、取流方式）和错误：

  ```bash
  curl -s -X POST -H 'content-type: application/json' -d '{"video":"<视频 id>"}' \
    http://127.0.0.1:8090/iyt/v1/sources/youtube/playback/resolve
  ```
- **接口是否完整**：`docker exec iutone node packages/cli/src/main.ts check http://127.0.0.1:8090`。

给 AI 的提示可以这样写：「NAS 是 <地址>，用 `ssh <用户>@<地址>` 登录，自建源容器叫 iutone。<时间> 在电视上 <现象>。
请按 README『常见问题』里的命令查服务日志和请求日志，找出原因；只看不改，要改配置或重启前先问我。」

常见原因对照：

| 现象 | 日志里看到的 | 处理 |
|---|---|---|
| 所有视频都放不了 | yt-dlp 报 `Sign in to confirm you're not a bot` | 出口被拦：配出口池，或给 YouTube 换节点 |
| 字幕、字幕翻译取不到 | 字幕请求 429、「出口被限，冷却」 | 出口池里换下被限的节点，或等冷却 |
| App 里提示需要登录 | `login_required` | 调试页或 App「我的」里登录；会员 / 年龄限制的视频要网页登录 |
| 解析很慢 | `playback/resolve` 耗时十几秒 | 出口节点慢，换一个快的 |
| 源在 App 里不显示 | 服务没起来，或 App 和服务不在同一网络 | 看 `docker logs` 是否「已启动」；容器必须 `--network host` |

## 写一个源

插件包默认导出一个工厂函数 `(options, env) => SourcePlugin`（`@iyt-source/kit` 的 `plugin.ts`）：有哪些模块
（`feed`、`search`、`detail`、`playback`、`account`、`history` …），manifest 的 `features` 就声明哪些。
需要请求头的流用 `ctx.media.proxy(...)` 交给媒体网关，播放列表会被改写；本地文件用 `ctx.media.file(...)`。
抛 `SourceError(code, message)` 给 App 看得懂的错误。参考 `sources/folder`。
