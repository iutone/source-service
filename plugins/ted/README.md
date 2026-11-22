# iyt-source-ted

IUTone 自建源的 TED 源。随镜像发布在 `/app/plugins/ted`，默认不启用，在配置里按路径加上：

```yaml
sources:
  - id: ted
    plugin: /app/plugins/ted              # 镜像里的路径；本机开发用 ../plugins/ted（相对配置文件）
    options:
      language: zh-cn                     # 标题、简介的语言（TED 的语言代码）；en 只用原文
      via: direct                         # 播放地址直连 TED（默认）；App 连不上 TED 时用 proxy
```

浏览走 ted.com 网站自己的 GraphQL，播放直接给 TED 的 HLS（自带各语言字幕），不需要 yt-dlp，国内可直连。
设计见 `docs/remote-source/SERVER.md` §19。

```bash
pnpm test                       # 链接、卡片、字幕解析
TED_LIVE=1 pnpm test            # 联网跑一致性检查（直连 ted.com）
```
