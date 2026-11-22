// 播放（照 App 的 BilibiliPlaybackService）：投稿视频（`BV…`、`BV…#cid`）或番剧一集（`ep…`；`ss…` 取续播的那一集）解析成
// DASH 轨道（视频、音频各是一个带 sidx 的单文件），经媒体网关做成按字节范围的 fMP4 HLS（kit 的 `dash`）：每档清晰度一条流。
// CDN 要 Referer 和 UA，所以分片经网关转发。进度用网页的 heartbeat 上报。CC 字幕（JSON）转成 WebVTT 写进 master，原文给 App 翻译。
import type { Chapter, Cue, Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream, SubtitleTrack } from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { SourceError, webVTTPlaylist, type Ctx, type DashAudioTrack, type DashVideoTrack, type SubtitleRendition } from '@iyt-source/kit'
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
/** HDR 真彩和杜比视界：网关生成的 master 不声明 VIDEO-RANGE，SDR 屏幕上 AVPlayer 会卡住或发灰，先不给。 */
const HDR = new Set([125, 126])

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
  dash?: { duration: number; video: PlayTrack[]; audio?: PlayTrack[] | null; dolby?: { audio?: PlayTrack[] | null } | null } | null
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

type Codec = 'avc' | 'hevc'

/** H.264 优先（哪儿都能播），再 HEVC（`hvc1`，再 `hev1`）；AV1 不要（Apple TV 和多数 iPhone 没有硬解），杜比视界不要。 */
export function preferredTrack(tracks: PlayTrack[]): { track: PlayTrack; codec: Codec } | undefined {
  const rank = (track: PlayTrack) => (track.codecs.startsWith('avc1') ? 3 : track.codecs.startsWith('hvc1') ? 2 : track.codecs.startsWith('hev1') ? 1 : 0)
  const best = tracks.filter((t) => rank(t) > 0).sort((a, b) => rank(b) - rank(a) || b.bandwidth - a.bandwidth)[0]
  return best ? { track: best, codec: best.codecs.startsWith('avc1') ? 'avc' : 'hevc' } : undefined
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

    // 最好的一条 AAC。杜比（E-AC-3）和无损不放进同一组：编码不同的音轨混在一组里，有的设备会挑错。
    const aac = (dash.audio ?? []).filter((a) => a.codecs.startsWith('mp4a')).sort((a, b) => b.bandwidth - a.bandwidth)[0]
    const audios: DashAudioTrack[] = aac ? [{ url: trackURLs(aac)[0], codecs: aac.codecs, bandwidth: peakBandwidth(aac.bandwidth), language: 'zh', name: '普通话', isDefault: true }] : []

    const labels = new Map((playURL.support_formats ?? []).map((f) => [f.quality, f.new_description || f.display_desc || '']))
    const quality = (qn: number) => ({ rank: QUALITY_HEIGHTS[qn] ?? qn, label: labels.get(qn) || QUALITY_LABELS[qn] || String(qn) })
    const byQuality = new Map<number, PlayTrack[]>()
    for (const track of dash.video) byQuality.set(track.id, [...(byQuality.get(track.id) ?? []), track])

    const cap = request.preferences?.maxQualityRank ?? Number.POSITIVE_INFINITY
    const playable: { qn: number; video: DashVideoTrack; codec: Codec; description: string }[] = []
    const skipped: string[] = []
    for (const [qn, tracks] of [...byQuality].sort((a, b) => b[0] - a[0])) {
      if (HDR.has(qn)) {
        skipped.push(`${qn}:hdr`)
        continue
      }
      const chosen = preferredTrack(tracks)
      if (!chosen) {
        skipped.push(`${qn}:${tracks.map((t) => t.codecs.split('.')[0]).join('/')}`)
        continue
      }
      const { track, codec } = chosen
      playable.push({
        qn,
        codec,
        video: compact({ url: trackURLs(track)[0], codecs: track.codecs, bandwidth: peakBandwidth(track.bandwidth), width: track.width, height: track.height, frameRate: Number(track.frame_rate ?? track.frameRate) || undefined }),
        description: `${track.codecs} ${track.width ?? 0}x${track.height ?? 0} ${Math.round(track.bandwidth / 1000)}kbps${codec === 'hevc' ? '（HEVC）' : ''}`,
      })
    }
    if (playable.length === 0) throw new SourceError('unplayable', '没有可播放的清晰度')

    const dashURL = (videos: DashVideoTrack[]) => ctx.media.dash({ videos, audios, subtitles: renditions }, { headers, via: 'proxy', ttl })
    const streams: Stream[] = []
    if (request.preferences?.adaptive) {
      const within = playable.filter((p) => quality(p.qn).rank <= cap)
      const ladder = within.length ? within : [playable.at(-1)!]
      streams.push({
        id: 'auto', url: dashURL(ladder.map((p) => p.video)), format: 'hls', quality: { rank: quality(ladder[0].qn).rank, label: '自动' },
        description: `adaptive ${ladder.map((p) => p.qn).join('/')}${ladder.some((p) => p.codec === 'hevc') ? '（含 HEVC）' : ''}`,
      })
    } else {
      for (const p of playable) {
        streams.push({ id: String(p.qn), url: dashURL([p.video]), format: 'hls', quality: quality(p.qn), description: p.description })
      }
      // 列在 `accept_quality` 里却没有轨道的（账号看不了）：标为不可用。
      for (const qn of playURL.accept_quality ?? []) {
        if (byQuality.has(qn) || HDR.has(qn)) continue
        const reason = qn >= VIP_THRESHOLD && !this.session.isVIP ? '大会员' : !this.session.loggedIn ? '需登录' : '不可用'
        streams.push({ id: String(qn), url: 'about:blank', format: 'hls', quality: quality(qn), description: reason, unavailableReason: reason })
      }
      streams.sort((a, b) => b.quality.rank - a.quality.rank || Number(b.id) - Number(a.id))
    }
    const available = streams.filter((s) => !s.unavailableReason)
    const selected = available.find((s) => s.quality.rank <= cap) ?? available.at(-1)!

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
        audio: aac?.codecs ?? 'none',
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
