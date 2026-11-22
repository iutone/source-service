// 搜索：`mtop.youku.soku.yksearch`（docs/youku-web/SEARCH.md），搜索页自己的 appKey。热搜榜、拼音联想、优酷自己的节目（影视 tab，
// 一页就是全部结果）。照 App 的 YoukuSearchService / YoukuSearchParser 移植。不登录也能用；结果要 cookie 里有 `cna`。
import type { MediaItem, SearchRanking, SearchResults, SearchSuggestion, Target, VideoItem } from '@iyt-source/protocol'
import { arr, compact, int, sortedJSON, text, webImage, type J } from './json.ts'
import { APP_KEY, type MTOPClient } from './mtop.ts'
import { shortVideoTarget, targetID } from './feed.ts'

export const SEARCH_APP_KEY = '23774304'
const API = 'mtop.youku.soku.yksearch'
/** 影视 tab：只有节目卡片，一页就是全部。 */
const SHOWS_CATEGORY = '2007'

function walk(root: J, predicate: (node: J) => boolean): J[] {
  const found: J[] = []
  const visit = (node: J) => {
    if (predicate(node)) found.push(node)
    for (const child of arr(node?.nodes)) visit(child)
  }
  visit(root)
  return found
}

function leaves(node: J): J[] {
  return arr(node?.nodes).flatMap((child: J) => (arr(child?.nodes).length === 0 ? [child] : leaves(child)))
}

/** 搜索的角标：VIP / 付费 type 3，独播 / 限免 / 预告 type 0。 */
function searchBadge(icon: J) {
  const label = text(icon?.tagText)
  return label ? { text: label, tone: int(icon?.tagType) === 3 ? 'gold' as const : 'red' as const } : undefined
}

/** `youku://play?source=search&showid=…`，或短剧的 `ykshortvideo://video_play?…&groupId=…`。 */
export function routeTarget(route: string | undefined): Target | undefined {
  if (!route) return undefined
  const short = shortVideoTarget(route)
  if (short) return short
  const at = route.indexOf('?')
  if (at < 0) return undefined
  for (const pair of route.slice(at + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq).toLowerCase() === 'showid') {
      let value = pair.slice(eq + 1)
      try { value = decodeURIComponent(value) } catch { /* 原样 */ }
      if (value) return { show: value }
    }
  }
  return undefined
}

/** 去掉 `<em>` 高亮。 */
export function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

// MARK: 热搜（`appScene: default_page`）

/** 类型 9119 组件的各个 tab；每个 tab 的叶子是排好的节目（9559）。 */
export function parseRankings(root: J): SearchRanking[] {
  const component = walk(root, (n) => int(n?.type) === 9119)[0]
  if (!component) return []
  const tabs = arr(component?.data?.tabs).length ? arr(component.data.tabs) : arr(arr(component.nodes)[0]?.data?.tabs)
  const out: SearchRanking[] = []
  for (const tab of tabs) {
    const title = text(tab?.title)
    if (!title) continue
    const items = leaves(tab.node).map((leaf, index) => rankedShow(leaf?.data, int(leaf?.data?.rank) ?? index + 1)).filter((x): x is MediaItem => Boolean(x))
    if (items.length) out.push({ id: text(tab.tabId) ?? title, title, items })
  }
  return out
}

function rankedShow(data: J, rank: number): MediaItem | undefined {
  const title = text(data?.title)
  const target = routeTarget(text(data?.action?.value))
  if (!title || !target) return undefined
  const poster = data.posterDTO
  return compact({
    id: targetID(target), title, subtitle: text(data.videoInfo), posterURL: webImage(poster?.vThumbUrl),
    badge: searchBadge(poster?.iconCorner), caption: text(poster?.rightBottomText), rank, target,
  })
}

// MARK: 联想（`appScene: kubox`）

export function parseSuggestions(root: J): SearchSuggestion[] {
  const seen = new Set<string>()
  const out: SearchSuggestion[] = []
  for (const leaf of walk(root, (n) => int(n?.type) === 1526)) {
    const data = leaf.data
    const raw = text(data?.w) ?? text(data?.keyword)
    const keyword = raw ? plainText(raw) : ''
    if (!keyword || seen.has(keyword)) continue
    seen.add(keyword)
    out.push(compact({ keyword, tag: text(data?.sugIconDTO?.tagText), detail: text(data?.rightText) }))
  }
  return out
}

// MARK: 结果（`appScene: mobile_multi`，`categories: 2007`）

/** 节目卡片：大卡（1027）、相关作品（1515）、IP 合集里的一项（9501）。 */
function showCard(data: J): MediaItem | undefined {
  const showID = text(data?.showId)
  const name = text(data?.titleDTO?.displayName)
  if (!showID || !name) return undefined
  const poster = data.posterDTO
  const facts = [text(data.cats), text(data.releaseDate)].filter(Boolean).join(' · ')
  return compact({
    id: showID,
    title: plainText(name),
    subtitle: text(data?.featureDTO?.text) ?? (facts || undefined),
    posterURL: webImage(poster?.vThumbUrl),
    landscapeURL: webImage(data.thumbUrl),
    badge: searchBadge(poster?.iconCorner),
    caption: text(data.stripeBottom) ?? text(poster?.leftBottomText?.title),
    target: { show: showID },
  })
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds / 60) % 60
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 节目的一集（1503）或一期（1525）。 */
function episode(data: J, show: MediaItem): VideoItem | undefined {
  const id = text(data?.videoId)
  if (!id) return undefined
  const stage = text(data.showVideoStage)
  const label = stage ? (/^\d+$/.test(stage) ? `第${stage}集` : stage) : undefined
  // 普通剧集的标题是「甄嬛传 01」，不比集数多说什么。
  const name = text(data.title)
  const seconds = int(data.seconds)
  return compact({
    id,
    showID: show.id,
    title: [show.title, label].filter(Boolean).join(' '),
    subtitle: name && !name.startsWith(show.title) ? name : undefined,
    coverURL: webImage(data.thumbUrl),
    posterURL: show.posterURL,
    badge: searchBadge(data.iconCorner),
    caption: seconds !== undefined ? duration(seconds) : undefined,
  })
}

export function titleMatches(title: string, keyword: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s《》]/g, '')
  const name = normalize(title)
  // 「大明风华 TV版(别名:大明皇妃孙若微传)」。
  const base = name.split('(')[0]
  return name === normalize(keyword) || base === normalize(keyword)
}

/** 优酷自己的节目，按结果顺序；第一张标题正好是搜索词的大卡（1027）作为最佳匹配（续集可能排在正篇前面）。 */
export function parseResults(root: J, keyword: string): SearchResults {
  const shows: { item: MediaItem; data: J; episodes: J[]; isCard: boolean }[] = []
  const seen = new Set<string>()
  for (const module of arr(root?.nodes)) {
    const components = arr(module?.nodes)
    // 剧集（1035）或期数（1052）跟在同一模块里节目大卡（1027）的后面。
    const episodes = arr(components.find((c: J) => [1035, 1052].includes(int(c?.type) ?? -1))?.nodes)
    for (const leaf of components.flatMap((c: J) => arr(c?.nodes))) {
      const type = int(leaf?.type)
      if (![1027, 1515, 9501].includes(type ?? -1) || int(leaf?.data?.isYouku) !== 1) continue
      const item = showCard(leaf.data)
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      const isCard = type === 1027
      shows.push({ item, data: leaf.data, episodes: isCard ? episodes : [], isCard })
    }
  }
  const index = shows.findIndex((s) => s.isCard && titleMatches(s.item.title, keyword))
  if (index < 0) return { shows: shows.map((s) => s.item), videos: [] }
  const [top] = shows.splice(index, 1)
  const info = text(top.data.info)
  return {
    topMatch: compact({
      show: top.item,
      facts: text(top.data?.featureDTO?.text),
      summary: info?.startsWith('简介：') ? info.slice('简介：'.length) : info,
      cast: text(top.data.notice)?.trim(),
      episodes: top.episodes.map((e) => episode(e?.data, top.item)).filter((x): x is VideoItem => Boolean(x)),
    }),
    shows: shows.map((s) => s.item),
    videos: [],
  }
}

export class YoukuSearch {
  private readonly client: MTOPClient
  private readonly utdid: () => Promise<string>

  constructor(client: MTOPClient, utdid: () => Promise<string>) {
    this.client = client
    this.utdid = utdid
  }

  private call(data: Record<string, unknown>, signal?: AbortSignal): Promise<J> {
    return this.client.call(API, '2.0', data, { appKey: SEARCH_APP_KEY, signal })
  }

  async rankings(signal?: AbortSignal): Promise<SearchRanking[]> {
    return parseRankings(await this.call({
      pg: '1', pz: '12', searchFrom: 'home', utdId: await this.utdid(), ykPid: '', sdkver: 314, pcKuFlixMode: 1, appScene: 'default_page', appCaller: 'youku-search-sdk',
    }, signal))
  }

  async suggestions(text: string, signal?: AbortSignal): Promise<SearchSuggestion[]> {
    const keyword = text.trim()
    if (!keyword) return []
    return parseSuggestions(await this.call({
      pg: '1', pz: '12', searchFrom: 'home', utdId: await this.utdid(), ykPid: '', sdkver: 314, pcKuFlixMode: 1, appScene: 'kubox', appCaller: 'pc',
      s: 'pc', device: 'pc', platform: 'pc', keyword,
    }, signal))
  }

  async search(raw: string, signal?: AbortSignal): Promise<SearchResults> {
    const keyword = raw.trim()
    if (!keyword) return { shows: [], videos: [] }
    const system = { osVer: '1.0.0', zx: 0, zx_list: '', appPackageKey: 'com.youku.pcweb', appPackageId: 'com.youku.pcweb', os: 'pcweb', ver: '1.0.0.0', pid: '' }
    return parseResults(await this.call({
      searchType: 1, keyword, pg: 1, pz: 20, site: 1, appCaller: 'pc', appScene: 'mobile_multi', userTerminal: 2, sdkver: 313, pcKuFlixMode: 1,
      userFrom: 1, noqc: 0, ftype: 0, duration: '', categories: SHOWS_CATEGORY, ob: '', utdId: await this.utdid(), userType: 'guest', userNumId: 0,
      searchFrom: 1, sourceFrom: 'home', ykPid: '', appKey: APP_KEY, system_info: sortedJSON(system),
    }, signal), keyword)
  }
}
