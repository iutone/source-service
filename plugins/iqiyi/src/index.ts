// IUTone 自建源：爱奇艺。照 App 的 `App/Core/IQiyi`（电视端的行为为准）移植：网页版（pcw）接口，扫码登录，凭证存服务端，
// 全家共用。明文 HLS 的内联播放列表经媒体网关提供，分片 App 直连 CDN；加密片源（FairPlay / Widevine）的证书、许可经服务端转发。
// 随镜像发布在 /app/plugins/iqiyi，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import { type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { IQiyiComments } from './comments.ts'
import { DANMAKU_SEGMENT, danmakuSegment } from './danmaku.ts'
import { IQiyiDrm } from './drm.ts'
import { IQiyiDetail } from './detail.ts'
import { FILTER_CATEGORIES, IQiyiFeed } from './feed.ts'
import { IQiyiHistory } from './history.ts'
import { LINK_PATTERNS, resolveLink } from './links.ts'
import { IQiyiPlayback } from './playback.ts'
import { IQiyiSearch } from './search.ts'
import { IQiyiSession } from './session.ts'

export interface IQiyiOptions {
  name?: string
}

const factory: SourceFactory = (options) => createIQiyiSource(options as IQiyiOptions)
export default factory

interface Services {
  session: IQiyiSession
  feed: IQiyiFeed
  detail: IQiyiDetail
  search: IQiyiSearch
  history: IQiyiHistory
  comments: IQiyiComments
  playback: IQiyiPlayback
  drm: IQiyiDrm
}

export function createIQiyiSource(options: IQiyiOptions = {}): SourcePlugin {
  let services: Services | undefined
  // 登录态在这个源的 ctx.store 里：第一次用到时按它建好会话和各模块。
  const use = (ctx: Ctx): Services => {
    if (!services) {
      const session = new IQiyiSession(ctx.store)
      const playback = new IQiyiPlayback(session)
      services = {
        session,
        feed: new IQiyiFeed(session),
        detail: new IQiyiDetail(session),
        search: new IQiyiSearch(session),
        history: new IQiyiHistory(session),
        comments: new IQiyiComments(session),
        playback,
        drm: new IQiyiDrm(session, playback),
      }
    }
    return services
  }

  return {
    info: {
      name: options.name ?? '爱奇艺',
      // 爱奇艺的标签图标是文字商标（App 的 SourceBranding.tabIconIsWordmark），主色同 App。
      brand: { tint: '#00C45A', tabIconIsWordmark: true },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      methods: ['qr'],
      requiredFor: 'browse',
      async state(ctx) {
        const profile = await use(ctx).session.state(ctx.signal)
        return profile ? { loggedIn: true, profile } : { loggedIn: false }
      },
      begin(_method, ctx) {
        return use(ctx).session.login(ctx)
      },
      async logout(ctx) {
        // 网页登录没有找到服务端登出接口（docs/iqiyi/PLAN.md §3.2）：只清服务端的凭证。
        use(ctx).session.clear()
      },
    },

    feed: {
      homeShowsHistory: true,
      channelBrowser: true,
      channels: (ctx) => use(ctx).feed.channels(ctx.signal),
      channel: (id, cursor, ctx) => use(ctx).feed.channel(id, cursor, ctx.signal),
      more: (route, cursor, ctx) => use(ctx).feed.more(route, cursor, ctx.signal),
    },

    filter: {
      categories: async () => FILTER_CATEGORIES,
      dimensions: (category, ctx) => use(ctx).feed.dimensions(category, ctx.signal),
      results: (category, selection, cursor, ctx) => use(ctx).feed.filterResults(category, selection, cursor, ctx.signal),
    },

    search: {
      prompt: '搜索影视、视频',
      rankings: (ctx) => use(ctx).search.rankings(ctx.signal),
      suggestions: (text, ctx) => use(ctx).search.suggestions(text, ctx.signal),
      search: (keyword, ctx) => use(ctx).search.search(keyword, ctx.signal),
      videos: (keyword, cursor, ctx) => use(ctx).search.videos(keyword, cursor, ctx.signal),
    },

    detail: {
      detail: (target, ctx) => use(ctx).detail.detail(target, ctx.signal),
      episodes: (cursor, ctx) => use(ctx).detail.episodes(cursor, ctx.signal),
      resume: (show, video, ctx) => use(ctx).detail.resume(show, video, ctx.signal),
    },

    comments: {
      first: (video, sort, ctx) => use(ctx).comments.first(video, sort, ctx.signal),
      page: (cursor, ctx) => use(ctx).comments.page(cursor, ctx.signal),
    },

    danmaku: {
      segmentDuration: DANMAKU_SEGMENT,
      segment: (video, segment, ctx) => danmakuSegment(use(ctx).session, video, segment, ctx.signal),
    },

    history: {
      page: (page, ctx) => use(ctx).history.page(page, ctx.signal),
      delete: (keys, ctx) => use(ctx).history.delete(keys, ctx.signal),
      clear: (ctx) => use(ctx).history.clear(ctx.signal),
    },

    playback: {
      resolve: (request, ctx) => use(ctx).playback.resolve(request, ctx),
      progress: (request, ctx) => use(ctx).playback.progress(request, ctx),
      // 版权方要求加密的片源（迪士尼等）：FairPlay / Widevine 的证书和许可经服务端转发（SERVER.md §6.4）。
      drm: {
        systems: IQiyiDrm.systems,
        certificate: (system, ref, ctx) => use(ctx).drm.certificate(system, ref),
        license: (system, ref, request, ctx) => use(ctx).drm.license(system, ref, request, ctx.signal),
      },
    },

    links: {
      patterns: LINK_PATTERNS,
      resolve: (url, ctx) => resolveLink(url, use(ctx).session, ctx.signal),
    },
  }
}
