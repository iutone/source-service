// 网站的频道（API.md §2，App 的 TencentFeedService / TencentFilterService）：一个频道是它的编辑页第一页
// （`PageService/getPage`：焦点轮播和各个货架；后面的页是无尽的单视频流，不要），再接频道片库的 最热 / 最新上架 / 高分好评
// 三行（`channel_list_second_page`），「更多」按页翻片库。筛选也是片库：第 0 页给维度，`filter_params` 选。不用登录。
import type { Badge, Channel, FeedPage, FeedSection, FilterDimension, MediaItem, MediaItemPage } from '@iyt-source/protocol'
import { int, imageURL, isObject, pageItems, parseJSON, str, text } from './json.ts'
import { apiError, loginRequired, type TencentSession } from './session.ts'
import { coverID, videoID } from './ids.ts'

/** 能浏览的频道；短剧、体育、游戏和短视频频道不要（docs/tencent/PLAN.md §2）。 */
export const CHANNELS: Channel[] = [
  { id: '100113', title: '电视剧' }, { id: '100173', title: '电影' }, { id: '100109', title: '综艺' },
  { id: '100119', title: '动漫' }, { id: '100150', title: '少儿' }, { id: '100105', title: '纪录片' },
]
export const HOME: Channel = { id: '100101', title: '首页' }
export const CHASING: Channel = { id: 'chasing', title: '我的追剧' }
/** 每个频道下的片库行：`sort` 75 最热、79 最新上架、85 高分好评。 */
export const LIBRARY_ROWS = [{ sort: '75', title: '最热' }, { sort: '79', title: '最新上架' }, { sort: '85', title: '高分好评' }]

const PAGE_QUERY = { video_appid: '3000010', vversion_platform: '2' }

// MARK: 卡片

/** 网站的角标：VIP / 会员 / 付费金色，独播 / 自制红色，预告蓝色。 */
export function badgeOf(label: string | undefined): Badge | undefined {
  if (!label) return undefined
  if (/VIP|会员|付费|用券/.test(label)) return { text: label, tone: 'gold' }
  if (/预告|预约/.test(label)) return { text: label, tone: 'blue' }
  if (/独播|自制|首播/.test(label)) return { text: label, tone: 'red' }
  return { text: label, tone: 'neutral' }
}

/** 左上角的标签（位置 1 或 2 的 `marklabel_<n>_prime_text`）：独播、VIP、限免中、预告。 */
export function markLabel(params: any): string | undefined {
  for (let index = 0; index < 6; index++) {
    const label = text(params?.[`marklabel_${index}_prime_text`])
    if (!label) continue
    const position = int(params[`marklabel_${index}_position`])
    if (position === 1 || position === 2) return label
  }
  return undefined
}

/** `uni_imgtag`（`tag_1` … `tag_4` 带 `text` 的 JSON 字符串）的一个标签：`tag_2` 角标，`tag_4` 集数。 */
export function imageTag(json: unknown, slot: string): string | undefined {
  return text(parseJSON(json)?.[slot]?.text)
}

/** 卡片的节目（`cid`），只有一个视频时是它；会员推广（`aid` / `ptag=ad.*`）丢掉。 */
export function mediaItem(params: any): MediaItem | undefined {
  if (!isObject(params)) return undefined
  if (text(params.aid) || text(params.ptag)?.startsWith('ad.')) return undefined
  const title = text(params.title)
  if (!title) return undefined
  const cid = text(params.cid)
  const vid = text(params.vid)
  let id: string
  let target: MediaItem['target']
  if (cid) {
    id = coverID(cid)
    target = { show: id }
  } else if (vid) {
    id = videoID(vid)
    target = { video: id }
  } else {
    return undefined
  }
  return {
    id,
    title,
    subtitle: text(params.sub_title) ?? text(params.second_title) ?? text(params.rec_subtitle),
    posterURL: imageURL(params.image_url_vertical ?? params.new_pic_vt),
    landscapeURL: imageURL(params.image_url ?? params.new_pic_hz),
    badge: badgeOf(markLabel(params) ?? imageTag(params.uni_imgtag, 'tag_2')),
    caption: text(params.episode_updated) ?? text(params.timelong) ?? imageTag(params.uni_imgtag, 'tag_4'),
    target,
  }
}

/** 页面的一张卡：焦点轮播是 `hero`，货架是海报行。广告、「猜你喜欢」标签、热门筛选标签和单个大视频卡不要。 */
export function section(card: any, channel: string, index: number): FeedSection | undefined {
  const type = text(card?.type) ?? ''
  const style = type === 'pc_carousel' ? 'hero' : type === 'pc_shelves' ? 'row' : undefined
  if (!style) return undefined
  const items = (card.children_list?.list?.cards ?? []).map((c: any) => mediaItem(c?.params)).filter(Boolean) as MediaItem[]
  if (!items.length) return undefined
  const params = card.params ?? {}
  const title = text(params.ZT_leaf_head) ?? text(params.title)
  const key = text(params.module_id) ?? text(params.mod_id) ?? String(index)
  return { id: `${channel}:${type}:${key}`, title: style === 'hero' ? undefined : (title ?? '推荐'), style, items }
}

/** `source_key=100113+rec_module_id=…+rec_module_type=801002+…`（末尾的 `rec_extend_info` 带控制字符，不要）。 */
export function dataKeys(key: string): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const part of key.split('+')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const name = part.slice(0, at)
    if (!name.startsWith('rec_extend')) keys[name] = part.slice(at + 1)
  }
  return keys
}

/** 追的一部剧（`asset_type` 2，节目）或视频；`second_title` 说看到哪（「第4集 · 观看至17%」）。 */
export function chasingItem(entry: any): MediaItem | undefined {
  const id = text(entry?.asset_id)
  const title = text(entry?.title)
  if (!id || !title || entry.is_removed === true) return undefined
  const isShow = str(entry.asset_type) === '2'
  const full = isShow ? coverID(id) : videoID(id)
  const label = (entry.mark_label_list ?? []).find((l: any) => int(l?.position) === 1 || int(l?.position) === 0)
  const progress = Number(entry.extra?.view_progress)
  return {
    id: full, title, subtitle: text(entry.second_title),
    landscapeURL: imageURL(entry.extra?.cover ?? entry.cover),
    badge: badgeOf(text(label?.prime_text)), caption: text(entry.second_title),
    progress: Number.isFinite(progress) && entry.extra?.view_progress !== undefined ? Math.min(Math.max(progress / 100, 0), 1) : undefined,
    target: isShow ? { show: full } : { video: full },
  }
}

/** 片库一页里的节目（`item_type` 2）。 */
export function libraryItems(data: any): MediaItem[] {
  const seen = new Set<string>()
  return pageItems(data)
    .filter((item) => str(item?.item_type) === '2')
    .map((item) => mediaItem(item.item_params))
    .filter((item): item is MediaItem => item !== undefined && !seen.has(item.id) && Boolean(seen.add(item.id)))
}

/** 按 `index_item_key` 分组的选项，保持顺序；`-1`（以维度命名的那个）是「全部」。 */
export function dimensions(data: any): FilterDimension[] {
  const order: string[] = []
  const titles = new Map<string, string>()
  const options = new Map<string, { id: string; title: string }[]>()
  const defaults = new Map<string, string>()
  for (const item of pageItems(data).map((i) => i?.item_params)) {
    const key = text(item?.index_item_key)
    const value = text(item?.option_value)
    const name = text(item?.option_name)
    if (!key || !value || !name) continue
    if (!options.has(key)) {
      order.push(key)
      titles.set(key, text(item.index_name) ?? key)
      options.set(key, [])
    }
    options.get(key)!.push({ id: value, title: value === '-1' ? '全部' : name })
    if (str(item.is_default_val) === '1') defaults.set(key, value)
  }
  return order.flatMap((key) => {
    const list = options.get(key)!
    if (list.length <= 1) return []
    return [{ id: key, title: titles.get(key) ?? key, options: list, defaultOptionID: defaults.get(key) ?? list[0]!.id, isSort: key === 'sort' }]
  })
}

/** 筛选的选择 → `filter_params`：空的不要，没选排序时按最热。 */
export function filterParams(selection: Record<string, string>): string {
  const picks: Record<string, string> = {}
  for (const [key, value] of Object.entries(selection)) if (value) picks[key] = value
  picks.sort ??= '75'
  return Object.keys(picks).sort().map((key) => `${key}=${picks[key]}`).join('&')
}

// MARK: 请求

export class TencentFeed {
  private readonly session: TencentSession
  private navigation?: { at: number; channels: Channel[] }

  constructor(session: TencentSession) {
    this.session = session
  }

  /** 导航的顺序和名字，只留上面的频道；读不到就用默认的。一天读一次。 */
  async channels(signal?: AbortSignal): Promise<Channel[]> {
    if (this.navigation && Date.now() - this.navigation.at < 86_400_000) return this.navigation.channels
    const known = new Map(CHANNELS.map((c) => [c.id, c]))
    let cards: any[] = []
    try {
      const response = await this.session.gateway('trpc.vector_layout.page_view.PageService/getNaviPage', {
        query: PAGE_QUERY,
        body: {
          page_context: null,
          page_params: { page_id: 'pc_nav', page_type: 'navigation', req_poi_ids: '3431' },
          page_bypass_params: {
            params: { caller_id: '3000010', data_mode: 'default', page_id: 'pc_nav', page_type: 'navigation', platform_id: '2', user_mode: 'default' },
            scene: 'navigation', abtest_bypass_id: this.session.guid,
          },
        },
        signal,
      })
      cards = response?.data?.CardList?.[0]?.children_list?.list?.cards ?? []
    } catch (error) {
      if (signal?.aborted) throw error
    }
    const seen = new Set<string>()
    const listed: Channel[] = []
    for (const card of cards) {
      const params = card?.params ?? {}
      const id = text(params.channel_id)
      if (!id || !known.has(id) || text(params.jump_url) || seen.has(id)) continue
      seen.add(id)
      listed.push({ id, title: text(params.channel_name) ?? known.get(id)!.title })
    }
    const channels = listed.length ? listed : CHANNELS
    if (listed.length) this.navigation = { at: Date.now(), channels }
    return channels
  }

  async channel(id: string, signal?: AbortSignal): Promise<FeedPage> {
    const params = { page_type: 'channel', page_id: id, scene: 'channel', new_mark_label_enabled: '1' }
    const response = await this.session.gateway('trpc.vector_layout.page_view.PageService/getPage', {
      query: PAGE_QUERY,
      body: {
        page_params: params,
        page_bypass_params: {
          params: { ...params, platform_id: '2', caller_id: '3000010', data_mode: 'default', user_mode: 'default' },
          scene: 'channel', abtest_bypass_id: this.session.guid,
        },
        page_context: null,
      },
      signal,
    })
    if (int(response?.ret) !== 0) throw apiError(response?.ret, text(response?.msg) ?? '频道加载失败')
    const sections: FeedSection[] = []
    const cards: any[] = response.data?.CardList ?? []
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index]
      const shelf = section(card, id, index)
      if (!shelf) continue
      sections.push(shelf)
      sections.push(...(await this.tabSections(card, shelf, signal)))
    }
    const info = CHANNELS.find((c) => c.id === id)
    if (info) {
      const rows = await Promise.all(LIBRARY_ROWS.map((row) => this.library(info.id, row.sort, 1, undefined, signal).catch(() => undefined)))
      LIBRARY_ROWS.forEach((row, index) => {
        const page = rows[index]
        if (!page?.items.length) return
        const route = `lib:${info.id}:${row.sort}`
        sections.push({ id: route, title: row.title, style: 'row', items: page.items, more: { title: `${info.title} · ${row.title}`, route } })
      })
    }
    return { sections, next: null }
  }

  /**
   * 货架的频道标签（`multi_tab`：重磅热播的 电视剧、综艺…，货架本身是「全部」），各自成一行接在后面，用货架的
   * `flip_infos.change` 一起经 `getCard` 取；这里不浏览的频道（游戏、体育）的标签不要。
   */
  private async tabSections(card: any, shelf: FeedSection, signal?: AbortSignal): Promise<FeedSection[]> {
    const flip = card?.flip_infos?.change
    const tabs = parseJSON(card?.params?.multi_tab)
    if (shelf.style !== 'row' || !Array.isArray(tabs) || flip === undefined || flip === null) return []
    const known = new Map(CHANNELS.map((c) => [c.id, c.title]))
    const wanted = tabs.flatMap((tab: any) => {
      const keys = dataKeys(text(tab?.data_key) ?? '')
      return keys.source_key && known.has(keys.source_key) && keys.rec_module_id ? [{ tab, keys }] : []
    })
    const rows = await Promise.all(wanted.map(({ tab, keys }) => this.tabSection(tab, keys, flip, shelf, signal).catch(() => undefined)))
    return rows.filter((row): row is FeedSection => row !== undefined)
  }

  private async tabSection(tab: any, keys: Record<string, string>, flip: unknown, shelf: FeedSection, signal?: AbortSignal): Promise<FeedSection | undefined> {
    const name = text(tab.tab_name)
    const source = keys.source_key
    if (!name || !source) return undefined
    const params = {
      ...(isObject(tab) ? tab : {}), page_id: 'scms_shake', page_type: 'scms_shake', source_key: source,
      tag_id: keys.rec_module_id, tag_type: keys.rec_module_type ?? '801002', new_mark_label_enabled: '1',
    }
    const response = await this.session.gateway('trpc.vector_layout.page_view.PageService/getCard', {
      query: PAGE_QUERY,
      body: { page_params: params, page_context: { page_index: '1' }, flip_info: flip },
      signal,
    })
    const items = (response?.data?.card?.children_list?.list?.cards ?? []).map((c: any) => mediaItem(c?.params)).filter(Boolean) as MediaItem[]
    if (!items.length) return undefined
    const hot = LIBRARY_ROWS[0]!
    const channelTitle = CHANNELS.find((c) => c.id === source)?.title ?? name
    return {
      id: `${shelf.id}:${source}`, title: `${shelf.title ?? ''} · ${name}`, style: 'row', items,
      more: { title: `${channelTitle} · ${hot.title}`, route: `lib:${source}:${hot.sort}` },
    }
  }

  /** `lib:<频道>:<排序>`：频道片库，按页。 */
  async more(route: string, cursor: string | undefined, signal?: AbortSignal): Promise<MediaItemPage> {
    const parts = route.split(':')
    if (parts.length !== 3 || parts[0] !== 'lib') return { items: [], next: null }
    return this.library(parts[1]!, parts[2]!, Number(cursor) || 1, undefined, signal)
  }

  /** 我的追剧（`getAlbumList` scene 1）：一页 20 部，从 0 开始；要登录。 */
  async chasing(page: number, signal?: AbortSignal): Promise<MediaItemPage> {
    await this.session.ensureSession(signal)
    const response = await this.session.gateway('trpc.universal_backend_service.video_list.VideoListService/getAlbumList', {
      query: { appid: '3000005', video_appid: '3000005', new_mark_label_enabled: '1', vversion_platform: '2' },
      body: { scene: 1, filter: 1, page, size: 20 },
      signal,
    })
    const ret = int(response?.ret)
    if (ret === 1110001 || ret === 1100005 || ret === 15006) throw loginRequired()
    if (ret !== 0) throw apiError(response?.ret, text(response?.msg))
    const items = (response.data?.list ?? []).map(chasingItem).filter(Boolean) as MediaItem[]
    return { items, next: response.data?.has_next === true && items.length ? String(page + 1) : null }
  }

  /** 按 `sort` 排好的频道片库的一页（21 部）。 */
  async library(channel: string, sort: string, page: number, filters?: string, signal?: AbortSignal): Promise<MediaItemPage> {
    const data = await this.libraryPage(channel, filters ?? `sort=${sort}&itype=-1&iarea=-1&iyear=-1&ipay=-1`, page, signal)
    const items = libraryItems(data)
    return { items, next: data?.has_next_page === true && items.length ? String(page + 1) : null }
  }

  /** `channel_list_second_page`：第 0 页是筛选项（和头几部），第 `n` 页（空 context）是第 `n` 页节目。 */
  async libraryPage(channel: string, filters: string, page: number, signal?: AbortSignal): Promise<any> {
    const response = await this.session.gateway('trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData', {
      query: { video_appid: '1000005', vplatform: '2', vversion_name: '8.9.10' },
      body: {
        page_params: {
          page_type: 'channel_operation', page_id: 'channel_list_second_page', channel_id: channel,
          filter_params: filters, page: String(page), new_mark_label_enabled: '1',
        },
        page_context: {},
      },
      signal,
    })
    if (int(response?.ret) !== 0) throw apiError(response?.ret, text(response?.msg) ?? '片库加载失败')
    return response.data
  }
}
