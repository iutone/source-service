// IUTone 自建源：YouTube（docs/remote-source/SERVER.md §15）。浏览、登录、评论、点赞、订阅、历史照 App 的
// Core/YouTube 以 TV 版 InnerTube 做，读答复用 App 规则包的 adapter；取流交给 yt-dlp（playback.ts）。
// 随镜像发布在 /app/plugins/youtube，默认不启用：用户在配置里加上（plugin: /app/plugins/youtube）。
import { fileURLToPath } from 'node:url'
import type { Channel, Comment, EpisodeList, FeedPage, MediaItem, ShowDetail } from '@iyt-source/protocol'
import { SourceError, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import * as adapter from '../rules/adapter.ts'
import { episode, items, mediaItem, parseCount, parseRelativeDate, sections, timeline, uniqueItems, uploaderProfile, videoItem } from './cards.ts'
import { YouTubePlayback, type PlaybackOptions } from './playback.ts'
import { YouTubeSession, type SessionOptions } from './session.ts'

export interface YouTubeOptions extends SessionOptions, PlaybackOptions {
  name?: string
  /** 搜索用的身份：默认网页版（匿名）。TV 版的搜索只给一行 5 条，续页每次一两条。 */
  searchClient?: string
}

const SUBSCRIPTIONS = 'FEsubscriptions'
/** 未登录的首页：YouTube TV 的推荐（FEtopics）未登录时是空的，拼几个主题频道的前两行。 */
const POPULAR = 'popular'
const POPULAR_TOPICS = ['FEtopics_music', 'FEtopics_gaming', 'FEtopics_news', 'FEtopics_sports']
const TOPICS: Channel[] = [
  { id: 'FEtopics', title: '推荐' },
  { id: 'FEtopics_gaming', title: '游戏' },
  { id: 'FEtopics_music', title: '音乐' },
  { id: 'FEtopics_news', title: '新闻' },
  { id: 'FEtopics_live', title: '直播' },
  { id: 'FEtopics_sports', title: '体育' },
]
/** 一行少于这么多张就先用它的续页补满（App 的 FeedGrid 约三行）。 */
const SHELF_FILL = 11
const PLAYLIST_PAGES = 3
const PLAYLIST_CURSOR = 'playlist:'

const factory: SourceFactory = (options, env) => createYouTubeSource(options as YouTubeOptions, env.dataDir)
export default factory

export function createYouTubeSource(options: YouTubeOptions = {}, _dataDir?: string): SourcePlugin {
  let session: YouTubeSession | undefined
  let playback: YouTubePlayback | undefined
  /** 「更多」打开时先给出这一行已显示的卡片：按 route（这一行的续页 token）记着，最近 200 行。 */
  const shelves = new Map<string, MediaItem[]>()
  /** 历史每一页的 token。 */
  const historyTokens = new Map<number, string>()

  const use = (ctx: Ctx) => {
    session ??= new YouTubeSession(ctx.store, options)
    playback ??= new YouTubePlayback(session, options)
    return { session, playback }
  }

  const page = async (ctx: Ctx, args: { browseId?: string; params?: string; continuation?: string }) =>
    adapter.page(await use(ctx).session.browse(args, ctx.signal))

  const remember = (route: string, list: MediaItem[]) => {
    shelves.set(route, list)
    if (shelves.size > 200) shelves.delete(shelves.keys().next().value!)
  }

  async function playlist(ctx: Ctx, id: string) {
    let current = await page(ctx, { browseId: `VL${id}` })
    const title = current.title
    const byline = current.byline
    const cards = current.shelves.flatMap((s) => s.cards).filter((c) => c.kind === 'video')
    for (let i = 1; i < PLAYLIST_PAGES && current.continuation; i++) {
      current = await page(ctx, { continuation: current.continuation })
      cards.push(...current.shelves.flatMap((s) => s.cards).filter((c) => c.kind === 'video'))
    }
    const seen = new Set<string>()
    return { title, byline, cards: cards.filter((c) => !seen.has(c.id) && seen.add(c.id)) }
  }

  async function channelVideos(ctx: Ctx, channelID: string): Promise<EpisodeList | null> {
    if (!channelID.startsWith('UC')) return null
    const channelPage = await page(ctx, { browseId: channelID })
    const withVideos = channelPage.shelves.filter((s) => s.cards.some((c) => c.kind === 'video'))
    const shelf = withVideos.find((s) => ['视频', 'Videos', '影片'].includes(s.title ?? '')) ?? withVideos[0]
    if (!shelf) return null
    return { episodes: shelf.cards.map(episode).filter((e) => e !== undefined) }
  }

  /** 匿名的网页版搜索（结果都是公开视频，带不带登录一样）。 */
  async function searchPage(ctx: Ctx, args: { query?: string; continuation?: string }) {
    const { session } = use(ctx)
    const client = options.searchClient ?? (session.clients.clients.WEB_SAFARI ? 'WEB_SAFARI' : session.clients.accountClient)
    return adapter.page(await session.innertube('search', adapter.searchRequest(args), client, { authorized: false, signal: ctx.signal }))
  }

  /** 搜索的下一页：页面自己的，否则结果那一行的（TV 版把它放在行上）。 */
  function searchContinuation(result: ReturnType<typeof adapter.page>): string | null {
    return result.continuation ?? result.shelves.find((shelf) => shelf.title !== 'Shorts' && shelf.continuation)?.continuation ?? null
  }

  async function next(ctx: Ctx, body: Record<string, unknown>) {
    const { session } = use(ctx)
    return session.innertube('next', body, session.clients.accountClient, { signal: ctx.signal })
  }

  async function account(ctx: Ctx, call: (session: YouTubeSession) => Promise<unknown>) {
    const { session } = use(ctx)
    if (!session.loggedIn) throw new SourceError('login_required', '需要登录 YouTube')
    await call(session)
  }

  return {
    info: {
      name: options.name ?? 'YouTube',
      brand: { tint: '#FF1040' },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        // App 内置的 YouTube 首页标签图标（@3x，30×21 pt），按模板图渲染。
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      // 设备码：TV 版账号（浏览、订阅、历史）。网页登录：只交 cookie 给 yt-dlp 取要账号的视频（会员、年龄限制）。
      methods: ['deviceCode', 'webCookie'],
      requiredFor: 'nothing',
      webLogin: {
        url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
        doneWhen: { cookie: 'SAPISID', domain: '.youtube.com' },
        userAgent: 'desktop',
      },
      async state(ctx) {
        const { session } = use(ctx)
        if (!session.loggedIn) return session.cookiesFile ? { loggedIn: true, profile: { name: 'YouTube 网页登录（仅播放）' } } : { loggedIn: false }
        try {
          return { loggedIn: true, profile: session.profile ?? (await session.refreshProfile(ctx.signal)) }
        } catch (error) {
          if (error instanceof SourceError && error.code === 'login_required' && !session.loggedIn) return { loggedIn: false }
          // 读不到账号不算退出：登录还在。
          return { loggedIn: true, profile: session.profile }
        }
      },
      begin(_method, ctx) {
        return use(ctx).session.login(ctx)
      },
      async acceptCookies(cookies, _userAgent, ctx) {
        const { session } = use(ctx)
        session.saveCookies(cookies)
        return session.profile ?? { name: 'YouTube 网页登录' }
      },
      async logout(ctx) {
        // 不撤销 token：Google 的撤销会让这个 client 在账号里的所有 TV 登录都退出。
        use(ctx).session.clear()
        historyTokens.clear()
      },
    },

    feed: {
      homeShowsHistory: false,
      channelBrowser: true,
      async channels(ctx) {
        const loggedIn = use(ctx).session.loggedIn
        return {
          home: loggedIn ? { id: SUBSCRIPTIONS, title: '订阅' } : { id: POPULAR, title: '热门' },
          pinned: loggedIn ? [TOPICS[0], TOPICS[1], TOPICS[3]] : [TOPICS[1], TOPICS[3]],
          // 推荐未登录时是空的。
          channels: loggedIn ? TOPICS : TOPICS.slice(1),
          library: loggedIn
            ? [
                { channel: { id: 'VLWL', title: '稍后观看' }, systemImage: 'clock', content: 'feed' as const },
                { channel: { id: 'VLLL', title: '赞过的视频' }, systemImage: 'hand.thumbsup', content: 'feed' as const },
                { channel: { id: 'channels', title: '订阅的频道' }, systemImage: 'person.2', content: 'uploaders' as const },
              ]
            : [],
        }
      },
      async channel(id, cursor, ctx): Promise<FeedPage> {
        if (id === POPULAR) {
          const pages = await Promise.all(POPULAR_TOPICS.map((topic) => page(ctx, { browseId: topic }).catch(() => undefined)))
          const list = pages.flatMap((result, index) => {
            if (!result) return []
            const topic = TOPICS.find((t) => t.id === POPULAR_TOPICS[index])!.title
            return sections(result).slice(0, 2).map((section) => ({ ...section, title: section.title ? `${topic} · ${section.title}` : topic }))
          })
          for (const section of list) if (section.more) remember(section.more.route, section.items)
          return { sections: list, next: null }
        }
        const result = await page(ctx, cursor ? { continuation: cursor } : { browseId: id })
        if (id === SUBSCRIPTIONS) return { sections: timeline(result), next: result.continuation ?? null }
        // 一行太短的，先用它的续页补上（并行）。
        await Promise.all(result.shelves.map(async (shelf) => {
          if (shelf.cards.length >= SHELF_FILL || !shelf.continuation) return
          try {
            const more = await page(ctx, { continuation: shelf.continuation })
            shelf.cards.push(...more.shelves.flatMap((s) => s.cards))
            shelf.continuation = more.continuation
          } catch {
            // 补不上就算了
          }
        }))
        const list = sections(result)
        for (const section of list) if (section.more) remember(section.more.route, section.items)
        return { sections: list, next: result.continuation ?? null }
      },
      async more(route, cursor, ctx) {
        if (!cursor) {
          const known = shelves.get(route)
          if (known) return { items: known, next: route }
        }
        const result = await page(ctx, { continuation: cursor ?? route })
        return { items: uniqueItems(result), next: result.continuation ?? null }
      },
      async uploaders(_id, cursor, ctx) {
        const result = await page(ctx, cursor ? { continuation: cursor } : { browseId: 'FEchannels' })
        const seen = new Set<string>()
        const uploaders = result.shelves.flatMap((s) => s.cards)
          .filter((card) => card.kind === 'channel' && !seen.has(card.id) && seen.add(card.id))
          .map(uploaderProfile)
        return { uploaders, next: result.continuation ?? null }
      },
    },

    search: {
      prompt: '搜索 YouTube',
      async suggestions(text, ctx) {
        const url = new URL('https://suggestqueries.google.com/complete/search')
        url.search = new URLSearchParams({ client: 'firefox', ds: 'yt', hl: options.language ?? 'zh-CN', q: text }).toString()
        const response = await fetch(url, { signal: ctx.signal })
        return adapter.suggestions(await response.text()).map((keyword) => ({ keyword }))
      },
      async search(keyword, ctx) {
        const result = await searchPage(ctx, { query: keyword })
        const all = uniqueItems(result)
        return {
          shows: all.filter((item) => 'show' in item.target),
          videos: all.filter((item) => 'video' in item.target),
          moreVideos: searchContinuation(result),
        }
      },
      async videos(_keyword, cursor, ctx) {
        const result = await searchPage(ctx, { continuation: cursor })
        const list = uniqueItems(result)
        // 后面只剩 Shorts（列表里去掉）时就到头了。
        return { items: list, next: list.length ? searchContinuation(result) : null }
      },
    },

    detail: {
      async detail(target, ctx): Promise<ShowDetail> {
        if ('show' in target) {
          const list = await playlist(ctx, target.show)
          const facts = list.byline.join(' · ') || undefined
          const episodes = list.cards.map(episode).filter((e) => e !== undefined)
          return {
            showID: target.show, kind: 'series', title: list.title ?? target.show, tagline: list.byline[0],
            shortSummary: facts, attributes: facts, category: '播放列表', landscapeURL: list.cards[0]?.thumbnail,
            ratings: [], tags: [], isPaid: false, credits: [], defaultVideoID: episodes[0]?.id,
            episodes: { episodes }, series: [], recommendations: { tabs: [], items: [] },
          }
        }
        const id = target.video
        const read = adapter.detail(await next(ctx, adapter.nextRequest({ videoId: id })))
        if (!read) throw new SourceError('not_found', '找不到这个视频')
        const uploader = read.channel
          ? { id: read.channel.id, name: read.channel.name, avatarURL: read.channel.avatar, followers: parseCount(read.channel.subscribers) }
          : undefined
        const uploads = uploader ? await channelVideos(ctx, uploader.id).catch(() => null) : null
        const facts = [read.views, read.published].filter(Boolean).join(' · ') || undefined
        return {
          kind: 'standalone',
          title: read.title ?? id,
          tagline: read.channel?.name,
          shortSummary: facts,
          summary: read.description,
          attributes: facts,
          landscapeURL: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          ratings: [], tags: [], isPaid: false, credits: [],
          defaultVideoID: id,
          series: [],
          uploads: uploads ?? undefined,
          recommendations: { tabs: [], items: items(read.related) },
          uploader,
          coUploaders: read.collaborators.map((c) => ({ id: c.id, name: c.name, avatarURL: c.avatar })),
          stats: { views: parseCount(read.views), likes: parseCount(read.likes) },
          publishedAt: parseRelativeDate(read.published),
        }
      },
      async episodes(cursor, ctx) {
        if (!cursor.startsWith(PLAYLIST_CURSOR)) return { episodes: [] }
        const list = await playlist(ctx, cursor.slice(PLAYLIST_CURSOR.length))
        return { episodes: list.cards.map(episode).filter((e) => e !== undefined) }
      },
      async uploader(id, ctx) {
        if (!id.startsWith('UC')) return null
        const answer = await use(ctx).session.browse({ browseId: id }, ctx.signal)
        const read = adapter.page(answer)
        const marks = adapter.marks(answer)
        return { uploader: { id, name: read.title ?? id }, isFollowing: use(ctx).session.loggedIn ? marks.subscribed : undefined }
      },
      async uploaderVideos(id, ctx) {
        return channelVideos(ctx, id)
      },
      async uploaderCollections(id, ctx) {
        if (!id.startsWith('UC')) return []
        const channelPage = await page(ctx, { browseId: id })
        const seen = new Set<string>()
        return channelPage.shelves.flatMap((s) => s.cards)
          .filter((c) => c.kind === 'playlist' && !c.id.startsWith('RD') && !seen.has(c.id) && seen.add(c.id))
          .map((c) => ({ title: c.title, section: '播放列表', cursor: PLAYLIST_CURSOR + c.id }))
      },
    },

    actions: {
      supports: { like: true, dislike: true, coins: false, favorite: false, follow: true },
      async state(video, uploader, ctx) {
        if (!use(ctx).session.loggedIn) throw new SourceError('login_required', '需要登录 YouTube')
        const marks = adapter.marks(await next(ctx, adapter.nextRequest({ videoId: video })))
        return {
          isLiked: marks.likeStatus === 'LIKE',
          isDisliked: marks.likeStatus === 'DISLIKE',
          coins: 0, maxCoins: 0, coinsPerDay: 0,
          isFollowingUploader: uploader ? (marks.subscribed ?? false) : undefined,
        }
      },
      async like(video, value, ctx) {
        await account(ctx, (s) => s.innertube(value ? 'like/like' : 'like/removelike', adapter.likeRequest({ videoId: video }), s.clients.accountClient, { signal: ctx.signal }))
      },
      async dislike(video, value, ctx) {
        await account(ctx, (s) => s.innertube(value ? 'like/dislike' : 'like/removedislike', adapter.likeRequest({ videoId: video }), s.clients.accountClient, { signal: ctx.signal }))
      },
      async follow(uploader, value, ctx) {
        await account(ctx, (s) => s.innertube(value ? 'subscription/subscribe' : 'subscription/unsubscribe', adapter.subscribeRequest({ channelId: uploader }), s.clients.accountClient, { signal: ctx.signal }))
      },
    },

    comments: {
      async first(video, sort, ctx) {
        const sorts = adapter.commentSorts(await next(ctx, adapter.nextRequest({ videoId: video })))
        const token = (sort === 'latest' ? sorts.latest : undefined) ?? sorts.hot
        // 关了评论的视频
        if (!token) return { comments: [], next: null }
        const first = await this.page(token, ctx)
        return { ...first, total: parseCount(sorts.total) }
      },
      async page(cursor, ctx) {
        const read = adapter.comments(await next(ctx, { continuation: cursor }))
        const comments: Comment[] = read.comments.map((item) => ({
          id: item.id,
          author: { name: item.author, avatarURL: item.avatar },
          text: item.text,
          date: parseRelativeDate(item.published),
          likes: parseCount(item.likes) ?? 0,
          replyCount: item.replyCount,
          replies: item.replies,
          isPinned: item.isPinned,
        }))
        return { comments, next: read.continuation ?? null }
      },
    },

    history: {
      async page(number, ctx) {
        if (!use(ctx).session.loggedIn) throw new SourceError('login_required', '需要登录 YouTube')
        const token = number <= 1 ? undefined : historyTokens.get(number)
        if (number > 1 && !token) return { items: [], hasMore: false }
        const result = await page(ctx, token ? { continuation: token } : { browseId: 'FEhistory' })
        if (result.continuation) historyTokens.set(number + 1, result.continuation)
        return {
          items: result.shelves.flatMap((s) => s.cards).map(videoItem).filter((item) => item !== undefined),
          hasMore: Boolean(result.continuation),
        }
      },
    },

    // 粘贴的 YouTube 链接（SERVER.md §5.10）：视频、Shorts、直播、嵌入页、短链，以及播放列表。
    links: {
      patterns: [
        '^https?://(www\\.|m\\.|music\\.)?youtube\\.com/(watch\\?|shorts/|live/|embed/|playlist\\?)',
        '^https?://youtu\\.be/[A-Za-z0-9_-]{11}',
      ],
      async resolve(url) {
        return linkTarget(url)
      },
    },

    playback: {
      resolve: (request, ctx) => use(ctx).playback.resolve(request, ctx),
      progress: (request, ctx) => use(ctx).playback.progress(request, ctx),
      cues: (ref, key, ctx) => use(ctx).playback.cues(ref, key, ctx),
    },
  }
}

/** 链接里的视频（`v=`、`youtu.be/<id>`、`shorts/<id>`、`live/<id>`、`embed/<id>`），否则播放列表（`list=`）。 */
export function linkTarget(raw: string): { target: { video: string } | { show: string } } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const id = /^[A-Za-z0-9_-]{11}$/
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  let video: string | undefined
  if (host === 'youtu.be') video = parts[0]
  else if (host === 'youtube.com') {
    if (parts[0] === 'watch') video = url.searchParams.get('v') ?? undefined
    else if (['shorts', 'live', 'embed'].includes(parts[0] ?? '')) video = parts[1]
  }
  if (video && id.test(video)) return { target: { video } }
  const list = url.searchParams.get('list')
  if (host === 'youtube.com' && list && /^[A-Za-z0-9_-]{10,}$/.test(list) && !list.startsWith('RD')) {
    return { target: { show: list } }
  }
  return null
}

export { mediaItem }
