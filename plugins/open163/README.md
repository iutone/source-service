# iyt-source-open163

IUTone 自建源的网易公开课源。随镜像发布在 `/app/plugins/open163`，默认不启用，在配置里按路径加上：

```yaml
sources:
  - id: open163
    plugin: /app/plugins/open163          # 镜像里的路径；本机开发用 ../plugins/open163（相对配置文件）
```

首页读网站首页的各栏，频道是手机站的分类（内容走网站的搜索接口），课程、分集、评论走网站和手机站的 JSON 接口；
播放直接给课程的 HLS / MP4，字幕由 App 加进主列表。不需要登录，国内直连。设计见 `docs/remote-source/SERVER.md` §20。

```bash
pnpm test                       # 链接、卡片、首页解析、清晰度挑选
OPEN163_LIVE=1 pnpm test        # 联网跑一致性检查
```
