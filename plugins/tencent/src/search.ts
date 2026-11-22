// 网站的搜索（API.md §6，App 的 TencentSearchService）：联想 `GetSugHttp`，结果 `MbSearch`：节目（`dataType` 2）在
// 主列表和「相关影视」里，片段（`dataType` 1）在「相关短视频」里。在别的网站播放的节目（`playSites` 里没有 `qq`）不要。
// 输入前的排行用各片库最热的节目（热搜词不带海报）。
import type { MediaItem, SearchResults, SearchSuggestion, SearchTopMatch, VideoItem } from '@iyt-source/protocol'
import { SUGGEST_HOST, SEARCH_APP_ID, SEARCH_APP_KEY } from './constants.ts'
import { badgeOf } from './feed.ts'
import { coverID, videoID } from './ids.ts'
import { arr, imageURL, int, parseJSON, text } from './json.ts'
import { apiError, randomHex, type TencentSession } from './session.ts'

export const RANKINGS = [
  { channel: '100113', title: '电视剧' }, { channel: '100109', title: '综艺' },
  { channel: '100173', title: '电影' }, { channel: '100119', title: '动漫' },
]
export const RANKING_SIZE = 20
const PAGE_SIZE = 30

/** 标题带 `<em>` 高亮。 */
export function plain(value: unknown): string | undefined {
  return text(text(value)?.replace(/<\/?[A-Za-z]+>/g, ''))
}

export function suggestions(list: unknown): SearchSuggestion[] {
  const seen = new Set<string>()
  return arr(list).flatMap((entry) => {
    const lines = arr(entry?.view?.lines).map((line) => plain(line?.text))
    const keyword = lines[0]
    if (!keyword || seen.has(keyword)) return []
    seen.add(keyword)
    return [{ keyword, tag: lines[1], detail: lines[2] }]
  })
}

function facts(info: any): string | undefined {
  const year = int(info?.year)
  return text([text(info?.typeName), text(info?.area), year && year > 0 ? String(year) : undefined].filter(Boolean).join(' · '))
}

/** 在腾讯视频播放的节目，带结果里列出的选集。 */
export function showOf(entry: any): { item: MediaItem; episodes: VideoItem[] } | undefined {
  const info = entry?.videoInfo ?? {}
  const sites = arr(info.playSites)
  const cid = text(entry?.doc?.id)
  const title = plain(info.title)
  if (!cid || !title || !(sites.length === 0 || sites.some((s) => text(s?.enName) === 'qq'))) return undefined
  const id = coverID(cid)
  const site = arr(info.episodeSites).find((s) => text(s?.enName) === 'qq')
  const episodes = arr(site?.episodeInfoList).flatMap((episode): VideoItem[] => {
    const vid = text(episode?.id)
    if (!vid || (int(episode.dataType) ?? 0) !== 0) return []
    const label = text(episode.title) ?? ''
    return [{ id: videoID(vid), showID: id, title: /^\d+$/.test(label) ? `第${label}集` : label }]
  })
  const tags = parseJSON(info.imgTag)
  const year = int(info.year)
  return {
    item: {
      id, title, subtitle: text(info.subTitle) ?? text(info.typeName), posterURL: imageURL(info.imgUrl),
      badge: badgeOf(text(tags?.['2']?.info?.text)),
      caption: text(tags?.['4']?.info?.text) ?? (year && year > 0 ? String(year) : undefined),
      target: { show: id },
    },
    episodes,
  }
}

export function results(data: any, keyword: string): SearchResults {
  const shows: MediaItem[] = []
  const videos: MediaItem[] = []
  let topMatch: SearchTopMatch | undefined
  const seen = new Set<string>()
  const boxes = arr(data?.areaBoxList)
  const entries = [...arr(data?.normalList?.itemList), ...boxes.filter((b) => text(b?.boxId) !== 'ShortVideos').flatMap((b) => arr(b?.itemList))]
  for (const entry of entries) {
    if (int(entry?.doc?.dataType) !== 2) continue
    const hit = showOf(entry)
    if (!hit || seen.has(hit.item.id)) continue
    seen.add(hit.item.id)
    if (!topMatch && hit.item.title === keyword) {
      const info = entry.videoInfo ?? {}
      const cast = arr(info.actors).map(text).filter(Boolean).slice(0, 5).join(' ')
      topMatch = { show: hit.item, facts: facts(info), summary: text(info.descrip), cast: cast ? `主演：${cast}` : undefined, episodes: hit.episodes }
    } else {
      shows.push(hit.item)
    }
  }
  for (const entry of boxes.filter((b) => text(b?.boxId) === 'ShortVideos').flatMap((b) => arr(b?.itemList))) {
    if (int(entry?.doc?.dataType) !== 1) continue
    const vid = text(entry.doc.id)
    const title = plain(entry.videoInfo?.title)
    if (!vid || !title || seen.has(vid)) continue
    seen.add(vid)
    const id = videoID(vid)
    videos.push({ id, title, subtitle: text(entry.videoInfo?.subTitle), landscapeURL: imageURL(entry.videoInfo?.imgUrl), target: { video: id } })
  }
  return { topMatch, shows, videos, moreVideos: null }
}

export class TencentSearch {
  private readonly session: TencentSession

  constructor(session: TencentSession) {
    this.session = session
  }

  async suggestions(input: string, signal?: AbortSignal): Promise<SearchSuggestion[]> {
    const keyword = input.trim()
    if (!keyword) return []
    const response = await this.session.request(`${SUGGEST_HOST}/trpc.videosearch.smartboxServer.SugRecallHttp/GetSugHttp`, {
      method: 'POST',
      query: { vplatform: '2' },
      body: { query: keyword, page_num: 0, page_size: 10, scene_id: 5, sug_id: randomHex(16), auth_info: { app_id: SEARCH_APP_ID, app_key: SEARCH_APP_KEY } },
      signal,
    })
    return suggestions(response?.data?.result_list?.item_list)
  }

  async search(input: string, signal?: AbortSignal): Promise<SearchResults> {
    const query = input.trim()
    const response = await this.session.gateway('trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch', {
      query: { vplatform: '2' },
      body: {
        version: '25071701', clientType: 1, filterValue: '', uuid: '', retry: 0, query, pagenum: 0, pagesize: PAGE_SIZE,
        queryFrom: 0, isneedQc: true, extraInfo: { multi_terminal_pc: '1', themeType: '1' },
      },
      signal,
    })
    if (int(response?.ret) !== 0 || (int(response?.data?.errcode) ?? 0) !== 0) {
      throw apiError(response?.data?.errcode ?? response?.ret, text(response?.data?.errmsg) ?? text(response?.msg) ?? '搜索失败')
    }
    return results(response.data, query)
  }
}
