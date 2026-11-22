// 播放（照 App 的 BilibiliPlaybackService）：投稿视频（`BV…`、`BV…#cid`）或番剧一集（`ep…`；`ss…` 取续播的那一集）解析成
// DASH 轨道（视频、音频各是一个带 sidx 的单文件），经媒体网关做成按字节范围的 fMP4 HLS（kit 的 `dash`）：每档清晰度一条流。
// CDN 要 Referer 和 UA，所以分片经网关转发。进度用网页的 heartbeat 上报。CC 字幕（JSON）转成 WebVTT 写进 master，原文给 App 翻译。
import type { Chapter, Cue, Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream, SubtitleTrack } from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { codecFamily, codecName, codecSupported, SourceError, webVTTPlaylist, type Ctx, type DashAudioTrack, type DashVideoTrack, type SubtitleRendition } from '@iyt-source/kit'
import {
  episodePaywall, episodeTitle, isMain, paywallMessage, playerInfo, viewPaywall,
  type BiliSeason, type Catalog, type Paywall, type PlayerInfo,
} from './catalog.ts'
import { episodeFromRedirect, parseID } from './ids.ts'
import { compact, cuesToVTT, subtitleCues, type SubtitleFile } from './models.ts'
import { image } from './session.ts'
import { API, REFERER, USER_AGENT } from './sign.ts'

/** 离结尾这么多秒以内的续播点算看完了，从头播。 */
const FINISHED_MARGIN = 10
/** 1080P+ 及以上要大会员（8K 127、杜比视界 126、HDR 125、4K 120、1080P60 116、1080P+ 112）。 */
const VIP_THRESHOLD = 112
/** HDR 真彩（125）和杜比视界（126）：master 声明 VIDEO-RANGE，并带一条最好的 SDR 画面作 SDR 屏幕的回退。 */
const HDR_QN = 125
const DOLBY_VISION_QN = 126
export const isHDR = (qn: number) => qn === HDR_QN || qn === DOLBY_VISION_QN

export const QUALITY_LABELS: Record<number, string> = {
  127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清', 116: '1080P 60帧', 112: '1080P 高码率', 80: '1080P 高清',
  74: '720P 60帧', 64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅', 6: '240P 极速',
}
/** 协议的 `quality.rank` 是像素高度；按 qn 给名义高度（竖屏视频的实际高度更大，不能直接用）。 */
export const QUALITY_HEIGHTS: Record<number, number> = {
  127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240,
}

export interface PlayTrack {
  /** 视频是 qn，音频是音质 id（30216 / 30232 / 30280，30250 杜比，30251 无损）。 */
  id: number
  base_url?: string
  baseUrl?: string
  backup_url?: string[] | null
  backupUrl?: string[] | null
  bandwidth: number
  codecs: string
  width?: number
  height?: number
  frame_rate?: string
  frameRate?: string
}

/** `x/player/wbi/playurl`（`data`）和 `pgc/player/web/playurl`（`result`），`fnval=4048`。 */
export interface PlayURL {
  quality?: number
  accept_quality?: number[]
  support_formats?: { quality: number; new_description?: string; display_desc?: string }[]
  dash?: {
    duration: number
    video: PlayTrack[]
    audio?: PlayTrack[] | null
    /** 杜比全景声（E-AC-3）。 */
    dolby?: { audio?: PlayTrack[] | null } | null
    /** Hi-Res 无损（FLAC）。 */
    flac?: { audio?: PlayTrack | null } | null
  } | null
  /** PGC：片头片尾。 */
  clip_info_list?: { start: number; end: number; clipType?: string }[] | null
  /** PGC：只给试看（`durl` 里几分钟的 MP4，没有 `dash`）时为 1。 */
  is_preview?: number
}

/** PCDN（带端口，或 `mcdn.bilivideo.cn` / `szbdyd.com`）常慢、拒外地客户端，排到最后。 */
export function isPCDN(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.port !== '' || parsed.hostname.endsWith('mcdn.bilivideo.cn') || parsed.hostname.endsWith('szbdyd.com')
  } catch {
    return true
  }
}

export function trackURLs(track: PlayTrack): string[] {
  const all = [track.base_url ?? track.baseUrl, ...(track.backup_url ?? track.backupUrl ?? [])].filter((url): url is string => Boolean(url))
  return [...all.filter((url) => !isPCDN(url)), ...all.filter(isPCDN)]
}

/**
 * 一档画面挑哪条轨：
 * - SDR 档：H.264 优先（哪儿都能播），再 HEVC（`hvc1`，再 `hev1`，客户端能解 HEVC 时）；AV1 不要（Apple TV 和多数 iPhone 没有硬解）。
 * - HDR / 杜比视界档（照 App）：`dvh1` / `hvc1` 优先，再 `avc1`，再 `hev1`（HDR10 有时只有它；AVPlayer 能播）。
 */
export function preferredTrack(tracks: PlayTrack[], options: { hdr?: boolean; hevc?: boolean } = {}): PlayTrack | undefined {
  const rank = (track: PlayTrack) => {
    const c = track.codecs
    if (options.hdr) return c.startsWith('dvh1') || c.startsWith('hvc1') ? 3 : c.startsWith('avc1') ? 2 : c.startsWith('hev1') ? 1 : 0
    if (c.startsWith('avc1')) return 3
    if (options.hevc === false) return 0
    return c.startsWith('hvc1') ? 2 : c.startsWith('hev1') ? 1 : 0
  }
  return tracks.filter((t) => rank(t) > 0).sort((a, b) => rank(b) - rank(a) || b.bandwidth - a.bandwidth)[0]
}

/**
 * HLS 怎么声明一条视频轨（照 App 的 `BiliDashPlaylist.videoFormat`）：杜比视界 profile 8 按它的 HEVC 基础层写 `CODECS`，
 * 杜比编码写进 `SUPPLEMENTAL-CODECS`（Apple 编写规范的要求）；profile 5 没有基础层，`CODECS` 就是 `dvh1`，`PQ`。HDR 真彩是 PQ，帧率不过 30。
 */
export function videoFormat(codecs: string, qn: number, frameRate?: string): { codecs: string; supplementalCodecs?: string; videoRange: 'SDR' | 'PQ' | 'HLG'; frameRate: number } {
  let rate = Number(frameRate) || 25
  let range: 'SDR' | 'PQ' | 'HLG' = 'SDR'
  let declared = codecs
  let supplemental: string | undefined
  if (qn === HDR_QN) {
    range = 'PQ'
    rate = Math.min(rate, 30)
  }
  if (codecs === 'dvh1.08.07' || codecs === 'dvh1.08.03') {
    supplemental = `${codecs}/db4h`
    declared = 'hvc1.2.4.L153.b0'
    range = 'HLG'
  } else if (codecs === 'dvh1.08.06') {
    supplemental = `${codecs}/db1p`
    declared = 'hvc1.2.4.L150'
    range = 'PQ'
  } else if (codecs.startsWith('dvh1.05')) {
    range = 'PQ'
  }
  return { codecs: declared, supplementalCodecs: supplemental, videoRange: range, frameRate: Math.min(rate, 60) }
}

/** 音轨在音频菜单里的名字（照 App）。 */
export function audioName(track: PlayTrack): string {
  const c = track.codecs.toLowerCase()
  if (c.startsWith('ec-3') || c.startsWith('ac-3')) return '杜比全景声'
  if (c.startsWith('flac')) return '无损音质'
  return `${Math.round(track.bandwidth / 1000)} kbps`
}

export interface StreamPlan {
  id: string
  quality: { rank: number; label: string }
  description: string
  /** 进 master 的画面：第一条是这一档；HDR 档后面跟一条 SDR 回退。 */
  videos: DashVideoTrack[]
  hdr: boolean
  unavailableReason?: string
  /** HDR 档的 SDR 回退（协议的 `fallback`）。 */
  fallback?: { peakBandwidths: number[]; label: string }
}

export interface PlanOptions {
  /** 客户端能解的编码（`preferences.codecs`）；缺省不限。 */
  codecs?: string[] | null
  maxQualityRank?: number | null
  adaptive?: boolean
  isVIP: boolean
  loggedIn: boolean
}

/**
 * 这次解析给哪些流（纯函数）：每档一条，HDR / 杜比视界档带 SDR 回退；客户端不能解的编码标不可用；音频按编码分组
 * （AAC 一定有；杜比全景声在客户端能解 E-AC-3 时；无损只在客户端明确列出 fLaC 时，App 自己也不放无损）。
 * 默认选清晰度上限内最好的 SDR 档；HDR / 杜比视界只在上限允许、且客户端明确声明能解时才默认选中。
 */
export function planStreams(playURL: PlayURL, dash: NonNullable<PlayURL['dash']>, options: PlanOptions) {
  const { codecs } = options
  const supports = (codec: string) => codecSupported(codecs, codec)
  const declares = (codec: string) => Boolean(codecs) && codecSupported(codecs, codec)
  const cap = options.maxQualityRank ?? Number.POSITIVE_INFINITY

  const best = (tracks: PlayTrack[]) => [...tracks].sort((a, b) => b.bandwidth - a.bandwidth)[0] as PlayTrack | undefined
  const audioTrack = (track: PlayTrack, isDefault: boolean): DashAudioTrack => {
    const [url, ...backupURLs] = trackURLs(track)
    return compact({ url, backupURLs: backupURLs.length ? backupURLs : undefined, codecs: track.codecs, bandwidth: peakBandwidth(track.bandwidth), language: 'zh', name: audioName(track), isDefault })
  }
  const aac = best((dash.audio ?? []).filter((a) => a.codecs.startsWith('mp4a')))
  const dolby = best(dash.dolby?.audio ?? [])
  const flac = dash.flac?.audio ?? undefined
  const audios: DashAudioTrack[] = []
  if (aac) audios.push(audioTrack(aac, true))
  if (dolby && supports(dolby.codecs)) audios.push(audioTrack(dolby, !aac))
  if (flac && declares(flac.codecs)) audios.push(audioTrack(flac, !aac))
  const audioPeak = audios[0]?.bandwidth ?? 0

  const labels = new Map((playURL.support_formats ?? []).map((f) => [f.quality, f.new_description || f.display_desc || '']))
  const quality = (qn: number) => ({ rank: QUALITY_HEIGHTS[qn] ?? qn, label: labels.get(qn) || QUALITY_LABELS[qn] || String(qn) })
  const byQuality = new Map<number, PlayTrack[]>()
  for (const track of dash.video) byQuality.set(track.id, [...(byQuality.get(track.id) ?? []), track])

  const videoTrack = (track: PlayTrack, qn: number): DashVideoTrack => {
    const format = videoFormat(track.codecs, qn, track.frame_rate ?? track.frameRate)
    const [url, ...backupURLs] = trackURLs(track)
    return compact({
      url, backupURLs: backupURLs.length ? backupURLs : undefined, codecs: format.codecs, supplementalCodecs: format.supplementalCodecs,
      videoRange: format.videoRange === 'SDR' ? undefined : format.videoRange, bandwidth: peakBandwidth(track.bandwidth),
      width: track.width, height: track.height, frameRate: format.frameRate,
    })
  }
  const hevc = supports('hvc1')
  // SDR 屏幕接不了 PQ / HLG：HDR 档带上最好的 SDR 画面作回退变体，播放器自己挑。
  const sdrFallback = [...byQuality.keys()].filter((qn) => !isHDR(qn)).sort((a, b) => b - a)
    .map((qn) => ({ qn, track: preferredTrack(byQuality.get(qn)!, { hevc }) })).find((c) => c.track)

  const plans: StreamPlan[] = []
  const skipped: string[] = []
  for (const [qn, tracks] of [...byQuality].sort((a, b) => b[0] - a[0])) {
    const hdr = isHDR(qn)
    const track = preferredTrack(tracks, { hdr, hevc })
    if (!track) {
      const families = [...new Set(tracks.map((t) => codecFamily(t.codecs)))]
      // 只有客户端解不了的 HEVC：标出来；只有 AV1 之类的：不列。
      if (families.includes('hvc1') && !hevc) plans.push({ id: String(qn), quality: quality(qn), description: 'HEVC', videos: [], hdr, unavailableReason: '设备不支持 HEVC' })
      else skipped.push(`${qn}:${families.join('/')}`)
      continue
    }
    const video = videoTrack(track, qn)
    // 杜比视界要客户端能解 dvh1（profile 8 还要能解它的 HEVC 基础层）；HDR 真彩要能解 HEVC。
    const needed = [video.codecs, ...(video.supplementalCodecs ? [video.supplementalCodecs.split('/')[0]] : [])]
    const missing = needed.find((codec) => !supports(codec))
    const range = video.videoRange ? ` ${video.videoRange}` : ''
    const description = `${track.codecs} ${track.width ?? 0}x${track.height ?? 0} ${Math.round(track.bandwidth / 1000)}kbps${range}${codecFamily(track.codecs) === 'hvc1' ? '（HEVC）' : codecFamily(track.codecs) === 'dvh1' ? '（杜比视界）' : ''}`
    if (missing) {
      plans.push({ id: String(qn), quality: quality(qn), description, videos: [], hdr, unavailableReason: `设备不支持${codecName(missing)}` })
      continue
    }
    const plan: StreamPlan = { id: String(qn), quality: quality(qn), description, videos: [video], hdr }
    if (hdr && sdrFallback?.track) {
      const fallback = videoTrack(sdrFallback.track, sdrFallback.qn)
      plan.videos.push(fallback)
      plan.fallback = { peakBandwidths: [fallback.bandwidth + audioPeak], label: 'SDR' }
    }
    plans.push(plan)
  }
  const playable = plans.filter((p) => !p.unavailableReason)
  if (playable.length === 0) return { plans, audios, selected: undefined, skipped }

  if (options.adaptive) {
    // 自动清晰度只用 SDR 档（照 App）。
    const sdr = playable.filter((p) => !p.hdr)
    const within = sdr.filter((p) => p.quality.rank <= cap)
    const ladder = within.length ? within : sdr.length ? [sdr.at(-1)!] : [playable.at(-1)!]
    const auto: StreamPlan = {
      id: 'auto', quality: { rank: ladder[0].quality.rank, label: '自动' }, hdr: false,
      description: `adaptive ${ladder.map((p) => p.id).join('/')}`, videos: ladder.map((p) => p.videos[0]),
    }
    return { plans: [auto], audios, selected: 'auto', skipped }
  }

  // 列在 `accept_quality` 里却没有轨道的（账号看不了）：标为不可用。
  for (const qn of playURL.accept_quality ?? []) {
    if (byQuality.has(qn)) continue
    const reason = qn >= VIP_THRESHOLD && !options.isVIP ? '大会员' : !options.loggedIn ? '需登录' : '不可用'
    plans.push({ id: String(qn), quality: quality(qn), description: reason, videos: [], hdr: isHDR(qn), unavailableReason: reason })
  }
  plans.sort((a, b) => b.quality.rank - a.quality.rank || Number(b.id) - Number(a.id))
  const eligible = (p: StreamPlan) => {
    if (p.unavailableReason) return false
    if (!p.hdr) return true
    const codec = p.id === String(DOLBY_VISION_QN) ? 'dvh1' : 'hvc1'
    return declares(codec) && p.quality.rank <= cap
  }
  const chosen = plans.find((p) => eligible(p) && p.quality.rank <= cap)
    ?? [...plans].reverse().find((p) => !p.unavailableReason && !p.hdr)
    ?? plans.find((p) => !p.unavailableReason)
  return { plans, audios, selected: chosen?.id, skipped }
}

/** 每段峰值约是平均码率的 1.5 倍（master 的 BANDWIDTH 要峰值）。 */
export const peakBandwidth = (average: number) => Math.round(average * 1.5)

/** 番剧的片头片尾。 */
export function clipMarkers(clips: PlayURL['clip_info_list']): Markers | undefined {
  const intro = (clips ?? []).find((c) => c.clipType === 'CLIP_TYPE_OP' && c.end > c.start)
  const outro = (clips ?? []).find((c) => c.clipType === 'CLIP_TYPE_ED' && c.end > c.start)
  if (!intro && !outro) return undefined
  return compact({ introEnd: intro?.end, outroStart: outro?.start })
}

export function chapters(info: PlayerInfo | undefined): Chapter[] {
  return (info?.view_points ?? []).map((point) => compact({ start: point.from, end: point.to, title: point.content ?? '', imageURL: image(point.imgUrl) }))
}

interface Target {
  title: string
  aid?: number
  bvid?: string
  cid: number
  epid?: number
  sid?: number
  seasonType?: number
  /** 番剧：季里记的续播点，秒。 */
  resume?: number
  paywall?: Paywall
}

interface Subtitle {
  key: string
  name: string
  language: string
  generated: boolean
  url: string
}

export function subtitleList(info: PlayerInfo | undefined): Subtitle[] {
  const list: Subtitle[] = []
  for (const track of info?.subtitle?.subtitles ?? []) {
    const url = image(track.subtitle_url)
    if (!url) continue
    const generated = track.lan.startsWith('ai-')
    const language = generated ? track.lan.slice(3) : track.lan
    list.push({ key: generated ? `${language}.asr` : track.lan, name: track.lan_doc || track.lan, language, generated, url })
  }
  // 上传的在前（第一个默认显示），AI 生成的只在选了时显示。
  return [...list.filter((s) => !s.generated), ...list.filter((s) => s.generated)]
}

export class Playback {
  private readonly catalog: Catalog
  /** 字幕原文：`<bvid>.<cid>` → 字幕 key → JSON 地址（`cues` 用）。 */
  private readonly captions = new Map<string, Map<string, string>>()
  /** 字幕 JSON 地址 → 读出的句子（播放器的 WebVTT 和翻译原文共用一份）。 */
  private readonly cueCache = new Map<string, Promise<Cue[]>>()

  constructor(catalog: Catalog) {
    this.catalog = catalog
  }

  private get session() {
    return this.catalog.session
  }

  async resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const id = parseID(request.video)
    if (!id) throw new SourceError('not_found', `无法识别的视频 ${request.video}`)
    let target: Target
    if (id.kind === 'video') {
      target = await this.videoTarget(id.bvid, id.cid, ctx.signal)
    } else if (id.kind === 'episode') {
      target = this.episodeTarget(await this.catalog.season({ epid: id.epid }, ctx.signal, true), id.epid)
    } else {
      const season = await this.catalog.season({ sid: id.sid }, ctx.signal, true)
      const epid = season.user_status?.progress?.last_ep_id ?? season.episodes.find(isMain)?.id
      if (!epid) throw new SourceError('unplayable', '该剧集暂无可播放的视频')
      target = this.episodeTarget(season, epid)
    }
    return this.media(target, request, ctx)
  }

  private async videoTarget(bvid: string, cid: number | undefined, signal: AbortSignal): Promise<Target> {
    const view = await this.catalog.view(bvid, signal)
    // 番剧一集的投稿版：按那一集播。
    const epid = episodeFromRedirect(view.redirect_url)
    if (epid) return this.episodeTarget(await this.catalog.season({ epid }, signal, true), epid)
    const part = cid ?? view.cid
    const pages = view.pages ?? []
    const page = pages.length > 1 ? pages.find((p) => p.cid === part) : undefined
    return {
      title: page ? `${view.title} P${page.page} ${page.part ?? ''}`.trim() : view.title,
      aid: view.aid, bvid: view.bvid, cid: part, paywall: viewPaywall(view),
    }
  }

  private episodeTarget(season: BiliSeason, epid: number): Target {
    const episode = [...season.episodes, ...(season.section ?? []).flatMap((s) => s.episodes ?? [])].find((e) => e.id === epid)
    if (!episode?.cid) throw new SourceError('not_found', '找不到该剧集')
    const progress = season.user_status?.progress
    return {
      title: `${season.title} ${episodeTitle(episode)}`.trim(),
      aid: episode.aid, bvid: episode.bvid, cid: episode.cid, epid, sid: season.season_id, seasonType: season.type,
      resume: progress?.last_ep_id === epid ? progress.last_time : undefined,
      paywall: episodePaywall(episode, season),
    }
  }

  private async media(target: Target, request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const { signal } = ctx
    const params: Record<string, string> = { qn: '127', fnval: '4048', fnver: '0', fourk: '1' }
    // 没登录时网页播放器要试看高清晰度，否则只到 480P。
    if (!this.session.loggedIn) params.try_look = '1'
    const info = target.bvid ? playerInfo(this.session, target.bvid, target.cid, signal).catch((error) => {
      if (signal.aborted) throw error
      ctx.log.warn('bilibili player info failed', { error: String(error) })
      return undefined
    }) : Promise.resolve(undefined)
    let playURL: PlayURL
    if (target.epid) {
      playURL = await this.session.get<PlayURL>(`${API}/pgc/player/web/playurl`,
        { ...params, ep_id: String(target.epid), cid: String(target.cid), support_multi_audio: 'true' }, { signal, sign: 'none' })
    } else {
      playURL = await this.session.get<PlayURL>(`${API}/x/player/wbi/playurl`, { ...params, bvid: target.bvid ?? '', cid: String(target.cid) }, { signal })
    }
    const player = await info
    // 没有权限时 PGC 的 playurl 也是 code 0：`is_preview`，没有 `dash`，只有试看的 `durl`。
    const dash = playURL.dash
    if (!dash?.video?.length) {
      if (target.paywall) throw new SourceError('restricted', paywallMessage(target.paywall, this.session.isVIP))
      if (playURL.is_preview === 1 || !this.session.isVIP) throw new SourceError('restricted', '该内容需要大会员或购买后观看')
      throw new SourceError('unplayable', '该视频暂不支持播放')
    }

    let resume = target.resume
    let markers: Markers | undefined
    if (target.epid) {
      markers = clipMarkers(playURL.clip_info_list)
    } else if (player) {
      const list = chapters(player)
      if (list.length) markers = { chapters: list }
      if (player.last_play_cid === target.cid && (player.last_play_time ?? 0) > 0) resume = player.last_play_time! / 1000
    }
    if (resume !== undefined && resume >= dash.duration - FINISHED_MARGIN) resume = undefined

    // 视频所在的页面：CDN 按它的 Referer 放行。
    const page = target.epid ? `/bangumi/play/ep${target.epid}` : `/video/${target.bvid}`
    const headers = { Referer: REFERER + page, 'User-Agent': USER_AGENT }
    const expires = expiry(dash)
    const ttl = Math.max(600, Math.floor((expires - Date.now()) / 1000))

    const subtitles = this.subtitles(target, player, dash.duration, ctx, ttl)
    const renditions = subtitles.map((s) => s.rendition)

    const plan = planStreams(playURL, dash, {
      codecs: request.preferences?.codecs, maxQualityRank: request.preferences?.maxQualityRank, adaptive: request.preferences?.adaptive,
      isVIP: this.session.isVIP, loggedIn: this.session.loggedIn,
    })
    if (!plan.selected) throw new SourceError('unplayable', '没有可播放的清晰度')
    const streams: Stream[] = plan.plans.map((p) => compact({
      id: p.id,
      url: p.videos.length ? ctx.media.dash({ videos: p.videos, audios: plan.audios, subtitles: renditions }, { headers, via: 'proxy', ttl }) : 'about:blank',
      format: 'hls' as const,
      quality: p.quality,
      description: p.description,
      unavailableReason: p.unavailableReason,
      fallback: p.fallback,
    }))
    const selected = { id: plan.selected }
    const skipped = plan.skipped
    const audioCodecs = plan.audios.map((a) => a.codecs).join('+') || 'none'

    const reportContext = compact({
      cid: String(target.cid), type: target.epid ? '4' : '3', aid: target.aid ? String(target.aid) : undefined, bvid: target.bvid,
      epid: target.epid ? String(target.epid) : undefined, sid: target.sid ? String(target.sid) : undefined,
      subType: target.seasonType !== undefined ? String(target.seasonType) : undefined,
    })
    return compact({
      title: target.title,
      startPosition: resume,
      expiresAt: new Date(expires).toISOString(),
      markers,
      streams,
      selectedStream: selected.id,
      subtitles: subtitles.length ? subtitles.map((s) => s.protocol) : undefined,
      reportContext,
      diagnostics: {
        path: target.epid ? 'pgc-dash-proxy' : 'ugc-dash-proxy',
        audio: audioCodecs,
        skipped: skipped.join(',') || 'none',
        vip: String(this.session.isVIP),
      },
    })
  }

  private subtitles(target: Target, player: PlayerInfo | undefined, duration: number, ctx: Ctx, ttl: number) {
    const list = subtitleList(player)
    if (!target.bvid || list.length === 0) return []
    const ref = `${target.bvid}.${target.cid}`
    this.captions.set(ref, new Map(list.map((s) => [s.key, s.url])))
    if (this.captions.size > 100) this.captions.delete(this.captions.keys().next().value!)
    const defaultKey = list.find((s) => !s.generated)?.key
    return list.map((subtitle) => {
      const vtt = ctx.media.generated(async () => cuesToVTT(await this.loadCues(subtitle.url)), { name: `${subtitle.key}.vtt`, ttl })
      const playlist = ctx.media.text(webVTTPlaylist(vtt, duration || 3600), { name: `${subtitle.key}.m3u8`, ttl })
      const protocol: SubtitleTrack = {
        key: subtitle.key, name: subtitle.name, language: subtitle.language, generated: subtitle.generated, vtt,
        cues: `${BASE_PATH}/sources/${ctx.sourceId}/subtitles/${encodeURIComponent(ref)}/${encodeURIComponent(subtitle.key)}`,
      }
      const rendition: SubtitleRendition = {
        name: subtitle.name, language: subtitle.language, uri: playlist, isDefault: subtitle.key === defaultKey, autoselect: !subtitle.generated,
        characteristics: subtitle.generated ? 'com.mxc.iyouteng.generated' : undefined,
      }
      return { protocol, rendition }
    })
  }

  /** 一条字幕 JSON 的句子（按地址缓存 100 条）。生成的 WebVTT 在播放器请求时才取，不随某次请求取消。 */
  private loadCues(url: string): Promise<Cue[]> {
    let cached = this.cueCache.get(url)
    if (!cached) {
      cached = this.session.json<SubtitleFile>(url, AbortSignal.timeout(20_000)).then(subtitleCues)
      this.cueCache.set(url, cached)
      cached.catch(() => this.cueCache.delete(url))
      if (this.cueCache.size > 100) this.cueCache.delete(this.cueCache.keys().next().value!)
    }
    return cached
  }

  /** 字幕原文（`subtitles/<ref>/<key>`）。服务重启后没有记录时，重读一次这个视频的字幕列表。 */
  async cues(ref: string, key: string, ctx: Ctx): Promise<Cue[]> {
    let url = this.captions.get(ref)?.get(key)
    if (!url) {
      const match = /^(BV[0-9A-Za-z]{10})\.(\d+)$/.exec(ref)
      if (!match) throw new SourceError('not_found', '找不到这条字幕')
      const info = await playerInfo(this.session, match[1], Number(match[2]), ctx.signal)
      const list = subtitleList(info)
      this.captions.set(ref, new Map(list.map((s) => [s.key, s.url])))
      url = list.find((s) => s.key === key)?.url
    }
    if (!url) throw new SourceError('not_found', '找不到这条字幕')
    return this.loadCues(url)
  }

  /** 网页的 heartbeat：投稿视频 `type=3`，番剧 `type=4`；看完时 `played_time=-1`。 */
  async progress(request: ProgressRequest, ctx: Ctx): Promise<void> {
    const context = (request.reportContext ?? {}) as Record<string, string | undefined>
    if (!this.session.loggedIn || !context.cid) return
    const position = String(Math.max(0, Math.floor(request.position)))
    const params: Record<string, string> = {
      cid: context.cid,
      played_time: request.event === 'end' ? '-1' : position,
      real_played_time: position,
      type: context.type ?? '3',
      dt: '2',
      play_type: request.event === 'start' ? '1' : '0',
    }
    if (context.aid) params.aid = context.aid
    if (context.bvid) params.bvid = context.bvid
    if (context.epid) {
      params.epid = context.epid
      if (context.sid) params.sid = context.sid
      if (context.subType) params.sub_type = context.subType
    }
    await this.session.action(`${API}/x/click-interface/web/heartbeat`, params, ctx.signal)
  }
}

/** 各轨道签名地址里最早的 `deadline`（Unix 秒）；读不到时两小时。 */
export function expiry(dash: NonNullable<PlayURL['dash']>, now = Date.now()): number {
  const tracks = [...dash.video, ...(dash.audio ?? []), ...(dash.dolby?.audio ?? [])]
  const deadlines = tracks.map((track) => {
    try {
      return Number(new URL(track.base_url ?? track.baseUrl ?? '').searchParams.get('deadline')) * 1000
    } catch {
      return 0
    }
  }).filter((value) => value > now)
  return deadlines.length ? Math.min(...deadlines) : now + 2 * 3600_000
}
