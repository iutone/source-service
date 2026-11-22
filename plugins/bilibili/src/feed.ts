// 频道（照 App 的 BilibiliFeedService / BilibiliLibrary / BilibiliFilterService）：
// 关注（关注的 UP 主的投稿，首页）、推荐、热门是无尽的视频网格；排行榜是一组榜单（子频道）；番剧（含国创）、影视（电影 / 电视剧 /
// 纪录片）是一行行的季。没有频道墙（TV 上全是标签）。「我的」里有稍后再看、收藏夹、追番追剧、关注的 UP 主。
import type { Channel, Channels, FeedPage, FeedSection, FilterCategory, FilterDimension, FilterSelection, MediaItem, MediaItemPage, UploaderPage } from '@iyt-source/protocol'
import { notFound } from '@iyt-source/kit'
import { archiveItem, compact, dynamicItem, seasonItem, type BiliArchive, type BiliSeasonCard, type DynamicItem } from './models.ts'
import { image, type BiliSession } from './session.ts'
import { API } from './sign.ts'

export const PAGE_SIZE = 30

export const CHANNELS = {
  follow: { id: 'follow', title: '关注' },
  recommend: { id: 'recommend', title: '推荐' },
  popular: { id: 'popular', title: '热门' },
  ranking: { id: 'ranking', title: '排行榜' },
  bangumi: { id: 'bangumi', title: '番剧' },
  cinema: { id: 'cinema', title: '影视' },
} satisfies Record<string, Channel>

/** 排行榜的各个榜：投稿视频的分区榜（`rid`），再是 PGC 榜（`season_type`）。 */
export const RANKINGS: Channel[] = [
  ['rank:ugc:0', '全站'], ['rank:ugc:1', '动画'], ['rank:ugc:3', '音乐'], ['rank:ugc:129', '舞蹈'], ['rank:ugc:4', '游戏'],
  ['rank:ugc:36', '知识'], ['rank:ugc:188', '科技'], ['rank:ugc:234', '运动'], ['rank:ugc:223', '汽车'], ['rank:ugc:160', '生活'],
  ['rank:ugc:211', '美食'], ['rank:ugc:217', '动物圈'], ['rank:ugc:119', '鬼畜'], ['rank:ugc:155', '时尚'], ['rank:ugc:5', '娱乐'],
  ['rank:ugc:181', '影视'], ['rank:pgc:1', '番剧'], ['rank:pgc:4', '国创'], ['rank:pgc:3', '纪录片'], ['rank:pgc:2', '电影'],
  ['rank:pgc:5', '电视剧'],
].map(([id, title]) => ({ id, title }))

/** 筛选的类别是 PGC 的 `season_type`；短剧（8）不要。 */
export const FILTER_CATEGORIES: FilterCategory[] = [
  ['1', '番剧'], ['4', '国创'], ['2', '电影'], ['5', '电视剧'], ['3', '纪录片'], ['7', '综艺'],
].map(([id, title]) => ({ id, title }))
const CHANNEL_CATEGORIES: Record<string, string[]> = { bangumi: ['1', '4'], cinema: ['2', '5', '3'] }
const categoriesOf = (channel: string) => (CHANNEL_CATEGORIES[channel] ?? []).map((id) => FILTER_CATEGORIES.find((c) => c.id === id)!)
const ORDER = 'order'

export function channels(): Channels {
  const tabs: Channel[] = [
    CHANNELS.recommend,
    CHANNELS.popular,
    { ...CHANNELS.ranking, subchannels: RANKINGS },
    { ...CHANNELS.bangumi, filterCategories: categoriesOf('bangumi') },
    { ...CHANNELS.cinema, filterCategories: categoriesOf('cinema') },
  ]
  return {
    home: CHANNELS.follow,
    pinned: tabs,
    channels: tabs,
    library: [
      { channel: { id: 'toview', title: '稍后再看' }, systemImage: 'clock.badge', content: 'feed' },
      { channel: { id: 'favorites', title: '收藏' }, systemImage: 'star', content: 'subchannels' },
      { channel: { id: 'seasons', title: '追番追剧' }, systemImage: 'tv', content: 'subchannels' },
      { channel: { id: 'followings', title: '关注的UP主' }, systemImage: 'person.2', content: 'uploaders' },
    ],
  }
}

type List<T> = (T | null)[] | null | undefined
const items = <T>(list: List<T>, map: (value: T) => MediaItem | undefined) =>
  (list ?? []).flatMap((value) => {
    if (!value) return []
    try {
      const item = map(value)
      return item ? [item] : []
    } catch {
      return []
    }
  })

const pageOf = (cursor: string | undefined) => Math.max(1, Number(cursor) || 1)
const grid = (id: string, list: MediaItem[]): FeedSection => ({ id, style: 'grid', items: list })

export async function channel(session: BiliSession, id: string, cursor: string | undefined, signal: AbortSignal): Promise<FeedPage> {
  const library = await libraryFeed(session, id, cursor, signal)
  if (library) return { sections: [grid(id, library.items)], next: library.next }
  if (id.startsWith('rank:')) return { sections: [grid(id, await ranking(session, id, signal))], next: null }
  const page = pageOf(cursor)
  switch (id) {
    case 'recommend': {
      const list = await recommended(session, page, signal)
      return { sections: [grid(id, list)], next: String(page + 1) }
    }
    case 'popular': {
      const result = await popular(session, page, signal)
      return { sections: [grid(id, result.items)], next: result.next }
    }
    case 'follow': {
      const result = await following(session, cursor, signal)
      return { sections: [grid(id, result.items)], next: result.next }
    }
    case 'ranking':
      // 排行榜本身只是榜单的集合：子频道里看。
      return { sections: [grid('rank:ugc:0', await ranking(session, 'rank:ugc:0', signal))], next: null }
    case 'bangumi':
      return { sections: await pgcSections(session, BANGUMI_ROWS, 1, '我的追番', signal), next: null }
    case 'cinema':
      return { sections: await pgcSections(session, CINEMA_ROWS, 2, '我的追剧', signal), next: null }
    default:
      throw notFound('这个频道')
  }
}

export function subchannels(session: BiliSession, id: string, signal: AbortSignal): Promise<Channel[]> {
  switch (id) {
    case 'favorites':
      return favoriteFolders(session, signal)
    case 'seasons':
      return Promise.resolve([{ id: 'follow:pgc:1', title: '追番' }, { id: 'follow:pgc:2', title: '追剧' }])
    case 'ranking':
      return Promise.resolve(RANKINGS)
    default:
      return Promise.resolve([])
  }
}

/** 「更多」：PGC 行的季索引（`index:<season_type>:<order>`），按页。 */
export async function more(session: BiliSession, route: string, cursor: string | undefined, signal: AbortSignal): Promise<MediaItemPage> {
  const match = /^index:(\d+):(\d+)$/.exec(route)
  if (!match) throw notFound('这个列表')
  const page = pageOf(cursor)
  const result = await seasonIndex(session, Number(match[1]), Number(match[2]), page, signal)
  return { items: result.items, next: result.hasNext ? String(page + 1) : null }
}

// MARK: 视频网格

/** 网页首页的推荐；每一页都是新的一批。 */
async function recommended(session: BiliSession, page: number, signal: AbortSignal): Promise<MediaItem[]> {
  const data = await session.get<{ item: List<BiliArchive> }>(`${API}/x/web-interface/wbi/index/top/feed/rcmd`, {
    fresh_type: '4', ps: String(PAGE_SIZE), fresh_idx: String(page), fresh_idx_1h: String(page), brush: String(page),
    fetch_row: String(Math.floor(((page - 1) * PAGE_SIZE) / 4) + 1), feed_version: 'V8', homepage_ver: '1', web_location: '1430650', y_num: '4',
  }, { signal })
  return items(data.item, archiveItem)
}

async function popular(session: BiliSession, page: number, signal: AbortSignal) {
  const data = await session.get<{ list: List<BiliArchive>; no_more?: boolean }>(`${API}/x/web-interface/popular`, { pn: String(page), ps: String(PAGE_SIZE) }, { signal })
  const list = items(data.list, archiveItem)
  return { items: list, next: data.no_more || list.length === 0 ? null : String(page + 1) }
}

/** 关注的 UP 主的投稿，新的在前。 */
async function following(session: BiliSession, offset: string | undefined, signal: AbortSignal) {
  const data = await session.get<{ items: List<DynamicItem>; offset?: string; has_more?: boolean }>(`${API}/x/polymer/web-dynamic/v1/feed/all`, {
    type: 'video', timezone_offset: '-480', offset: offset ?? '', features: 'itemOpusStyle',
  }, { signal })
  return { items: items(data.items, dynamicItem), next: data.has_more && data.offset ? data.offset : null }
}

/** 一个榜，一页：分区近三天的视频，或 PGC 榜。 */
async function ranking(session: BiliSession, id: string, signal: AbortSignal): Promise<MediaItem[]> {
  const match = /^rank:(ugc|pgc):(\d+)$/.exec(id)
  if (!match) throw notFound('这个榜单')
  if (match[1] === 'pgc') return pgcRanking(session, Number(match[2]), signal)
  const data = await session.get<{ list: List<BiliArchive> }>(`${API}/x/web-interface/ranking/v2`, { rid: match[2], type: 'all' }, { signal })
  return items(data.list, archiveItem)
}

// MARK: PGC

interface PGCRow {
  title: string
  seasonType: number
  /** 「更多」的索引排序：0 最近更新，2 最多播放。 */
  moreOrder: number
}

const BANGUMI_ROWS: PGCRow[] = [
  { title: '热门番剧', seasonType: 1, moreOrder: 2 },
  { title: '热门国创', seasonType: 4, moreOrder: 2 },
  { title: '最近更新', seasonType: 1, moreOrder: 0 },
]

const CINEMA_ROWS: PGCRow[] = [
  { title: '热门电影', seasonType: 2, moreOrder: 2 },
  { title: '热门电视剧', seasonType: 5, moreOrder: 2 },
  { title: '热门纪录片', seasonType: 3, moreOrder: 2 },
]

/** 账号追的季在前，再是每一行。某一行失败就不要它，不让整页失败。 */
async function pgcSections(session: BiliSession, rows: PGCRow[], followType: number, followTitle: string, signal: AbortSignal): Promise<FeedSection[]> {
  const followed = followedSeasons(session, followType, 1, signal).catch(() => undefined)
  const results = await Promise.allSettled(rows.map((row) =>
    row.moreOrder === 0 ? seasonIndex(session, row.seasonType, 0, 1, signal).then((r) => r.items) : pgcRanking(session, row.seasonType, signal)))
  const sections: FeedSection[] = []
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return
    const row = rows[index]
    sections.push({
      id: `pgc:${row.seasonType}:${row.moreOrder}`, title: row.title, style: 'row', items: result.value,
      more: { title: row.title, route: `index:${row.seasonType}:${row.moreOrder}` },
    })
  })
  const mine = await followed
  if (mine?.items.length) sections.unshift({ id: `follow:${followType}`, title: followTitle, style: 'continueWatching', items: mine.items })
  if (sections.length === 0) {
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) throw failure.reason
  }
  return sections
}

export async function pgcRanking(session: BiliSession, seasonType: number, signal: AbortSignal): Promise<MediaItem[]> {
  const data = await session.get<{ list: List<BiliSeasonCard> }>(`${API}/pgc/web/rank/list`, { day: '3', season_type: String(seasonType) }, { signal, sign: 'none' })
  return items(data.list, seasonItem)
}

/** `pgc/season/index/result`：某类的全部季，排好序。 */
async function seasonIndex(session: BiliSession, type: number, order: number, page: number, signal: AbortSignal) {
  const data = await session.get<{ list: List<BiliSeasonCard>; has_next?: number }>(`${API}/pgc/season/index/result`, {
    season_type: String(type), type: '1', order: String(order), sort: '0', page: String(page), pagesize: String(PAGE_SIZE), st: String(type),
  }, { signal, sign: 'none' })
  return { items: items(data.list, seasonItem), hasNext: data.has_next === 1 }
}

// MARK: 我的

async function libraryFeed(session: BiliSession, id: string, cursor: string | undefined, signal: AbortSignal): Promise<MediaItemPage | undefined> {
  const page = pageOf(cursor)
  if (id === 'toview') return { items: await toView(session, signal), next: null }
  const fav = /^fav:(\d+)$/.exec(id)
  if (fav) return favorites(session, fav[1], page, signal)
  const follow = /^follow:pgc:(\d+)$/.exec(id)
  if (follow) return followedSeasons(session, Number(follow[1]), page, signal)
  return undefined
}

async function toView(session: BiliSession, signal: AbortSignal): Promise<MediaItem[]> {
  const data = await session.get<{ list: List<BiliArchive> }>(`${API}/x/v2/history/toview`, {}, { signal, sign: 'none' })
  return items(data.list, archiveItem)
}

async function favoriteFolders(session: BiliSession, signal: AbortSignal): Promise<Channel[]> {
  const data = await session.get<{ list: { id: number; title: string }[] | null }>(`${API}/x/v3/fav/folder/created/list-all`, { up_mid: session.mid }, { signal, sign: 'none' })
  return (data.list ?? []).map((folder) => ({ id: `fav:${folder.id}`, title: folder.title }))
}

interface FavoriteMedia {
  /** 2 是视频；其他（音频、番剧）只要带季的。 */
  type?: number
  /** 收藏后被删的视频（「已失效视频」）不为 0。 */
  attr?: number
  title: string
  cover?: string
  duration?: number
  bvid?: string
  upper?: { mid?: number; name?: string; face?: string }
  cnt_info?: { play?: number; danmaku?: number }
  pubtime?: number
  ogv?: { season_id?: number } | null
}

async function favorites(session: BiliSession, folder: string, page: number, signal: AbortSignal): Promise<MediaItemPage> {
  const data = await session.get<{ medias: List<FavoriteMedia>; has_more?: boolean }>(`${API}/x/v3/fav/resource/list`, {
    media_id: folder, pn: String(page), ps: '20', platform: 'web',
  }, { signal, sign: 'none' })
  const list = items(data.medias, (media) => {
    if (media.ogv?.season_id) {
      const id = `ss${media.ogv.season_id}`
      return compact({ id, title: media.title, landscapeURL: image(media.cover, 672, 378), target: { show: id } })
    }
    if (media.type !== 2 || (media.attr ?? 0) !== 0 || !media.bvid) return undefined
    return compact({
      id: media.bvid,
      title: media.title,
      landscapeURL: image(media.cover, 672, 378),
      uploader: media.upper?.name ? compact({ id: String(media.upper.mid ?? ''), name: media.upper.name, avatarURL: image(media.upper.face) }) : undefined,
      stats: compact({ views: media.cnt_info?.play, danmaku: media.cnt_info?.danmaku }),
      duration: media.duration || undefined,
      publishedAt: media.pubtime ? new Date(media.pubtime * 1000).toISOString() : undefined,
      target: { video: media.bvid },
    })
  })
  return { items: list, next: data.has_more ? String(page + 1) : null }
}

/** 追番（`type` 1）/ 追剧（2），带看到哪（「看到第12话」）。 */
async function followedSeasons(session: BiliSession, type: number, page: number, signal: AbortSignal): Promise<MediaItemPage> {
  const data = await session.get<{ list: List<BiliSeasonCard>; total?: number }>(`${API}/x/space/bangumi/follow/list`, {
    vmid: session.mid, type: String(type), follow_status: '0', pn: String(page), ps: String(PAGE_SIZE),
  }, { signal, sign: 'none' })
  return { items: items(data.list, seasonItem), next: page * PAGE_SIZE < (data.total ?? 0) ? String(page + 1) : null }
}

/** 关注的 UP 主，最近关注的在前。 */
export async function uploaders(session: BiliSession, id: string, cursor: string | undefined, signal: AbortSignal): Promise<UploaderPage> {
  if (id !== 'followings') return { uploaders: [], next: null }
  const page = pageOf(cursor)
  const size = 50
  const data = await session.get<{ list: List<{ mid: number; uname: string; face?: string; sign?: string }>; total?: number }>(`${API}/x/relation/followings`, {
    vmid: session.mid, order_type: 'attention', pn: String(page), ps: String(size),
  }, { signal, sign: 'none' })
  const users = (data.list ?? []).filter((user) => user !== null)
  // 接口只给前几百个；空页也算到头。
  return {
    uploaders: users.map((user) => compact({
      uploader: compact({ id: String(user.mid), name: user.uname, avatarURL: image(user.face, 160, 160) }),
      signature: user.sign || undefined,
      isFollowing: true,
    })),
    next: users.length > 0 && page * size < (data.total ?? 0) ? String(page + 1) : null,
  }
}

// MARK: 筛选（网站的 PGC 索引页：`pgc/season/index/condition` 的维度和排序，`index/result` 的结果；不签名）

export async function filterDimensions(session: BiliSession, category: string, signal: AbortSignal): Promise<FilterDimension[]> {
  if (!FILTER_CATEGORIES.some((c) => c.id === category)) throw notFound('这个分类')
  const data = await session.get<{
    filter?: { field: string; name: string; values: { keyword: string; name: string }[] }[] | null
    order?: { field: string; name: string }[] | null
  }>(`${API}/pgc/season/index/condition`, { season_type: category, type: '1' }, { signal, sign: 'none' })
  // 只要降序：升序（最少追番在前）没什么用。
  const orders = (data.order ?? []).map((order) => ({ id: order.field, title: order.name }))
  const dimensions: FilterDimension[] = []
  if (orders.length) dimensions.push({ id: ORDER, title: '排序', options: orders, defaultOptionID: orders[0].id, isSort: true })
  for (const field of data.filter ?? []) {
    if (field.values.length < 2) continue
    const options = field.values.map((value) => ({ id: value.keyword, title: value.name }))
    dimensions.push({ id: field.field, title: field.name, options, defaultOptionID: options[0].id })
  }
  return dimensions
}

export async function filterResults(session: BiliSession, category: string, selection: FilterSelection, cursor: string | undefined, signal: AbortSignal): Promise<MediaItemPage> {
  const page = pageOf(cursor)
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(selection)) if (key !== ORDER && value) params[key] = value
  Object.assign(params, {
    season_type: category, st: category, type: '1', order: selection[ORDER] ?? '', sort: '0', page: String(page), pagesize: String(PAGE_SIZE),
  })
  const data = await session.get<{ list: List<BiliSeasonCard>; has_next?: number }>(`${API}/pgc/season/index/result`, params, { signal, sign: 'none' })
  const list = items(data.list, (season) => {
    const item = seasonItem(season)
    // 当前排序的数字（「553.1万追番」「9.9分」）作副标题。
    if (item && season.order && season.order !== item.caption) item.subtitle = season.order
    return item
  })
  return { items: list, next: data.has_next === 1 && list.length > 0 ? String(page + 1) : null }
}
