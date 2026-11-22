// 详情（照 App 的 IQiyiDetailService）：无签名的 `pcw-api` 接口——专辑 / 视频 `baseinfo`、剧的分集
// （`albums/album/avlistinfo`，正片再花絮 / 预告）、综艺按年的各期（`album/source/svlistinfo`），「猜你喜欢」取播放页的
// `tvg/v2/lw/base_info`。
import type { Credit, Episode, EpisodeList, EpisodeRange, MediaItem, ResumePoint, ShowDetail, Target } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { CHANNELS } from './feed.ts'
import { apiError, type IQiyiSession } from './session.ts'
import { albumID, APP_VERSION, arr, bool, idOf, image, int, MESH, num, parseID, PCW_API, qipsValue, str, text, updateStatus, videoID } from './util.ts'

/** 每页集数，和网站一样。 */
const RANGE_SIZE = 50
/** 综艺往回列几年。 */
const VARIETY_YEARS = 4
const FEATURE_SECTION = '正片'
const EXTRAS_SECTION = '花絮'

export class IQiyiDetail {
  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  async detail(target: Target, signal: AbortSignal | undefined): Promise<ShowDetail> {
    const raw = 'show' in target ? target.show : target.video
    const id = parseID(raw)
    if (!id) throw new SourceError('not_found', `无法识别的 id ${raw}`)
    if (id.kind === 'video') {
      let video: any
      try {
        video = await this.videoInfo(id.id, signal)
      } catch (error) {
        // 以 01 结尾的是专辑 id（片库里的单片 / 综艺有时这样给）：当剧再试一次。
        if (!(error instanceof SourceError && error.code === 'not_found' && id.id.endsWith('01'))) throw error
        return this.detail({ show: albumID(id.id) }, signal)
      }
      const album = idOf(video.albumId)
      // 剧的一集或综艺的一期：给剧的详情，选中这一集。
      if (album && album !== id.id && ((int(video.videoCount) ?? 0) > 1 || (idOf(video.sourceId) ?? '0') !== '0')) {
        return this.showDetail(await this.albumInfo(album, signal), album, id.id, signal)
      }
      return this.videoDetail(video, id.id, signal)
    }
    const album = await this.albumInfo(id.id, signal)
    // 电影的专辑就是这部电影。
    if ((int(album.videoCount) ?? 0) <= 1 && (idOf(album.sourceId) ?? '0') === '0') {
      const first = idOf(album.firstVideoId) ?? id.id
      return this.videoDetail(await this.videoInfo(first, signal), first, signal)
    }
    return this.showDetail(album, id.id, undefined, signal)
  }

  /** `ep:<albumId>:<page>` 剧的一页正片，`ex:<albumId>` 花絮，`yr:<albumId>:<year>` 综艺一年的各期。 */
  async episodes(cursor: string, signal: AbortSignal | undefined): Promise<EpisodeList> {
    const [kind, album, extra] = cursor.split(':')
    if (!album || !/^\d+$/.test(album)) throw new SourceError('bad_request', '分集游标不对')
    const info = await this.albumInfo(album, signal)
    switch (kind) {
      case 'ep': return this.seriesEpisodes(info, album, Number(extra) || 1, false, undefined, signal)
      case 'ex': return this.seriesEpisodes(info, album, 1, true, undefined, signal)
      case 'yr': return this.varietyEpisodes(info, album, Number(extra) || undefined, undefined, signal)
      default: throw new SourceError('bad_request', '分集游标不对')
    }
  }

  /** 剧的继续播放随详情一起给；电影（单个视频）的从历史里找。 */
  async resume(show: string | undefined, video: string | undefined, signal: AbortSignal | undefined): Promise<ResumePoint | null> {
    const records = await this.session.historyRecords(signal)
    if (!records) return null
    const album = parseID(show)
    const tvid = parseID(video)
    const record = records.find((r) => (tvid?.kind === 'video' && idOf(r.episodeId) === tvid.id) || (album?.kind === 'album' && idOf(r.albumId) === album.id))
    return (record && resumePoint(record)) ?? null
  }

  videoInfo(tvid: string, signal: AbortSignal | undefined): Promise<any> {
    return this.baseinfo(`${PCW_API}/video/video/baseinfo/${tvid}`, '找不到该视频', signal)
  }

  albumInfo(album: string, signal: AbortSignal | undefined): Promise<any> {
    return this.baseinfo(`${PCW_API}/album/album/baseinfo/${album}`, '找不到该剧集', signal)
  }

  private async baseinfo(url: string, missing: string, signal: AbortSignal | undefined): Promise<any> {
    const response = await this.session.json(url, '', signal)
    if (str(response?.code) === 'A00000' && response.data) return response.data
    if (str(response?.code) === 'A00111') throw apiError('A00111', undefined)
    throw new SourceError('not_found', missing)
  }

  private async showDetail(album: any, albumId: string, playing: string | undefined, signal: AbortSignal | undefined): Promise<ShowDetail> {
    const isVariety = (idOf(album.sourceId) ?? '0') !== '0'
    let resume: ResumePoint | undefined
    if (!playing) {
      const record = (await this.session.historyRecords(signal))?.find((r) => idOf(r.albumId) === albumId)
      resume = record ? resumePoint(record) : undefined
      const resumed = parseID(resume?.videoID)
      if (resumed?.kind === 'video') playing = resumed.id
    }
    const firstVideo = idOf(album.firstVideoId)
    const [episodes, recommendations] = await Promise.all([
      isVariety ? this.varietyEpisodes(album, albumId, undefined, playing, signal) : this.seriesEpisodes(album, albumId, undefined, false, playing, signal),
      this.recommended(playing ?? firstVideo, signal),
    ])
    const defaultVideoID = playing ? videoID(playing) : (episodes.episodes.find((e) => e.isFeature)?.id ?? (firstVideo ? videoID(firstVideo) : undefined))
    return { ...detailOf(album, albumID(albumId), defaultVideoID, episodes, recommendations), resume }
  }

  private async videoDetail(video: any, tvid: string, signal: AbortSignal | undefined): Promise<ShowDetail> {
    const recommendations = await this.recommended(tvid, signal)
    const album = idOf(video.albumId)
    return detailOf(video, album && album !== '0' && album !== tvid ? albumID(album) : undefined, videoID(tvid), undefined, recommendations)
  }

  // MARK: 剧

  /** 一页正片（给了 `playing` 时是它所在的那页），分页和花絮 / 预告作为区间；`extras` 时给花絮。 */
  private async seriesEpisodes(album: any, albumId: string, page: number | undefined, extras: boolean, playing: string | undefined, signal: AbortSignal | undefined): Promise<EpisodeList> {
    const total = Math.max(int(album.videoCount) ?? 0, int(album.latestOrder) ?? 0)
    let current = page ?? 1
    let found: any
    if (playing && !extras && total > RANGE_SIZE) {
      // 事先不知道这集在第几页：一页页找（很少超过一两页）。
      for (let candidate = 1; candidate <= Math.ceil(total / RANGE_SIZE); candidate++) {
        const list = await this.avlist(albumId, candidate, signal)
        if (arr(list.epsodelist).some((e) => idOf(e?.tvId) === playing)) {
          current = candidate
          found = list
          break
        }
      }
    }
    const list = found ?? (await this.avlist(albumId, extras ? 1 : current, signal))
    const features = arr(list.epsodelist)
    const extraEntries = [...arr(list.afterEpisodeList), ...arr(list.vipprevuelist), ...arr(list.updateprevuelist)]
    const count = Math.max(int(list.total) ?? features.length, features.length)
    let ranges: EpisodeRange[] = []
    if (count > RANGE_SIZE) {
      for (let start = 0; start < count; start += RANGE_SIZE) {
        ranges.push({ title: `${start + 1}-${Math.min(start + RANGE_SIZE, count)}`, section: FEATURE_SECTION, cursor: `ep:${albumId}:${start / RANGE_SIZE + 1}` })
      }
    } else if (extraEntries.length > 0) {
      ranges = [{ title: FEATURE_SECTION, section: FEATURE_SECTION, cursor: `ep:${albumId}:1` }]
    }
    if (extraEntries.length > 0) ranges.push({ title: EXTRAS_SECTION, section: EXTRAS_SECTION, cursor: `ex:${albumId}` })
    const episodes = (extras ? extraEntries.map((e) => episode(e, false)) : features.map((e) => episode(e, true))).filter((e): e is Episode => Boolean(e))
    const selected = extras ? `ex:${albumId}` : (count > RANGE_SIZE || extraEntries.length > 0 ? `ep:${albumId}:${current}` : undefined)
    return {
      episodes,
      ranges: ranges.length > 0 ? ranges : undefined,
      selectedRange: ranges.find((r) => r.cursor === selected),
      summary: summary(album),
    }
  }

  private async avlist(albumId: string, page: number, signal: AbortSignal | undefined): Promise<any> {
    const response = await this.session.json(`${PCW_API}/albums/album/avlistinfo`, { aid: albumId, page: String(page), size: String(RANGE_SIZE) }, signal)
    if (str(response?.code) !== 'A00000') throw apiError(response?.code, response?.msg, '选集加载失败')
    return response.data ?? {}
  }

  // MARK: 综艺

  /** 综艺一年的各期（默认最新一年，或 `playing` 所在的那年），新的在前；一年一个区间。 */
  private async varietyEpisodes(album: any, albumId: string, year: number | undefined, playing: string | undefined, signal: AbortSignal | undefined): Promise<EpisodeList> {
    const sourceID = idOf(album.sourceId) ?? albumId
    const latestYear = Number(text(album.period)?.slice(0, 4)) || new Date().getFullYear()
    const years = Array.from({ length: VARIETY_YEARS }, (_, i) => latestYear - i)
    const response = await this.session.json(`${PCW_API}/album/source/svlistinfo`, { sourceid: sourceID, timelist: years.join(',') }, signal)
    if (str(response?.code) !== 'A00000') throw apiError(response?.code, response?.msg, '选集加载失败')
    const byYear = years.map((y) => [y, arr(response.data?.[String(y)])] as const).filter(([, list]) => list.length > 0)
    let selected = year ?? byYear[0]?.[0]
    if (playing && year === undefined) {
      const match = byYear.find(([, list]) => list.some((e) => idOf(e?.tvId) === playing))
      if (match) selected = match[0]
    }
    const ranges: EpisodeRange[] = byYear.length > 1 ? byYear.map(([y]) => ({ title: `${y}年`, cursor: `yr:${albumId}:${y}` })) : []
    const entries = byYear.find(([y]) => y === selected)?.[1] ?? []
    return {
      episodes: entries.map(issue).filter((e): e is Episode => Boolean(e)),
      ranges: ranges.length > 0 ? ranges : undefined,
      selectedRange: ranges.find((r) => r.cursor === `yr:${albumId}:${selected ?? 0}`),
      summary: text(album.updateStrategy),
    }
  }

  // MARK: 推荐

  /** 播放页的「猜你喜欢」。失败时空。 */
  private async recommended(tvid: string | undefined, signal: AbortSignal | undefined): Promise<MediaItem[]> {
    if (!tvid) return []
    const s = this.session
    try {
      const info = await s.tvgJSON(`${MESH}/tvg/v2/lw/base_info`, {
        entity_id: tvid, device_id: s.deviceID, auth_cookie: s.authCookie ?? '', user_id: s.uid ?? '',
        vip_type: s.isVIP ? s.vipType : '-1', vip_status: s.isVIP ? '1' : '3', conduit_id: '', pcv: APP_VERSION,
        app_version: APP_VERSION, ext: '', app_mode: 'standard', scale: '200', src: 'pca_tvg', os: '', ad_ext: '', adn_token: '',
      }, signal)
      const blocks = arr(info?.data?.template?.tabs).flatMap((tab) => arr(tab?.blocks))
      const block = blocks.find((b) => str(b?.bk_id) === 'recommend_bk')
      return arr(block?.data?.data?.videos).map(recommendation).filter((i): i is MediaItem => Boolean(i))
    } catch (error) {
      if (signal?.aborted) throw error
      return []
    }
  }
}

// MARK: 解析

/** 专辑和视频的 `baseinfo` 描述字段相同。 */
export function detailOf(info: any, showID: string | undefined, defaultVideoID: string | undefined, episodes: EpisodeList | undefined, recommendations: MediaItem[]): ShowDetail {
  const categories = arr(info.categories).map((c) => text(c?.name)).filter((c): c is string => Boolean(c))
  const time = num(info.publishTime) ?? num(info.issueTime)
  const year = time ? String(new Date(time).getFullYear()) : undefined
  const areas = arr(info.areas).map((a) => text(a) ?? text(a?.name)).filter((a): a is string => Boolean(a))
  const attributes = [areas[0], year, categories[0]].filter(Boolean).join('·')
  const count = int(info.videoCount) ?? 0
  const latest = int(info.latestOrder) ?? 0
  const score = num(info.score)
  const isPaid = (int(info.payMark) ?? 0) > 0
  const picture = info.imageUrl
  return {
    showID,
    title: (showID ? text(info.albumName) : undefined) ?? text(info.name) ?? '',
    tagline: text(info.focus),
    shortSummary: text(info.focus),
    summary: text(info.description),
    attributes: attributes || undefined,
    category: CHANNELS.find((c) => c.id === int(info.channelId))?.title,
    posterURL: image(picture, 260, 360),
    landscapeURL: image(picture, 592, 333),
    badge: isPaid ? { text: 'VIP', tone: 'gold' } : bool(info.exclusive) === true ? { text: '独播', tone: 'red' } : undefined,
    updateInfo: text(info.updateStrategy) ?? updateStatus(count, latest),
    ratings: score && score > 0 ? [{ source: 'platform', score: score.toFixed(1) }] : [],
    tags: categories,
    isPaid,
    credits: credits(info.people),
    defaultVideoID,
    episodes,
    series: [],
    recommendations: { tabs: [], items: recommendations },
  }
}

export function credits(people: any): Credit[] {
  const person = (p: any, role?: string): Credit | undefined => {
    const id = idOf(p?.id)
    const name = text(p?.name)
    return id && name ? { id, name, role, avatarURL: image(p.image_url) } : undefined
  }
  const directors = arr(people?.director).map((p) => person(p, '导演'))
  const cast = [...arr(people?.main_charactor), ...arr(people?.host), ...arr(people?.guest)].map((p) => {
    const character = arr(p?.character).map(text).find(Boolean)
    return person(p, character ? `饰${character}` : undefined)
  })
  const seen = new Set<string>()
  return [...directors, ...cast].filter((c): c is Credit => Boolean(c) && !seen.has(c!.id) && Boolean(seen.add(c!.id)))
}

export function episode(entry: any, isFeature: boolean): Episode | undefined {
  const tvid = idOf(entry?.tvId)
  if (!tvid) return undefined
  const order = int(entry.order) ?? 0
  const name = text(entry.name) ?? ''
  const isPaid = (int(entry.payMark) ?? 0) > 0
  return {
    id: videoID(tvid),
    title: isFeature ? (text(entry.subtitle) ?? name) : (text(entry.shortTitle) ?? name),
    stage: isFeature && order > 0 ? String(order) : (text(entry.period) ?? ''),
    isFeature,
    kind: isFeature ? FEATURE_SECTION : EXTRAS_SECTION,
    imageURL: image(entry.imageUrl, 480, 270),
    isPaid,
    badge: isPaid ? { text: 'VIP', tone: 'gold' } : undefined,
    duration: clock(entry.duration),
  }
}

/** 综艺的一期：按日期而不是集数；纯享、花絮和各期列在一起。 */
export function issue(entry: any): Episode | undefined {
  const tvid = idOf(entry?.tvId)
  if (!tvid) return undefined
  const isPaid = (int(entry.payMark) ?? 0) > 0
  return {
    id: videoID(tvid),
    title: text(entry.subtitle) ?? text(entry.name) ?? '',
    stage: text(entry.period)?.slice(-5) ?? '',
    isFeature: true,
    imageURL: image(entry.imageUrl, 480, 270),
    isPaid,
    badge: isPaid ? { text: 'VIP', tone: 'gold' } : undefined,
    duration: clock(entry.duration),
  }
}

/** 分集的时长：`"45:33"` / `"1:02:03"`，或秒数。 */
export function clock(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined
  const parts = text(value)?.split(':').map(Number)
  if (!parts || parts.some((p) => !Number.isFinite(p))) return undefined
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return seconds > 0 ? seconds : undefined
}

function summary(album: any): string | undefined {
  const status = updateStatus(int(album.videoCount) ?? 0, int(album.latestOrder) ?? 0)
  return [status, text(album.updateStrategy)].filter(Boolean).join('，') || undefined
}

/** 「猜你喜欢」的一项。广告和合集卡（「查看全部…」，id 以 02 结尾）不是能播的作品。 */
export function recommendation(video: any): MediaItem | undefined {
  if (!video || bool(video.isAd) === true || bool(video.isCollection) === true) return undefined
  const entity = idOf(video.entity_id)
  const title = text(video.display_name) ?? text(video.title)
  if (!entity || !title) return undefined
  const tvid = qipsValue('tvid', text(video.play_url))
  const isAlbum = entity.endsWith('01')
  const id = isAlbum ? albumID(entity) : videoID(tvid ?? entity)
  return {
    id,
    title,
    subtitle: text(video.brief),
    posterURL: image(video.image_url, 260, 360),
    landscapeURL: image(text(video.horizon_img_url) ?? video.image_url, 592, 333),
    badge: (int(video.pay_mark) ?? 0) > 0 ? { text: 'VIP', tone: 'gold' } : undefined,
    caption: text(video.right_bottom_txt),
    target: isAlbum ? { show: id } : { video: id },
  }
}

/** 历史记录里的那一集和看到的比例（`play_time` / `duration`，秒）。 */
export function resumePoint(record: any): ResumePoint | undefined {
  const tvid = idOf(record?.episodeId)
  if (!tvid) return undefined
  const duration = num(record.duration) ?? 0
  const position = num(record.play_time) ?? 0
  return { videoID: videoID(tvid), progress: duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : undefined }
}
