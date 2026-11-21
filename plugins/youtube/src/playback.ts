// 播放：yt-dlp 匿名取格式（服务端的出口铸 PO Token 与否交给 yt-dlp 和它的插件），H.264 视频 + AAC 音频的单文件
// DASH 轨道经媒体网关做成 HLS（SERVER.md §12.3），每个清晰度 × 音轨语言一条流；字幕写进 master。
// 观看记录：登录时以 TV 身份另取一次 `player`，只要它的 playbackTracking（App 的 trackingContext）。
import { randomBytes } from 'node:crypto'
import { setTimeout as later } from 'node:timers'
import type { Cue, PlaybackMedia, ProgressRequest, ResolveRequest, Stream, SubtitleTrack } from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { SourceError, type Ctx, type Exit, type DashAudioTrack, type DashVideoTrack, type SubtitleRendition, webVTTPlaylist } from '@iyt-source/kit'
import * as adapter from '../rules/adapter.ts'
import { CaptionFetcher } from './captions.ts'
import type { YouTubeSession } from './session.ts'

/** yt-dlp `-J` 里用到的部分。 */
export interface YtDlpInfo {
  id: string
  title?: string
  duration?: number
  is_live?: boolean
  live_status?: string
  language?: string
  formats: YtDlpFormat[]
  subtitles?: Record<string, YtDlpCaption[]>
  automatic_captions?: Record<string, YtDlpCaption[]>
}

export interface YtDlpFormat {
  format_id: string
  url: string
  protocol?: string
  ext?: string
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  fps?: number
  tbr?: number
  language?: string
  language_preference?: number
  format_note?: string
  http_headers?: Record<string, string>
}

export interface YtDlpCaption {
  ext: string
  url: string
  name?: string
}

export interface PlaybackOptions {
  /** 分片地址直连 CDN 还是经网关转发（默认）。YouTube 的地址绑定服务端的出口 IP，App 与服务出口不同就只能转发。 */
  via?: 'direct' | 'proxy'
  /** 额外的 yt-dlp 参数（如 `--extractor-args youtube:player_client=...`）。 */
  ytdlpArgs?: string[]
}

const QUALITIES = [1080, 720, 480, 360, 240]
/** 字幕原文：视频 → 轨道 key → json3 地址（`cues` 用）。 */
type CaptionIndex = Map<string, Map<string, { url: string; auto: boolean }>>

export function languageName(code: string | undefined): string {
  if (!code) return '默认'
  try {
    return new Intl.DisplayNames(['zh-Hans'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

const isAVC = (f: YtDlpFormat) => f.protocol === 'https' && f.ext === 'mp4' && f.vcodec?.startsWith('avc1') && (!f.acodec || f.acodec === 'none')
const isAAC = (f: YtDlpFormat) => f.protocol === 'https' && f.ext === 'm4a' && f.acodec?.startsWith('mp4a') && !f.format_id.includes('drc')

/** 每个高度一条最好的 H.264 视频（帧率高的、码率高的先）。 */
export function videoLadder(formats: YtDlpFormat[]): YtDlpFormat[] {
  const best = new Map<number, YtDlpFormat>()
  for (const format of formats.filter(isAVC)) {
    const height = format.height ?? 0
    const current = best.get(height)
    if (!current || (format.fps ?? 0) > (current.fps ?? 0) || ((format.fps ?? 0) === (current.fps ?? 0) && (format.tbr ?? 0) > (current.tbr ?? 0))) {
      best.set(height, format)
    }
  }
  return [...best.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
}

/** 每种语言一条最好的 AAC 音频；原声（language_preference 最高）在前。 */
export function audioTracks(formats: YtDlpFormat[]): YtDlpFormat[] {
  const best = new Map<string, YtDlpFormat>()
  for (const format of formats.filter(isAAC)) {
    const key = format.language ?? ''
    const current = best.get(key)
    if (!current || (format.tbr ?? 0) > (current.tbr ?? 0)) best.set(key, format)
  }
  return [...best.values()].sort((a, b) => (b.language_preference ?? -1) - (a.language_preference ?? -1))
}

/** yt-dlp 说要验证不是机器人：出口 IP 的问题，换出口能好。 */
const BOT_CHECK = 'YouTube 暂时拦下了服务的网络（要求验证不是机器人），请稍后再试'

export class YouTubePlayback {
  private readonly session: YouTubeSession
  private readonly options: PlaybackOptions
  private readonly captions: CaptionIndex = new Map()
  /** 字幕文件：播放器的 WebVTT 和翻译用的原文共用，缓存、被限流后冷却。 */
  private readonly captionFiles = new CaptionFetcher()
  /** 每次播放上次上报到的位置（watchtime 的 st）。 */
  private readonly positions = new Map<string, string>()

  constructor(session: YouTubeSession, options: PlaybackOptions = {}) {
    this.session = session
    this.options = options
  }

  async resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const tracking = this.session.loggedIn ? this.trackingContext(request.video, ctx) : Promise.resolve(undefined)
    const { info, withAccount, exit } = await this.extract(request.video, ctx)
    const via = this.options.via ?? 'proxy'
    // googlevideo 的地址绑定解析时的出口 IP：网关取分片也走这个出口（SERVER.md §18）。
    const dispatcher = exit?.dispatcher
    const duration = info.duration ?? 0
    const subtitles = this.subtitles(info, ctx, duration, dispatcher)
    const renditions: SubtitleRendition[] = subtitles.map((track) => track.rendition)
    const streams: Stream[] = []
    let live = false

    if (info.is_live || info.live_status === 'is_live') {
      // 直播：YouTube 自己的 HLS 主列表，经网关改写（地址绑定服务端的出口）。
      const manifest = info.formats.find((f) => f.protocol === 'm3u8_native' && f.url.includes('hls_variant'))?.url
        ?? info.formats.find((f) => f.protocol === 'm3u8_native')?.url
      if (!manifest) throw new SourceError('unplayable', '这个直播没有可播放的流')
      live = true
      streams.push({ id: 'live', url: ctx.media.proxy(manifest, { playlist: 'yes', name: 'live.m3u8', ttl: 6 * 3600, dispatcher }), format: 'hls', quality: { rank: 1080, label: '直播' }, description: 'youtube live hls' })
    } else {
      const videos = videoLadder(info.formats)
      const audios = audioTracks(info.formats)
      if (videos.length === 0 || audios.length === 0) throw new SourceError('unplayable', '没有可播放的格式（H.264 + AAC）')
      const dashVideo = (f: YtDlpFormat): DashVideoTrack => ({
        url: f.url, codecs: f.vcodec!, bandwidth: Math.round((f.tbr ?? 1000) * 1000), width: f.width, height: f.height, frameRate: f.fps,
      })
      const dashAudio = (f: YtDlpFormat, isDefault: boolean): DashAudioTrack => ({
        url: f.url, codecs: f.acodec!, bandwidth: Math.round((f.tbr ?? 128) * 1000), language: f.language, name: languageName(f.language), isDefault,
      })
      const multipleLanguages = audios.length > 1
      for (const audio of audios) {
        const language = multipleLanguages ? { code: audio.language ?? 'und', name: languageName(audio.language) } : undefined
        if (request.preferences?.adaptive) {
          streams.push({
            id: `auto-${audio.language ?? 'und'}`,
            url: ctx.media.dash({ videos: videos.map(dashVideo), audios: [dashAudio(audio, true)], subtitles: renditions }, { via, ttl: 5 * 3600, dispatcher }),
            format: 'hls',
            quality: { rank: videos[0].height ?? 0, label: '自动' },
            language,
            description: `avc1 adaptive ${via}`,
          })
          continue
        }
        for (const video of videos.filter((v) => QUALITIES.includes(v.height ?? 0) || v === videos[0])) {
          streams.push({
            id: `${video.height}-${audio.language ?? 'und'}`,
            url: ctx.media.dash({ videos: [dashVideo(video)], audios: [dashAudio(audio, true)], subtitles: renditions }, { via, ttl: 5 * 3600, dispatcher }),
            format: 'hls',
            quality: { rank: video.height ?? 0, label: `${video.height}P` },
            language,
            description: `${video.vcodec} ${video.height}p${video.fps ? ` ${video.fps}fps` : ''} ${via}`,
          })
        }
      }
    }

    // 清晰度上限内最好的，原声优先。
    const cap = request.preferences?.maxQualityRank ?? Number.POSITIVE_INFINITY
    const wanted = request.preferences?.language
    const candidates = streams.filter((s) => !wanted || s.language?.code === wanted)
    const pool = candidates.length ? candidates : streams
    const selected = pool.find((s) => s.quality.rank <= cap) ?? pool.at(-1)!

    const context = await tracking
    return {
      title: info.title ?? request.video,
      live,
      expiresAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
      streams,
      selectedStream: selected.id,
      subtitles: subtitles.length ? subtitles.map((track) => track.protocol) : undefined,
      reportContext: context,
      diagnostics: { path: `yt-dlp-${via}`, exit: exit?.url ?? 'default', account: withAccount ? 'cookies' : 'anonymous', tracking: context ? 'yes' : this.session.loggedIn ? 'failed' : 'signed_out' },
    }
  }

  /**
   * yt-dlp 取格式：按出口池的 `ytdlp` 出口依次试（SERVER.md §18），某个出口被要求验证不是机器人就冷却它、换下一个；
   * 没配出口池时走全局代理。返回用的出口：之后取这个视频的分片也要走它。
   */
  private async extract(video: string, ctx: Ctx): Promise<{ info: YtDlpInfo; withAccount: boolean; exit?: Exit }> {
    return ctx.exits.run('ytdlp', async (exit) => ({ ...(await this.extractVia(video, ctx, exit)), exit }),
      (error) => (error instanceof SourceError && error.message === BOT_CHECK ? '要求验证不是机器人' : undefined),
      'YouTube 暂时拦下了服务的所有出口（要求验证不是机器人），请约 {minutes} 分钟后再试')
  }

  /**
   * 经一个出口取格式：先匿名；说要登录（会员、年龄限制）且有网页登录的 cookie 时带上 cookie 再取一次；
   * 解析失败可能是 yt-dlp 过时，更新后再试一次。
   */
  private async extractVia(video: string, ctx: Ctx, exit: Exit | undefined): Promise<{ info: YtDlpInfo; withAccount: boolean }> {
    const url = `https://www.youtube.com/watch?v=${video}`
    const args = [...(this.options.ytdlpArgs ?? []), ...(exit ? ['--proxy', exit.url] : [])]
    const run = (extra: string[] = [], cacheMs = 20 * 60_000) => ctx.ytdlp.extract<YtDlpInfo>(url, [...args, ...extra], { signal: ctx.signal, cacheMs })
    try {
      return { info: await run(), withAccount: false }
    } catch (error) {
      if (!(error instanceof SourceError)) throw error
      const cookies = this.session.cookiesFile
      if (error.code === 'login_required' && cookies) {
        try {
          return { info: await run(['--cookies', cookies]), withAccount: true }
        } catch (second) {
          if (second instanceof SourceError && second.code === 'login_required') {
            throw new SourceError('login_required', '网页登录的账号也看不了这个视频（会员或年龄限制），或登录已失效')
          }
          throw second
        }
      }
      // 机器人验证是服务出口 IP 的问题（机房 IP 常见），不是这个视频要账号：保留 yt-dlp 分类出来的说法。
      if (error.code === 'login_required' && /not a bot/i.test(String(error.cause ?? ''))) {
        throw new SourceError('unavailable', BOT_CHECK)
      }
      if (error.code === 'login_required') throw new SourceError('login_required', '这个视频需要账号才能看：在调试页或 App 里用「网页登录」交给服务一次')
      if (error.code === 'upstream_changed' && (await ctx.ytdlp.update())) return { info: await run([], 0), withAccount: false }
      throw error
    }
  }

  /** 上传的字幕全要；语音识别只要原声那条（`xx-orig`），机器翻译的不要。 */
  private subtitles(info: YtDlpInfo, ctx: Ctx, duration: number, dispatcher?: unknown) {
    const index = new Map<string, { url: string; auto: boolean }>()
    this.captions.set(info.id, index)
    if (this.captions.size > 50) this.captions.delete(this.captions.keys().next().value!)
    const tracks: { protocol: SubtitleTrack; rendition: SubtitleRendition }[] = []
    const add = (key: string, language: string, captions: YtDlpCaption[], auto: boolean) => {
      const vtt = captions.find((c) => c.ext === 'vtt')
      const json3 = captions.find((c) => c.ext === 'json3')
      if (!vtt) return
      const name = auto ? `${languageName(language)}（自动生成）` : languageName(language)
      // 有 json3 时由这里取（缓存、限流后冷却，和翻译原文共用一份）再转成 WebVTT，不让网关直接转发 timedtext；
      // 只有 vtt 的才代理它。
      const vttURL = json3
        ? ctx.media.generated(async () => adapter.captionVTT(await this.captionFile(`${info.id}|${key}`, json3.url, ctx)),
                              { name: `${key}.vtt`, ttl: 5 * 3600 })
        : ctx.media.proxy(vtt.url, { playlist: 'no', name: `${key}.vtt`, ttl: 5 * 3600, dispatcher })
      const playlist = ctx.media.text(webVTTPlaylist(vttURL, duration || 3600), { name: `${key}.m3u8`, ttl: 5 * 3600 })
      if (json3) index.set(key, { url: json3.url, auto })
      tracks.push({
        protocol: {
          key, name, language, generated: auto, vtt: vttURL,
          cues: json3 ? `${BASE_PATH}/sources/${ctx.sourceId}/subtitles/${info.id}/${encodeURIComponent(key)}` : undefined,
        },
        rendition: {
          name, language, uri: playlist, autoselect: !auto,
          characteristics: auto ? 'com.mxc.iyouteng.generated' : undefined,
        },
      })
    }
    for (const [language, captions] of Object.entries(info.subtitles ?? {})) {
      if (language === 'live_chat') continue
      add(language, language, captions, false)
    }
    for (const [key, captions] of Object.entries(info.automatic_captions ?? {})) {
      if (!key.endsWith('-orig')) continue
      const language = key.slice(0, -'-orig'.length)
      add(`${language}.asr`, language, captions, true)
    }
    return tracks
  }

  async cues(video: string, key: string, ctx: Ctx): Promise<Cue[]> {
    const caption = this.captions.get(video)?.get(key)
    if (!caption) throw new SourceError('not_found', '找不到这条字幕，请重新解析')
    const answer = await this.captionFile(`${video}|${key}`, caption.url, ctx, ctx.signal)
    return adapter.captionCues({ answer, auto: caption.auto })
  }

  /** 一条字幕的 json3：缓存（`CaptionFetcher`），请求按出口池的 `subtitles` 出口依次试，被限（429）的冷却、换下一个。 */
  private captionFile(key: string, url: string, ctx: Ctx, signal?: AbortSignal) {
    return this.captionFiles.get(key, url, signal, (target, abort) => ctx.exits.fetch('subtitles', target, { signal: abort },
      (response) => response.status === 429, 'YouTube 暂时限制了这台服务的所有出口取字幕，请约 {minutes} 分钟后再试'))
  }

  /** 登录时以规则里第一个播放身份另取一次 `player`，只要它的观看记录地址；5 秒拿不到就算了。 */
  private async trackingContext(video: string, ctx: Ctx): Promise<Record<string, string> | undefined> {
    const work = (async () => {
      const signatureTimestamp = await this.session.signatureTimestamp(ctx.signal)
      const answer = await this.session.innertube('player', adapter.playerRequest({ videoId: video, signatureTimestamp }), this.session.clients.playerClients[0], { signal: ctx.signal })
      const read = adapter.player(answer)
      if (read.status !== 'OK' || !read.tracking?.watchtime) return undefined
      const context: Record<string, string> = { vid: video, cpn: randomBytes(12).toString('base64url').slice(0, 16), watchtime: read.tracking.watchtime }
      if (read.tracking.playback) context.playback = read.tracking.playback
      if (read.lengthSeconds) context.len = read.lengthSeconds.toFixed(3)
      return context
    })().catch((error) => {
      ctx.log.warn('tracking context failed', { error: String(error) })
      return undefined
    })
    const timeout = new Promise<undefined>((resolve) => later(resolve, 5000))
    return Promise.race([work, timeout])
  }

  /** 照 TV 版记观看：开始时发 playback 地址，播放中发 watchtime（上次位置到这次），结束或离开带 final=1。 */
  async progress(request: ProgressRequest, ctx: Ctx): Promise<void> {
    const context = request.reportContext as Record<string, string> | undefined
    if (!this.session.loggedIn || !context?.cpn || !context.watchtime) return
    const length = context.len ?? (request.duration ?? 0).toFixed(3)
    const position = Math.max(request.position, 0).toFixed(3)
    const previous = this.positions.get(context.cpn) ?? position
    this.positions.set(context.cpn, position)
    const parameters: Record<string, string> = { ver: '2', cpn: context.cpn, cmt: position, len: length }
    switch (request.event) {
      case 'start':
        if (context.playback) await this.session.track(context.playback, parameters, ctx.signal)
        return
      case 'progress':
      case 'seek':
        Object.assign(parameters, { st: previous, et: position })
        break
      case 'leave':
      case 'end':
        Object.assign(parameters, { st: previous, et: request.event === 'end' ? length : position, final: '1' })
        this.positions.delete(context.cpn)
        break
    }
    await this.session.track(context.watchtime, parameters, ctx.signal)
  }
}
