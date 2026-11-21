# iyt-source-youtube

IUTone 自建源的 YouTube 源。随镜像发布在 `/app/plugins/youtube`，默认不启用，在配置里按路径加上：

```yaml
sources:
  - id: youtube
    plugin: /app/plugins/youtube          # 镜像里的路径；本机开发用 ./plugins/youtube（相对配置文件）
    options:
      language: zh-CN                     # InnerTube 的 hl
      via: proxy                          # 媒体经服务转发（默认）；App 与服务同一出口时可用 direct
```

需要 yt-dlp（`YTDLP_PATH`），平台请求和 yt-dlp 走 `HTTPS_PROXY`，或配置里的出口池（`exits`）。浏览用 `rules/` 里的
`adapter.ts` 与 `clients.json`：和 IUTone App 的 YouTube 规则包是同一份，从 App 仓库同步过来（见 `rules/README.md`）。

```bash
pnpm install
pnpm test                                                    # 格式挑选、卡片解析
YOUTUBE_LIVE=1 HTTPS_PROXY=http://127.0.0.1:7890 YTDLP_PATH=… pnpm test   # 联网跑一致性检查
```
