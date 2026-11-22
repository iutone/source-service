// 详情：Columbus 网关 `ms_codes=2019030100`（docs/youku-web/DETAIL.md）；评论：讨论区 `ycp.query` 按页、回复
// `ycp.comment.detailpage.module.get`（DETAIL.md §5.7）。照 App 的 YoukuDetailService / YoukuDetailParser / YoukuComments 移植。
import type { Comment, CommentPage, CommentSort, Credit, Episode, EpisodeList, EpisodeRange, MediaItem, Rating, RecommendationTab, Recommendations, ShowDetail, ShowPart, Stats, Target, Uploader } from '@iyt-source/protocol'
import { SourceError, badRequest } from '@iyt-source/kit'
import { emotesIn } from './emotes.ts'
import { componentsByTypeName, cardItem, mediaTarget, badge, nodes } from './feed.ts'
import { arr, bool, compact, int, isNull, num, sortedJSON, text, webImage, type J } from './json.ts'
import { APP_KEY, md5, type MTOPClient } from './mtop.ts'

export const DETAIL_MS_CODE = '2019030100'

const C = {
  intro: 'PC播放页kuflix简介组件',
  introMeta: '简介节目元数据',
  shortIntro: 'kuflix短简介组件',
  reasons: '播放页推荐理由组件',
  credits: '播放页演职员卡片',
  episodes: 'Web播放页选集组件',
  movieSeries: '播放页电影系列组件',
  recommendations: '播放页推荐组件',
  /** UP 主（PUGV）视频的页面：这个 UP 主的视频，新的在前。 */
  uploads: 'up主视频',
  /** UP 主视频的页面：谁发的。 */
  follow: '[播放页]kuflix关注组件',
}

/** 评分来源只能靠图标区分（DETAIL.md §5.1）。 */
const RATING_ICONS: Record<string, Rating['source']> = {
  '3672e11b3be367f74aa996a90a690c58': 'platform',
  '4f0b7036130ca8ed3a4953939002ac4a': 'douban',
}
/** 「UP 主视频」往后翻几页去找正在看的那个；更早的视频停在第一页。 */
const MAX_UPLOAD_PAGES = 5

// MARK: 解析

/** `root` 是 `scene=web_page` 响应的 `data["2019030100"].data`。 */
export function parseDetail(root: J, uploads?: EpisodeList): ShowDetail {
  const extra = root?.data?.extra ?? {}
  // UP 主视频不属于任何节目：没有 `showId` / `show*`，只有 `video*`。
  const showID = text(extra.showId)
  if (!showID && !text(extra.videoId)) throw new SourceError('upstream_changed', '优酷的详情里没有节目 id')
  const components = componentsByTypeName(root)
  const meta = nodes(components.get(C.intro)).find((n) => n?.typeName === C.introMeta)?.data ?? {}
  const reasonInfo = reasons(components.get(C.reasons))
  const episodesComponent = components.get(C.episodes)
  const recommendationsComponent = components.get(C.recommendations)
  const videoID = text(extra.videoId)
  return compact({
    showID,
    title: text(meta.introTitle) ?? text(extra.showName) ?? text(extra.videoTitle) ?? '',
    tagline: text(extra.showSubtitle),
    shortSummary: text(nodes(components.get(C.shortIntro))[0]?.data?.shortDesc),
    summary: text(meta.desc),
    attributes: text(meta.introSubTitle),
    category: text(extra.showCategory) ?? text(extra.videoCategory),
    posterURL: webImage(meta.showImgV ?? extra.showImgV ?? extra.videoImgV),
    landscapeURL: webImage(extra.showImg ?? extra.videoImg),
    badge: badge(meta),
    updateInfo: text(meta.updateInfo),
    heat: int(meta.heat) ?? reasonInfo.heat,
    ratings: reasonInfo.ratings,
    tags: reasonInfo.tags,
    isPaid: bool(extra.paid) ?? false,
    credits: credits(components.get(C.credits)),
    defaultVideoID: videoID,
    episodes: episodesComponent ? episodeList(episodesComponent, showID) : undefined,
    series: nodes(components.get(C.movieSeries)).map(cardItem).filter((x): x is MediaItem => Boolean(x)),
    recommendations: recommendationsComponent ? recommendations(recommendationsComponent, showID) : { tabs: [], items: [] },
    uploads: uploads ?? (videoID ? uploadsIn(root, videoID) : undefined),
    uploader: showID ? undefined : uploader(components.get(C.follow)),
    stats: stats(extra),
    publishedAt: showID ? undefined : beijingTime(text(extra.videoPublishTime)),
    duration: showID ? undefined : num(extra.duration),
  })
}

/** UP 主视频的「关注」：名字、头像、id，粉丝数在类型为 `FOLLOW` 的副标题里（「3.4万粉丝」）。 */
function uploader(component: J): Uploader | undefined {
  const data = nodes(component)[0]?.data
  const name = text(data?.title)
  if (!name) return undefined
  const followers = text(arr(data.subtitles).find((s: J) => s?.subtitleType === 'FOLLOW')?.subtitle)
  return compact({ id: text(data.ownerUid) ?? name, name, avatarURL: webImage(data.img), followers: followers ? countOf(followers) : undefined })
}

/** 点赞（`totalUp`）和评论（`totalComment`）；优酷不给播放数。 */
function stats(extra: J): Stats | undefined {
  const likes = int(extra.totalUp)
  const replies = int(extra.totalComment)
  if (likes === undefined && replies === undefined) return undefined
  return compact({ likes, replies })
}

/** 优酷写法的数字开头：「3.4万粉丝」→ 34000，「1.2亿」→ 120000000，「865」→ 865。 */
export function countOf(value: string): number | undefined {
  const match = /^([0-9.]+)(万|亿)?/.exec(value)
  if (!match) return undefined
  const n = Number(match[1])
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * (match[2] === '万' ? 10_000 : match[2] === '亿' ? 100_000_000 : 1))
}

/** 「2026-10-09 10:44:18」，北京时间。 */
export function beijingTime(value: string | undefined): string | undefined {
  const match = value && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s)).toISOString()
}

/** 「推荐理由」：热度，带来源图标的评分，然后是榜单和类型标签。 */
function reasons(component: J): { heat?: number; ratings: Rating[]; tags: string[] } {
  let heat: number | undefined
  const ratings: Rating[] = []
  const tags: string[] = []
  for (const node of nodes(component)) {
    const data = node?.data
    const title = text(data?.title)
    if (!title) continue
    const icon = text(data.icon)
    if (icon && title.endsWith('分')) {
      const source = Object.entries(RATING_ICONS).find(([key]) => icon.includes(key))?.[1] ?? 'unknown'
      ratings.push({ source, score: title.slice(0, -1) })
    } else if (isNull(data.icon) && heat === undefined && ratings.length === 0 && tags.length === 0 && /^\d+$/.test(title)) {
      heat = Number(title)
    } else {
      tags.push(title)
    }
  }
  return { heat, ratings, tags }
}

function credits(component: J): Credit[] {
  return nodes(component).map((node): Credit | undefined => {
    const data = node?.data
    const name = text(data?.title)
    if (!name) return undefined
    return compact({ id: text(data.personId) ?? name, name, role: text(data.subtitle), avatarURL: webImage(data.img) })
  }).filter((x): x is Credit => Boolean(x))
}

/**
 * 「选集」：一个区间的剧集。`stageTabs` 按集数分页（`NUMBER`：1-60、61-120）或按类型分（`FILTER`：正片 / 人物解读）
 * （DETAIL.md §3.3、§3.4）。
 */
export function episodeList(component: J, showID: string | undefined): EpisodeList {
  const data = component?.data ?? {}
  const session = text(data.session)
  const episodes: Episode[] = []
  for (const node of nodes(component)) {
    const item = node?.data
    const target = mediaTarget(item)
    if (!target || !('video' in target)) continue
    const kind = text(item.videoType)
    episodes.push(compact({
      id: target.video,
      title: text(item.title) ?? target.video,
      stage: text(item.stage) ?? '',
      isFeature: bool(item?.episodeInfo?.isZp) ?? kind === '正片',
      kind,
      imageURL: webImage(item.img),
      isPaid: bool(item.paid) ?? false,
      badge: badge(item),
    }))
  }
  let selected: EpisodeRange | undefined
  const ranges: EpisodeRange[] = []
  for (const tab of arr(data.stageTabs)) {
    const paging: Record<string, unknown> = {}
    for (const key of ['itemStartStage', 'itemEndStage', 'filterId']) if (!isNull(tab?.[key])) paging[key] = tab[key]
    const title = text(tab?.title)
    const cursor = title && Object.keys(paging).length ? componentCursor(showID, session, paging) : undefined
    if (!title || !cursor) continue
    const range = { title, cursor }
    if (bool(tab.selected) === true) selected = range
    ranges.push(range)
  }
  // `series`：多部分的节目（「呼伦贝尔篇」/「吉林篇」），每部分是单独的节目。
  const parts: ShowPart[] = []
  for (const part of arr(data.series)) {
    const id = text(part?.showId)
    const title = text(part?.title)
    if (id && title) parts.push({ id, title, isCurrent: bool(part.current) ?? id === showID })
  }
  return compact({
    episodes,
    ranges: ranges.length ? ranges : undefined,
    selectedRange: selected,
    summary: text(data.moreText) ?? text(data.subtitle),
    parts: parts.length > 1 ? parts : undefined,
  })
}

/** 「为你推荐」，加上每个主演一个 tab（DETAIL.md §5.3）。 */
export function recommendations(component: J, showID: string | undefined): Recommendations {
  const data = component?.data ?? {}
  const session = text(data.session)
  const tabs: RecommendationTab[] = []
  for (const tab of arr(data.tabs)) {
    const title = text(tab?.title)
    if (!title) continue
    let cursor: string | undefined
    if (!isNull(tab.personId)) {
      cursor = componentCursor(showID, session, { star_id: tab.personId })
      if (!cursor) continue
    }
    tabs.push(compact({ title, imageURL: webImage(tab.img), cursor }))
  }
  return { tabs, items: nodes(component).map(cardItem).filter((x): x is MediaItem => Boolean(x)) }
}

// MARK: UP 主视频

/**
 * 「UP 主视频」的第一页。这个组件没有自己的 `session`：它的页用兄弟组件的 session 改指向它（`id`、`index`）再加
 * `lastPageNo` 来请求。
 */
export function uploadsIn(root: J, videoID: string): EpisodeList | undefined {
  for (const module of nodes(root)) {
    const siblings = nodes(module)
    const index = siblings.findIndex((s) => s?.typeName === C.uploads)
    if (index < 0 || isNull(siblings[index]?.id)) continue
    const raw = siblings.map((s) => text(s?.data?.session)).find(Boolean)
    if (!raw) return undefined
    let session: Record<string, unknown>
    try {
      session = JSON.parse(raw)
    } catch {
      return undefined
    }
    for (const key of ['lastSubId', 'lastSubIndex', 'scmC', 'spmC']) delete session[key]
    session.id = siblings[index].id
    session.index = index + 1
    return uploadsPage(siblings[index], videoID, session, 1)
  }
  return undefined
}

/** 「UP 主视频」的一页（从 1 起）。`more` 总是 true，所以有条目的页后面总有下一页。 */
export function uploadsPage(component: J, videoID: string, session: Record<string, unknown>, page: number): EpisodeList {
  const episodes: Episode[] = []
  for (const node of nodes(component)) {
    const item = node?.data
    const target = mediaTarget(item)
    const title = text(item?.title)
    if (!target || !('video' in target) || !title) continue
    episodes.push(compact({ id: target.video, title, stage: '', isFeature: true, imageURL: webImage(item.img), isPaid: false }))
  }
  const pages = episodes.length ? page + 1 : page
  const ranges: EpisodeRange[] = []
  for (let number = 1; number <= pages; number++) {
    ranges.push({ title: `第${number}页`, cursor: cursorFor({ videoId: videoID }, { ...session, lastPageNo: number - 1 }) })
  }
  return { episodes, ranges, selectedRange: ranges[page - 1] }
}

// MARK: 游标

/** 组件请求：`scene=component`，带组件的 `session` 加翻页键。 */
export function componentCursor(showID: string | undefined, session: string | undefined, fields: Record<string, unknown>): string | undefined {
  if (!showID || !session) return undefined
  let object: Record<string, unknown>
  try {
    object = JSON.parse(session)
  } catch {
    return undefined
  }
  if (!object || typeof object !== 'object') return undefined
  return cursorFor({ showId: showID }, { ...object, ...fields })
}

function cursorFor(target: Record<string, string>, session: Record<string, unknown>): string {
  return sortedJSON({ ...target, nextSession: sortedJSON(session) })
}

/** 区间的翻页键（起止集数、类型），用来认出同一个区间。 */
function pagingKey(session: string | undefined): string {
  try {
    const object = JSON.parse(session ?? '')
    return JSON.stringify([object?.itemStartStage, object?.itemEndStage, object?.filterId])
  } catch {
    return ''
  }
}

export function decodeComponentCursor(raw: string): { showID?: string; videoID?: string; nextSession: string } | undefined {
  try {
    const object = JSON.parse(raw)
    const showID = text(object?.showId)
    const videoID = text(object?.videoId)
    const nextSession = text(object?.nextSession)
    if ((!showID && !videoID) || !nextSession) return undefined
    return { showID, videoID, nextSession }
  } catch {
    return undefined
  }
}

// MARK: 评论

interface CommentCursor {
  kind: 'comments' | 'replies'
  /** 评论：视频；回复：评论。 */
  id: string
  /** 回复：评论所在的视频。 */
  video?: string
  /** 评论：101 最热，102 最新。 */
  tab?: number
  page: number
}

const COMMENT_MS_CODE = '2019061000'
const COMMENTS_PAGE_SIZE = 20
const REPLIES_PAGE_SIZE = 20
/** 文字（3200）和图片（3201）评论；网页不显示投票（3217）等卡片。 */
const COMMENT_TYPES = new Set([3200, 3201])

function commentFrom(data: J, videoID: string, repliesTo?: string): Comment {
  const publisher = data?.publisher ?? {}
  const content = data?.content ?? {}
  const interact = data?.interact ?? {}
  const id = text(data?.commentId) ?? text(content.targetId) ?? ''
  const body = typeof content.text === 'string' ? content.text : ''
  const replyCount = int(interact.replyCount) ?? 0
  // 普通用户的 `identity.title` 是自我介绍；明星和主创有身份类型。
  const identity = publisher.identity ?? {}
  const hasRole = Boolean(text(identity?.type3?.name) ?? text(identity?.type?.name))
  const created = num(content.gmtCreate)
  const pictures = [...arr(content.imgs).map((i: J) => webImage(i?.imgUrl)), webImage(content?.pasterAttr?.pasterImgUrl)].filter((x): x is string => Boolean(x))
  return compact({
    id,
    author: compact({ name: text(publisher.nickName) ?? '优酷用户', avatarURL: webImage(publisher.headPicUrl), role: hasRole ? text(identity.title) : undefined }),
    text: body,
    emotes: emotesIn(body),
    pictures: pictures.length ? pictures : undefined,
    date: created !== undefined ? new Date(created).toISOString() : undefined,
    location: text(content.publishIpArea),
    likes: int(interact.likeCount) ?? 0,
    replyCount,
    replies: replyCount > 0 ? JSON.stringify({ kind: 'replies', id, video: videoID, page: 1 } satisfies CommentCursor) : undefined,
    repliesTo,
  })
}

// MARK: 服务

export class YoukuDetail {
  private readonly client: MTOPClient
  private readonly utdid: () => Promise<string>

  constructor(client: MTOPClient, utdid: () => Promise<string>) {
    this.client = client
    this.utdid = utdid
  }

  async detail(target: Target, signal?: AbortSignal): Promise<ShowDetail> {
    if ('show' in target) return parseDetail(await this.request({ showID: target.show }, signal))
    const root = await this.request({ videoID: target.video }, signal)
    let uploads = uploadsIn(root, target.video)
    if (uploads) uploads = await this.locate(target.video, uploads, signal)
    return parseDetail(root, uploads)
  }

  async episodes(cursor: string, signal?: AbortSignal): Promise<EpisodeList> {
    const decoded = decodeComponentCursor(cursor)
    if (!decoded) throw badRequest('选集的翻页参数不对')
    const root = await this.request({ showID: decoded.showID, videoID: decoded.videoID, scene: 'component', nextSession: decoded.nextSession }, signal)
    if (decoded.videoID && root?.typeName === C.uploads) {
      let session: Record<string, unknown> = {}
      try { session = JSON.parse(decoded.nextSession) } catch { /* 空 */ }
      const page = (int(session.lastPageNo) ?? 0) + 1
      return uploadsPage(root, decoded.videoID, session, page)
    }
    const page = episodeList(root, decoded.showID)
    // 组件的响应总把节目默认的区间标成选中；选中的是请求的这个（按区间的翻页键认）。
    const requested = pagingKey(decoded.nextSession)
    const selected = page.ranges?.find((r) => pagingKey(decodeComponentCursor(r.cursor)?.nextSession) === requested)
    return compact({ ...page, selectedRange: selected ?? page.selectedRange })
  }

  async recommendations(cursor: string, signal?: AbortSignal): Promise<MediaItem[]> {
    const decoded = decodeComponentCursor(cursor)
    if (!decoded) return []
    const root = await this.request({ showID: decoded.showID, videoID: decoded.videoID, scene: 'component', nextSession: decoded.nextSession }, signal)
    return recommendations(root, decoded.showID).items
  }

  /** 「UP 主视频」里正在看的那一页，找不到就第一页。出错保留第一页。 */
  private async locate(videoID: string, first: EpisodeList, signal?: AbortSignal): Promise<EpisodeList> {
    let page = first
    for (let i = 1; i < MAX_UPLOAD_PAGES; i++) {
      if (page.episodes.some((e) => e.id === videoID) || page.episodes.length === 0 || !page.selectedRange || !page.ranges) break
      const index = page.ranges.findIndex((r) => r.cursor === page.selectedRange!.cursor)
      if (index < 0 || index + 1 >= page.ranges.length) break
      try {
        page = await this.episodes(page.ranges[index + 1].cursor, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        break
      }
    }
    return page.episodes.some((e) => e.id === videoID) ? page : first
  }

  /** 返回 `data["2019030100"].data`；`scene=component` 时就是组件本身。 */
  private async request(options: { showID?: string; videoID?: string; scene?: string; nextSession?: string }, signal?: AbortSignal): Promise<J> {
    const params: Record<string, unknown> = {
      biz: 'kuflix_pc_detail', scene: options.scene ?? 'web_page', componentVersion: '3', ip: '127.0.0.1', debug: 0, utdid: await this.utdid(),
      platform: 'pc', nextSession: options.nextSession ?? '', gray: 0, appPackageKey: 'pcweb',
    }
    if (options.showID) params.showId = options.showID
    if (options.videoID) params.videoId = options.videoID
    const system = { appPackageKey: 'pcweb', appPackageId: 'pcweb', appkey: APP_KEY, device: 'pc', os: 'pc', ver: '1.0.0' }
    const data = await this.client.call('mtop.youku.columbus.gateway.new.execute', '1.0', {
      ms_codes: DETAIL_MS_CODE, params: sortedJSON(params), system_info: sortedJSON(system),
    }, { signal })
    const root = data?.[DETAIL_MS_CODE]?.data
    if (isNull(root)) throw new SourceError('not_found', '优酷没有这个节目或视频')
    return root
  }

  // MARK: 评论

  async comments(video: string, sort: CommentSort, signal?: AbortSignal): Promise<CommentPage> {
    return this.commentPage({ kind: 'comments', id: video, tab: sort === 'hot' ? 101 : 102, page: 1 }, signal)
  }

  async commentsAt(raw: string, signal?: AbortSignal): Promise<CommentPage> {
    let cursor: CommentCursor
    try {
      cursor = JSON.parse(raw)
    } catch {
      throw badRequest('评论的翻页参数不对')
    }
    if (!cursor?.id || !cursor.page) throw badRequest('评论的翻页参数不对')
    return cursor.kind === 'replies' ? this.replyPage(cursor, signal) : this.commentPage(cursor, signal)
  }

  /** 一页评论：`FEED_DRAWER_PAGINATION` 的条目，去掉投票等不是评论的卡片。 */
  private async commentPage(cursor: CommentCursor, signal?: AbortSignal): Promise<CommentPage> {
    const params = {
      bizKey: 'ycp', nodeKey: 'MAINPAGEPC_SUBPAGE', app: '5200-C2cNqy93', objectType: 1, objectCode: cursor.id, page: cursor.page,
      pageSize: COMMENTS_PAGE_SIZE, time: Date.now(), utdid: await this.utdid(), gray: 0, tabCode: cursor.tab ?? 101,
    }
    const system = { appPackageKey: 'pcweb', appPackageId: 'pcweb', appkey: APP_KEY, device: 'pc', os: 'pc', ver: '1.0.0' }
    const data = await this.client.call('mtop.youku.columbus.ycp.query', '1.0', {
      ms_codes: COMMENT_MS_CODE, params: sortedJSON(params), system_info: sortedJSON(system),
    }, { signal })
    const modules = arr(arr(data?.[COMMENT_MS_CODE]?.data?.nodes)[0]?.nodes)
    const feed = modules.find((m: J) => m?.typeName === 'FEED_DRAWER_PAGINATION')
    // 过了最后一页这个模块就没了；第一页就没有它是没有评论。
    if (!feed) return { comments: [], next: null, total: cursor.page === 1 ? 0 : undefined }
    const comments: Comment[] = []
    for (const item of arr(feed.nodes)) {
      const node = arr(item?.nodes)[0]
      if (node && COMMENT_TYPES.has(int(node.type) ?? 0)) comments.push(commentFrom(node.data, cursor.id))
    }
    const hasMore = bool(feed.more) ?? false
    return compact({
      comments,
      next: hasMore ? JSON.stringify({ ...cursor, page: cursor.page + 1 }) : null,
      total: int(feed?.data?.commentCount),
    })
  }

  /**
   * 一条评论下的一页回复。第 1 页是前 `limit` 条，第 2 页跳过前两条（网页「展开」先给两条再给八条）；从第 3 页起，
   * 第 `p` 页是 `[(p - 2)·limit, (p - 1)·limit)`。
   */
  private async replyPage(cursor: CommentCursor, signal?: AbortSignal): Promise<CommentPage> {
    const app = '100-DDwODVkv'
    const time = Date.now()
    const sign = md5(`${app}&6c4aa6af6560efff5df3c16c704b49f1&${time}`)
    const data = await this.client.call('mtop.youku.ycp.comment.detailpage.module.get', '1.0', {
      app, time, objectCode: cursor.video ?? '', objectType: 1, dataSource: 'COMMENT_REPLY_LIST_DATASOURCE', page: cursor.page,
      limit: REPLIES_PAGE_SIZE, lastId: false, bizParam: JSON.stringify({ commentId: Number(cursor.id) || 0 }), sign,
    }, { signal })
    const list = arr(data?.data?.nodes)
    const replies = list.map((node: J) => {
      // 每条回复都写着上级；只有回复别人的回复时才说回复的是谁。
      const parent = node?.parentComment
      const answers = text(parent?.commentId) !== cursor.id ? text(parent?.publisher?.nickName) : undefined
      return commentFrom(node, cursor.video ?? '', answers)
    })
    const total = int(data?.data?.totalCount) ?? 0
    // `hasMore` 总是 false：满一页且没到总数就还有。
    const fetched = cursor.page === 1 ? REPLIES_PAGE_SIZE : (cursor.page - 1) * REPLIES_PAGE_SIZE
    const hasMore = list.length >= REPLIES_PAGE_SIZE && fetched < total
    return { comments: replies, next: hasMore ? JSON.stringify({ ...cursor, page: cursor.page === 1 ? 3 : cursor.page + 1 }) : null, total }
  }
}
