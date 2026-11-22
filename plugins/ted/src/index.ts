// IUTone 自建源：TED（docs/remote-source/SERVER.md §19）。浏览走 ted.com 网站自己的 GraphQL（api.ts），标题和简介取
// `language` 的译文；播放直接给 TED 的 HLS（hls.ted.com，无需请求头，国内可直连），主列表自带各语言字幕。
// 随镜像发布在 /app/plugins/ted，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import type { Channel, Cue, Episode, FeedPage, FeedSection, MediaItem, PlaybackMedia, ShowDetail, Stream, SubtitleTrack } from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { notFound, parseWebVTT, SourceError, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { gql, localize, picture, PLAYLIST_FIELDS, VIDEO_FIELDS, type Playlist, type Video } from './api.ts'

export interface TEDOptions {
  name?: string
  /** 标题、简介、字幕的语言（TED 的语言代码）：默认 zh-cn。en 只用原文。 */
  language?: string
  /** 播放地址直连 TED（默认）还是经服务的媒体网关转发（App 连不上 TED 时）。 */
  via?: 'direct' | 'proxy'
}

const PAGE = 24
/** 频道：TED 的主题（slug），中文名。 */
const TOPICS: [string, string][] = [
  ['technology', '科技'], ['science', '科学'], ['psychology', '心理学'], ['business', '商业'], ['health', '健康'],
  ['education', '教育'], ['personal+growth', '个人成长'], ['culture', '文化'], ['design', '设计'], ['society', '社会'],
  ['climate+change', '气候变化'], ['ai', '人工智能'], ['history', '历史'], ['art', '艺术'], ['economics', '经济'],
  ['communication', '沟通'], ['leadership', '领导力'], ['brain', '大脑'], ['space', '太空'], ['relationships', '人际关系'],
]
const RIBBON_NAMES: Record<string, string> = { "Editor's Picks": '编辑精选', 'Trending': '热门', 'Most popular': '最受欢迎' }
const NEWEST = 'newest'
const PLAYLISTS = 'playlists'
const TOPIC = 'topic:'
/** 播放列表作为节目：`show` 的 id 是它的 slug。 */
const LANGUAGE_NAMES = new Intl.DisplayNames(['zh-Hans'], { type: 'language' })

const factory: SourceFactory = (options) => createTEDSource(options as TEDOptions)
export default factory

export function languageName(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code
  } catch {
    return code
  }
}

/** 列表里的一场演讲 → 卡片。 */
export function videoItem(video: Video): MediaItem {
  return {
    id: video.slug,
    title: video.title,
    subtitle: video.presenterDisplayName || undefined,
    landscapeURL: picture(video.primaryImageSet),
    duration: video.duration,
    stats: video.viewedCount ? { views: video.viewedCount } : undefined,
    publishedAt: video.publishedAt,
    caption: video.videoContext || undefined,
    target: { video: video.slug },
  }
}

export function playlistItem(playlist: Playlist): MediaItem {
  const count = playlist.videos?.totalCount
  return {
    id: playlist.slug,
    title: playlist.title,
    subtitle: playlist.author || undefined,
    landscapeURL: picture(playlist.primaryImageSet, ['400x209', '16x9', '2x1', '1x1']),
    caption: count ? `${count} 场演讲` : undefined,
    target: { show: playlist.slug },
  }
}

/** 链接里的演讲或播放列表：`ted.com/talks/<slug>`、`ted.com/playlists/<id>/<slug>`。 */
export function linkTarget(raw: string): { target: { video: string } | { show: string } } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)ted\.com$/.test(url.hostname)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  // 站点有语言前缀的路径（/dubbing/…、/talks/…/transcript），取 talks 后面那一段。
  const talk = parts.indexOf('talks')
  if (talk >= 0 && parts[talk + 1] && /^[a-z0-9_]+$/i.test(parts[talk + 1])) return { target: { video: parts[talk + 1] } }
  const list = parts.indexOf('playlists')
  if (list >= 0 && parts[list + 2]) return { target: { show: parts[list + 2] } }
  return null
}

export function createTEDSource(options: TEDOptions = {}): SourcePlugin {
  const language = (options.language ?? 'zh-cn').toLowerCase()
  const via = options.via ?? 'direct'
  /** 字幕原文：演讲 slug → 语言 → 整片 VTT 地址（`cues` 用）。 */
  const captions = new Map<string, Map<string, string>>()
  let homeCache: { at: number; page: Promise<FeedPage> } | undefined

  const videosPage = async (query: string, variables: Record<string, unknown>, pick: (data: any) => { nodes: Video[]; pageInfo?: { endCursor?: string; hasNextPage?: boolean } }, ctx: Ctx) => {
    const data = await gql<any>(query, variables, ctx.signal)
    const connection = pick(data)
    if (!connection) throw notFound('这个列表')
    const items = (await localize(connection.nodes, language, ctx.signal)).map(videoItem)
    const next = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? null : null
    return { items, next }
  }

  /** 最新的演讲（网站的「最新」：channel FEATURED），按游标翻页。 */
  const newest = (cursor: string | undefined, ctx: Ctx) => videosPage(
    `query($first:Int,$after:String){videos(first:$first,after:$after,channel:FEATURED){pageInfo{endCursor hasNextPage} nodes{${VIDEO_FIELDS}}}}`,
    { first: PAGE, after: cursor }, (d) => d.videos, ctx,
  )

  const topic = (slug: string, cursor: string | undefined, ctx: Ctx) => videosPage(
    `query($slug:String!,$first:Int,$after:String){topic(slug:$slug){videos(first:$first,after:$after){pageInfo{endCursor hasNextPage} nodes{${VIDEO_FIELDS}}}}}`,
    { slug, first: PAGE, after: cursor }, (d) => d.topic?.videos, ctx,
  )

  async function playlists(cursor: string | undefined, ctx: Ctx) {
    const data = await gql<{ playlists: { pageInfo: { endCursor: string; hasNextPage: boolean }; nodes: Playlist[] } }>(
      `query($first:Int,$after:String){playlists(first:$first,after:$after){pageInfo{endCursor hasNextPage} nodes{${PLAYLIST_FIELDS}}}}`,
      { first: PAGE, after: cursor }, ctx.signal,
    )
    return { items: data.playlists.nodes.map(playlistItem), next: data.playlists.pageInfo.hasNextPage ? data.playlists.pageInfo.endCursor : null }
  }

  /** 首页：网站首页的推荐条（编辑精选等），再是最新演讲。 */
  async function home(ctx: Ctx): Promise<FeedPage> {
    // 推荐条（连同译文）和最新演讲同时取：TED 的接口一次要 1.5～2.5 秒。
    const ribbonSections = gql<{ platform: { ribbons: { nodes: { name: string; live: boolean; slots: { nodes: { video: Video | null }[] } }[] } } }>(
      `{platform(id:1){ribbons{nodes{name live slots{nodes{order video{${VIDEO_FIELDS}}}}}}}}`, {}, ctx.signal,
    ).then(async (ribbons) => {
      const rows = ribbons.platform.ribbons.nodes.map((ribbon, index) => ({
        index, ribbon, videos: ribbon.slots.nodes.map((slot) => slot.video).filter((v): v is Video => Boolean(v)),
      })).filter((row) => row.ribbon.live && row.videos.length >= 3)
      // 所有推荐条的译文一次取完。
      const localized = new Map((await localize(rows.flatMap((row) => row.videos), language, ctx.signal)).map((v) => [v.id, v]))
      return rows.map(({ index, ribbon, videos }): FeedSection => ({
        id: `ribbon-${index}`,
        title: RIBBON_NAMES[ribbon.name] ?? ribbon.name,
        style: 'row',
        items: videos.map((v) => videoItem(localized.get(v.id) ?? v)),
      }))
    }).catch((error): FeedSection[] => {
      if (ctx.signal.aborted) throw error
      ctx.log.warn('ted ribbons failed', { error: String(error) })
      return []
    })
    const [sections, latest] = await Promise.all([ribbonSections, newest(undefined, ctx)])
    sections.push({ id: NEWEST, title: '最新演讲', style: 'grid', items: latest.items, more: latest.next ? { title: '更多', route: NEWEST } : undefined })
    return { sections, next: null }
  }

  async function videoByslug(slug: string, fields: string, ctx: Ctx): Promise<any> {
    const query = `query($slug:[String!],$language:String){videos(slug:$slug,language:$language,first:1,channel:ALL,isPublished:[true]){nodes{${fields}}}}`
    // 带语言查不到（没有这门语言的译文）就用原文。
    let data = language === 'en' ? undefined : await gql<{ videos: { nodes: any[] } }>(query, { slug: [slug], language }, ctx.signal)
    if (!data?.videos.nodes.length) data = await gql<{ videos: { nodes: any[] } }>(query, { slug: [slug] }, ctx.signal)
    const video = data.videos.nodes[0]
    if (!video) throw notFound('这场演讲')
    return video
  }

  async function playlistDetail(slug: string, ctx: Ctx) {
    const data = await gql<{ playlist: (Playlist & { videos: { totalCount: number; nodes: Video[] } }) | null }>(
      `query($slug:String!){playlist(slug:$slug){id slug title description author primaryImageSet{url aspectRatioName} videos{totalCount nodes{${VIDEO_FIELDS}}}}}`,
      { slug }, ctx.signal,
    )
    if (!data.playlist) throw notFound('这个播放列表')
    return { ...data.playlist, videos: { ...data.playlist.videos, nodes: await localize(data.playlist.videos.nodes, language, ctx.signal) } }
  }

  const episode = (video: Video, index: number): Episode => ({
    id: video.slug, title: video.title, stage: String(index + 1), isFeature: true, imageURL: picture(video.primaryImageSet, ['16x9', '2x1', '4x3'], 320),
    isPaid: false, duration: video.duration, views: video.viewedCount, publishedAt: video.publishedAt,
  })

  return {
    info: {
      name: options.name ?? 'TED',
      brand: { tint: '#E62B1E', tabIconIsWordmark: true },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    feed: {
      homeShowsHistory: false,
      channelBrowser: true,
      async channels() {
        const topics: Channel[] = TOPICS.map(([slug, title]) => ({ id: TOPIC + slug, title }))
        const home = { id: 'home', title: '推荐' }
        return {
          home,
          pinned: [{ id: NEWEST, title: '最新' }, { id: PLAYLISTS, title: '播放列表' }],
          channels: [home, { id: NEWEST, title: '最新' }, { id: PLAYLISTS, title: '播放列表' }, ...topics],
          library: [],
        }
      },
      async channel(id, cursor, ctx): Promise<FeedPage> {
        if (id === 'home') {
          // 首页的推荐条一天才变几次：缓存 10 分钟。
          if (!homeCache || Date.now() - homeCache.at > 10 * 60_000) {
            const page = home(ctx)
            homeCache = { at: Date.now(), page }
            page.catch(() => { if (homeCache?.page === page) homeCache = undefined })
          }
          return homeCache.page
        }
        const page = id === NEWEST ? await newest(cursor, ctx)
          : id === PLAYLISTS ? await playlists(cursor, ctx)
          : id.startsWith(TOPIC) ? await topic(id.slice(TOPIC.length), cursor, ctx)
          : undefined
        if (!page) throw notFound('这个频道')
        return { sections: [{ id: `grid-${id}`, style: 'grid', items: page.items }], next: page.next }
      },
      async more(route, cursor, ctx) {
        if (route === NEWEST) return newest(cursor, ctx)
        throw notFound('这个列表')
      },
    },

    search: {
      prompt: '搜索 TED（英文关键词）',
      async suggestions(text, ctx) {
        const data = await gql<{ searchSuggest: { suggestions: { text: string; category: string }[] } }>(
          'query($q:String!,$limit:Int){searchSuggest(q:$q,limit:$limit){status suggestions{text url category}}}', { q: text, limit: 8 }, ctx.signal,
        )
        return data.searchSuggest.suggestions.filter((s) => s.category === 'VIDEOS' || s.category === 'PLAYLISTS').map((s) => ({ keyword: s.text }))
      },
      async search(keyword, ctx) {
        const [videos, lists] = await Promise.all([
          searchVideos(keyword, 1, ctx),
          gql<{ search: { results: { __typename: string; slug: string; title: string; description?: string; talkCount?: number; thumbnailUrl?: string }[] } }>(
            'query($q:String!){search(q:$q,category:PLAYLISTS,page:1,perPage:12){results{__typename ... on SearchPlaylist{id slug title description talkCount thumbnailUrl}}}}', { q: keyword }, ctx.signal,
          ).catch(() => undefined),
        ])
        const shows: MediaItem[] = (lists?.search.results ?? []).filter((r) => r.__typename === 'SearchPlaylist').map((r) => ({
          id: r.slug, title: r.title, landscapeURL: r.thumbnailUrl, caption: r.talkCount ? `${r.talkCount} 场演讲` : undefined, target: { show: r.slug },
        }))
        return { shows, videos: videos.items, moreVideos: videos.next }
      },
      async videos(keyword, cursor, ctx) {
        return searchVideos(keyword, Number(cursor) || 2, ctx)
      },
    },

    detail: {
      async detail(target, ctx): Promise<ShowDetail> {
        if ('show' in target) {
          const list = await playlistDetail(target.show, ctx)
          const episodes = list.videos.nodes.map(episode)
          return {
            showID: list.slug, kind: 'series', title: list.title, tagline: list.author, summary: list.description,
            shortSummary: `${list.videos.totalCount} 场演讲`, category: '播放列表',
            landscapeURL: picture(list.primaryImageSet, ['400x209', '16x9', '1x1'], 1280), ratings: [], tags: [], isPaid: false, credits: [],
            defaultVideoID: episodes[0]?.id, episodes: { episodes }, series: [], recommendations: { tabs: [], items: [] },
          }
        }
        const video = await videoByslug(target.video, `${VIDEO_FIELDS} description recordedOn type{name} topics{nodes{name slug}} speakers{nodes{slug firstname middlename lastname photoUrl description}} relatedVideos{id}`, ctx)
        const related = video.relatedVideos?.length
          ? await gql<{ videos: { nodes: Video[] } }>(
            `query($id:[Int!]){videos(id:$id,first:12,channel:ALL,isPublished:[true]){nodes{${VIDEO_FIELDS}}}}`,
            { id: video.relatedVideos.map((v: { id: string }) => Number(v.id)) }, ctx.signal,
          ).then((d) => localize(d.videos.nodes, language, ctx.signal)).catch(() => [] as Video[])
          : []
        const speakers = (video.speakers?.nodes ?? []) as { slug: string; firstname: string; middlename?: string; lastname: string; photoUrl?: string; description?: string }[]
        const year = (video.recordedOn as string | undefined)?.slice(0, 4)
        const facts = [video.videoContext, year, video.duration ? `${Math.round(video.duration / 60)} 分钟` : undefined].filter(Boolean).join(' · ')
        return {
          kind: 'standalone',
          title: video.title,
          tagline: video.presenterDisplayName,
          shortSummary: facts || undefined,
          summary: video.description,
          attributes: facts || undefined,
          category: video.type?.name,
          landscapeURL: picture(video.primaryImageSet, ['16x9', '2x1', '4x3'], 1280),
          ratings: [],
          tags: (video.topics?.nodes ?? []).map((t: { name: string }) => t.name),
          isPaid: false,
          credits: speakers.map((s) => ({ id: s.slug, name: [s.firstname, s.middlename, s.lastname].filter(Boolean).join(' '), role: s.description || '演讲者', avatarURL: s.photoUrl })),
          defaultVideoID: video.slug,
          series: [],
          recommendations: { tabs: [], items: related.map(videoItem) },
          stats: video.viewedCount ? { views: video.viewedCount } : undefined,
          publishedAt: video.publishedAt,
          duration: video.duration,
        }
      },
    },

    links: {
      patterns: ['^https?://(www\\.)?ted\\.com/(.+/)?(talks|playlists)/'],
      async resolve(url) {
        return linkTarget(url)
      },
    },

    playback: {
      async resolve(request, ctx): Promise<PlaybackMedia> {
        const video = await videoByslug(request.video, 'id slug title duration hlsUrl videoPlayerData { resources { hls { stream metadata } h264 { bitrate file } } languages { languageCode languageName } dubbedVideoStreams { languageCode url } }', ctx)
        const player = video.videoPlayerData
        const hls: string | undefined = player?.resources?.hls?.stream ?? video.hlsUrl
        const mp4 = (player?.resources?.h264 ?? []) as { bitrate: number; file: string }[]
        if (!hls && !mp4.length) throw new SourceError('unplayable', '这场演讲没有可播放的视频')
        const url = (address: string, name: string) => via === 'proxy' ? ctx.media.proxy(address, { name, ttl: 12 * 3600 }) : address
        const streams: Stream[] = []
        if (hls) {
          streams.push({ id: 'hls', url: url(hls, 'master.m3u8'), format: 'hls', quality: { rank: 720, label: '自动' }, description: `ted hls ${via}` })
        }
        for (const dub of (player?.dubbedVideoStreams ?? []) as { languageCode: string; url: string }[]) {
          streams.push({
            id: `dub-${dub.languageCode}`, url: url(dub.url, `dub-${dub.languageCode}.m3u8`), format: 'hls', quality: { rank: 720, label: '自动' },
            language: { code: dub.languageCode, name: `${languageName(dub.languageCode)}（配音）` }, description: `ted dubbed ${dub.languageCode}`,
          })
        }
        // 低码率的 MP4（单文件，可缓存）：HLS 播不了时用。
        for (const file of mp4.sort((a, b) => b.bitrate - a.bitrate).slice(0, 1)) {
          streams.push({ id: `mp4-${file.bitrate}`, url: url(file.file, 'talk.mp4'), format: 'mp4', quality: { rank: 360, label: '标清 MP4' }, description: `ted mp4 ${file.bitrate}k`, keepable: true })
        }
        const subtitles = await subtitleTracks(video.slug, player?.resources?.hls?.metadata, ctx)
        const wanted = request.preferences?.language
        const selected = (wanted && streams.find((s) => s.language?.code === wanted)) || streams[0]
        return {
          title: video.title,
          expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
          streams,
          selectedStream: selected.id,
          subtitles: subtitles.length ? subtitles : undefined,
          diagnostics: { path: `ted-${via}`, subtitles: String(subtitles.length) },
        }
      },
      async cues(ref, key, ctx): Promise<Cue[]> {
        let address = captions.get(ref)?.get(key)
        if (!address) {
          // 服务重启后没有记录：重新读一次这场演讲的字幕列表。
          const video = await videoByslug(ref, 'slug videoPlayerData { resources { hls { metadata } } }', ctx)
          await subtitleTracks(ref, video.videoPlayerData?.resources?.hls?.metadata, ctx)
          address = captions.get(ref)?.get(key)
        }
        if (!address) throw notFound('这条字幕')
        const response = await fetch(address, { signal: ctx.signal })
        if (!response.ok) throw new SourceError('unavailable', `字幕返回 ${response.status}`, { retryable: true })
        return parseWebVTT(await response.text())
      },
    },
  }

  async function searchVideos(keyword: string, page: number, ctx: Ctx) {
    const data = await gql<{ search: { results: { __typename: string; id: string; slug: string; title: string; speakers?: string; durationSeconds?: number; viewedCount?: number; thumbnailUrl?: string; publishedAt?: string }[]; pageInfo: { hasNext: boolean } } }>(
      'query($q:String!,$page:Int,$perPage:Int){search(q:$q,category:VIDEOS,page:$page,perPage:$perPage){results{__typename ... on SearchTalk{id slug title speakers durationSeconds viewedCount thumbnailUrl publishedAt}} pageInfo{hasNext}}}',
      { q: keyword, page, perPage: PAGE }, ctx.signal,
    )
    const talks = data.search.results.filter((r) => r.__typename === 'SearchTalk')
    const localized = await localize(talks.map((t) => ({ id: t.id, slug: t.slug, title: t.title, presenterDisplayName: t.speakers })), language, ctx.signal)
    const items: MediaItem[] = talks.map((talk, index) => ({
      id: talk.slug,
      title: localized[index].title,
      subtitle: localized[index].presenterDisplayName || undefined,
      landscapeURL: talk.thumbnailUrl,
      duration: talk.durationSeconds,
      stats: talk.viewedCount ? { views: talk.viewedCount } : undefined,
      publishedAt: talk.publishedAt,
      target: { video: talk.slug },
    }))
    return { items, next: data.search.pageInfo.hasNext ? String(page + 1) : null }
  }

  /** 字幕列表（HLS 的 metadata.json）：每种语言一条，`cues` 给原文（翻译用）。播放时字幕由主列表自带。 */
  async function subtitleTracks(slug: string, metadata: string | undefined, ctx: Ctx): Promise<SubtitleTrack[]> {
    if (!metadata) return []
    let list: { code: string; name: string; webvtt: string }[] = []
    try {
      const response = await fetch(metadata, { signal: ctx.signal })
      if (response.ok) list = ((await response.json()) as { subtitles?: typeof list }).subtitles ?? []
    } catch (error) {
      if (ctx.signal.aborted) throw error
      ctx.log.warn('ted subtitles failed', { slug, error: String(error) })
    }
    const index = new Map(list.map((s) => [s.code, s.webvtt]))
    captions.set(slug, index)
    if (captions.size > 200) captions.delete(captions.keys().next().value!)
    // 设定的语言和英文在前。
    const order = (code: string) => (code === language ? 0 : code === 'en' ? 1 : 2)
    return [...list].sort((a, b) => order(a.code) - order(b.code)).map((s) => ({
      key: s.code,
      name: languageName(s.code),
      language: s.code,
      generated: false,
      vtt: via === 'proxy' ? ctx.media.proxy(s.webvtt, { playlist: 'no', name: `${s.code}.vtt`, ttl: 12 * 3600 }) : s.webvtt,
      cues: `${BASE_PATH}/sources/${ctx.sourceId}/subtitles/${slug}/${encodeURIComponent(s.code)}`,
    }))
  }
}
