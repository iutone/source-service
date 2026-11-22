// 搜索（照 App 的 IQiyiSearchService）：热搜（`search/keywords/hotList`）、拼音联想（`suggest.video.iqiyi.com`）、
// 结果（`search/homePageV3`）：剧（模板 101 剧集、103 电影）和短视频（108）。
import type { MediaItem, MediaItemPage, SearchRanking, SearchResults, SearchSuggestion, SearchTopMatch, VideoItem } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import type { IQiyiSession } from './session.ts'
import { albumID, APP_VERSION, arr, idOf, image, int, MESH, num, sleep, str, text, videoID } from './util.ts'

/** 输入前显示的热搜榜，按接口给的标题挑。 */
const RANKING_TITLES = new Set(['热搜', '电视剧', '电影', '综艺', '动漫', '少儿', '纪录片'])
const PAGE_SIZE = 25
/** 搜索结果短时间缓存：App 每个关键词会先后要结果和第二页，平台又限流。 */
const RESULT_TTL = 5 * 60_000

interface Show {
  item: MediaItem
  facts?: string
  summary?: string
  cast?: string
  episodes: VideoItem[]
}

interface ResultPage {
  shows: Show[]
  videos: MediaItem[]
  hasMore: boolean
}

export class IQiyiSearch {
  private readonly cache = new Map<string, { at: number; page: Promise<ResultPage> }>()

  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  async rankings(signal: AbortSignal | undefined): Promise<SearchRanking[]> {
    const response = await this.session.json(`${MESH}/portal/lw/search/keywords/hotList`, {
      device_id: this.session.deviceID, uid: this.session.uid ?? '', v: APP_VERSION,
    }, signal)
    const rankings: SearchRanking[] = []
    for (const group of arr(response?.hotQuery)) {
      const title = text(group?.title)
      if (!title || !RANKING_TITLES.has(title)) continue
      const items = arr(group.items).map((item, index): MediaItem | undefined => {
        const qipu = idOf(item?.qipuId)
        const name = text(item?.title)
        if (!qipu || !name) return undefined
        const isAlbum = qipu.endsWith('01')
        const id = isAlbum ? albumID(qipu) : videoID(qipu)
        return {
          id, title: name, subtitle: text(item.tag),
          posterURL: image(item.image, 260, 360), landscapeURL: image(item.image, 592, 333),
          caption: text(item.specialTag), rank: index + 1,
          target: isAlbum ? { show: id } : { video: id },
        }
      }).filter((i): i is MediaItem => Boolean(i))
      if (items.length > 0) rankings.push({ id: title, title, items })
    }
    return rankings
  }

  async suggestions(input: string, signal: AbortSignal | undefined): Promise<SearchSuggestion[]> {
    const keyword = input.trim()
    if (!keyword) return []
    const response = await this.session.json('https://suggest.video.iqiyi.com/', { if: 'mobile', key: keyword, platform: '11', rltnum: '10' }, signal)
    return arr(response?.data).map((entry): SearchSuggestion | undefined => {
      const name = text(entry?.name)
      if (!name) return undefined
      const element = entry.presentation_element ?? {}
      return { keyword: name, tag: text(arr(element.tags)[0]?.name), detail: text(element.show_reason) }
    }).filter((s): s is SearchSuggestion => Boolean(s))
  }

  async search(keyword: string, signal: AbortSignal | undefined): Promise<SearchResults> {
    const page = await this.results(keyword, 1, signal)
    const shows = [...page.shows]
    let topMatch: SearchTopMatch | undefined
    const index = shows.findIndex((s) => s.item.title === keyword.trim())
    if (index >= 0) {
      const [best] = shows.splice(index, 1)
      topMatch = { show: best.item, facts: best.facts, summary: best.summary, cast: best.cast, episodes: best.episodes }
    }
    return { topMatch, shows: shows.map((s) => s.item), videos: page.videos, moreVideos: page.hasMore ? '2' : null }
  }

  async videos(keyword: string, cursor: string, signal: AbortSignal | undefined): Promise<MediaItemPage> {
    const number = Number(cursor) || 2
    const page = await this.results(keyword, number, signal)
    return { items: page.videos, next: page.hasMore ? String(number + 1) : null }
  }

  private results(keyword: string, page: number, signal: AbortSignal | undefined): Promise<ResultPage> {
    const key = `${page}:${keyword.trim()}`
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < RESULT_TTL) return hit.page
    const promise = this.load(keyword.trim(), page, signal)
    this.cache.set(key, { at: Date.now(), page: promise })
    promise.catch(() => this.cache.delete(key))
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!)
    return promise
  }

  private async load(keyword: string, page: number, signal: AbortSignal | undefined): Promise<ResultPage> {
    let response = await this.query(keyword, page, signal)
    // 限流：`code` -1，网页等一下再问。
    if (str(response?.code) === '-1') {
      await sleep(3_000, signal)
      response = await this.query(keyword, page, signal)
    }
    if (!(int(response?.code) === 0 || str(response?.code) === 'A00000')) {
      throw new SourceError('throttled', '搜索太频繁，请稍后再试', { retryAfter: 10 })
    }
    const templates = arr(response.data?.templates)
    const shows: Show[] = []
    const videos: MediaItem[] = []
    for (const template of templates) {
      const info = template?.albumInfo
      switch (int(template?.template)) {
        case 101:
        case 103: {
          const s = show(info)
          if (s) shows.push(s)
          break
        }
        case 108: {
          const v = video(info)
          if (v) videos.push(v)
          break
        }
      }
    }
    const total = int(response.data?.resultNum) ?? 0
    return { shows, videos, hasMore: page * PAGE_SIZE < total && templates.length > 0 }
  }

  private query(keyword: string, page: number, signal: AbortSignal | undefined): Promise<any> {
    return this.session.json(`${MESH}/portal/lw/search/homePageV3`, {
      key: keyword, current_page: String(page), pageNum: String(page), pageSize: String(PAGE_SIZE),
      u: this.session.deviceID, pu: this.session.uid ?? '', scale: '200', mode: '1', source: 'input', version: APP_VERSION,
    }, signal)
  }
}

const isIQiyi = (info: any) => {
  const site = str(info?.siteId)
  return site === undefined || site === 'iqiyi'
}

export function show(info: any): Show | undefined {
  const qipu = idOf(info?.qipuId)
  const title = text(info?.title)
  if (!qipu || !title || !isIQiyi(info)) return undefined
  const channel = text(info.channel)?.split(',')[0]
  const isAlbum = qipu.endsWith('01')
  const id = isAlbum ? albumID(qipu) : videoID(idOf(info.playQipuId) ?? qipu)
  const item: MediaItem = {
    id, title, subtitle: text(info.introduction),
    posterURL: image(info.img, 260, 360),
    landscapeURL: image(text(info.imgH) ?? info.img, 592, 333),
    badge: text(info.payMarkUrl) ? { text: 'VIP', tone: 'gold' } : undefined,
    caption: text(info.subscriptContent),
    target: isAlbum ? { show: id } : { video: id },
  }
  const facts = [channel, text(info.year?.value), text(info.region?.value)].filter(Boolean).join(' · ')
  const actors = arr(info.actors?.value).map((a) => text(a?.title)).filter((a): a is string => Boolean(a))
  const episodes = arr(info.videos).map((v): VideoItem | undefined => {
    const tvid = idOf(v?.qipuId)
    if (!tvid) return undefined
    return {
      id: videoID(tvid), showID: isAlbum ? id : undefined, title: text(v.title) ?? '', subtitle: text(v.subtitle),
      coverURL: image(v.img, 480, 270), badge: text(v.payMarkUrl) ? { text: 'VIP', tone: 'gold' } : undefined,
    }
  }).filter((e): e is VideoItem => Boolean(e))
  return {
    item, facts: facts || undefined, summary: text(info.brief?.value),
    cast: actors.length > 0 ? `主演：${actors.slice(0, 4).join(' ')}` : undefined, episodes,
  }
}

export function video(info: any): MediaItem | undefined {
  const tvid = idOf(info?.playQipuId) ?? idOf(info?.qipuId)
  const title = text(info?.title)
  if (!tvid || !title || !isIQiyi(info)) return undefined
  const id = videoID(tvid)
  const views = int(info.playCount)
  const duration = num(info.duration)
  return {
    id, title: title.trim(), subtitle: text(info.channel)?.split(',')[0],
    landscapeURL: image(info.img, 480, 270),
    stats: views !== undefined ? { views } : undefined,
    duration: duration !== undefined ? duration / 1000 : undefined,
    target: { video: id },
  }
}
