// IUTone 自建源：哔哩哔哩。照 App 的 `App/Core/Bilibili`（Apple TV 上的行为为准，docs/bilibili/PLAN.md）移植：
// TV 扫码登录（登录后才能用），网页接口加 WBI 签名浏览，DASH 经媒体网关做成 HLS 播放。
// 随镜像发布在 /app/plugins/bilibili，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import type { Danmaku } from '@iyt-source/protocol'
import { notFound, SourceError, type Ctx, type Logger, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { Catalog } from './catalog.ts'
import { Detail } from './detail.ts'
import * as feed from './feed.ts'
import { isShortLink, LINK_PATTERNS, linkTarget, parseID } from './ids.ts'
import { Interactions } from './interact.ts'
import { parseDanmakuSegment } from './models.ts'
import { Playback } from './playback.ts'
import { History, rankings, search, searchVideos, suggestions } from './search.ts'
import { BiliSession, MESSAGES } from './session.ts'
import { API, USER_AGENT } from './sign.ts'

export interface BilibiliOptions {
  name?: string
}

/** 弹幕按 6 分钟一段（`x/v2/dm/wbi/web/seg.so`）。 */
const DANMAKU_SEGMENT = 360

const factory: SourceFactory = (options) => createBilibiliSource(options as BilibiliOptions)
export default factory

export function createBilibiliSource(options: BilibiliOptions = {}): SourcePlugin {
  let services: { session: BiliSession; catalog: Catalog; detail: Detail; interact: Interactions; playback: Playback; history: History } | undefined
  /** 弹幕要 cid：按视频 id 记一下。 */
  const cids = new Map<string, number>()

  /** 第一次用到时按这个源的存储建好会话（登录态在 `ctx.store`）。 */
  const use = (ctx: Ctx) => {
    if (!services) {
      const session = new BiliSession(ctx.store, ctx.log)
      const catalog = new Catalog(session)
      services = { session, catalog, detail: new Detail(catalog), interact: new Interactions(catalog), playback: new Playback(catalog), history: new History(session) }
    }
    return services
  }

  /** 要登录的接口：没登录直接 `login_required`。 */
  const account = (ctx: Ctx) => {
    const all = use(ctx)
    if (!all.session.loggedIn) throw new SourceError('login_required', MESSAGES.loginRequired)
    return all
  }

  async function cid(video: string, ctx: Ctx): Promise<number> {
    const cached = cids.get(video)
    if (cached) return cached
    const id = parseID(video)
    const { catalog } = use(ctx)
    let value: number | undefined
    if (id?.kind === 'video') value = id.cid ?? (await catalog.view(id.bvid, ctx.signal)).cid
    else if (id?.kind === 'episode') value = (await catalog.episode(id.epid, ctx.signal)).episode.cid
    if (!value) throw notFound('这个视频')
    cids.set(video, value)
    if (cids.size > 500) cids.delete(cids.keys().next().value!)
    return value
  }

  return {
    info: {
      name: options.name ?? '哔哩哔哩',
      brand: { tint: '#FB7299', tabIconIsWordmark: true },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        // App 内置的哔哩哔哩首页标签图标（@3x，文字商标），按模板图渲染。
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      // 照 TV 端：用哔哩哔哩 App 扫码（`passport-tv-login`）。登录后才能用。
      methods: ['qr'],
      requiredFor: 'browse',
      state: (ctx) => use(ctx).session.state(ctx.signal),
      begin: (_method, ctx) => use(ctx).session.login(ctx.signal),
      async logout(ctx) {
        await use(ctx).session.logout(ctx.signal)
        cids.clear()
      },
    },

    feed: {
      // 首页是视频流，不是分区页：没有「观看历史」一行。TV 上全是标签，没有频道墙。
      homeShowsHistory: false,
      channelBrowser: false,
      channels: async () => feed.channels(),
      channel: (id, cursor, ctx) => feed.channel(account(ctx).session, id, cursor, ctx.signal),
      more: (route, cursor, ctx) => feed.more(account(ctx).session, route, cursor, ctx.signal),
      subchannels: (id, ctx) => feed.subchannels(account(ctx).session, id, ctx.signal),
      uploaders: (id, cursor, ctx) => feed.uploaders(account(ctx).session, id, cursor, ctx.signal),
    },

    filter: {
      categories: async () => feed.FILTER_CATEGORIES,
      dimensions: (category, ctx) => feed.filterDimensions(account(ctx).session, category, ctx.signal),
      results: (category, selection, cursor, ctx) => feed.filterResults(account(ctx).session, category, selection, cursor, ctx.signal),
    },

    search: {
      prompt: '搜索视频、番剧、影视',
      rankings: (ctx) => rankings(account(ctx).session, ctx.signal),
      suggestions: (text, ctx) => suggestions(account(ctx).session, text, ctx.signal),
      search: (keyword, ctx) => search(account(ctx).session, keyword, ctx.signal),
      videos: (keyword, cursor, ctx) => searchVideos(account(ctx).session, keyword, cursor, ctx.signal),
    },

    detail: {
      detail: (target, ctx) => account(ctx).detail.detail(target, ctx.signal),
      episodes: (cursor, ctx) => account(ctx).detail.episodes(cursor, ctx.signal),
      // 相关推荐只有一个标签，随详情给出。
      recommendations: async () => [],
      resume: (show, video, ctx) => account(ctx).detail.resume(show, video, ctx.signal),
      uploader: (id, ctx) => account(ctx).detail.uploader(id, ctx.signal),
      uploaderVideos: (id, ctx) => account(ctx).detail.uploads(id, 1, ctx.signal),
      uploaderCollections: (id, ctx) => account(ctx).detail.collections(id, ctx.signal),
    },

    actions: {
      supports: { like: true, dislike: true, coins: true, favorite: true, follow: true },
      state: (video, uploader, ctx) => account(ctx).interact.state(video, uploader, ctx.signal),
      like: (video, value, ctx) => account(ctx).interact.like(video, value, ctx.signal),
      dislike: (video, value, ctx) => account(ctx).interact.dislike(video, value, ctx.signal),
      coins: (video, count, ctx) => account(ctx).interact.coins(video, count, ctx.signal),
      favorites: (video, ctx) => account(ctx).interact.favorites(video, ctx.signal),
      updateFavorites: (video, adding, removing, ctx) => account(ctx).interact.updateFavorites(video, adding, removing, ctx.signal),
      follow: (uploader, value, ctx) => account(ctx).interact.follow(uploader, value, ctx.signal),
    },

    comments: {
      first: (video, sort, ctx) => account(ctx).interact.comments(video, sort, ctx.signal),
      page: (cursor, ctx) => account(ctx).interact.commentPage(cursor, ctx.signal),
    },

    danmaku: {
      segmentDuration: DANMAKU_SEGMENT,
      async segment(video, segment, ctx): Promise<Danmaku[]> {
        const { session } = account(ctx)
        const bytes = await session.bytes(`${API}/x/v2/dm/wbi/web/seg.so`, { type: '1', oid: String(await cid(video, ctx)), segment_index: String(segment + 1) }, { signal: ctx.signal })
        try {
          return parseDanmakuSegment(bytes)
        } catch (error) {
          throw new SourceError('upstream_changed', '弹幕读不懂了', { cause: error })
        }
      },
    },

    history: {
      page: (page, ctx) => account(ctx).history.page(page, ctx.signal),
      delete: (keys, ctx) => account(ctx).history.delete(keys, ctx.signal),
      clear: (ctx) => account(ctx).history.clear(ctx.signal),
    },

    links: {
      patterns: LINK_PATTERNS,
      async resolve(url, ctx) {
        let address = url
        try {
          // 短链接（b23.tv / bili2233.cn）跟一次跳转。
          if (isShortLink(new URL(url))) address = await expandShortLink(url, ctx.signal, ctx.log)
        } catch (error) {
          if (ctx.signal.aborted) throw error
          return null
        }
        return linkTarget(address)
      },
    },

    playback: {
      resolve: (request, ctx) => account(ctx).playback.resolve(request, ctx),
      progress: (request, ctx) => use(ctx).playback.progress(request, ctx),
      cues: (ref, key, ctx) => account(ctx).playback.cues(ref, key, ctx),
    },
  }
}

/** 短链接跳到哪：只要 Location，不跟到底（目标页很大）。 */
export async function expandShortLink(url: string, signal: AbortSignal, log?: Logger): Promise<string> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return current
    current = new URL(location, current).toString()
    if (!isShortLink(new URL(current))) return current
  }
  log?.warn('bilibili short link loops', { url })
  return current
}
