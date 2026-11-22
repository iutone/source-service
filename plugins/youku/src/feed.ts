// 首页与频道：`mtop.youku.columbus.home.query`（docs/youku-web/HOME.md §3、§7），「更多」走节点页网关
// `columbus.gateway.new.execute`（ms_codes 2019041100）；筛选是同一接口的 `nodeKey=ALL`（docs/youku-web/FILTER.md）。
// 照 App 的 YoukuFeedService / YoukuFeedParser / YoukuFilterService 移植。不登录也能用，登录后首页按账号推荐。
import type { Channel, FeedPage, FeedSection, FilterCategory, FilterDimension, FilterSelection, MediaItem, MediaItemPage, Reservation, SectionStyle, Target } from '@iyt-source/protocol'
import { SourceError, badRequest } from '@iyt-source/kit'
import { arr, bool, compact, int, isNull, num, sortedJSON, text, tone, trimmed, webImage, type J } from './json.ts'
import { APP_KEY, type MTOPClient } from './mtop.ts'

export const HOME_MS_CODE = '2019061000'
export const NODE_MS_CODE = '2019041100'
export const HOME_NODE_KEY = 'WEBHOME'
/** 不是视频信息流的频道：直播、小游戏。 */
const EXCLUDED_NODE_KEYS = new Set([HOME_NODE_KEY, 'WEBLIVE', 'PLAYCENTER2'])

export const HOME_CHANNEL: Channel = { id: HOME_NODE_KEY, title: '首页' }
/** 默认置顶（电视）：频道列表里的 `nodeKey`（HOME.md §7.1）。 */
export const PINNED_CHANNELS: Channel[] = [
  { id: 'WEBMOVIE', title: '电影' },
  { id: 'WEBTV', title: '电视剧' },
  { id: 'WEBVARIETY', title: '综艺' },
  { id: 'WEBCOMIC', title: '动漫' },
]
/** 读不到频道列表时用的。 */
export const FALLBACK_CHANNELS: Channel[] = [
  ...PINNED_CHANNELS,
  { id: 'WEBDUANJU', title: '短剧' },
  { id: 'WEBCHILD', title: '少儿' },
  { id: 'WEBDOCUMENTARY', title: '纪录片' },
]

// MARK: 树

export function nodes(node: J): J[] {
  return arr(node?.nodes)
}

/** 带 `typeName` 的节点，深度优先，同名取第一个。 */
export function componentsByTypeName(root: J): Map<string, J> {
  const found = new Map<string, J>()
  const walk = (node: J) => {
    for (const child of nodes(node)) {
      const name = text(child?.typeName)
      if (name && !found.has(name)) found.set(name, child)
      walk(child)
    }
  }
  walk(root)
  return found
}

/** `data.mark.data`：「独播」（RED）、「VIP」（YELLOW）、「预告」（BLUE）。 */
export function badge(data: J) {
  const mark = data?.mark?.data
  const label = text(mark?.text)
  return label ? { text: label, tone: tone(mark?.color) } : undefined
}

/** `data.action`：`JUMP_TO_SHOW`（节目 id）、`JUMP_TO_VIDEO`（视频 id），或短剧的 `JUMP_TO_NATIVE`。 */
export function mediaTarget(data: J): Target | undefined {
  const action = data?.action
  const value = text(action?.value)
  if (!value) return undefined
  switch (action?.type) {
    case 'JUMP_TO_SHOW':
      return { show: value }
    case 'JUMP_TO_VIDEO':
      return { video: value }
    case 'JUMP_TO_NATIVE':
      return shortVideoTarget(value)
    default:
      return undefined
  }
}

/**
 * `ykshortvideo://video_play?vid=…&groupType=show&groupId=<节目>` 的节目，否则视频。query 手工拆：有的路由带没转义的 JSON
 * （`context={"appid":…}`）。
 */
export function shortVideoTarget(route: string): Target | undefined {
  const at = route.indexOf('?')
  if (at < 0 || route.slice(0, at) !== 'ykshortvideo://video_play') return undefined
  const query: Record<string, string> = {}
  for (const pair of route.slice(at + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const raw = pair.slice(eq + 1)
    let value = raw
    try { value = decodeURIComponent(raw) } catch { /* 原样 */ }
    query[pair.slice(0, eq)] = value
  }
  if (query.groupId && (query.groupType ?? 'show') === 'show') return { show: query.groupId }
  if (query.vid) return { video: query.vid }
  return undefined
}

export function targetID(target: Target): string {
  return 'show' in target ? target.show : target.video
}

/** 推荐、系列这类卡片节点（和首页条目同样的形状）。 */
export function cardItem(node: J): MediaItem | undefined {
  const data = node?.data
  const title = text(data?.title)
  const target = mediaTarget(data)
  if (!title || !target) return undefined
  return compact({
    id: targetID(target),
    title,
    subtitle: text(data.subtitle) ?? text(data?.reason?.text?.title),
    posterURL: webImage(data.img),
    landscapeURL: webImage(data.hImg),
    badge: badge(data),
    caption: text(data.summary) ?? text(arr(data.lbTexts)[0]?.title),
    target,
  })
}

// MARK: 频道

/** `showNodeList=1` 的导航：请求页之外的第 0 级节点。H5 链接（繁星）、筛选页、别的接口的频道不算。 */
export function parseChannels(root: J): Channel[] {
  const out: Channel[] = []
  for (const node of nodes(root)) {
    const data = node?.data
    const key = text(data?.nodeKey)
    const title = text(data?.title)
    if (!key || !title || !isNull(data.type) || !isNull(data.apiName) || EXCLUDED_NODE_KEYS.has(key)) continue
    out.push({ id: key, title })
  }
  return out
}

export function sectionStyle(typeName: string): SectionStyle {
  if (typeName.includes('LUNBO')) return 'hero'
  if (typeName.includes('FEED_SUBSCRIBE')) return 'continueWatching'
  if (typeName.includes('BILLBOARD') || typeName.includes('BILLOARD')) return 'ranking'
  if (typeName.includes('RESERVE') || typeName.includes('SMALL_CATEGORY')) return 'upcoming'
  if (typeName.includes('SHORT_VIDEO')) return 'shortVideo'
  return 'row'
}

/** 分区是第 2 级节点：首页第一页在模块下面，后面的页直接在根上。 */
export function sectionNodes(root: J): J[] {
  const found: J[] = []
  const walk = (node: J) => {
    for (const child of nodes(node)) {
      if (int(child?.level) === 2) found.push(child)
      else walk(child)
    }
  }
  walk(root)
  return found
}

function paginationNode(root: J): J | undefined {
  let found: J
  const walk = (node: J) => {
    for (const child of nodes(node)) {
      if (found) return
      if (child?.typeName === 'FEED_DRAWER_PAGINATION') found = child
      else walk(child)
    }
  }
  walk(root)
  return found
}

/** 预约中的节目：`data.reserve`，上线时间是 `onlineDesc`（「今天上线」）。 */
function reservation(data: J): Reservation | undefined {
  const reserve = data?.reserve
  const id = text(reserve?.id)
  if (!id) return undefined
  return compact({
    id,
    onlineText: trimmed(data.onlineDesc) ?? trimmed(data?.reason?.text?.title),
    count: int(reserve.count),
    isReserved: bool(reserve.isReserve) ?? bool(reserve.reserve) ?? false,
  })
}

/** 一张卡片；`rank` 只给排行榜。 */
export function feedItem(node: J, style: SectionStyle, rank: number): MediaItem | undefined {
  const data = node?.data
  const title = text(data?.title)
  const target = mediaTarget(data)
  if (!title || !target) return undefined
  const reserve = reservation(data)
  // 在看（`KU_FLIX_HISTORY`）：进度和「看至14%」。
  const percent = num(data.playPercent)
  const statusTag = trimmed(arr(data.tags).find((t: J) => int(t?.uiType) === 1)?.text?.title)
  const caption = reserve?.onlineText ?? trimmed(data.summary) ?? trimmed(arr(data.lbTexts)[0]?.title) ?? statusTag
  const subtitle = trimmed(data.playPercentLabel) ?? trimmed(data.subtitle) ?? trimmed(data?.reason?.text?.title)
  // 短视频只有一张横图。
  const landscape = text(data.hImg) ?? (style === 'shortVideo' ? text(data.img) : undefined)
  return compact({
    id: targetID(target),
    title,
    subtitle: subtitle === caption ? undefined : subtitle,
    posterURL: webImage(data.img),
    landscapeURL: webImage(landscape),
    badge: badge(data),
    caption,
    progress: percent === undefined ? undefined : Math.min(Math.max(percent / 100, 0), 1),
    rank: style === 'ranking' ? rank : undefined,
    reservation: reserve,
    target,
  })
}

export function section(node: J): FeedSection | undefined {
  const typeName = text(node?.typeName) ?? ''
  if (typeName === 'YK_AD_COMPONENT') return undefined
  const data = node?.data
  const style = sectionStyle(typeName)
  // 「每日更新」每个星期几一个 tab：取当天的（勾选的）。
  let itemNodes = nodes(node)
  if (typeName.includes('MULTI_TAB')) itemNodes = nodes(itemNodes.find((n) => bool(n?.data?.checked) === true) ?? itemNodes[0])
  const items = itemNodes.map((n, i) => feedItem(n, style, i + 1)).filter((x): x is MediaItem => Boolean(x))
  if (items.length === 0) return undefined
  const title = text(data?.title)
  return compact({
    id: text(node?.id) ?? title ?? typeName,
    title,
    style,
    items,
    more: more(data?.moreAction, title),
  })
}

/** 第 `pageNo` 页（`root` 是 `data["2019061000"].data`）：分区和下一页的 session，到头为 undefined。 */
export function parseFeedPage(root: J, pageNo: number): { sections: FeedSection[]; nextSession?: string } {
  const sections = sectionNodes(root).map(section).filter((s): s is FeedSection => Boolean(s))
  // 第一页的游标在分页模块里，后面的页在根上。
  const session = pageNo === 1 ? paginationNode(root)?.data?.session : root?.data?.session
  const maxPage = int(root?.data?.pageNumMax)
  // 过了真正的末尾，服务器还会一直给空页（HOME.md §7.2）。
  const isLast = sections.length === 0 || (pageNo > 1 && bool(root?.more) === false) || (maxPage !== undefined && pageNo >= maxPage)
  return { sections, nextSession: isLast ? undefined : jsonString(session) }
}

/** session 回来是对象，发出去是 JSON 字符串。 */
export function jsonString(value: J): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (value && typeof value === 'object') return JSON.stringify(value)
  return undefined
}

// MARK: 更多

interface MoreRoute { nodeKey: string; bizContext: string }
interface MoreCursor { pageNo: number; session: string; offset: number }

/** `moreAction.value` 是 `youku://kuflix/node?bizKey=kuflix_node_page&nodeKey=…&bizContext=…&title=…`；没有 `type` 就没有第二页。 */
export function more(action: J, sectionTitle?: string) {
  if (!text(action?.type)) return undefined
  const value = text(action?.value)
  if (!value) return undefined
  let query: URLSearchParams
  try {
    query = new URL(value).searchParams
  } catch {
    return undefined
  }
  const nodeKey = query.get('nodeKey')
  const bizContext = query.get('bizContext')
  if (query.get('bizKey') !== 'kuflix_node_page' || !nodeKey || !bizContext) return undefined
  return { title: query.get('title') || sectionTitle || '更多', route: sortedJSON({ bizContext, nodeKey }) }
}

/** 节点页（`data["2019041100"].data`）：第一页是 页 → 模块 → 组件 → 条目，后面的页就是组件本身。 */
export function parseMorePage(root: J, offset: number): { items: MediaItem[]; nextSession?: string } {
  const component = int(root?.level) === 2 ? root : sectionNodes(root)[0]
  if (!component) return { items: [] }
  const style = sectionStyle(text(component.typeName) ?? '')
  const items = nodes(component).map((n, i) => feedItem(n, style, offset + i + 1)).filter((x): x is MediaItem => Boolean(x))
  const hasMore = bool(component.more) === true && items.length > 0
  return { items, nextSession: hasMore ? jsonString(component?.data?.session) : undefined }
}

// MARK: 请求

/** `params`、`system_info` 都是 JSON 字符串，放在 JSON 的 `data` 里。 */
export function columbusRequest(msCode: string, params: Record<string, unknown>): Record<string, string> {
  const system = { appPackageKey: 'com.youku.pcweb', appPackageId: 'com.youku.pcweb', device: 'pcweb', os: 'pcweb', ver: '1.0.0.0', appkey: APP_KEY }
  return { ms_codes: msCode, params: sortedJSON(params), system_info: sortedJSON(system) }
}

function baseParams(utdid: string, bizKey: string, nodeKey: string, pageNo: number, showNodeList: boolean): Record<string, unknown> {
  return {
    debug: 0, utdid, appPackageKey: 'com.youku.pcweb', appPackageId: 'com.youku.pcweb', ip: '127.0.0.1', reqSubNode: 0, gray: '0',
    pageNo, bizKey, showNodeList: showNodeList ? 1 : 0, nodeKey, appKey: APP_KEY,
  }
}

function decodeCursor<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw badRequest(`${what}的翻页参数不对`)
  }
}

export class YoukuFeed {
  private readonly client: MTOPClient
  private readonly utdid: () => Promise<string>

  constructor(client: MTOPClient, utdid: () => Promise<string>) {
    this.client = client
    this.utdid = utdid
  }

  /** 返回 `data["2019061000"].data`。 */
  private async home(nodeKey: string, pageNo: number, session: string | undefined, showNodeList: boolean, signal?: AbortSignal): Promise<J> {
    const params = baseParams(await this.utdid(), 'kuflix_pc_home', nodeKey, pageNo, showNodeList)
    // 不带上一页的 session，服务器总是回第一页。
    if (session) params.session = session
    const data = await this.client.call('mtop.youku.columbus.home.query', '1.0', columbusRequest(HOME_MS_CODE, params), { signal })
    const root = data?.[HOME_MS_CODE]?.data
    if (isNull(root)) throw new SourceError('upstream_changed', '优酷的频道接口没有返回内容')
    return root
  }

  async channels(signal?: AbortSignal): Promise<Channel[]> {
    return parseChannels(await this.home(HOME_NODE_KEY, 1, undefined, true, signal))
  }

  async channel(nodeKey: string, cursor: string | undefined, signal?: AbortSignal): Promise<FeedPage> {
    let pageNo = 1
    let session: string | undefined
    if (cursor) {
      const decoded = decodeCursor<{ pageNo: number; session: string }>(cursor, '频道')
      pageNo = decoded.pageNo
      session = decoded.session
    }
    const page = parseFeedPage(await this.home(nodeKey, pageNo, session, false, signal), pageNo)
    return { sections: page.sections, next: page.nextSession ? sortedJSON({ pageNo: pageNo + 1, session: page.nextSession }) : null }
  }

  async more(route: string, cursor: string | undefined, signal?: AbortSignal): Promise<MediaItemPage> {
    const target = decodeCursor<MoreRoute>(route, '更多')
    if (!target.nodeKey || !target.bizContext) throw badRequest('更多的参数不对')
    const position = cursor ? decodeCursor<MoreCursor>(cursor, '更多') : undefined
    const pageNo = position?.pageNo ?? 1
    const offset = position?.offset ?? 0
    const params = baseParams(await this.utdid(), 'kuflix_node_page', target.nodeKey, pageNo, false)
    // 原样传路由里的 bizContext。
    params.bizContext = target.bizContext
    if (position?.session) params.session = position.session
    const data = await this.client.call('mtop.youku.columbus.gateway.new.execute', '1.0', columbusRequest(NODE_MS_CODE, params), { signal })
    const root = data?.[NODE_MS_CODE]?.data
    if (isNull(root)) throw new SourceError('upstream_changed', '优酷的更多页没有返回内容')
    const page = parseMorePage(root, offset)
    return {
      items: page.items,
      next: page.nextSession ? sortedJSON({ offset: offset + page.items.length, pageNo: pageNo + 1, session: page.nextSession }) : null,
    }
  }
}

// MARK: 筛选

/** 类型行：网站上的名字（和频道名比对）与类别（id 就是 `type:` 的值）。 */
const NAMED_CATEGORIES: { name: string; category: FilterCategory }[] = [
  { name: '全部', category: { id: '全部', title: '全部' } },
  { name: '电视剧', category: { id: '电视剧', title: '电视剧' } },
  { name: '电影', category: { id: '电影', title: '电影' } },
  { name: '综艺', category: { id: '综艺', title: '综艺' } },
  { name: '动漫', category: { id: '动漫', title: '动漫' } },
  { name: '少儿', category: { id: '少儿', title: '少儿' } },
  { name: '纪录片', category: { id: '纪录片', title: '纪录片' } },
  { name: '人文', category: { id: '文化', title: '人文' } },
  { name: '体育', category: { id: '体育', title: '体育' } },
  { name: '游戏', category: { id: '游戏', title: '游戏' } },
]
export const FILTER_CATEGORIES: FilterCategory[] = NAMED_CATEGORIES.map((c) => c.category)
/** 有自己类别的频道；其他频道按名字对。 */
const CHANNEL_CATEGORIES: Record<string, string> = {
  WEBTV: '电视剧', WEBMOVIE: '电影', WEBVARIETY: '综艺', WEBCOMIC: '动漫', WEBCHILD: '少儿', WEBDOCUMENTARY: '纪录片',
}

/** 频道自己的筛选类别（App 的 `categories(for:)`）。 */
export function channelFilterCategories(channel: Channel): FilterCategory[] | undefined {
  const id = CHANNEL_CATEGORIES[channel.id]
  const found = NAMED_CATEGORIES.find((c) => c.category.id === id || c.name === channel.title)
  return found ? [found.category] : undefined
}

/** 按 `filterType` 起的名字（有的类别里行首写着「全部年份」「付费类型」「综合排序」）。 */
const DIMENSION_TITLES: Record<string, string> = {
  main_area: '地区', tags: '类型', year: '年份', status_type: '资费', pay_type: '资费', sort: '排序', theatre: '剧场',
  award_collection_index_meizi: '奖项', tag_label_name: '推荐', source: '规格', movie_theatre: '影厅', brand: '出品', completed: '连载',
  child_lable_type: '类型', age: '年龄', character_collection_index_new_meizi: '动画明星', company: '出品', people_collection_index: '大咖',
  game_brand: '品牌', game_type: '类型',
}

/** 一行：行首（没有 `value`）是「不限」（排序时是服务器自己的顺序），后面是选项。 */
export function parseDimension(row: J): FilterDimension | undefined {
  const options = nodes(row).map((n) => n?.data)
  const head = options[0]
  const type = text(head?.filterType)
  if (!type || options.length <= 1) return undefined
  const isSort = type === 'sort'
  const name = DIMENSION_TITLES[type] ?? text(head.title) ?? type
  const headTitle = (text(head.title) !== name ? text(head.title) : undefined) ?? (isSort ? '综合' : '全部')
  const choices = [{ id: '', title: headTitle }]
  for (const option of options.slice(1)) {
    const value = text(option?.value)
    const title = text(option?.title)
    if (value && title) choices.push({ id: value, title })
  }
  return compact({ id: type, title: name, options: choices, defaultOptionID: '', isSort: isSort || undefined })
}

/** 服务器每页先取这么多候选再丢掉一部分（FILTER.md §5）：空页按这个窗口往后跳。 */
const FILTER_WINDOW = 20
/** 一页凑够这么多，或者连续这么多个窗口都是空的（到头了）。 */
const FILTER_PAGE_TARGET = 12
const FILTER_EMPTY_LIMIT = 5

export class YoukuFilter {
  private readonly client: MTOPClient
  private readonly utdid: () => Promise<string>

  constructor(client: MTOPClient, utdid: () => Promise<string>) {
    this.client = client
    this.utdid = utdid
  }

  async dimensions(category: string, signal?: AbortSignal): Promise<FilterDimension[]> {
    const root = await this.query(category, {}, 1, undefined, true, signal)
    const rows = componentsByTypeName(root).get('TV_FILTER_CATEGORY')
    if (!rows) throw new SourceError('upstream_changed', '优酷没有返回筛选项')
    // 第一行是类别。
    return nodes(rows).slice(1).map(parseDimension).filter((d): d is FilterDimension => Boolean(d))
  }

  async results(category: string, selection: FilterSelection, cursor: string | undefined, signal?: AbortSignal): Promise<MediaItemPage> {
    const filters = Object.fromEntries(Object.entries(selection).filter(([, v]) => v))
    let position: { pageNo: number; session?: string } = cursor ? decodeCursor(cursor, '筛选') : { pageNo: 1 }
    const items: MediaItem[] = []
    let empty = 0
    while (items.length < FILTER_PAGE_TARGET && empty < FILTER_EMPTY_LIMIT) {
      const root = await this.query(category, filters, position.pageNo, position.session, false, signal)
      const grid = root?.typeName === 'KU_FLIX_V_GRID_COMPONENT' ? root : componentsByTypeName(root).get('KU_FLIX_V_GRID_COMPONENT')
      // 一个格子都没有：没有匹配的。
      if (!grid) return { items, next: null }
      const found = nodes(grid).map((n) => feedItem(n, 'row', 0)).filter((x): x is MediaItem => Boolean(x)).map((item) => compact({ ...item, rank: undefined }))
      items.push(...found)
      empty = found.length === 0 ? empty + 1 : 0
      const previous = position.session ? safeParse(position.session) : undefined
      const next: J = (grid?.data?.session && typeof grid.data.session === 'object') ? { ...grid.data.session } : previous
      if (!next || typeof next !== 'object') return { items, next: null }
      // 服务器按它返回的数量挪 `subIndex`：整个窗口都被丢掉的话会一直回同一个窗口。
      const start = int(previous?.subIndex) ?? 0
      const returned = int(next.subIndex) ?? start
      if (found.length === 0 || returned <= start) next.subIndex = start + FILTER_WINDOW
      position = { pageNo: position.pageNo + 1, session: JSON.stringify(next) }
    }
    return { items, next: empty < FILTER_EMPTY_LIMIT ? sortedJSON(position) : null }
  }

  private async query(category: string, filters: Record<string, string>, pageNo: number, session: string | undefined, refreshOptions: boolean, signal?: AbortSignal): Promise<J> {
    const filterParam = [`type:${category}`, ...Object.keys(filters).sort().map((k) => `${k}:${filters[k]}`)].join('|')
    const context: Record<string, unknown> = { filterParam, category }
    if (refreshOptions) context.optionRefresh = 1
    const params: Record<string, unknown> = {
      debug: 0, utdid: await this.utdid(), appPackageKey: 'com.youku.pcweb', ip: '127.0.0.1', reqSubNode: 1, gray: '0', pageNo,
      bizKey: 'kuflix_pc_home', showNodeList: 0, nodeKey: 'ALL', bizContext: sortedJSON(context),
    }
    if (session) params.session = session
    const data = await this.client.call('mtop.youku.columbus.home.query', '1.0', columbusRequest(HOME_MS_CODE, params), { signal })
    const root = data?.[HOME_MS_CODE]?.data
    if (isNull(root)) throw new SourceError('upstream_changed', '优酷的筛选接口没有返回内容')
    return root
  }
}

function safeParse(raw: string): J {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
