// IUTone 自建源：芒果TV。照 App 的 `App/Core/Mgtv`（Apple TV 上的行为为准）移植：网页端（pcweb）接口，除搜索外不签名；
// 扫码登录（GetMultiPic / GetQrcodeResult），凭证（ticket、uuid）存在服务端；播放是 streamList → 调度 → 明文 HLS。
// 芒果的 m3u8 和分片都要 `Referer: https://www.mgtv.com/`（不带一律 403），所以流一律经媒体网关转发。
// 随镜像发布在 /app/plugins/mgtv，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  Channel, Channels, CommentPage, Danmaku, EpisodeList, FeedPage, FeedSection, FilterCategory, FilterDimension, HistoryPage,
  LoginStep, MediaItem, MediaItemPage, PlaybackMedia, ProgressRequest, ResolveRequest, ResumePoint, SearchRanking,
  SearchResults, SearchSuggestion, ShowDetail, Stream, Target,
} from '@iyt-source/protocol'
import { notFound, SourceError, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import {
  APP_VERSION, HOST, MgtvSession, REFERER, SUPPORT, USER_AGENT, apiError, clipID, idOf, int, list, num, pageIDs,
  parseID, signedQuery, sleep, text, timestamp, videoID,
} from './api.ts'
import {
  COMMENTS_PAGE, FILM, REPLIES_PAGE, SKIPPED_MODULES, comment, danmaku, episodeList,
  historyItem, historyProgress, libraryItem, lockedReason, markers, moduleSection, parseEpisodesCursor, pickRenditions,
  qualityLabel, qualityRank, recommendations, restriction, searchResults, showDetail, type CommentCursor,
} from './parse.ts'

export interface MgtvOptions {
  name?: string
  /** 要不要 H.265 的档位（会员的 fMP4，AVPlayer 能播）：默认要。连的设备有不能硬解 HEVC 的（Apple TV HD）时关掉。 */
  hevc?: boolean
}

/** 浏览的频道：导航的 `vclassId` → 片库的 `channelId`。VIP、播客、新闻、短剧、公益、音乐、直播、游戏、教育不要（docs/mgtv/PLAN.md §2）。 */
export const CHANNELS: { id: string; library: number; title: string }[] = [
  { id: '6', library: 1, title: '综艺' }, { id: '4', library: 2, title: '电视剧' }, { id: '9', library: 3, title: '电影' },
  { id: '8', library: 50, title: '动漫' }, { id: '10', library: 10, title: '少儿' }, { id: '111', library: 51, title: '纪录片' },
]
export const HOME: Channel = { id: '5', title: '首页' }
/** 片库的分类（筛选），教育不要。 */
export const CATEGORIES: FilterCategory[] = [
  { id: '2', title: '电视剧' }, { id: '3', title: '电影' }, { id: '1', title: '综艺' },
  { id: '50', title: '动漫' }, { id: '10', title: '少儿' }, { id: '51', title: '纪录片' },
]
/** 每个频道下的片库行：`sort` c2 最热，c1 最新。 */
const LIBRARY_ROWS = [{ sort: 'c2', title: '最热' }, { sort: 'c1', title: '最新' }]
const LIBRARY_PAGE = 60
const ROW_SIZE = 24
/** 每次 `module/infos` 请求的模块数，和网页一样。 */
const MODULE_BATCH = 6
const CHANNEL_CACHE = 5 * 60_000
/** 搜索前显示的排行：片库各频道最热的。 */
const RANKINGS = [{ channel: 2, title: '电视剧' }, { channel: 1, title: '综艺' }, { channel: 3, title: '电影' }, { channel: 50, title: '动漫' }]
const RANKING_SIZE = 20
const SEARCH_PAGE = 20
const HISTORY_PAGE = 30
/** 离结尾这么多秒以内的进度算看完，从头播。 */
const FINISHED_MARGIN = 10
/** 扫码：网页每 3 秒问一次；码约 2.5 分钟失效，提前一点换。 */
const POLL_INTERVAL = 3_000
const CODE_LIFETIME = 140_000

const factory: SourceFactory = (options) => createMgtvSource(options as MgtvOptions)
export default factory

/** 链接里的节目或视频：`mgtv.com/b/<clipId>/<videoId>.html` 是视频，`/b/<clipId>.html`、`/h/<clipId>.html` 是节目。 */
export function linkTarget(raw: string): { target: Target } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)mgtv\.com$/.test(url.hostname)) return null
  const ids = pageIDs(url.pathname)
  if (!ids) return null
  return { target: ids.video ? { video: videoID(ids.video) } : { show: clipID(ids.clip) } }
}

/** 选中的流：不高于偏好的最高档；都比偏好高时取最低档。 */
export function selectStream(streams: Stream[], maxRank?: number | null): Stream | undefined {
  const available = streams.filter((stream) => !stream.unavailableReason).sort((a, b) => b.quality.rank - a.quality.rank)
  if (!maxRank) return available[0]
  return available.find((stream) => stream.quality.rank <= maxRank) ?? available[available.length - 1]
}

interface State {
  session: MgtvSession
  /** 历史第 n 页（n ≥ 2）的 `beforeTime`，翻页时记下。 */
  historyCursors: Map<number, string>
}

export function createMgtvSource(options: MgtvOptions = {}): SourcePlugin {
  const hevc = options.hevc ?? true
  const states = new Map<string, State>()
  let navigation: { at: number; titles: Promise<Map<string, string> | undefined> } | undefined
  let rankingCache: { at: number; rankings: Promise<SearchRanking[]> } | undefined
  const channelPages = new Map<string, { at: number; page: FeedPage }>()
  const danmakuCDNs = new Map<string, { at: number; cdn: Promise<{ hosts: string[]; version: string } | null> }>()

  function use(ctx: Ctx): State {
    let state = states.get(ctx.store.directory)
    if (!state) {
      state = { session: new MgtvSession(ctx.store), historyCursors: new Map() }
      states.set(ctx.store.directory, state)
    }
    return state
  }

  // MARK: 登录

  async function* login(ctx: Ctx): AsyncIterable<LoginStep> {
    const { session } = use(ctx)
    const params = () => ({
      abroad: '0', src: 'mgtv', _support: SUPPORT, deviceid: session.deviceID, appVersion: `pcweb-${APP_VERSION}`,
      dname: '', invoker: 'pcweb', noBinding: '0',
    })
    let refreshing = false
    for (;;) {
      let generated: any
      try {
        generated = await session.get(`${HOST.account}/GetMultiPic`, params(), ctx.signal)
      } catch (error) {
        // 只有第一个码取不到才算失败；换码时取不到就过一会儿再试。
        if (!refreshing || ctx.signal.aborted) throw error
        yield { kind: 'waiting', message: '正在刷新二维码…' }
        await sleep(5_000, ctx.signal)
        continue
      }
      refreshing = true
      const rcode = text(generated?.data?.rcode)
      const content = text(generated?.data?.url)
      if (int(generated?.code) !== 200 || !rcode || !content) throw apiError(generated, '取不到登录二维码')
      const expires = Date.now() + CODE_LIFETIME
      yield {
        kind: 'showCode',
        content,
        title: '芒果TV扫码登录',
        message: '打开芒果TV App，扫一扫登录（也支持微信、QQ）',
        expiresAt: new Date(expires).toISOString(),
      }
      while (Date.now() < expires) {
        await sleep(POLL_INTERVAL, ctx.signal)
        let result: any
        try {
          result = await session.get(`${HOST.account}/GetQrcodeResult`, { ...params(), rcode, t: String(Date.now()) }, ctx.signal)
        } catch (error) {
          // 断网、休眠只跳过这一次，码留在屏幕上。
          if (ctx.signal.aborted) throw error
          continue
        }
        const code = int(result?.code)
        if (code === 203) continue
        if (code !== 200) break // 26：码失效；别的也换个新码。
        const user = result.data ?? {}
        const ticket = text(user.ticket)
        const uuid = text(user.uuid) ?? idOf(user.uid)
        if (!ticket || !uuid) {
          yield { kind: 'failed', message: '登录失败，请重试', restartable: true }
          return
        }
        if (int(user.needRelate) === 1) {
          yield { kind: 'failed', message: '该账号未绑定手机号，请先在芒果TV App 绑定后再登录', restartable: true }
          return
        }
        yield { kind: 'waiting', message: '登录成功，正在获取账号信息…' }
        session.apply({ ticket, uuid })
        yield { kind: 'completed', profile: await session.refreshProfile(ctx.signal) }
        return
      }
    }
  }

  // MARK: 频道

  /** 导航里频道的名字（`vrsList`），一天读一次；读不到用插件写死的。 */
  function navigationTitles(ctx: Ctx): Promise<Map<string, string> | undefined> {
    if (navigation && Date.now() - navigation.at < 86_400_000) return navigation.titles
    const { session } = use(ctx)
    const titles = session.get(
      `${HOST.channel}/dynamic/v1/channel/vrsList/${APP_VERSION}/10_15/5.0/${SUPPORT}/0/4/0/0`,
      { osType: 'mac', cType: '0', subchannelFlag: '1' },
    ).then((answer) => {
      const map = new Map<string, string>()
      for (const entry of list(answer?.data)) {
        const id = idOf(entry?.vclassId)
        const title = text(entry?.title)
        if (id && title) map.set(id, title)
      }
      return map.size ? map : undefined
    }).catch((error) => {
      ctx.log.warn('mgtv channel list failed', { error: String(error) })
      navigation = undefined
      return undefined
    })
    navigation = { at: Date.now(), titles }
    return titles
  }

  async function channelList(ctx: Ctx): Promise<Channel[]> {
    const titles = await navigationTitles(ctx)
    const listed = titles ? [...titles.keys()].filter((id) => CHANNELS.some((c) => c.id === id)) : CHANNELS.map((c) => c.id)
    return listed.map((id) => {
      const known = CHANNELS.find((c) => c.id === id)!
      const category = CATEGORIES.find((c) => c.id === String(known.library))
      return { id, title: titles?.get(id) ?? known.title, filterCategories: category ? [category] : undefined }
    })
  }

  /** 片库一页（`rider/list`），按 `sort` 排。 */
  async function library(ctx: Ctx, channel: number, sort: string, page: number, size: number): Promise<MediaItemPage> {
    const answer = await use(ctx).session.get(`${HOST.library}/rider/list/pcweb/v3`, {
      allowedRC: '1', platform: 'pcweb', channelId: String(channel), pn: String(page), pc: String(size), hudong: '1',
      _support: SUPPORT, kind: 'a1', year: 'all', chargeInfo: 'a1', sort, area: 'a1', feature: 'all',
    }, ctx.signal)
    return libraryPage(answer, page, '片库加载失败')
  }

  function libraryPage(answer: any, page: number, fallback: string): MediaItemPage {
    if (int(answer?.code) !== 200) throw apiError(answer, fallback)
    const items = list(answer.data?.hitDocs).map(libraryItem).filter((item): item is MediaItem => Boolean(item))
    return { items, next: answer.data?.hasMore === true && items.length > 0 ? String(page + 1) : null }
  }

  /** 频道的编辑页：`channel/index` 给出全部模块的顺序和首屏的几个，其余按批取。 */
  async function editorial(ctx: Ctx, vclass: string): Promise<FeedSection[]> {
    const { session } = use(ctx)
    const path = `${session.deviceID}/${APP_VERSION}/10_15/${SUPPORT}/${session.ticket ?? 'space'}/0/4`
    const params = { osType: 'mac', seqId: session.deviceID, device: 'pc', playList: '' }
    const index = await session.get(`${HOST.channel}/dynamic/v1/channel/index/${path}/${vclass}`, params, ctx.signal)
    if (int(index?.code) !== 200) throw apiError(index, '频道内容加载失败')
    const order = list(index.moduleIDS).flatMap((entry) => {
      const id = text(entry?.moduleEntityId)
      return id ? [{ id, type: text(entry.moduleType) ?? '' }] : []
    })
    const modules = new Map<string, any>()
    for (const module of list(index.data)) {
      const id = text(module?.moduleEntityId)
      if (id) modules.set(id, module)
    }
    const missing = order.filter((entry) => !modules.has(entry.id) && !SKIPPED_MODULES.has(entry.type)).map((entry) => entry.id)
    const batches: string[][] = []
    for (let i = 0; i < missing.length; i += MODULE_BATCH) batches.push(missing.slice(i, i + MODULE_BATCH))
    const answers = await Promise.all(batches.map((batch) =>
      session.get(`${HOST.channel}/dynamic/v1/module/infos/${path}/${vclass}/${batch.join(',')}`, params, ctx.signal)
        .catch((error) => {
          if (ctx.signal.aborted) throw error
          return undefined
        })))
    for (const answer of answers) {
      for (const module of list(answer?.data)) {
        const id = text(module?.moduleEntityId)
        if (id) modules.set(id, module)
      }
    }
    return order.flatMap((entry) => {
      if (SKIPPED_MODULES.has(entry.type)) return []
      const module = modules.get(entry.id)
      const section = module ? moduleSection(module, entry.type, vclass) : undefined
      return section ? [section] : []
    })
  }

  /** 频道页：编辑页的模块，再是片库的最热、最新两行（首页没有）。 */
  async function channelPage(ctx: Ctx, id: string): Promise<{ page: FeedPage; complete: boolean }> {
    const known = CHANNELS.find((c) => c.id === id)
    const errors: unknown[] = []
    const [sections, ...rows] = await Promise.all([
      editorial(ctx, id).catch((error) => {
        if (ctx.signal.aborted) throw error
        errors.push(error)
        return [] as FeedSection[]
      }),
      ...(known ? LIBRARY_ROWS : []).map(async (row): Promise<FeedSection | undefined> => {
        try {
          const page = await library(ctx, known!.library, row.sort, 1, ROW_SIZE)
          if (page.items.length === 0) return undefined
          const route = `lib:${known!.library}:${row.sort}`
          return { id: route, title: row.title, style: 'row', items: page.items, more: { title: `${known!.title} · ${row.title}`, route } }
        } catch (error) {
          if (ctx.signal.aborted) throw error
          errors.push(error)
          return undefined
        }
      }),
    ])
    const all = [...sections, ...rows.filter((row): row is FeedSection => Boolean(row))]
    if (all.length === 0 && errors.length) throw errors[0]
    return { page: { sections: all, next: null }, complete: errors.length === 0 }
  }

  // MARK: 观看历史

  function checkHistory(ctx: Ctx, answer: any): void {
    const code = int(answer?.code)
    if (code === 200) return
    const { session } = use(ctx)
    if (code === 401 || code === 2001) {
      session.clear()
      throw new SourceError('login_required', '芒果TV登录已失效，请重新登录')
    }
    throw session.fail(answer, '观看历史加载失败')
  }

  async function historyPage(ctx: Ctx, beforeTime: string | undefined, size: number): Promise<any> {
    const { session } = use(ctx)
    const { ticket, uuid } = session.requireLogin()
    const params: Record<string, string> = {
      allowedRC: '1', _support: SUPPORT, uid: uuid, ticket, pageSize: String(size), from: '2', isFilter: '0',
    }
    if (beforeTime) params.beforeTime = beforeTime
    const answer = await session.get(`${HOST.history}/playHistory/v2/get`, params, ctx.signal)
    checkHistory(ctx, answer)
    return answer.data ?? {}
  }

  /** 第一页原始记录（详情的继续播放、解析的起播点用）；没登录或取不到时为空。 */
  async function recentRecords(ctx: Ctx): Promise<any[]> {
    if (!use(ctx).session.credential) return []
    try {
      return list((await historyPage(ctx, undefined, 50)).playList)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return []
    }
  }

  async function historyPost(ctx: Ctx, path: string, extra: Record<string, string>): Promise<void> {
    const { session } = use(ctx)
    const { ticket, uuid } = session.requireLogin()
    const answer = await session.post(`${HOST.history}${path}`, {}, {
      ...extra, uid: uuid, ticket, from: '1', _support: SUPPORT, allowedRC: '1',
    }, ctx.signal)
    checkHistory(ctx, answer)
  }

  function resumeOf(record: any): ResumePoint | null {
    const vid = idOf(record?.vid)
    if (!vid) return null
    const progress = historyProgress(record)
    return progress === undefined ? { videoID: videoID(vid) } : { videoID: videoID(vid), progress }
  }

  // MARK: 详情

  async function episodes(ctx: Ctx, clip: string, page: number, type: number | undefined): Promise<EpisodeList> {
    const { session } = use(ctx)
    const answer = await session.post(`${HOST.mobile}/vod/video/positives`, { allowedRC: '1' }, {
      ...session.common(), clipId: clip, pageNum: String(page), t_mainDisplayType: '2', t_requestMode: 'direct',
    }, ctx.signal)
    if (int(answer?.code) !== 0) throw apiError(answer, '选集加载失败')
    return episodeList(answer.data, clip, page, type)
  }

  async function recommended(ctx: Ctx, clip: string, video: string | undefined): Promise<MediaItem[]> {
    const { session } = use(ctx)
    try {
      const answer = await session.get(`${HOST.recommend}/api/server/rec/mix-feed`, {
        ...session.common(), clipId: clip, videoId: video ?? '', jumpUrl: 'imgotv://player', vodAbStrategy: '1',
      }, ctx.signal)
      return recommendations(answer?.data, clip)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return []
    }
  }

  async function vodInfo(ctx: Ctx, key: { clipId: string } | { videoId: string }): Promise<any> {
    const { session } = use(ctx)
    const answer = await session.get(`${HOST.vod}/v1/vod/info`, { ...session.common(), ...key }, ctx.signal)
    if (int(answer?.code) !== 200) throw apiError(answer, '找不到该节目')
    if (!idOf(answer.data?.info?.clip?.clipId)) throw notFound('节目')
    return answer.data
  }

  async function detail(ctx: Ctx, target: Target): Promise<ShowDetail> {
    const raw = 'show' in target ? target.show : target.video
    const id = parseID(raw)
    if (!id) throw notFound('节目')
    const data = await vodInfo(ctx, id.kind === 'clip' ? { clipId: id.id } : { videoId: id.id })
    const info = data.info
    const clip = idOf(info.clip.clipId)!
    const type = int(info.fstlvlTypeId)
    const isFilm = type === FILM && (int(info.clip.serialCount) ?? 1) <= 1
    const playing = id.kind === 'video' ? id.id : undefined
    const [recs, resume, list] = await Promise.all([
      recommended(ctx, clip, playing ?? idOf(info.video?.videoId)),
      playing ? Promise.resolve(null) : recentRecords(ctx).then((records) => resumeOf(records.find((r) => idOf(r?.pid) === clip))),
      isFilm ? Promise.resolve(undefined) : episodes(ctx, clip, 1, type).catch((error) => {
        if (ctx.signal.aborted) throw error
        ctx.log.warn('mgtv episodes failed', { clip, error: String(error) })
        return undefined
      }),
    ])
    const result = showDetail(data, clip)
    const fallback = idOf(info.video?.videoId)
    result.defaultVideoID = playing ? videoID(playing) : resume?.videoID ?? (fallback ? videoID(fallback) : undefined)
    if (!result.defaultVideoID) delete result.defaultVideoID
    if (list) result.episodes = list
    result.recommendations = { tabs: [], items: recs }
    if (resume) result.resume = resume
    return result
  }

  // MARK: 评论

  async function commentPage(ctx: Ctx, cursor: CommentCursor): Promise<CommentPage> {
    const isReplies = cursor.kind === 'replies'
    const size = isReplies ? REPLIES_PAGE : COMMENTS_PAGE
    const params: Record<string, string> = {
      subjectType: 'hunantv2014', subjectId: cursor.subject, page: String(cursor.page), pageSize: String(size),
      platform: 'pc', _support: SUPPORT, allowedRC: '1',
    }
    if (cursor.comment) params.commentId = cursor.comment
    if (cursor.hot) params.orderBy = 'ai-score-desc'
    const answer = await use(ctx).session.get(`${HOST.comment}/${isReplies ? 'getReplyList' : 'getCommentList'}`, params, ctx.signal)
    if (int(answer?.code) !== 200) throw apiError(answer, '评论加载失败')
    const data = answer.data ?? {}
    const comments = list(data.list).map((entry) => comment(entry, cursor.subject, isReplies)).filter((c) => c !== undefined)
    const total = int(data.commentCount)
    const hasMore = comments.length > 0 && (total !== undefined ? cursor.page * size < total : comments.length >= size)
    const page: CommentPage = { comments, next: hasMore ? JSON.stringify({ ...cursor, page: cursor.page + 1 }) : null }
    if (total !== undefined) page.total = total
    return page
  }

  // MARK: 弹幕

  /** 视频弹幕所在的 CDN（`getctlbarrage` 的 `cdn_list` + `cdn_version`），按视频缓存半小时；没有时为 null。 */
  function danmakuCDN(ctx: Ctx, vid: string): Promise<{ hosts: string[]; version: string } | null> {
    const cached = danmakuCDNs.get(vid)
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.cdn
    const { session } = use(ctx)
    // 不带节目 id（cid）时 getctlbarrage 回 `switcher: false`、没有 CDN：先用 `player/vinfo` 查视频属于哪个节目。
    const cdn = session.get(`${HOST.pcweb}/player/vinfo`, { video_id: vid, _support: SUPPORT, allowedRC: '1' }, ctx.signal)
      .then((answer) => idOf(answer?.data?.clip_id) ?? '', () => '')
      .then((cid) => session.get(`${HOST.danmaku}/getctlbarrage`, {
        version: '9.0.0', abroad: '0', uuid: session.uuid ?? '', os: '', platform: '0', deviceid: session.deviceID, mac: '',
        vid, pid: '', cid, ticket: session.ticket ?? '',
      }, ctx.signal)).then((answer) => {
      const version = text(answer?.data?.cdn_version)
      const hosts = (text(answer?.data?.cdn_list) ?? '').split(',').map((h) => h.trim()).filter((h) => /^[a-z0-9.-]+$/i.test(h))
      return version && hosts.length ? { hosts, version } : null
    }).catch(() => {
      danmakuCDNs.delete(vid)
      return null
    })
    if (danmakuCDNs.size > 500) danmakuCDNs.clear()
    danmakuCDNs.set(vid, { at: Date.now(), cdn })
    return cdn
  }

  /**
   * 一分钟的弹幕。有 CDN 版本的视频（现在多数）从 `bullet-*.hitv.com/<cdn_version>/<n>.json` 取，否则用
   * `galaxy.bz.mgtv.com/cdn/opbarrage`（App 只用后者；新视频那里常回「点播弹幕未开启」）。都不用登录。
   */
  async function danmakuSegment(ctx: Ctx, video: string, segment: number): Promise<Danmaku[]> {
    const id = parseID(video)
    if (id?.kind !== 'video') return []
    const { session } = use(ctx)
    const cdn = await danmakuCDN(ctx, id.id)
    if (cdn) {
      for (const host of cdn.hosts) {
        try {
          const response = await fetch(`https://${host}/${cdn.version}/${segment}.json`, {
            headers: { 'user-agent': USER_AGENT, referer: REFERER },
            signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
          })
          // 超过片长的段：404 / 403。
          if (response.status === 404 || response.status === 403) return []
          if (!response.ok) continue
          const answer = await response.json() as any
          if (int(answer?.status) === 0) return danmaku(answer.data?.items)
        } catch (error) {
          if (ctx.signal.aborted) throw error
        }
      }
    }
    const answer = await session.get(`${HOST.danmaku}/cdn/opbarrage`, {
      vid: id.id, pid: '', cid: '', ticket: session.ticket ?? '', time: String(segment * 60_000), allowedRC: '1',
    }, ctx.signal)
    if (int(answer?.status) !== 0) return []
    return danmaku(answer.data?.items)
  }

  // MARK: 播放

  async function streamList(ctx: Ctx, vid: string): Promise<any> {
    const { session } = use(ctx)
    const answer = await session.get(`${HOST.pcweb}/video/streamList`, {
      playType: '1', auth_mode: '1', definitionType: '2', definition: '2', fileSourceType: '1', video_id: vid,
      did: session.deviceID, suuid: randomUUID(), vf: hevc ? 'h265,h264' : 'h264', type: 'pch5', _support: SUPPORT,
      src: 'mgtv', abroad: '0', appVersion: APP_VERSION, allowedRC: '1', sdk_version: '27', cputy: 'Safari',
    }, ctx.signal)
    if (int(answer?.code) === 200 && answer.data?.info) return answer.data
    // 40004：因版权限制，请前往芒果TV App观看；40005：地区限制。
    const code = int(answer?.code)
    const message = text(answer?.msg) ?? '该视频暂不支持播放'
    if (code === 40005) throw new SourceError('restricted', message)
    const error = apiError(answer, message)
    if (error.code === 'login_required') throw use(ctx).session.fail(answer, message)
    throw new SourceError('unplayable', `${message}（${answer?.code ?? '?'}）`)
  }

  /** 节目要播的视频：历史里最近看的那个，否则播放页的默认集。 */
  async function defaultVideo(ctx: Ctx, clip: string, records: any[]): Promise<string> {
    const record = records.find((r) => idOf(r?.pid) === clip)
    const fromHistory = idOf(record?.vid)
    if (fromHistory) return fromHistory
    const data = await vodInfo(ctx, { clipId: clip })
    const vid = idOf(data.info?.video?.videoId)
    if (!vid) throw new SourceError('unplayable', '该节目暂无可播放的视频')
    return vid
  }

  /** 这一档的 HLS 地址：调度域名按序试，第一个答 ok 的。 */
  async function dispatch(ctx: Ctx, path: string, domains: string[]): Promise<string | undefined> {
    const { session } = use(ctx)
    for (const domain of domains) {
      try {
        const answer = JSON.parse(await session.text(`${domain}${path}&did=${session.deviceID}&suuid=${randomUUID()}`, ctx.signal))
        const url = text(answer?.info)
        if (text(answer?.status) === 'ok' && url && /^https?:\/\//.test(url)) return url
      } catch (error) {
        if (ctx.signal.aborted) throw error
      }
    }
    return undefined
  }

  async function resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const { session } = use(ctx)
    const id = parseID(request.video)
    if (!id) throw new SourceError('not_found', `无法识别的视频 ${request.video}`)
    const records = await recentRecords(ctx)
    const vid = id.kind === 'video' ? id.id : await defaultVideo(ctx, id.id, records)
    const data = await streamList(ctx, vid)
    const info = data.info ?? {}
    // 凭证不再登录：问一下账号，失效（过期或被挤下线）就清掉让 App 去登录；账号还好就照未登录的结果播。
    if (session.credential && data.user?.login === false) {
      await session.refreshProfile(ctx.signal)
      ctx.log.warn('mgtv stream list not logged in with a valid ticket', { vid })
    }
    if (int(data.user?.isvip) === 1) session.isVIP = true
    const note = restriction(data)
    if (note) throw new SourceError('restricted', note)
    if (text(data.drm?.licenseUrl)) throw new SourceError('unplayable', '这个视频有版权保护（DRM），暂不支持')

    const domains = list(data.stream_domain).map(text).filter((d): d is string => Boolean(d))
    const picked = pickRenditions(data, hevc)
    const streams = (await Promise.all([...picked].map(async ([definition, rendition]): Promise<Stream | undefined> => {
      const quality = { rank: qualityRank(rendition), label: qualityLabel(rendition) }
      const videoFormat = text(rendition.videoFormat) ?? ''
      const fileFormat = text(rendition.fileFormat) ?? ''
      // H.265 是 fMP4（`EXT-X-MAP`），AVPlayer 能播；实测（2026-11）未登录也给 H.265 档。
      const codec = /265|hevc/i.test(videoFormat) ? 'H.265' : /264|avc/i.test(videoFormat) ? 'H.264' : videoFormat
      const container = /fmp4/i.test(fileFormat) ? 'fMP4' : /ts/i.test(fileFormat) ? 'TS' : fileFormat
      const description = `${codec} ${container} ${quality.label}`.replace(/\s+/g, ' ').trim()
      const streamID = `${videoFormat || 'h264'}-${definition}`
      const path = text(rendition.url)
      if (!path) return { id: streamID, url: 'about:blank', format: 'hls', quality, description, unavailableReason: lockedReason(rendition) }
      const m3u8 = await dispatch(ctx, path, domains)
      if (!m3u8) return undefined
      // m3u8 和分片都要 Referer：经网关转发，播放列表里的地址都指回网关。
      const url = ctx.media.proxy(m3u8, { headers: { referer: REFERER, 'user-agent': USER_AGENT }, name: 'index.m3u8', playlist: 'auto' })
      return { id: streamID, url, format: 'hls', quality, description: `${description} via proxy` }
    }))).filter((stream): stream is Stream => Boolean(stream)).sort((a, b) => b.quality.rank - a.quality.rank)
    const selected = selectStream(streams, request.preferences?.maxQualityRank)
    if (!selected) throw new SourceError('unplayable', '没有可播放的清晰度', { retryable: true })

    const duration = num(info.duration)
    const record = records.find((r) => idOf(r?.vid) === vid)
    const position = num(record?.watchTime)
    const media: PlaybackMedia = {
      title: text(info.partName) ?? text(info.title) ?? '',
      streams,
      selectedStream: selected.id,
      reportContext: { vid, cid: idOf(info.collection_id) ?? '' },
      diagnostics: { vf: hevc ? 'h265,h264' : 'h264', vip: session.isVIP ? 'yes' : 'no', domain: domains[0] ?? '' },
    }
    if (position && position > 0 && int(record?.isEnd) !== 1 && (!duration || position < duration - FINISHED_MARGIN)) {
      media.startPosition = position
    }
    const marks = markers(data.points)
    if (marks) media.markers = marks
    return media
  }

  /** 网页播放器的心跳：起播、过程中、暂停 / 拖动 / 离开时，结束时 `isEnd=1`。 */
  async function progress(request: ProgressRequest, ctx: Ctx): Promise<void> {
    const { session } = use(ctx)
    const credential = session.credential
    if (!credential) return
    const context = (request.reportContext ?? {}) as { vid?: string; cid?: string }
    const vid = context.vid ?? (parseID(request.video)?.kind === 'video' ? parseID(request.video)!.id : undefined)
    if (!vid) return
    const isEnd = request.event === 'end'
    const position = Math.floor(isEnd && request.duration ? request.duration : request.position)
    const answer = await session.get(`${HOST.history}/playHistory/heartbeat`, {
      watchTime: String(Math.max(position, 0)), ticket: credential.ticket, uid: credential.uuid, cid: context.cid ?? '',
      vid, pid: '', sid: '0', from: '1', isEnd: isEnd ? '1' : '0',
    }, ctx.signal)
    checkHistory(ctx, answer)
  }

  // MARK: 插件

  return {
    info: {
      name: options.name ?? '芒果TV',
      brand: { tint: '#FF5E00', tabIconIsWordmark: false },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        // App 内置的芒果TV 首页标签图标（@3x），按模板图渲染。
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      methods: ['qr'],
      requiredFor: 'browse',
      async state(ctx) {
        const { session } = use(ctx)
        if (!session.credential) return { loggedIn: false }
        const cached = session.profile
        if (cached) return { loggedIn: true, profile: cached }
        try {
          return { loggedIn: true, profile: await session.refreshProfile(ctx.signal) }
        } catch (error) {
          if (error instanceof SourceError && error.code === 'login_required') return { loggedIn: false }
          // 读不到账号不算退出：凭证还在。
          return { loggedIn: true, profile: session.staleProfile ?? { name: '芒果TV用户' } }
        }
      },
      begin(_method, ctx) {
        return login(ctx)
      },
      async logout(ctx) {
        const state = use(ctx)
        state.session.clear()
        state.historyCursors.clear()
      },
    },

    feed: {
      homeShowsHistory: true,
      channelBrowser: true,
      async channels(ctx): Promise<Channels> {
        const channels = await channelList(ctx)
        const pinned = CHANNELS.slice(0, 4).map((known) => channels.find((c) => c.id === known.id) ?? { id: known.id, title: known.title })
        return { home: HOME, pinned: pinned.map(({ id, title }) => ({ id, title })), channels, library: [] }
      },
      async channel(id, cursor, ctx): Promise<FeedPage> {
        if (cursor) return { sections: [], next: null }
        if (!/^\d+$/.test(id)) throw notFound('频道')
        // 芒果的接口一次约 1 秒，频道页要好几个：同一频道几分钟内给同一份。
        const key = `${id}:${use(ctx).session.ticket ?? ''}`
        const cached = channelPages.get(key)
        if (cached && Date.now() - cached.at < CHANNEL_CACHE) return cached.page
        const { page, complete } = await channelPage(ctx, id)
        if (channelPages.size > 50) channelPages.clear()
        // 有一部分没取到的不缓存，下次再试。
        if (complete) channelPages.set(key, { at: Date.now(), page })
        return page
      },
      async more(route, cursor, ctx) {
        const match = /^lib:(\d+):(c\d+)$/.exec(route)
        if (!match) throw notFound('列表')
        const page = Math.max(Number(cursor) || 1, 1)
        return library(ctx, Number(match[1]), match[2], page, LIBRARY_PAGE)
      },
    },

    filter: {
      async categories() {
        return CATEGORIES
      },
      async dimensions(category, ctx): Promise<FilterDimension[]> {
        const answer = await use(ctx).session.get(`${HOST.library}/rider/config/channel/v1`, {
          allowedRC: '1', platform: 'pcweb', channelId: category, _support: SUPPORT,
        }, ctx.signal)
        if (int(answer?.code) !== 200) throw apiError(answer, '筛选项加载失败')
        return list(answer.data?.listItems).flatMap((entry): FilterDimension[] => {
          const name = text(entry?.eName)
          if (!name) return []
          const items = list(entry.items)
          const options = items.flatMap((item) => {
            const id = text(item?.tagId)
            const title = text(item?.tagName)
            return id && title ? [{ id, title }] : []
          })
          if (options.length < 2) return []
          const picked = text(items.find((item) => item?.picked === true)?.tagId)
          const dimension: FilterDimension = { id: name, title: text(entry.typeName) ?? name, options, defaultOptionID: picked ?? options[0].id }
          if (name === 'sort') dimension.isSort = true
          return [dimension]
        })
      },
      async results(category, selection, cursor, ctx) {
        if (!/^\d+$/.test(category)) throw notFound('分类')
        const page = Math.max(Number(cursor) || 1, 1)
        const params: Record<string, string> = {}
        for (const [key, value] of Object.entries(selection)) if (value) params[key] = value
        Object.assign(params, {
          allowedRC: '1', platform: 'pcweb', _support: SUPPORT, hudong: '1', channelId: category, pn: String(page),
          pc: String(LIBRARY_PAGE),
        })
        const answer = await use(ctx).session.get(`${HOST.library}/rider/list/pcweb/v3`, params, ctx.signal)
        return libraryPage(answer, page, '片库加载失败')
      },
    },

    search: {
      prompt: '搜索综艺、剧集、电影',
      async rankings(ctx) {
        if (rankingCache && Date.now() - rankingCache.at < 10 * 60_000) return rankingCache.rankings
        const rankings = Promise.all(RANKINGS.map(async (ranking): Promise<SearchRanking | undefined> => {
          try {
            const page = await library(ctx, ranking.channel, 'c2', 1, RANKING_SIZE)
            if (page.items.length === 0) return undefined
            return { id: String(ranking.channel), title: ranking.title, items: page.items.map((item, index) => ({ ...item, rank: index + 1 })) }
          } catch {
            return undefined
          }
        })).then((all) => all.filter((r): r is SearchRanking => Boolean(r)))
        rankingCache = { at: Date.now(), rankings }
        const result = await rankings
        if (result.length === 0) rankingCache = undefined
        return result
      },
      async suggestions(input, ctx): Promise<SearchSuggestion[]> {
        const keyword = input.trim()
        if (!keyword) return []
        const { session } = use(ctx)
        const answer = await session.get(`${HOST.search}/pc/suggest/v1`, {
          allowedRC: '1', src: 'mgtv', did: session.deviceID, pc: '10', q: keyword, _support: SUPPORT,
        }, ctx.signal)
        return list(answer?.data?.suggest).flatMap((entry) => {
          const title = text(entry?.title)
          if (!title) return []
          const suggestion: SearchSuggestion = { keyword: title }
          const tag = text(entry.clipTag)
          const detail = text(entry.subtitle)
          if (tag) suggestion.tag = tag
          if (detail) suggestion.detail = detail
          return [suggestion]
        })
      },
      async search(input, ctx): Promise<SearchResults> {
        const keyword = input.trim()
        if (!keyword) return { shows: [], videos: [] }
        const { session } = use(ctx)
        const answer = await session.get(`${HOST.search}/pc/search/v2`, signedQuery({
          allowedRC: '1', _support: SUPPORT, src: 'mgtv', did: session.deviceID, timestamp: timestamp(), signVersion: '1',
          signNonce: randomUUID().replaceAll('-', ''), q: keyword, pn: '1', pc: String(SEARCH_PAGE), corr: '1',
          uid: session.uuid ?? '',
        }), ctx.signal)
        if (int(answer?.code) !== 200) throw apiError(answer, '搜索失败')
        return searchResults(answer.data?.contents, keyword)
      },
    },

    detail: {
      detail: (target, ctx) => detail(ctx, target),
      async episodes(cursor, ctx) {
        const parsed = parseEpisodesCursor(cursor)
        if (!parsed) throw notFound('选集')
        return episodes(ctx, parsed.clip, parsed.page, parsed.type)
      },
      async resume(show, video, ctx) {
        const clip = show ? parseID(show) : undefined
        const vid = video ? parseID(video) : undefined
        const records = await recentRecords(ctx)
        const record = clip?.kind === 'clip'
          ? records.find((r) => idOf(r?.pid) === clip.id)
          : vid?.kind === 'video' ? records.find((r) => idOf(r?.vid) === vid.id) : undefined
        return record ? resumeOf(record) : null
      },
    },

    comments: {
      async first(video, sort, ctx) {
        const id = parseID(video)
        if (!id) throw notFound('视频')
        return commentPage(ctx, { kind: 'comments', subject: id.id, hot: sort === 'hot', page: 1 })
      },
      async page(cursor, ctx) {
        let parsed: CommentCursor
        try {
          parsed = JSON.parse(cursor)
        } catch {
          throw new SourceError('bad_request', '评论游标不对')
        }
        if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.page !== 'number') throw new SourceError('bad_request', '评论游标不对')
        return commentPage(ctx, parsed)
      },
    },

    danmaku: {
      segmentDuration: 60,
      segment: (video, segment, ctx) => danmakuSegment(ctx, video, segment),
    },

    history: {
      async page(page, ctx): Promise<HistoryPage> {
        const state = use(ctx)
        let before: string | undefined
        if (page > 1) {
          before = state.historyCursors.get(page)
          if (!before) return { items: [], hasMore: false }
        }
        const data = await historyPage(ctx, before, HISTORY_PAGE)
        const items = list(data.playList).map(historyItem).filter((item) => item !== undefined)
        const hasMore = int(data.hasNext) === 1 && items.length > 0
        const last = idOf(data.lastRecondTime)
        if (hasMore && last) state.historyCursors.set(page + 1, last)
        return { items, hasMore: hasMore && Boolean(last) }
      },
      /** `playHistory/v2/delete`（个人中心的表单 POST）：按记录的 `playId`，多条用逗号拼。 */
      async delete(keys, ctx) {
        const ids = keys.filter(Boolean)
        if (ids.length === 0) return
        await historyPost(ctx, '/playHistory/v2/delete', { playId: ids.join(',') })
      },
      async clear(ctx) {
        await historyPost(ctx, '/playHistory/v2/clear', {})
      },
    },

    links: {
      patterns: ['^https?://([a-z0-9-]+\\.)*mgtv\\.com/[bh]/\\d+'],
      async resolve(url) {
        return linkTarget(url)
      },
    },

    playback: { resolve, progress },
  }
}

export { MgtvSession } from './api.ts'
