// 投稿视频（`x/web-interface/view`）和番剧的季（`pgc/view/web/season`）的模型与缓存：详情、互动、评论、弹幕、播放都要用。
import type { Badge } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import type { Owner } from './models.ts'
import type { BiliSession } from './session.ts'
import { API } from './sign.ts'

/** `x/web-interface/view`（`data`）和 `view/detail` 的 `View`：投稿视频，带分P和所在的合集。 */
export interface BiliView {
  aid: number
  bvid: string
  cid: number
  title: string
  pic?: string
  desc?: string
  pubdate?: number
  duration?: number
  /** 分区：「单机游戏」。 */
  tname?: string
  owner?: Owner & { mid: number }
  /** 联合投稿的创作者（含 UP 主本人）。 */
  staff?: { mid: number; title?: string; name: string; face?: string; follower?: number }[] | null
  stat?: Record<string, number>
  pages?: { cid: number; page: number; part?: string; duration?: number; first_frame?: string }[] | null
  ugc_season?: {
    id: number
    title: string
    sections: { title?: string; episodes: { aid?: number; cid?: number; bvid: string; title: string; arc?: { pic?: string; duration?: number } }[] }[]
  } | null
  redirect_url?: string
  /** 1 原创，2 转载（只能投一个币）。 */
  copyright?: number
  rights?: { ugc_pay?: number; arc_pay?: number }
  /** 充电专属。 */
  is_upower_exclusive?: boolean
  /** 单独售卖的合集。 */
  is_chargeable_season?: boolean
}

export interface SeasonEpisode {
  /** ep id。 */
  id: number
  aid?: number
  bvid?: string
  cid?: number
  cover?: string
  /** 集数（「1」）或标签（「PV1」）。 */
  title?: string
  long_title?: string
  show_title?: string
  badge?: string
  badge_info?: { text?: string }
  /** 2 免费，13 大会员，8 付费（单独购买，大会员打折）。 */
  status?: number
  /** 毫秒。 */
  duration?: number
  /** 0（或没有）是正片；1 是混在正片里的预告。 */
  section_type?: number
}

export interface BiliSeason {
  season_id: number
  title: string
  season_title?: string
  cover?: string
  bkg_cover?: string
  /** 简介。 */
  evaluate?: string
  /** 1 番剧，2 电影，3 纪录片，4 国创，5 电视剧，7 综艺。 */
  type?: number
  episodes: SeasonEpisode[]
  section?: { title?: string; episodes?: SeasonEpisode[] | null }[] | null
  seasons?: { season_id: number; season_title?: string; title?: string }[] | null
  rating?: { score?: number; count?: number }
  new_ep?: { desc?: string }
  stat?: Record<string, number>
  user_status?: { progress?: { last_ep_id?: number; last_time?: number } }
  areas?: { name?: string }[]
  styles?: string[]
  publish?: { pub_time_show?: string }
  actors?: string
  payment?: { price?: string; vip_price?: string }
}

export const SEASON_TYPES: Record<number, string> = { 1: '番剧', 2: '电影', 3: '纪录片', 4: '国创', 5: '电视剧', 7: '综艺' }

export const isMain = (episode: SeasonEpisode) => (episode.section_type ?? 0) === 0

/** 「第1话 凡人风起天南」；没有标题时只有集数。 */
export function episodeTitle(episode: SeasonEpisode): string {
  if (episode.show_title) return episode.show_title
  const number = episode.title && /^\d+$/.test(episode.title) ? `第${episode.title}话` : episode.title
  return [number, episode.long_title].filter(Boolean).join(' ')
}

export function episodeBadge(episode: SeasonEpisode): string | undefined {
  return episode.badge || episode.badge_info?.text || undefined
}

/** 正片，再是每个有名字的分区（预告、特别花絮…），和官方 App 一样分组。混在正片里的预告并进「预告」。 */
export function seasonGroups(season: BiliSeason): { title: string; episodes: SeasonEpisode[] }[] {
  const trailers = season.episodes.filter((e) => !isMain(e))
  const groups = [{ title: '正片', episodes: season.episodes.filter(isMain) }]
  let hasTrailers = trailers.length === 0
  for (const section of season.section ?? []) {
    const title = section.title || '其他'
    let episodes = section.episodes ?? []
    if (title === '预告' && !hasTrailers) {
      episodes = [...episodes, ...trailers]
      hasTrailers = true
    }
    if (episodes.length) groups.push({ title, episodes })
  }
  if (!hasTrailers) groups.push({ title: '预告', episodes: trailers })
  return groups.filter((group) => group.episodes.length > 0)
}

export const allEpisodes = (season: BiliSeason) => [...season.episodes, ...(season.section ?? []).flatMap((s) => s.episodes ?? [])]
export const findEpisode = (season: BiliSeason, epid: number) => allEpisodes(season).find((e) => e.id === epid)

/** 账号想完整看还缺什么。 */
export type Paywall =
  | { kind: 'vip' }
  | { kind: 'purchase'; price?: string; vipPrice?: string }
  | { kind: 'charge' }
  | { kind: 'paidVideo' }

export function viewPaywall(view: BiliView): Paywall | undefined {
  if (view.is_upower_exclusive) return { kind: 'charge' }
  if (view.rights?.ugc_pay === 1 || view.rights?.arc_pay === 1 || view.is_chargeable_season) return { kind: 'paidVideo' }
  return undefined
}

/** 「6.0」「4.8」；随大会员赠送时是「0.0」，不显示。 */
function amount(text: string | undefined): string | undefined {
  const value = Number(text)
  if (!text || !Number.isFinite(value) || value <= 0) return undefined
  return Number.isInteger(value) ? String(value) : text
}

export function episodePaywall(episode: SeasonEpisode, season: BiliSeason): Paywall | undefined {
  const badge = episodeBadge(episode) ?? ''
  if (episode.status === 8 || badge.includes('付费')) return { kind: 'purchase', price: amount(season.payment?.price), vipPrice: amount(season.payment?.vip_price) }
  if (episode.status === 13 || badge.includes('会员')) return { kind: 'vip' }
  return undefined
}

export function paywallBadge(paywall: Paywall): Badge {
  switch (paywall.kind) {
    case 'vip':
      return { text: '大会员', tone: 'red' }
    case 'charge':
      return { text: '充电专属', tone: 'gold' }
    default:
      return { text: '付费', tone: 'gold' }
  }
}

/** 播放失败时给用户看的原因。 */
export function paywallMessage(paywall: Paywall, isVIP: boolean): string {
  switch (paywall.kind) {
    case 'vip':
      return isVIP ? '大会员专享内容，当前账号的大会员暂不能观看' : '大会员专享内容，开通哔哩哔哩大会员后才能观看'
    case 'charge':
      return '充电专属视频，为 UP 主充电后才能观看'
    case 'paidVideo':
      return '付费视频，需在哔哩哔哩购买后观看'
    case 'purchase': {
      const prices = [paywall.price && `¥${paywall.price}`, paywall.vipPrice && `大会员 ¥${paywall.vipPrice}`].filter(Boolean).join('，')
      return `付费内容，需在哔哩哔哩单独购买后观看${prices ? `（${prices}）` : ''}`
    }
  }
}

/** 投稿视频和季的缓存（翻集数页、互动、弹幕都要 aid / cid）。 */
export class Catalog {
  readonly session: BiliSession
  private readonly views = new Map<string, { view: BiliView; at: number }>()
  private readonly seasons = new Map<number, { season: BiliSeason; at: number }>()
  private readonly episodes = new Map<number, number>()

  constructor(session: BiliSession) {
    this.session = session
  }

  remember(view: BiliView): void {
    this.views.set(view.bvid, { view, at: Date.now() })
    trim(this.views, 200)
  }

  rememberSeason(season: BiliSeason): void {
    this.seasons.set(season.season_id, { season, at: Date.now() })
    for (const episode of allEpisodes(season)) this.episodes.set(episode.id, season.season_id)
    trim(this.seasons, 100)
    trim(this.episodes, 5000)
  }

  async view(bvid: string, signal: AbortSignal): Promise<BiliView> {
    const cached = this.views.get(bvid)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.view
    const view = await this.session.get<BiliView>(`${API}/x/web-interface/view`, { bvid }, { signal, sign: 'none' })
    this.remember(view)
    return view
  }

  /** 一季：按 ep 或 season id 取。`fresh` 时不用缓存（要读续播进度）。 */
  async season(ids: { epid?: number; sid?: number }, signal: AbortSignal, fresh = false): Promise<BiliSeason> {
    const sid = ids.sid ?? (ids.epid !== undefined ? this.episodes.get(ids.epid) : undefined)
    const cached = sid !== undefined ? this.seasons.get(sid) : undefined
    if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.season
    const params: Record<string, string> = ids.epid !== undefined ? { ep_id: String(ids.epid) } : { season_id: String(ids.sid) }
    const season = await this.session.get<BiliSeason>(`${API}/pgc/view/web/season`, params, { signal, sign: 'none' })
    this.rememberSeason(season)
    return season
  }

  async episode(epid: number, signal: AbortSignal): Promise<{ season: BiliSeason; episode: SeasonEpisode }> {
    const season = await this.season({ epid }, signal)
    const episode = findEpisode(season, epid)
    if (!episode) throw new SourceError('not_found', '找不到该剧集')
    return { season, episode }
  }
}

function trim<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) map.delete(map.keys().next().value as K)
}

/** `x/player/wbi/v2`：投稿视频的续播点、看点（章节）和 CC 字幕。 */
export interface PlayerInfo {
  /** 毫秒。 */
  last_play_time?: number
  last_play_cid?: number
  view_points?: { from: number; to?: number; content?: string; imgUrl?: string }[] | null
  /** AI 生成的字幕语言以 `ai-` 开头。 */
  subtitle?: { subtitles?: { lan: string; lan_doc?: string; subtitle_url?: string }[] | null }
}

export function playerInfo(session: BiliSession, bvid: string, cid: number, signal: AbortSignal): Promise<PlayerInfo> {
  return session.get<PlayerInfo>(`${API}/x/player/wbi/v2`, { bvid, cid: String(cid) }, { signal })
}
