// 搜索与观看历史（照 App 的 BilibiliSearchService / BilibiliHistoryService）。
// 搜索：`search/all/v2` 的番剧 / 影视和投稿视频，`search/type` 翻更多视频，`s.search.bilibili.com` 联想，没输入时给 PGC 榜。
// 历史：`history/cursor` 按游标翻页，这里记住每一页的游标给页码用；删除按 `kid`（`archive_<aid>` / `pgc_<season id>`）逐条。
import type { HistoryPage, MediaItem, MediaItemPage, SearchRanking, SearchResults, SearchSuggestion } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { pgcRanking } from './feed.ts'
import { historyItem, ranked, searchSeason, searchVideo, type HistoryEntry, type SearchHit } from './models.ts'
import { MESSAGES, type BiliSession } from './session.ts'
import { API, encode } from './sign.ts'

const searchReferer = (keyword: string) => `https://search.bilibili.com/all?keyword=${encode(keyword)}`
const keep = <T>(list: (T | undefined)[]) => list.filter((value): value is T => value !== undefined)

export async function rankings(session: BiliSession, signal: AbortSignal): Promise<SearchRanking[]> {
  const [bangumi, movies, series] = await Promise.all([1, 2, 5].map((type) => pgcRanking(session, type, signal)))
  return [
    { id: 'bangumi', title: '热门番剧', items: ranked(bangumi) },
    { id: 'movie', title: '热门电影', items: ranked(movies) },
    { id: 'tv', title: '热门电视剧', items: ranked(series) },
  ].filter((ranking) => ranking.items.length > 0)
}

/** 联想：按输入缓存一分钟（App 每输入一个字都会调）。 */
const suggestionCache = new Map<string, { at: number; list: SearchSuggestion[] }>()

export async function suggestions(session: BiliSession, text: string, signal: AbortSignal): Promise<SearchSuggestion[]> {
  const term = text.trim()
  if (!term) return []
  const cached = suggestionCache.get(term)
  if (cached && Date.now() - cached.at < 60_000) return cached.list
  const data = await session.json<{ result?: { tag?: { value: string }[] } }>(
    `https://s.search.bilibili.com/main/suggest?term=${encode(term)}&main_ver=v1`, signal)
  const list = (data.result?.tag ?? []).map((tag) => ({ keyword: tag.value }))
  suggestionCache.set(term, { at: Date.now(), list })
  if (suggestionCache.size > 300) suggestionCache.delete(suggestionCache.keys().next().value!)
  return list
}

export async function search(session: BiliSession, keyword: string, signal: AbortSignal): Promise<SearchResults> {
  const data = await session.get<{ result?: { result_type: string; data?: SearchHit[] | null }[] | null; numPages?: number; v_voucher?: string }>(
    `${API}/x/web-interface/wbi/search/all/v2`,
    { keyword, page: '1', platform: 'pc', web_location: '1430654' },
    { signal, referer: searchReferer(keyword) },
  )
  // 风控要验证码时只给 `v_voucher`。
  if (!data.result && data.v_voucher) throw new SourceError('throttled', MESSAGES.riskControl)
  const hits = (type: string) => (data.result ?? []).find((group) => group.result_type === type)?.data ?? []
  const shows = keep([...hits('media_bangumi'), ...hits('media_ft')].map(searchSeason))
  const videos = keep(hits('video').map(searchVideo))
  return { shows, videos, moreVideos: (data.numPages ?? 1) > 1 ? '2' : null }
}

export async function searchVideos(session: BiliSession, keyword: string, cursor: string, signal: AbortSignal): Promise<MediaItemPage> {
  const page = Math.max(2, Number(cursor) || 2)
  const data = await session.get<{ result?: SearchHit[] | null; numPages?: number; v_voucher?: string }>(
    `${API}/x/web-interface/wbi/search/type`,
    { keyword, search_type: 'video', page: String(page), page_size: '42', platform: 'pc', web_location: '1430654' },
    { signal, referer: searchReferer(keyword) },
  )
  if (!data.result && data.v_voucher) throw new SourceError('throttled', MESSAGES.riskControl)
  const items: MediaItem[] = keep((data.result ?? []).map(searchVideo))
  return { items, next: page < (data.numPages ?? page) ? String(page + 1) : null }
}

// MARK: 历史

const HISTORY_PAGE = 30

interface HistoryCursor {
  max: number
  view_at: number
  business?: string
}

export class History {
  private readonly session: BiliSession
  /** 第 n 页的游标（第 1 页没有）。 */
  private readonly cursors = new Map<number, HistoryCursor>()

  constructor(session: BiliSession) {
    this.session = session
  }

  async page(page: number, signal: AbortSignal): Promise<HistoryPage> {
    if (page <= 1) this.cursors.clear()
    // 服务重启后没有这一页的游标：从第一页往后走到这一页（最多 20 页）。
    for (let walk = 1; page > 1 && !this.cursors.has(page) && walk < Math.min(page, 20); walk++) {
      if (!this.cursors.has(walk + 1)) {
        const result = await this.fetch(walk, signal)
        if (!result.hasMore) return { items: [], hasMore: false }
      }
    }
    return this.fetch(page, signal)
  }

  private async fetch(page: number, signal: AbortSignal): Promise<HistoryPage> {
    const params: Record<string, string> = { ps: String(HISTORY_PAGE), type: 'all' }
    if (page > 1) {
      const cursor = this.cursors.get(page)
      if (!cursor) return { items: [], hasMore: false }
      params.max = String(cursor.max)
      params.view_at = String(cursor.view_at)
      if (cursor.business) params.business = cursor.business
    }
    const data = await this.session.get<{ cursor?: HistoryCursor; list?: (HistoryEntry | null)[] | null }>(
      `${API}/x/web-interface/history/cursor`, params, { signal, sign: 'none' })
    const list = data.list ?? []
    const hasMore = list.length > 0 && (data.cursor?.max ?? 0) > 0
    if (hasMore && data.cursor) this.cursors.set(page + 1, data.cursor)
    return { items: keep(list.map((entry) => (entry ? historyItem(entry) : undefined))), hasMore }
  }

  async delete(keys: string[], signal: AbortSignal): Promise<void> {
    for (const key of keys) {
      if (!/^(archive|pgc)_\d+$/.test(key)) throw new SourceError('bad_request', `不是观看记录：${key}`)
      await this.session.action(`${API}/x/v2/history/delete`, { kid: key }, signal)
    }
  }

  async clear(signal: AbortSignal): Promise<void> {
    await this.session.action(`${API}/x/v2/history/clear`, {}, signal)
    this.cursors.clear()
  }
}
