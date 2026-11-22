// 频道、片库与筛选（照 App 的 IQiyiFeedService / IQiyiFilterService）：推荐（首页）和导航条上的长视频频道；
// 一个频道 = 编辑页（`portal/lw/v7/channel/<name>`，一页）+ 频道片库的 热播 / 最新 / 高分 三行，「更多」翻片库
// （`pcw-api …/search/recommend/list`）。筛选是网站的 片库（docs/iqiyi-web/FILTER.md）。
import type { Badge, Channel, Channels, FeedPage, FeedSection, FilterCategory, FilterDimension, FilterSelection, MediaItem, MediaItemPage } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { apiError, type IQiyiSession } from './session.ts'
import { albumID, APP_VERSION, arr, bool, idOf, image, int, MESH, num, PCW_API, qipsValue, str, text, updateStatus, videoID } from './util.ts'

/** 可浏览的频道：导航条的 `channelid` → 编辑页名。短视频、短剧、游戏、体育、直播和剧场 / 专题页不要（docs/iqiyi/PLAN.md §2）。 */
export const CHANNELS: { id: number; slug: string; title: string }[] = [
  { id: 2, slug: 'tv', title: '电视剧' },
  { id: 1, slug: 'film', title: '电影' },
  { id: 6, slug: 'variety', title: '综艺' },
  { id: 4, slug: 'cartoon', title: '动漫' },
  { id: 15, slug: 'child', title: '少儿' },
  { id: 3, slug: 'series', title: '纪录片' },
  { id: 12, slug: 'knowledge', title: '知识' },
  { id: 37, slug: 'comicdrama', title: '漫剧' },
]

export const HOME: Channel = { id: 'recommend', title: '推荐' }

/** 频道下的片库行：`mode` 11 热播、4 最新、8 高分。 */
const LIBRARY_ROWS: { mode: number; title: string }[] = [{ mode: 11, title: '热播' }, { mode: 4, title: '最新' }, { mode: 8, title: '高分' }]
const LIBRARY_PAGE = 48
const ROW_SIZE = 24
const CHANNELS_TTL = 60 * 60_000

/** 筛选的类目：片库的频道行（`channel_id`），短剧不要。 */
export const FILTER_CATEGORIES: FilterCategory[] = [{ id: '1009', title: '全部' }, ...CHANNELS.map((c) => ({ id: String(c.id), title: c.title }))]
const FILTER_PAGE = 60
/** 一页至少凑够这么多：服务端每页会丢掉大半（FILTER.md §4）。 */
const FILTER_TARGET = 12
/** 一次最多翻这么多页（总共 800 个位置）。 */
const FILTER_PAGES_PER_CALL = 4

export class IQiyiFeed {
  private channelsCache?: { at: number; list: Channel[] }

  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  async channels(signal: AbortSignal | undefined): Promise<Channels> {
    const list = await this.channelList(signal)
    const pinned = CHANNELS.slice(0, 4).map((c) => ({ id: c.slug, title: list.find((l) => l.id === c.slug)?.title ?? c.title }))
    return { home: HOME, pinned, channels: list, library: [] }
  }

  /** 导航条的顺序和名称，只留上面的频道；读不到时用默认的。缓存一小时（manifest 每次都要）。 */
  private async channelList(signal: AbortSignal | undefined): Promise<Channel[]> {
    if (this.channelsCache && Date.now() - this.channelsCache.at < CHANNELS_TTL) return this.channelsCache.list
    const withFilter = (c: (typeof CHANNELS)[number], title?: string): Channel => ({
      id: c.slug, title: title ?? c.title, filterCategories: [{ id: String(c.id), title: c.title }],
    })
    let listed: Channel[] = []
    try {
      const bar = await this.session.json(`${MESH}/portal/lw/v5/channel/navigateBar`, this.session.portalParams(), signal)
      const seen = new Set<string>()
      for (const item of arr(bar?.items)) {
        const channel = CHANNELS.find((c) => c.id === int(item?.channelid))
        if (!channel || item.data_url != null || seen.has(channel.slug)) continue
        seen.add(channel.slug)
        listed.push(withFilter(channel, text(item.text)))
      }
    } catch (error) {
      if (signal?.aborted) throw error
    }
    if (listed.length === 0) listed = CHANNELS.map((c) => withFilter(c))
    else this.channelsCache = { at: Date.now(), list: listed }
    return listed
  }

  async channel(id: string, cursor: string | undefined, signal: AbortSignal | undefined): Promise<FeedPage> {
    if (cursor) return { sections: [], next: null }
    if (id === HOME.id) {
      const page = await this.session.postJSON(`${MESH}/portal/lw/v5/channel/recommend`, {
        ...this.session.portalParams(), scale: '200', brightness: 'dark', width: '1200', mode: 'page', page: '1',
        conduit_id: 'PPStream', from: 'webapp', agenttype: '1',
      }, '{"adnToken":"{}"}', signal)
      return { sections: editorialSections(page, id), next: null }
    }
    const info = CHANNELS.find((c) => c.slug === id)
    if (!info) throw new SourceError('not_found', '找不到这个频道')
    const editorial = this.session.json(`${MESH}/portal/lw/v7/channel/${info.slug}`, { ...this.session.portalParams(), scale: '200', width: '1200', mode: 'page', page: '1' }, signal)
      .then((page) => editorialSections(page, id))
    const rows = LIBRARY_ROWS.map((row) => this.library(info.id, row.mode, 1, ROW_SIZE, signal).then((page): FeedSection | undefined => {
      if (page.items.length === 0) return undefined
      const route = `lib:${info.id}:${row.mode}`
      return { id: route, title: row.title, style: 'row', items: page.items, more: { title: `${info.title} · ${row.title}`, route } }
    }))
    const results = await Promise.allSettled([editorial, ...rows])
    const sections: FeedSection[] = []
    let lastError: unknown
    for (const result of results) {
      if (result.status === 'rejected') lastError = result.reason
      else if (Array.isArray(result.value)) sections.push(...result.value)
      else if (result.value) sections.push(result.value)
    }
    if (sections.length === 0 && lastError) throw lastError
    return { sections, next: null }
  }

  /** `lib:<channelId>:<mode>`：频道片库，按页。 */
  async more(route: string, cursor: string | undefined, signal: AbortSignal | undefined): Promise<MediaItemPage> {
    const match = /^lib:(\d+):(\d+)$/.exec(route)
    if (!match) throw new SourceError('not_found', '找不到这个列表')
    return this.library(Number(match[1]), Number(match[2]), Number(cursor) || 1, LIBRARY_PAGE, signal)
  }

  /** 频道片库的一页，按 `mode` 排序。无签名、无风控。 */
  async library(channel: number, mode: number, page: number, size: number, signal: AbortSignal | undefined): Promise<MediaItemPage> {
    const response = await this.session.json(`${PCW_API}/search/recommend/list`, {
      channel_id: String(channel), data_type: '1', mode: String(mode), page_id: String(page), ret_num: String(size),
    }, signal)
    if (str(response?.code) !== 'A00000') throw apiError(response?.code, response?.msg, '片库加载失败')
    const items = arr(response.data?.list).map(libraryItem).filter((i): i is MediaItem => Boolean(i))
    return { items, next: int(response.data?.has_next) === 1 && items.length > 0 ? String(page + 1) : null }
  }

  // MARK: 筛选

  /** 风控时的退路：只选了排序（或什么都没选）、且是单个频道时，用旧片库（`recommend/list`，无风控）按 `mode` 给。 */
  private async legacyResults(category: string, selection: FilterSelection, page: number, signal: AbortSignal | undefined): Promise<MediaItemPage> {
    const picked = Object.values(selection).filter((value) => value !== '')
    const channel = CHANNELS.find((c) => String(c.id) === category)
    const mode = picked.length === 0 ? 11 : picked.length === 1 ? Number(/^mode=(\d+)$/.exec(picked[0])?.[1]) : NaN
    if (!channel || !Number.isFinite(mode)) throw verificationRequired()
    const result = await this.library(channel.id, mode, page, LIBRARY_PAGE, signal)
    return { items: result.items, next: result.next ? `L${result.next}` : null }
  }

  /** 一个类目的维度：`videolib/tag` 的分组；网页收起的分组放最后（App 的「展开」后面）。 */
  async dimensions(category: string, signal: AbortSignal | undefined): Promise<FilterDimension[]> {
    const groups = arr(await this.session.json(`${MESH}/portal/lw/videolib/tag`, {
      channel_id: category, tagAdd: '', selected_tag_name: '', version: APP_VERSION, device: this.session.deviceID,
      uid: this.session.uid ?? '', vip: this.session.isVIP ? '1' : '0',
    }, signal))
    if (groups.length === 0) throw new SourceError('upstream_changed', '筛选项未返回')
    return groups
      .map((group, index) => ({ group, index, dimension: dimension(group) }))
      .filter((entry): entry is { group: any; index: number; dimension: FilterDimension } => Boolean(entry.dimension))
      .sort((l, r) => {
        const ld = bool(l.group.display) !== false
        const rd = bool(r.group.display) !== false
        return ld !== rd ? (ld ? -1 : 1) : l.index - r.index
      })
      .map((entry) => entry.dimension)
  }

  async filterResults(category: string, selection: FilterSelection, cursor: string | undefined, signal: AbortSignal | undefined): Promise<MediaItemPage> {
    // `L<页>`：被风控后改用的旧片库（见下）。
    if (cursor?.startsWith('L')) return this.legacyResults(category, selection, Number(cursor.slice(1)) || 1, signal)
    const filter = filterParam(selection)
    let page = Number(cursor) || 1
    const items: MediaItem[] = []
    for (let n = 0; n < FILTER_PAGES_PER_CALL; n++) {
      const response = await this.session.json(`${MESH}/portal/lw/videolib/data`, {
        channel_id: category, page_id: String(page), ret_num: String(FILTER_PAGE), device_id: this.session.deviceID,
        uid: this.session.uid ?? '', passport_id: this.session.uid ?? '', auth: this.session.authCookie ?? '',
        vip: this.session.isVIP ? '1' : '0', version: APP_VERSION, filter,
      }, signal)
      // 8：过了最后一个位置。
      if (int(response?.code) === 8) return { items, next: null }
      if (int(response?.code) !== 0) throw apiError(response?.code, response?.msg, '片库加载失败')
      const entries = arr(response.data)
      if (entries.length === 0 && (int(response.extData?.dataExtRisk?.risk_level) ?? 0) >= 2) {
        // 风控：这个设备 id 要先过极验（FILTER.md §6），服务端过不了。只按排序筛的还能用没有风控的旧片库给出。
        if (items.length === 0 && page === (Number(cursor) || 1)) return this.legacyResults(category, selection, 1, signal)
        throw verificationRequired()
      }
      // 广告推的是筛选之外的剧；「第N集」插入项每页都有。
      items.push(...entries.filter((e) => bool(e?.isAd) !== true && bool(e?.h) !== true).map(cardItem).filter((i): i is MediaItem => Boolean(i)))
      page++
      if (int(response.has_next) !== 1) return { items, next: null }
      if (items.length >= FILTER_TARGET) break
    }
    return { items, next: String(page) }
  }
}

const verificationRequired = () =>
  new SourceError('restricted', '爱奇艺要求人机验证，这台服务暂时只能按排序筛选（其他条件要先在网页上过验证码，服务端做不到）')

// MARK: 解析

/** 编辑页的卡片作为分区：焦点图 `hero`，榜单（风云榜）`ranking`，其余一行。广告和指向视频页之外的卡片丢掉。 */
export function editorialSections(page: any, channel: string): FeedSection[] {
  if (int(page?.code) !== 0) throw apiError(page?.code, page?.msg, '频道内容加载失败')
  const sections: FeedSection[] = []
  arr(page.items).forEach((card, index) => {
    if (text(card?.temp?.feedRowAd)) return
    const template = int(card?.temp?.id) ?? 0
    const title = text(card?.title)
    const isRanking = title?.includes('榜') === true
    const items = arr(card?.video?.[0]?.data).map(cardItem).filter((i): i is MediaItem => Boolean(i))
      .map((item, offset) => (isRanking ? { ...item, rank: offset + 1 } : item))
    if (items.length === 0) return
    const style = template === 62 ? 'hero' : isRanking ? 'ranking' : 'row'
    sections.push({
      id: `${channel}:${index}:${template}`,
      title: style === 'hero' ? undefined : (title ?? (sections.some((s) => s.style === 'row') ? '推荐' : '正在热播')),
      style,
      items,
    })
  })
  return sections
}

/** 一张卡：一部剧（专辑）或一个视频。广告、游戏等非视频链接 undefined。 */
export function cardItem(card: any): MediaItem | undefined {
  if (!card || bool(card.isAd) === true) return undefined
  const tvid = idOf(card.tv_id) ?? qipsValue('tvid', text(card.play_url))
  const page = text(card.page_url)
  if (!tvid || (page && !page.includes('iqiyi.com/v_'))) return undefined
  const rawAlbum = idOf(card.album_id)
  const album = rawAlbum && rawAlbum !== tvid && rawAlbum !== '0' ? rawAlbum : undefined
  const contentType = text(card.content_type)
  const isClip = contentType ? contentType !== 'FEATURE_FILM' : false
  // 各模板图片字段不同：行是 image_url_normal / image_cover，焦点图是 image_url；地址里的尺寸后缀会被换掉，所以都能用。
  const poster = text(card.recom?.extension?.poster_url) ?? text(card.image_url_normal) ?? text(card.album_image_url_hover) ?? text(card.image_url) ?? text(card.image_cover)
  const landscape = text(card.album_image_url_hover) ?? text(card.image_url) ?? text(card.image_cover) ?? text(card.thumbnail_url) ?? poster
  const title = text(card.display_name) ?? text(card.title)
  if (!title) return undefined
  const show = album && !isClip
  const id = show ? albumID(album) : videoID(tvid)
  return {
    id,
    title,
    subtitle: text(card.desc),
    posterURL: image(poster, 260, 360),
    landscapeURL: image(landscape, 592, 333),
    badge: badge(text(card.pay_mark), text(card.cornerMark)),
    caption: text(card.dq_updatestatus),
    target: show ? { show: id } : { video: videoID(tvid) },
  }
}

/** 会员标（VIP / 星钻）优先，再是独播。 */
export function badge(payMark: string | undefined, corner: string | undefined): Badge | undefined {
  switch (payMark) {
    case 'VIP_MARK': return { text: 'VIP', tone: 'gold' }
    case 'PAY_MARK_FUN_VIP_MARK': return { text: '星钻', tone: 'gold' }
    case 'PAY_ON_DEMAND_MARK':
    case 'PAY_MARK': return { text: '付费', tone: 'red' }
  }
  return corner === 'exclusive' ? { text: '独播', tone: 'red' } : undefined
}

/** 旧片库接口的条目。 */
export function libraryItem(entry: any): MediaItem | undefined {
  const album = idOf(entry?.albumId)
  if (!album) return undefined
  const count = int(entry.videoCount) ?? 0
  const latest = int(entry.latestOrder) ?? 0
  const score = num(entry.score)
  // 综艺的 videoCount 是 0，但有 sourceId：也是一部「剧」（App 这里当成单个视频，打不开）。
  const isShow = count > 1 || (idOf(entry.sourceId) ?? '0') !== '0'
  const id = isShow ? albumID(album) : videoID(idOf(entry.tvId) ?? album)
  return {
    id,
    title: text(entry.name) ?? text(entry.title) ?? '',
    subtitle: text(entry.focus),
    posterURL: image(entry.imageUrl, 260, 360),
    landscapeURL: image(entry.imageUrl, 592, 333),
    badge: badge(int(entry.payMark) === 1 ? 'VIP_MARK' : undefined, int(entry.exclusive) === 1 ? 'exclusive' : undefined),
    caption: updateStatus(count, latest) ?? (score && score > 0 ? `${score.toFixed(1)}分` : undefined),
    target: isShow ? { show: id } : { video: id },
  }
}

/** 一个分组：选项按 `tag_param`（「全部」没有）；排序没有「全部」，默认选中网页选中的。 */
export function dimension(group: any): FilterDimension | undefined {
  const name = text(group?.group)
  if (!name) return undefined
  const tags = arr(group.tags)
  const options = tags.filter((t) => text(t?.text)).map((t) => ({ id: str(t.tag_param) ?? '', title: text(t.text)! }))
  if (options.length <= 1) return undefined
  const isSort = options.some((o) => o.id.startsWith('mode='))
  const selected = str(tags.find((t) => bool(t?.selected) === true)?.tag_param)
  return { id: name, title: name, options, defaultOptionID: selected ?? options[0].id, isSort }
}

/** 选中的各个 `tag_param`（`k=v`，几个用逗号连）按 key 合并，同 key 的值用逗号连，JSON（key 排序）。 */
export function filterParam(selection: FilterSelection): string {
  const merged = new Map<string, string[]>()
  for (const param of Object.values(selection).sort()) {
    // 不带「=」的一段接在上一个值后面：有的标签是列表（「欧洲」= `k=a;should,b;should`）。
    const pairs: { key: string; value: string }[] = []
    for (const piece of param.split(',').filter((p) => p !== '')) {
      const at = piece.indexOf('=')
      if (at >= 0) pairs.push({ key: piece.slice(0, at), value: piece.slice(at + 1) })
      else if (pairs.length > 0) pairs[pairs.length - 1].value += `,${piece}`
    }
    for (const { key, value } of pairs) {
      const values = merged.get(key) ?? []
      if (!values.includes(value)) values.push(value)
      merged.set(key, values)
    }
  }
  const object: Record<string, string> = {}
  for (const key of [...merged.keys()].sort()) object[key] = merged.get(key)!.join(',')
  return JSON.stringify(object)
}
