import type { FeedPage, Manifest, MediaItem, PlaybackMedia, ShowDetail, SourceManifest } from '@iyt-source/protocol'

/**
 * 一致性检查（SERVER.md §11.4）：按 App 的顺序走一遍——manifest、频道、首个频道、首个条目的详情、解析、探测流地址。
 * 只检查 App 依赖的必填字段与形状。返回失败条数。
 */
export async function check(baseURL: string, print: (line: string) => void = console.log): Promise<number> {
  const base = baseURL.replace(/\/+$/, '')
  let failures = 0
  const ok = (message: string) => print(`  ✓ ${message}`)
  const fail = (message: string) => {
    failures++
    print(`  ✗ ${message}`)
  }
  const absolute = (url: string) => new URL(url, `${base}/`).toString()

  async function get<T>(path: string, init?: RequestInit): Promise<T> {
    const started = Date.now()
    const response = await fetch(absolute(path), { ...init, headers: { 'x-iutone-client': 'iyt-source-check', ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`)
    const ms = Date.now() - started
    if (ms > 3000) print(`  ! ${path} 用了 ${ms} ms`)
    return (text ? JSON.parse(text) : null) as T
  }

  print(`检查 ${base}`)
  let manifest: Manifest
  try {
    manifest = await get<Manifest>('/iyt/v1/manifest')
  } catch (error) {
    fail(`manifest：${(error as Error).message}`)
    return failures
  }
  manifest.protocol === 1 ? ok(`协议 v${manifest.protocol}`) : fail(`协议版本 ${manifest.protocol}，App 只支持 1`)
  manifest.server?.id ? ok(`服务 ${manifest.server.name}（${manifest.server.id}）`) : fail('server.id 缺失')
  if (!Array.isArray(manifest.sources)) return failures + 1

  for (const source of manifest.sources) {
    print(`\n源 ${source.id}（${source.name}）`)
    try {
      await checkSource(source)
    } catch (error) {
      fail((error as Error).message)
    }
  }
  print(failures ? `\n${failures} 项失败` : '\n全部通过')
  return failures

  async function checkSource(source: SourceManifest) {
    const prefix = `/iyt/v1/sources/${source.id}`
    for (const key of ['id', 'name', 'brand', 'status', 'account', 'features'] as const) {
      if (source[key] === undefined) fail(`manifest 缺 ${key}`)
    }
    if (!/^[a-z0-9-]{1,24}$/.test(source.id)) fail(`源 id 不合规：${source.id}`)
    if (source.account.requiredFor === 'browse' && !source.account.loggedIn) {
      print('  - 未登录且浏览需要登录，跳过其余检查')
      return
    }
    const channels = await get<{ home: { id: string }; channels: unknown[] }>(`${prefix}/feed/channels`)
    channels.home?.id ? ok(`频道：首页 + ${channels.channels.length} 个`) : fail('feed/channels 缺 home')
    const feed = await get<FeedPage>(`${prefix}/feed/channel?id=${encodeURIComponent(channels.home.id)}`)
    const items = feed.sections.flatMap((section) => {
      if (!section.id || !section.style || !Array.isArray(section.items)) fail(`分区形状不对：${JSON.stringify(section).slice(0, 120)}`)
      return section.items
    })
    ok(`首页 ${feed.sections.length} 个分区、${items.length} 个条目`)
    items.forEach(checkItem)
    const first = items[0]
    if (!first) {
      print('  - 首页没有条目，跳过详情与播放')
      return
    }
    const target = 'show' in first.target ? `show:${first.target.show}` : `video:${first.target.video}`
    const detail = await get<ShowDetail>(`${prefix}/detail?target=${encodeURIComponent(target)}`)
    for (const key of ['title', 'ratings', 'tags', 'isPaid', 'credits', 'series', 'recommendations'] as const) {
      if (detail[key] === undefined) fail(`详情缺 ${key}`)
    }
    ok(`详情「${detail.title}」${detail.episodes ? `，${detail.episodes.episodes.length} 集` : ''}`)
    const videoID = detail.defaultVideoID ?? detail.episodes?.episodes[0]?.id
    if (!videoID) {
      print('  - 没有可播放的视频')
      return
    }
    const media = await get<PlaybackMedia>(`${prefix}/playback/resolve`, {
      method: 'POST',
      body: JSON.stringify({ video: videoID, show: detail.showID ?? null, preferences: {} }),
    })
    const selected = media.streams.find((stream) => stream.id === media.selectedStream)
    if (!selected) return fail('selectedStream 不在 streams 里')
    for (const stream of media.streams) {
      if (stream.format !== 'hls' && stream.format !== 'mp4') fail(`流 ${stream.id} 的格式是 ${stream.format}，只允许 hls / mp4`)
      if (typeof stream.quality?.rank !== 'number') fail(`流 ${stream.id} 缺 quality.rank`)
    }
    ok(`解析：${media.streams.length} 个流，选中 ${selected.id}（${selected.description}）`)
    const head = await fetch(absolute(selected.url), { method: 'HEAD' })
    head.ok ? ok(`流地址 HEAD ${head.status} ${head.headers.get('content-type') ?? ''}`) : fail(`流地址 HEAD ${head.status}`)
    if (selected.format === 'mp4') {
      const ranged = await fetch(absolute(selected.url), { headers: { range: 'bytes=0-1023' } })
      await ranged.arrayBuffer()
      ranged.status === 206 ? ok('Range 请求 206') : fail(`Range 请求返回 ${ranged.status}，MP4 拖动会出问题`)
    } else {
      const playlist = await (await fetch(absolute(selected.url))).text()
      playlist.startsWith('#EXTM3U') ? ok('HLS 播放列表可读') : fail('HLS 地址返回的不是播放列表')
    }
  }

  function checkItem(item: MediaItem) {
    if (!item.id || !item.title || !item.target || (!('show' in item.target) && !('video' in item.target))) {
      fail(`条目形状不对：${JSON.stringify(item).slice(0, 120)}`)
    }
  }
}
