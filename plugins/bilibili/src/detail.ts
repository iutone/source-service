// 详情（照 App 的 BilibiliDetailService / BilibiliUploadCollections）：投稿视频（`view/detail`）带分P或合集、UP 主的其他视频和
// 相关推荐；番剧的季（`pgc/view/web/season`）带分集、花絮和相关的季。UP 主页：名片、投稿（按页）、合集与系列。
import type { Episode, EpisodeList, EpisodeRange, MediaItem, ResumePoint, ShowDetail, Target, Uploader, UploaderProfile } from '@iyt-source/protocol'
import { badRequest, notFound } from '@iyt-source/kit'
import {
  allEpisodes, episodeBadge, episodeTitle, isMain, paywallBadge, playerInfo, SEASON_TYPES, seasonGroups, viewPaywall,
  type BiliSeason, type BiliView, type Catalog, type SeasonEpisode,
} from './catalog.ts'
import { episodeFromRedirect, episodeID, parseID, seasonID, videoID } from './ids.ts'
import { archiveItem, compact, parseCount, parseDuration, stats, uploader as uploaderOf, type BiliArchive } from './models.ts'
import { image } from './session.ts'
import { API, SPACE_FINGERPRINT } from './sign.ts'

const UPLOADS_PAGE = 30
/** 长的分组按这么多集一页，和官方 App 一样。 */
const RANGE_SIZE = 50

/** 东八区的日期：「2026-11-20」。 */
export function day(seconds: number): string {
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

/** `count` 集分页：放得下就一页（标题是分组名），否则「1-50」「51-100」…。 */
export function pages(count: number, section: string | undefined, cursor: (start: number) => string): EpisodeRange[] {
  if (count <= RANGE_SIZE) return [compact({ title: section ?? '全部', section, cursor: cursor(0) })]
  const ranges: EpisodeRange[] = []
  for (let start = 0; start < count; start += RANGE_SIZE) {
    ranges.push(compact({ title: `${start + 1}-${Math.min(start + RANGE_SIZE, count)}`, section, cursor: cursor(start) }))
  }
  return ranges
}

export class Detail {
  private readonly catalog: Catalog
  private readonly uploadPages = new Map<string, { list: EpisodeList; at: number }>()

  constructor(catalog: Catalog) {
    this.catalog = catalog
  }

  private get session() {
    return this.catalog.session
  }

  async detail(target: Target, signal: AbortSignal): Promise<ShowDetail> {
    const raw = 'show' in target ? target.show : target.video
    const id = parseID(raw)
    if (!id) throw notFound('这个视频')
    switch (id.kind) {
      case 'video':
        return this.videoDetail(id.bvid, id.cid, signal)
      case 'episode':
        return this.seasonDetail(await this.catalog.season({ epid: id.epid }, signal, true), id.epid, signal)
      case 'season':
        return this.seasonDetail(await this.catalog.season({ sid: id.sid }, signal, true), undefined, signal)
    }
  }

  /**
   * `up:<mid>:<页>` UP 主的投稿；`uss:<mid>:<合集>:<页>` / `usr:<mid>:<系列>:<页>` 他的某个合集 / 系列；
   * `ss:<季>:<组>:<起始>` / `bv:<bvid>:<组>:<起始>` 季或视频的某组某页。
   */
  async episodes(cursor: string, signal: AbortSignal): Promise<EpisodeList> {
    const parts = cursor.split(':')
    const number = (index: number) => {
      const value = Number(parts[index])
      if (!Number.isInteger(value) || value < 0) throw badRequest('游标不对')
      return value
    }
    switch (parts[0]) {
      case 'up':
        if (parts.length === 3) return this.uploads(parts[1], Math.max(1, number(2)), signal)
        break
      case 'uss':
      case 'usr':
        if (parts.length === 4) return this.collectionUploads(parts[0], parts[1], parts[2], Math.max(1, number(3)), signal)
        break
      case 'ss':
        if (parts.length === 4) return seasonEpisodes(await this.catalog.season({ sid: number(1) }, signal), number(2), number(3))
        break
      case 'bv':
        if (parts.length === 4) return videoEpisodes(await this.catalog.view(parts[1], signal), number(2), number(3))
        break
    }
    throw badRequest('游标不对')
  }

  /** 季的续播点在季里；投稿视频的来自 `x/player/wbi/v2`：上次播的分P（`last_play_cid`）和位置（毫秒）。 */
  async resume(show: string | undefined, video: string | undefined, signal: AbortSignal): Promise<ResumePoint | null> {
    const id = parseID(show ?? video ?? '')
    if (!id) return null
    if (id.kind === 'season' || id.kind === 'episode') {
      const season = await this.catalog.season(id.kind === 'season' ? { sid: id.sid } : { epid: id.epid }, signal, true)
      return seasonResume(season) ?? null
    }
    const view = await this.catalog.view(id.bvid, signal)
    const info = await playerInfo(this.session, view.bvid, view.cid, signal)
    const cid = info.last_play_cid
    const time = info.last_play_time
    if (!cid || !time || time <= 0) return null
    const page = view.pages?.find((p) => p.cid === cid)
    const duration = page?.duration ?? view.duration ?? 0
    return compact({
      videoID: (page?.page ?? 1) > 1 ? videoID(view.bvid, cid) : view.bvid,
      progress: duration > 0 ? Math.min(time / 1000 / duration, 1) : undefined,
    })
  }

  // MARK: 投稿视频

  private async videoDetail(bvid: string, cid: number | undefined, signal: AbortSignal): Promise<ShowDetail> {
    const detail = await this.session.get<{
      View: BiliView
      Card?: { card?: { mid?: string; name?: string; face?: string; fans?: number }; follower?: number }
      Related?: BiliArchive[] | null
      Tags?: { tag_name?: string }[] | null
    }>(`${API}/x/web-interface/view/detail`, { bvid }, { signal })
    const view = detail.View
    // 其实是番剧一集的投稿：按那一集打开。
    const epid = episodeFromRedirect(view.redirect_url)
    if (epid) return this.seasonDetail(await this.catalog.season({ epid }, signal, true), epid, signal)
    this.catalog.remember(view)
    const playing = cid ? videoID(view.bvid, cid) : view.bvid
    const list = videoEpisodes(view, 0, 0, playing)
    const episodes = list.episodes.length ? list : undefined
    const owner = uploaderOf(view.owner, detail.Card?.card?.fans ?? detail.Card?.follower)
    // 既不分P、也不在合集里的视频：给 UP 主的其他投稿。
    const uploads = !episodes && view.owner?.mid ? await this.uploads(String(view.owner.mid), 1, signal).catch(() => undefined) : undefined
    const paywall = viewPaywall(view)
    const published = view.pubdate ? new Date(view.pubdate * 1000).toISOString() : undefined
    return compact({
      title: view.title,
      summary: view.desc && view.desc !== '-' ? view.desc : undefined,
      attributes: [view.tname, view.pubdate ? day(view.pubdate) : undefined].filter(Boolean).join(' · ') || undefined,
      category: view.tname || undefined,
      landscapeURL: image(view.pic, 960, 540),
      badge: paywall ? paywallBadge(paywall) : undefined,
      heat: view.stat?.view,
      ratings: [],
      tags: (detail.Tags ?? []).map((tag) => tag.tag_name).filter((name): name is string => Boolean(name)).slice(0, 8),
      isPaid: paywall !== undefined,
      credits: owner ? [compact({ id: owner.id, name: owner.name, role: 'UP主', avatarURL: owner.avatarURL })] : [],
      defaultVideoID: playing,
      episodes,
      series: [],
      recommendations: { tabs: [{ title: '相关推荐' }], items: (detail.Related ?? []).map(archiveItem).filter((item): item is MediaItem => Boolean(item)) },
      uploads,
      uploader: owner,
      coUploaders: (view.staff ?? []).filter((staff) => staff.mid !== view.owner?.mid)
        .map((staff) => uploaderOf({ mid: staff.mid, name: staff.name, face: staff.face }, staff.follower))
        .filter((u): u is Uploader => Boolean(u)),
      stats: stats(view.stat),
      publishedAt: published,
      duration: view.duration,
    })
  }

  /** UP 主的一页投稿，新的在前；页码列出已知的页再加下一页。 */
  async uploads(mid: string, page: number, signal: AbortSignal): Promise<EpisodeList> {
    // 空间的投稿接口风控很紧（同一出口连着请求常 412）：一页缓存 5 分钟。
    const key = `${mid}:${page}`
    const cached = this.uploadPages.get(key)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.list
    const list = await this.fetchUploads(mid, page, signal)
    this.uploadPages.set(key, { list, at: Date.now() })
    if (this.uploadPages.size > 100) this.uploadPages.delete(this.uploadPages.keys().next().value!)
    return list
  }

  private async fetchUploads(mid: string, page: number, signal: AbortSignal): Promise<EpisodeList> {
    const data = await this.session.get<{
      list: { vlist: { bvid: string; title: string; pic?: string; play?: number | string; length?: string; created?: number }[] | null }
      page: { count: number }
    }>(`${API}/x/space/wbi/arc/search`, {
      mid, pn: String(page), ps: String(UPLOADS_PAGE), order: 'pubdate', platform: 'web', web_location: '1550101', ...SPACE_FINGERPRINT,
    }, { signal, referer: `https://space.bilibili.com/${mid}/video` })
    const pageCount = Math.max(1, Math.ceil(data.page.count / UPLOADS_PAGE))
    const ranges = numberedPages(Math.min(pageCount, page + 1), page, (n) => `up:${mid}:${n}`)
    return {
      episodes: (data.list.vlist ?? []).map((video) => compact({
        id: video.bvid, title: video.title, stage: '', isFeature: true, imageURL: image(video.pic, 480, 270), isPaid: false,
        duration: parseDuration(video.length), views: parseCount(typeof video.play === 'number' ? video.play : video.play?.replace('--', '')),
        publishedAt: video.created ? new Date(video.created * 1000).toISOString() : undefined,
      })),
      ranges,
      selectedRange: ranges[page - 1],
    }
  }

  // MARK: 番剧

  private async seasonDetail(season: BiliSeason, epid: number | undefined, signal: AbortSignal): Promise<ShowDetail> {
    // 要的那一集；不然是账号上次看到的（在这一季里的话）；再不然第一集。
    const resume = seasonResume(season)
    const defaultEpisode = epid ?? (resume ? Number(resume.videoID.slice(2)) : undefined)
      ?? season.episodes.find(isMain)?.id ?? allEpisodes(season)[0]?.id
    const related = this.relatedSeasons(season.season_id, signal).catch(() => [] as MediaItem[])
    return compact({
      showID: seasonID(season.season_id),
      title: season.title,
      summary: season.evaluate || undefined,
      attributes: [season.areas?.[0]?.name, season.publish?.pub_time_show, (season.styles ?? []).slice(0, 3).join('/')].filter(Boolean).join(' · ') || undefined,
      category: season.type !== undefined ? SEASON_TYPES[season.type] : undefined,
      posterURL: image(season.cover, 480, 640),
      landscapeURL: image(season.bkg_cover || season.episodes[0]?.cover, 960, 540),
      updateInfo: season.new_ep?.desc || undefined,
      heat: season.stat?.views,
      ratings: season.rating?.score ? [{ source: 'platform' as const, score: season.rating.score.toFixed(1) }] : [],
      tags: season.styles ?? [],
      isPaid: false,
      credits: [],
      defaultVideoID: defaultEpisode !== undefined ? episodeID(defaultEpisode) : undefined,
      episodes: seasonEpisodes(season, 0, 0, defaultEpisode),
      series: [],
      recommendations: { tabs: [{ title: '相关推荐' }], items: await related },
      stats: stats(season.stat),
      resume,
    })
  }

  private async relatedSeasons(sid: number, signal: AbortSignal): Promise<MediaItem[]> {
    const data = await this.session.get<{ season?: { season_id: number; title: string; cover?: string; new_ep?: { index_show?: string } }[] | null }>(
      `${API}/pgc/season/web/related/recommend`, { season_id: String(sid) }, { signal, sign: 'none' })
    return (data.season ?? []).map((season) => compact({
      id: seasonID(season.season_id), title: season.title, posterURL: image(season.cover, 480, 640),
      caption: season.new_ep?.index_show || undefined, target: { show: seasonID(season.season_id) },
    }))
  }

  // MARK: UP 主

  /** UP 主的名片（`x/web-interface/card`）：名字、头像、签名、粉丝 / 关注 / 投稿数，账号是否关注了他。 */
  async uploader(mid: string, signal: AbortSignal): Promise<UploaderProfile | null> {
    if (!/^\d+$/.test(mid)) return null
    const data = await this.session.get<{
      card?: { name?: string; face?: string; sign?: string; fans?: number; attention?: number }
      following?: boolean
      archive_count?: number
      follower?: number
    }>(`${API}/x/web-interface/card`, { mid, photo: 'false' }, { signal, sign: 'none' })
    if (!data.card?.name) return null
    return compact({
      uploader: compact({ id: mid, name: data.card.name, avatarURL: image(data.card.face, 160, 160), followers: data.follower ?? data.card.fans }),
      signature: data.card.sign || undefined,
      followingCount: data.card.attention,
      videoCount: data.archive_count,
      isFollowing: data.following,
    })
  }

  /** 他的全部合集，再是全部系列，各给出第一页视频的游标。 */
  async collections(mid: string, signal: AbortSignal): Promise<EpisodeRange[]> {
    type Collection = { meta: { season_id?: number; series_id?: number; name?: string } }
    const seasons: EpisodeRange[] = []
    const series: EpisodeRange[] = []
    // 一页最多 20 个；几页就够了。
    for (let page = 1; page <= 5; page++) {
      const data = await this.session.get<{ items_lists: { seasons_list?: Collection[] | null; series_list?: Collection[] | null; page?: { total?: number } } }>(
        `${API}/x/polymer/web-space/seasons_series_list`, { mid, page_num: String(page), page_size: '20' },
        { signal, referer: `https://space.bilibili.com/${mid}/lists` })
      const lists = data.items_lists
      for (const { meta } of lists.seasons_list ?? []) {
        if (meta.season_id && meta.name) seasons.push({ title: meta.name, section: '合集', cursor: `uss:${mid}:${meta.season_id}:1` })
      }
      for (const { meta } of lists.series_list ?? []) {
        if (meta.series_id && meta.name) series.push({ title: meta.name, section: '系列', cursor: `usr:${mid}:${meta.series_id}:1` })
      }
      const fetched = (lists.seasons_list?.length ?? 0) + (lists.series_list?.length ?? 0)
      if (fetched === 0 || page * 20 >= (lists.page?.total ?? 0)) break
    }
    return [...seasons, ...series]
  }

  /** 合集或系列的一页视频（页码同 `uploads`）。 */
  private async collectionUploads(kind: string, mid: string, id: string, page: number, signal: AbortSignal): Promise<EpisodeList> {
    type Response = { archives?: { bvid: string; title: string; pic?: string; duration?: number; pubdate?: number; stat?: { view?: number } }[] | null; page?: { total?: number } }
    const referer = `https://space.bilibili.com/${mid}/lists`
    const data = kind === 'uss'
      ? await this.session.get<Response>(`${API}/x/polymer/web-space/seasons_archives_list`,
        { mid, season_id: id, sort_reverse: 'false', page_num: String(page), page_size: String(UPLOADS_PAGE) }, { signal, referer })
      : await this.session.get<Response>(`${API}/x/series/archives`,
        { mid, series_id: id, only_normal: 'true', sort: 'desc', pn: String(page), ps: String(UPLOADS_PAGE) }, { signal, referer })
    const pageCount = Math.max(1, Math.ceil((data.page?.total ?? 0) / UPLOADS_PAGE))
    const ranges = numberedPages(Math.max(page, Math.min(pageCount, page + 1)), page, (n) => `${kind}:${mid}:${id}:${n}`)
    return {
      episodes: (data.archives ?? []).map((video) => compact({
        id: video.bvid, title: video.title, stage: '', isFeature: true, imageURL: image(video.pic, 480, 270), isPaid: false,
        duration: video.duration || undefined, views: video.stat?.view,
        publishedAt: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : undefined,
      })),
      ranges,
      selectedRange: ranges[page - 1],
    }
  }
}

function numberedPages(count: number, _current: number, cursor: (page: number) => string): EpisodeRange[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => ({ title: `第${index + 1}页`, cursor: cursor(index + 1) }))
}

/** 账号在这一季的续播点（上次看的那一集在这一季里时）。 */
export function seasonResume(season: BiliSeason): ResumePoint | undefined {
  const progress = season.user_status?.progress
  const epid = progress?.last_ep_id
  const episode = epid ? allEpisodes(season).find((e) => e.id === epid) : undefined
  if (!episode) return undefined
  // `last_time` 是秒，这一集的 `duration` 是毫秒。
  const duration = (episode.duration ?? 0) / 1000
  const time = progress?.last_time ?? 0
  return compact({ videoID: episodeID(episode.id), progress: time > 0 && duration > 0 ? Math.min(time / duration, 1) : undefined })
}

function seasonEpisode(episode: SeasonEpisode, kind: string, isFeature: boolean): Episode {
  const badge = episodeBadge(episode)
  return compact({
    id: episodeID(episode.id),
    title: episodeTitle(episode),
    stage: episode.title ?? '',
    isFeature,
    kind,
    imageURL: image(episode.cover, 480, 270),
    isPaid: Boolean(badge && (badge.includes('会员') || badge === '付费')),
    badge: badge ? { text: badge, tone: badge.includes('会员') ? 'red' as const : 'neutral' as const } : undefined,
    duration: episode.duration ? episode.duration / 1000 : undefined,
  })
}

/** 第 `group` 组从 `start` 起的一页；给了 `playing` 时改为含这一集的那一页。 */
export function seasonEpisodes(season: BiliSeason, group: number, start: number, playing?: number): EpisodeList {
  const groups = seasonGroups(season)
  if (groups.length === 0) return { episodes: [] }
  let selected = Math.min(group, groups.length - 1)
  let from = start
  if (playing !== undefined) {
    for (const [index, candidate] of groups.entries()) {
      const position = candidate.episodes.findIndex((e) => e.id === playing)
      if (position >= 0) {
        selected = index
        from = Math.floor(position / RANGE_SIZE) * RANGE_SIZE
        break
      }
    }
  }
  const ranges = groups.flatMap((candidate, index) => pages(candidate.episodes.length, candidate.title, (s) => `ss:${season.season_id}:${index}:${s}`))
  const siblings = season.seasons ?? []
  return compact({
    episodes: groups[selected].episodes.slice(from, from + RANGE_SIZE).map((e) => seasonEpisode(e, groups[selected].title, selected === 0)),
    ranges: ranges.length > 1 ? ranges : [],
    selectedRange: ranges.find((range) => range.cursor === `ss:${season.season_id}:${selected}:${from}`),
    summary: season.new_ep?.desc || undefined,
    parts: siblings.length > 1
      ? siblings.map((s) => ({ id: seasonID(s.season_id), title: s.season_title || s.title || '', isCurrent: s.season_id === season.season_id }))
      : [],
  })
}

/** 投稿视频的分P；不分P时是它所在合集（按小节）。 */
function videoGroups(view: BiliView): { title?: string; episodes: Episode[] }[] {
  const parts = view.pages ?? []
  if (parts.length > 1) {
    return [{
      episodes: parts.map((page) => compact({
        id: page.page === 1 ? view.bvid : videoID(view.bvid, page.cid), title: page.part || `P${page.page}`, stage: `P${page.page}`,
        isFeature: true, imageURL: image(page.first_frame || view.pic, 480, 270), isPaid: false, duration: page.duration,
      })),
    }]
  }
  const season = view.ugc_season
  if (!season) return []
  const named = season.sections.length > 1
  return season.sections.map((section) => ({
    title: named ? section.title : undefined,
    episodes: section.episodes.map((episode) => compact({
      id: episode.bvid, title: episode.title, stage: '', isFeature: true, imageURL: image(episode.arc?.pic, 480, 270), isPaid: false,
      duration: episode.arc?.duration,
    })),
  }))
}

export function videoEpisodes(view: BiliView, group: number, start: number, playing?: string): EpisodeList {
  const groups = videoGroups(view)
  if (groups.length === 0) return { episodes: [] }
  let selected = Math.min(group, groups.length - 1)
  let from = start
  if (playing) {
    for (const [index, candidate] of groups.entries()) {
      const position = candidate.episodes.findIndex((e) => e.id === playing)
      if (position >= 0) {
        selected = index
        from = Math.floor(position / RANGE_SIZE) * RANGE_SIZE
        break
      }
    }
  }
  const ranges = groups.flatMap((candidate, index) => pages(candidate.episodes.length, candidate.title, (s) => `bv:${view.bvid}:${index}:${s}`))
  const total = groups.reduce((sum, candidate) => sum + candidate.episodes.length, 0)
  // 分P 比视频也在的合集优先（和 `videoGroups` 一致）。
  const collection = (view.pages?.length ?? 0) > 1 ? undefined : view.ugc_season?.title
  return compact({
    episodes: groups[selected].episodes.slice(from, from + RANGE_SIZE),
    ranges: ranges.length > 1 ? ranges : [],
    selectedRange: ranges.find((range) => range.cursor === `bv:${view.bvid}:${selected}:${from}`),
    summary: collection ? `合集 · ${collection}` : `共${total}P`,
    collection,
  })
}
