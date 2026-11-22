// IUTone 自建源：腾讯视频。照 App 的 Core/Tencent（Apple TV 上的行为为准）移植：网页（v.qq.com）的接口，扫码登录
// （腾讯视频 App 扫），`vusession` 两小时续期；频道、筛选、搜索、详情、讨论、我的追剧、观看历史、弹幕、播放（vinfo_proxy，
// 失败时 proxyhttp 自己签 cKey）、进度上报、链接解析。id 沿用 App：`c<cid>` 节目、`v<vid>` 视频。
// 随镜像发布在 /app/plugins/tencent，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import type { FeedPage, MediaItem, SearchRanking } from '@iyt-source/protocol'
import { type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { qrLogin } from './account.ts'
import { danmakuSegment, DANMAKU_SEGMENT } from './danmaku.ts'
import { TencentDetail } from './detail.ts'
import { CHANNELS, CHASING, HOME, LIBRARY_ROWS, TencentFeed, dimensions, filterParams } from './feed.ts'
import { TencentHistory } from './history.ts'
import { linkTarget, LINK_PATTERNS } from './ids.ts'
import { TENCENT_DRM_SYSTEMS, TencentPlayback, type PlaybackOptions } from './playback.ts'
import { RANKINGS, RANKING_SIZE, TencentSearch } from './search.ts'
import { TencentSession } from './session.ts'

export interface TencentOptions extends PlaybackOptions {
  name?: string
}

/** 频道页（编辑页 + 片库三行，十来个请求）缓存这么久。 */
const CHANNEL_TTL = 5 * 60_000
const RANKINGS_TTL = 30 * 60_000

const factory: SourceFactory = (options) => createTencentSource(options as TencentOptions)
export default factory

export function createTencentSource(options: TencentOptions = {}): SourcePlugin {
  let parts: ReturnType<typeof build> | undefined
  const pages = new Map<string, { at: number; page: Promise<FeedPage> }>()
  let rankings: { at: number; list: Promise<SearchRanking[]> } | undefined

  function build(ctx: Ctx) {
    const session = new TencentSession(ctx.store)
    const history = new TencentHistory(session)
    const detail = new TencentDetail(session, history)
    const playback = new TencentPlayback(session, detail, history, options)
    session.onLogout = () => {
      history.forget()
      pages.clear()
    }
    return { session, history, detail, playback, feed: new TencentFeed(session), search: new TencentSearch(session) }
  }
  const use = (ctx: Ctx) => (parts ??= build(ctx))

  const cached = (id: string, load: () => Promise<FeedPage>) => {
    const hit = pages.get(id)
    if (hit && Date.now() - hit.at < CHANNEL_TTL) return hit.page
    const page = load()
    pages.set(id, { at: Date.now(), page })
    page.catch(() => pages.delete(id))
    if (pages.size > 30) pages.delete(pages.keys().next().value!)
    return page
  }

  return {
    info: {
      name: options.name ?? '腾讯视频',
      brand: { tint: '#FF8800', tabIconIsWordmark: false },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        // App 内置的腾讯视频首页标签图标（@3x），按模板图渲染。
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      methods: ['qr'],
      requiredFor: 'browse',
      async state(ctx) {
        const { session } = use(ctx)
        if (!session.loggedIn) return { loggedIn: false }
        try {
          return { loggedIn: true, profile: await session.profile(ctx.signal) }
        } catch (error) {
          // 续期说登录没了：已经退出。其他错误（断网）不算退出。
          if (!session.loggedIn) return { loggedIn: false }
          if (ctx.signal.aborted) throw error
          return { loggedIn: true, profile: { name: session.credential?.nick ?? '腾讯视频用户' } }
        }
      },
      begin(_method, ctx) {
        return qrLogin(use(ctx).session, ctx)
      },
      async logout(ctx) {
        use(ctx).session.clear()
      },
    },

    feed: {
      homeShowsHistory: true,
      channelBrowser: true,
      async channels(ctx) {
        const channels = await use(ctx).feed.channels(ctx.signal)
        return {
          home: HOME,
          pinned: CHANNELS.slice(0, 4),
          channels: channels.map((channel) => ({ ...channel, filterCategories: [{ id: channel.id, title: channel.title }] })),
          library: [{ channel: CHASING, systemImage: 'tv', content: 'feed' as const }],
        }
      },
      async channel(id, cursor, ctx) {
        const { feed } = use(ctx)
        if (id === CHASING.id) {
          const page = await feed.chasing(Number(cursor) || 0, ctx.signal)
          return { sections: [{ id, style: 'grid', items: page.items }], next: page.next }
        }
        if (cursor) return { sections: [], next: null }
        return cached(id, () => feed.channel(id, ctx.signal))
      },
      more(route, cursor, ctx) {
        return use(ctx).feed.more(route, cursor, ctx.signal)
      },
    },

    filter: {
      async categories() {
        return CHANNELS.map((c) => ({ id: c.id, title: c.title }))
      },
      async dimensions(category, ctx) {
        return dimensions(await use(ctx).feed.libraryPage(category, 'sort=75', 0, ctx.signal))
      },
      results(category, selection, cursor, ctx) {
        const params = filterParams(selection)
        return use(ctx).feed.library(category, selection.sort || '75', Number(cursor) || 1, params, ctx.signal)
      },
    },

    search: {
      prompt: '搜索电视剧、电影、综艺',
      rankings(ctx) {
        if (rankings && Date.now() - rankings.at < RANKINGS_TTL) return rankings.list
        const { feed } = use(ctx)
        const list = Promise.all(RANKINGS.map(async (ranking): Promise<SearchRanking | undefined> => {
          const page = await feed.library(ranking.channel, LIBRARY_ROWS[0]!.sort, 1, undefined, ctx.signal).catch(() => undefined)
          if (!page?.items.length) return undefined
          const items: MediaItem[] = page.items.slice(0, RANKING_SIZE).map((item, index) => ({ ...item, rank: index + 1 }))
          return { id: ranking.channel, title: ranking.title, items }
        })).then((list) => list.filter((r): r is SearchRanking => r !== undefined))
        rankings = { at: Date.now(), list }
        list.then((l) => {
          if (!l.length) rankings = undefined
        }, () => {
          rankings = undefined
        })
        return list
      },
      suggestions(text, ctx) {
        return use(ctx).search.suggestions(text, ctx.signal)
      },
      search(keyword, ctx) {
        return use(ctx).search.search(keyword, ctx.signal)
      },
    },

    detail: {
      detail(target, ctx) {
        return use(ctx).detail.detail(target, ctx.signal)
      },
      episodes(cursor, ctx) {
        return use(ctx).detail.episodesAt(cursor, ctx.signal)
      },
      resume(show, video, ctx) {
        return use(ctx).detail.resume(show, video, ctx.signal)
      },
    },

    comments: {
      first(video, sort, ctx) {
        return use(ctx).detail.comments(video, sort, ctx.signal)
      },
      page(cursor, ctx) {
        return use(ctx).detail.commentsAt(cursor, ctx.signal)
      },
    },

    danmaku: {
      segmentDuration: DANMAKU_SEGMENT,
      segment(video, segment, ctx) {
        return danmakuSegment(use(ctx).session, video, segment, ctx.signal)
      },
    },

    history: {
      page(page, ctx) {
        return use(ctx).history.page(page, ctx.signal)
      },
      delete(keys, ctx) {
        return use(ctx).history.delete(keys, ctx.signal)
      },
      clear(ctx) {
        return use(ctx).history.clear(ctx.signal)
      },
    },

    playback: {
      resolve(request, ctx) {
        return use(ctx).playback.resolve(request, ctx)
      },
      progress(request, ctx) {
        return use(ctx).playback.progress(request, ctx)
      },
      // 加密档（FairPlay：drm 4，TS + SAMPLE-AES、skd://；Widevine：drm 5，CENC fMP4）的证书和许可，照网页播放器转发（SERVER.md §6.4）。
      drm: {
        // Widevine 的取流和转发已写好，但许可可能被腾讯封装进 `anc`（网页里的可信 JS 才解得开），真实许可的格式还没抓包确认，先不声明。
        systems: TENCENT_DRM_SYSTEMS,
        certificate(system, ref, ctx) {
          return use(ctx).playback.certificate(system, ref, ctx)
        },
        license(system, ref, request, ctx) {
          return use(ctx).playback.license(system, ref, request, ctx)
        },
      },
    },

    links: {
      patterns: LINK_PATTERNS,
      async resolve(url) {
        const target = linkTarget(url)
        return target ? { target } : null
      },
    },
  }
}

