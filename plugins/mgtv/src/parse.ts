// 芒果TV 响应 → 协议模型（纯函数，单元测试用 test/fixtures 里抓的样本）。照 App 的 Mgtv 各服务里的解析移植。
import type {
  Badge, Comment, Danmaku, Episode, EpisodeList, EpisodeRange, FeedSection, Markers, MediaItem, SearchResults,
  SearchTopMatch, ShowDetail, ShowPart, VideoItem,
} from '@iyt-source/protocol'
import { clipID, idOf, image, int, list, num, pageIDs, text, videoID } from './api.ts'

/** 网站的角标：VIP / 会员 / 付费 金色，独播 / HOT 红色，预告 蓝色。 */
export function badge(value: unknown): Badge | undefined {
  const label = text(value)
  if (!label) return undefined
  if (label.includes('VIP') || label.includes('会员') || label.includes('付费')) return { text: label, tone: 'gold' }
  if (label === '预告' || label === '预约') return { text: label, tone: 'blue' }
  if (['独播', 'HOT', '热播', '自制'].includes(label)) return { text: label, tone: 'red' }
  return { text: label, tone: 'neutral' }
}

/** 去掉 undefined 的字段，JSON 干净些。 */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key]
  return value
}

// MARK: 频道

/** 不是节目卡片的模块：广告、导航、搜索入口、无尽推荐流、文字链、预约。 */
export const SKIPPED_MODULES = new Set([
  't-topAdbu', 't-nav-lv1', 't-search', 't-newfeed', 't-followinghot', 't-acrossreserve', 't-bannerAd',
  't-carouselAd', 't-hottag', 't-newsbigtitle',
])

/** 一张频道卡片：节目（`jumpKind` 1）或节目里的一个视频（12）。网页链接（4）、互动视频（28）等丢弃。 */
export function cardItem(card: any): MediaItem | undefined {
  const kind = int(card?.jumpKind)
  const clip = idOf(card?.jumpId)
  const title = text(card?.name)
  if (kind === undefined || !clip || !title) return undefined
  const video = idOf(card.childId) ?? idOf(card.videoId)
  let target: MediaItem['target']
  if (kind === 1) target = { show: clipID(clip) }
  else if (kind === 12) target = video ? { video: videoID(video) } : { show: clipID(clip) }
  else return undefined
  return compact({
    id: 'show' in target ? target.show : target.video,
    title,
    subtitle: text(card.subName),
    posterURL: image(card.imageV),
    landscapeURL: image(card.imageH),
    badge: badge(card.cornerType?.cornerTitle),
    caption: text(card.updateInfo),
    target,
  })
}

/** 一个模块的卡片：焦点图是 `hero`；有竖图的多是竖版海报行，否则横图行。 */
export function moduleSection(module: any, type: string, channel: string): FeedSection | undefined {
  let title = text(module?.moduleTitle)
  const items: MediaItem[] = []
  for (const dsl of list(module?.DSLList)) {
    const data = dsl?.data ?? {}
    title ??= text(data.title)
    for (const card of list(data.items)) {
      const item = cardItem(card)
      if (item) items.push(item)
    }
  }
  if (items.length === 0) return undefined
  const portraits = items.filter((item) => item.posterURL).length
  const style: FeedSection['style'] = type === 't-focus' ? 'hero' : portraits * 2 >= items.length ? 'row' : 'shortVideo'
  return compact({
    id: `${channel}:${text(module.moduleEntityId) ?? type}`,
    title: style === 'hero' ? undefined : title ?? '推荐',
    style,
    items,
  })
}

/** 片库（`rider/list`）的一条。 */
export function libraryItem(entry: any): MediaItem | undefined {
  const clip = idOf(entry?.clipId)
  const title = text(entry?.title)
  if (!clip || !title) return undefined
  const score = num(entry.zhihuScore)
  return compact({
    id: clipID(clip),
    title,
    subtitle: text(entry.subtitle),
    posterURL: image(entry.img),
    landscapeURL: image(entry.imgUrlH),
    badge: badge(entry.rightCorner?.text),
    caption: text(entry.updateInfo) ?? (score !== undefined && score > 0 ? `${score.toFixed(1)}分` : undefined),
    target: { show: clipID(clip) },
  })
}

// MARK: 详情

/** `fstlvlTypeId`：1 综艺，2 电视剧，3 电影。 */
export const VARIETY = 1
export const SERIES = 2
export const FILM = 3

/** `vod/info` 的 data → 详情（分集、推荐另给）。 */
export function showDetail(data: any, clip: string): ShowDetail {
  const info = data?.info ?? {}
  const show = info.clip ?? {}
  const clipInfo = list(data?.template?.modules).find((module) => int(module?.dataType) === 101)?.clipInfo ?? {}
  const labels = list(clipInfo.detail)
  const fonts = (types: number[]) => labels.filter((label) => types.includes(int(label?.type) ?? -1)).map((label) => text(label.font)).filter((v): v is string => Boolean(v))
  const category = fonts([8])[0]
  const year = text(clipInfo.releaseTime)?.slice(0, 4)
  const genres = fonts([5])
  const attributes = [text(clipInfo.area), year, genres[0] ?? text(show.kind)].filter(Boolean).join('·')
  const count = int(show.serialCount) ?? 0
  const summary = text(clipInfo.intro) ?? text(show.story)
  return compact({
    showID: clipID(clip),
    title: text(show.clipName) ?? text(info.video?.partName) ?? '',
    shortSummary: summary,
    summary,
    attributes: attributes || undefined,
    category,
    posterURL: image(show.vImgUrl),
    landscapeURL: image(show.hImgUrl),
    updateInfo: count > 1 && int(info.fstlvlTypeId) === SERIES ? `共${count}集` : undefined,
    ratings: [],
    tags: [...fonts([0]), ...genres],
    isPaid: int(info.pay) !== undefined ? int(info.pay) !== 0 : false,
    credits: fonts([4]).map((name) => ({ id: name, name })),
    series: [],
    recommendations: { tabs: [], items: [] },
  })
}

/** 分集页游标：`ep:<clipId>:<页>[:<fstlvlTypeId>]`。 */
export function episodesCursor(clip: string, page: number, type?: number): string {
  return type === undefined ? `ep:${clip}:${page}` : `ep:${clip}:${page}:${type}`
}

export function parseEpisodesCursor(cursor: string): { clip: string; page: number; type?: number } | undefined {
  const match = /^ep:(\d+):(\d+)(?::(\d+))?$/.exec(cursor)
  if (!match) return undefined
  return { clip: match[1], page: Number(match[2]), type: match[3] === undefined ? undefined : Number(match[3]) }
}

/** `vod/video/positives` 的 data：有多个筛选（正片 / 衍生）时取第一个；每 60 集一个区间；多季 / 年份是 parts。 */
export function episodeList(data: any, clip: string, page: number, type: number | undefined): EpisodeList {
  const filters = list(data?.filters)
  const entries = filters.length > 0 ? list(filters[0]?.list) : list(data?.list)
  const episodes = entries.map((entry) => episode(entry, type === VARIETY)).filter((e): e is Episode => Boolean(e))
  const pages = int(data?.page?.pageTotal) ?? 1
  const size = int(data?.page?.pageSize) ?? 60
  const total = int(data?.page?.total) ?? episodes.length
  const ranges: EpisodeRange[] = []
  if (pages > 1) {
    for (let number = 1; number <= pages; number++) {
      ranges.push({ title: `${(number - 1) * size + 1}-${Math.min(number * size, total)}`, cursor: episodesCursor(clip, number, type) })
    }
  }
  const tabs = list(data?.tabs)
  const parts: ShowPart[] = tabs.length > 1
    ? tabs.flatMap((tab) => {
        const id = idOf(tab?.tabId)
        const title = text(tab?.name)
        return id && title ? [{ id: clipID(id), title, isCurrent: id === clip }] : []
      })
    : []
  return compact({
    episodes,
    ranges: ranges.length ? ranges : undefined,
    selectedRange: ranges[page - 1],
    parts: parts.length ? parts : undefined,
  })
}

export function episode(entry: any, isVariety: boolean): Episode | undefined {
  const vid = idOf(entry?.videoId)
  if (!vid) return undefined
  const prefix = text(entry.detailTitle?.prefix)
  const title = text(entry.detailTitle?.title) ?? text(entry.title) ?? ''
  const rb = text(entry.rbTitle)
  const date = rb && /^\d{4}-\d{2}-\d{2}$/.test(rb) ? rb : undefined
  const vip = int(entry.vipMark) ?? 0
  const intact = int(entry.isIntact)
  return compact({
    id: videoID(vid),
    title,
    stage: (isVariety ? date : undefined) ?? prefix ?? text(entry.serialno) ?? title,
    isFeature: intact === undefined ? true : intact === 1,
    imageURL: image(entry.hImgUrl),
    isPaid: vip !== 0,
    badge: badge(entry.cornerLabelStyle?.font) ?? (vip !== 0 ? { text: 'VIP', tone: 'gold' as const } : undefined),
  })
}

/** 「看了还会看」（`rec/mix-feed`），去掉本节目和重复的。 */
export function recommendations(data: any, clip: string): MediaItem[] {
  const seen = new Set<string>()
  const items: MediaItem[] = []
  for (const entry of list(data?.list)) {
    const other = idOf(entry?.clipId)
    const title = text(entry?.title)
    if (!other || other === clip || !title || seen.has(other)) continue
    seen.add(other)
    items.push(compact({
      id: clipID(other), title, subtitle: text(entry.subTitle) ?? text(entry.story), posterURL: image(entry.vImgUrl),
      landscapeURL: image(entry.hImgUrl), caption: text(entry.rbTitle), target: { show: clipID(other) },
    }))
  }
  return items
}

// MARK: 评论

/** 评论或回复的翻页位置（不透明游标，JSON）。 */
export interface CommentCursor {
  kind: 'comments' | 'replies'
  /** 视频 id（`subjectId`）。 */
  subject: string
  hot: boolean
  page: number
  /** 回复所属的评论。 */
  comment?: string
}

export const COMMENTS_PAGE = 15
export const REPLIES_PAGE = 20

export function comment(entry: any, subject: string, isReply: boolean): Comment | undefined {
  const id = idOf(entry?.commentId)
  if (!id) return undefined
  const user = entry.user ?? {}
  const body = [text(entry.title), text(entry.content)].filter(Boolean).join('\n')
  const replyCount = isReply ? 0 : int(entry.commentNum) ?? 0
  const previews = isReply ? [] : list(entry.replyList).map((reply) => comment(reply, subject, true)).filter((c): c is Comment => Boolean(c))
  const created = num(entry.createTime)
  const pictures = list(entry.images).map((picture) => image(picture?.big ?? picture?.small)).filter((u): u is string => Boolean(u))
  const cursor: CommentCursor = { kind: 'replies', subject, hot: false, page: 1, comment: id }
  return compact({
    id,
    author: compact({
      name: text(user.nickName) ?? '芒果TV用户',
      avatarURL: image(user.photo),
      role: int(entry.isAuthorReply) === 1 ? '作者' : undefined,
    }),
    text: body,
    pictures: pictures.length ? pictures : undefined,
    date: created !== undefined && created > 0 ? new Date(created * 1000).toISOString() : undefined,
    location: text(entry.area),
    likes: int(entry.praiseNum) ?? 0,
    replyCount: isReply ? undefined : replyCount,
    previewReplies: previews.length ? previews : undefined,
    replies: replyCount > 0 ? JSON.stringify(cursor) : undefined,
  })
}

// MARK: 弹幕

/** `time` 毫秒；`v2_position` 1 顶部，2 底部；颜色取（渐变的）左色。 */
export function danmaku(items: unknown): Danmaku[] {
  return list(items).flatMap((entry) => {
    const content = text(entry?.content)
    const time = num(entry?.time)
    if (!content || time === undefined) return []
    const position = int(entry.v2_position) === 1 ? 'top' : int(entry.v2_position) === 2 ? 'bottom' : 'scroll'
    return [{
      id: text(entry.ids) ?? idOf(entry.id) ?? `${time}-${content}`,
      time: time / 1000,
      text: content,
      position,
      color: color(entry.v2_color?.color_left),
    } satisfies Danmaku]
  })
}

export function color(rgb: any): string {
  const parts = [int(rgb?.r), int(rgb?.g), int(rgb?.b)]
  if (parts.some((v) => v === undefined || v < 0 || v > 255)) return '#FFFFFF'
  return `#${parts.map((v) => v!.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

// MARK: 观看历史

/** 历史里的一条（每个节目一条：最近看的那个视频和进度）。 */
export function historyItem(record: any): VideoItem | undefined {
  const vid = idOf(record?.vid)
  if (!vid) return undefined
  const fraction = historyProgress(record)
  const pid = idOf(record.pid)
  const show = pid && pid !== vid ? pid : undefined
  const updated = num(record.updateTime)
  return compact({
    id: videoID(vid),
    showID: show ? clipID(show) : undefined,
    title: text(record.pName) ?? text(record.vName) ?? '',
    subtitle: historyStage(record),
    coverURL: image(record.vImage) ?? image(record.pImage),
    posterURL: image(record.collVerImage) ?? image(record.verImage),
    progress: fraction,
    watchedPercent: fraction === undefined ? undefined : Math.round(fraction * 100),
    lastWatched: updated !== undefined && updated > 0 ? new Date(updated * 1000).toISOString() : undefined,
    historyKey: idOf(record.playId),
  })
}

export function historyProgress(record: any): number | undefined {
  if (int(record?.isEnd) === 1) return 1
  const duration = num(record?.duration) ?? 0
  const position = num(record?.watchTime) ?? 0
  return duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : undefined
}

/** 电视剧「第8集」，综艺是播出日期，电影没有。 */
export function historyStage(record: any): string | undefined {
  const serial = text(record?.serialno)
  if (!serial) return undefined
  const type = int(record.fstlvlType)
  if (type === 3) return undefined
  if (type === 2 && /^\d+$/.test(serial)) return `第${serial}集`
  return serial
}

// MARK: 搜索

/** 标题带 `<B>` 高亮。 */
export function plain(value: unknown): string | undefined {
  return text(text(value)?.replace(/<\/?[A-Za-z]+>/g, ''))
}

/** 节目来自芒果TV自己的来源（`sourceList[].source == "imgo"`），连同结果列出的几集。 */
export function searchShow(entry: any): { item: MediaItem; episodes: VideoItem[] } | undefined {
  const source = list(entry?.sourceList).find((s) => text(s?.source) === 'imgo')
  if (!source) return undefined
  const page = pageIDs(source.url) ?? list(source.videoList).map((v) => pageIDs(v?.url)).find(Boolean)
  const title = plain(entry.title ?? entry.hitTitle)
  if (!page || !title) return undefined
  const id = clipID(page.clip)
  const episodes = list(source.videoList).flatMap((video): VideoItem[] => {
    const vid = idOf(video?.vid) ?? pageIDs(video?.url)?.video
    if (!vid) return []
    return [compact({
      id: videoID(vid), showID: id, title: text(video.title) ?? title, subtitle: text(video.subtitle),
      coverURL: image(video.pic), badge: badge(video.rightCorner?.text),
    })]
  })
  const item = compact({
    id, title, subtitle: text(entry.story), posterURL: image(entry.pic), badge: badge(entry.rightTopCorner?.text),
    caption: text(entry.year), target: { show: id },
  })
  return { item, episodes }
}

function searchFacts(entry: any): string | undefined {
  const kind = text(list(entry?.desc).find((d) => text(d?.label) === '类型')?.text)
  return [kind, text(entry?.year)].filter(Boolean).join(' · ') || undefined
}

function searchCast(entry: any): string | undefined {
  const label = list(entry?.desc).find((d) => ['主演', '嘉宾', '主持人'].includes(text(d?.label) ?? ''))
  const names = text(label?.text)
  if (!names) return undefined
  const kind = text(label.label)
  return kind === '嘉宾' ? `嘉宾：${names}` : kind === '主持人' ? `主持人：${names}` : `主演：${names}`
}

/** `pc/search/v2` 的 `contents`：节目（每季 / 年一张）、电影、片段；外站（爱奇艺、腾讯）的丢弃。 */
export function searchResults(contents: unknown, keyword: string): SearchResults {
  const shows: MediaItem[] = []
  const videos: MediaItem[] = []
  let topMatch: SearchTopMatch | undefined
  const seen = new Set<string>()
  for (const content of list(contents)) {
    const data = content?.data ?? {}
    const type = text(content?.type)
    if (type === 'program' || type === 'serial' || type === 'movie') {
      const years = list(data.yearList)
      for (const entry of years.length ? years : [data]) {
        const hit = searchShow(entry)
        if (!hit || seen.has(hit.item.id)) continue
        seen.add(hit.item.id)
        if (!topMatch && plain(entry.title ?? entry.hitTitle) === keyword) {
          topMatch = compact({ show: hit.item, facts: searchFacts(entry), summary: text(entry.story), cast: searchCast(entry), episodes: hit.episodes })
        } else {
          shows.push(hit.item)
        }
      }
    } else if (type === 'video') {
      const rpt = text(data.rpt)
      if (rpt && !rpt.includes('source=imgo')) continue
      const vid = pageIDs(data.url)?.video
      const title = plain(data.title ?? data.hitTitle)
      if (!vid || !title || seen.has(videoID(vid))) continue
      seen.add(videoID(vid))
      videos.push(compact({ id: videoID(vid), title, subtitle: text(data.subTitle), landscapeURL: image(data.pic), target: { video: videoID(vid) } }))
    }
  }
  return compact({ topMatch, shows, videos })
}

// MARK: 播放

/** 网站给的档位：1 标清 … 4 蓝光 1080P；个别片有更高档，网站不展示。 */
export const MAX_DEFINITION = 4
const DEFINITION_HEIGHT: Record<number, number> = { 1: 480, 2: 576, 3: 720, 4: 1080 }

export function qualityLabel(rendition: any): string {
  return text(rendition?.standardName) ?? text(rendition?.name) ?? String(rendition?.definition ?? '')
}

/** 清晰度的像素高度：`standardName`（"1080P"），否则按档位。 */
export function qualityRank(rendition: any): number {
  const named = /^(\d{3,4})P/i.exec(text(rendition?.standardName) ?? '')
  if (named) return Number(named[1])
  return DEFINITION_HEIGHT[int(rendition?.definition) ?? 0] ?? (int(rendition?.definition) ?? 0) * 100
}

/** 锁住的档位：会员档写「VIP」，否则用网站的说法。 */
export function lockedReason(rendition: any): string {
  return int(rendition?.needPay) === 1 ? 'VIP' : text(rendition?.tips) ?? '不可用'
}

/** 付费片对这个账号只给试看时的原因（网站的试看结束文案）；能看完整版时为 undefined。 */
export function restriction(streamList: any): string | undefined {
  const info = streamList?.info ?? {}
  const paymark = int(info.paymark)
  if (!paymark) return undefined
  const isPreview = list(streamList.stream_domain).some((domain) => text(domain)?.includes('preview-disp'))
  if (!isPreview) return undefined
  const components = list(info.authInfo?.pay_info?.preview_end?.components)
  const title = text(components.find((c) => text(c?.code) === 'title')?.text) ?? components.map((c) => text(c?.text)).find(Boolean)
  return title?.replace('尊敬的用户，', '') ?? '该视频需要芒果TV会员'
}

/** `points.start` / `end`（"106|片头"）和看点 `content`（"781|…"，作为章节）。 */
export function markers(points: any): Markers | undefined {
  const seconds = (value: unknown) => {
    const first = text(value)?.split('|')[0]
    const n = first === undefined ? undefined : num(first)
    return n !== undefined && n > 0 ? n : undefined
  }
  const chapters = list(points?.content).flatMap((entry) => {
    const raw = text(entry)
    const bar = raw?.indexOf('|') ?? -1
    if (!raw || bar < 0) return []
    const start = num(raw.slice(0, bar))
    return start === undefined ? [] : [{ start, title: raw.slice(bar + 1) }]
  })
  const result = compact({
    introEnd: seconds(points?.start),
    outroStart: seconds(points?.end),
    chapters: chapters.length ? chapters : undefined,
  })
  return Object.keys(result).length ? result : undefined
}

/**
 * 每档一个流：会员有 H.265（fMP4）时先用它，再是 H.264（TS）。返回 定义档 → 选中的 rendition。
 * - Parameter hevc: 是否要 H.265 的档位。
 */
export function pickRenditions(streamList: any, hevc: boolean): Map<number, any> {
  const h265 = hevc ? list(streamList?.stream_h265) : []
  const renditions = [...(h265.some((r) => text(r?.url)) ? h265 : []), ...list(streamList?.stream)]
  const picked = new Map<number, any>()
  for (const rendition of renditions) {
    const definition = int(rendition?.definition)
    if (definition === undefined || definition > MAX_DEFINITION) continue
    const existing = picked.get(definition)
    if (existing && (text(existing.url) || !text(rendition.url))) continue
    picked.set(definition, rendition)
  }
  return picked
}
