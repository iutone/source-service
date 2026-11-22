// 播放：UPS `mtop.youku.play.ups.appinfo.get`（docs/youku-web/REPORT.md §3、§8.6；PLAYER.md），进度上报 `playlog.open.push`
// （PLAYER.md §6）。照 App 的 YoukuPlaybackService 移植。给 App 的都是不要请求头的 HLS：明文流直接给 CDN 地址（实测不校验
// UA / Referer / cookie）；优酷私有加密（copyrightDRM）、MPEG-TS 封装的 HEVC（mp5*，AVPlayer 只解得出声音）要在服务端解密 /
// 转封装（private.ts）；cbcs 加密的 CMAF 档在客户端解密（FairPlay / Widevine），服务端只转发许可（fairplay.ts）。
import type { DrmSystem, Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { arr, bool, compact, int, num, text, webImage, type J } from './json.ts'
import { CCODE, CLIENT_VERSION, PLAYER_VERSION, UPS_HOST, type MTOPClient } from './mtop.ts'

/** 客户端什么 DRM 都不能用（`preferences.drm` 是 `[]`）。 */
export const NO_DRM = '这台设备不能播加密片源'

/** UPS 的错误码，照 KuPlayer 对它们的提示（PLAYER.md §错误码）：note 往往只有「此视频无法播放」。 */
export function restriction(code: number): string | undefined {
  switch (code) {
    case -3001:
    case -3007:
      return '这个视频需要优酷 VIP 或单独购买才能观看'
    case -2004:
      return '这个视频需要订阅后观看'
    case -2002:
    case -2003:
      return '这个视频设了密码'
    case -2001:
    case -2005:
      return '这个视频是私密的，看不了'
    case -6005:
      return '登录优酷后才能观看这个视频'
    default:
      return undefined
  }
}

export class UPSError extends SourceError {
  readonly upsCode: number
  constructor(code: ConstructorParameters<typeof SourceError>[0], message: string, upsCode: number, options: { retryable?: boolean } = {}) {
    super(code, message, options)
    this.upsCode = upsCode
  }
}

/** 私有流的会话：`encryptR_client` 是随机数用固定密钥加密后的 base64，服务端拿它包内容密钥（private.ts）。 */
export interface PrivateClient {
  client: string
  /** 恢复 copyrightDRM 流的内容密钥；不支持时省略。 */
  recover?(server: string, copyright: string): Buffer
}

export function upsParameters(options: { vid: string; ckey: string; utid: string; privateClient?: string; hevc?: boolean; cbcs?: DrmSystem; now?: number }): Record<string, string> {
  const biz: Record<string, unknown> = {
    vid: options.vid, app_ver: CLIENT_VERSION, h265: 0, play_ability: 16782592, master_m3u8: 0, preferClarity: 3, media_type: 'standard',
    extag: 'EXT-X-PRIVINF',
  }
  if (options.cbcs) {
    // KuPlayer 的 getDrmType：Safari（FairPlay）19 加 drmLevel 1；Chrome 69+ 的 Widevine 走 cbcs 也是 19，不带 drmLevel
    // （不走 cbcs 时是 35 = cenc，CMAF 用不上）。keyIndex 都是 web01（FAIRPLAY.md §3）。给的是同一组 cbcs CMAF。
    biz.drm_type = 19
    if (options.cbcs === 'fairplay') biz.drm_level = 1
    biz.key_index = 'web01'
  }
  if (options.privateClient) {
    biz.encryptR_client = options.privateClient
    // 私有密钥的包装和 KSM 的响应加密无关：FairPlay 的 CKC 不包装。
    biz.enc_ver = 0
    biz.key_index = 'web01'
    biz.drm_type = options.cbcs ? 19 : 3
    biz.h265 = options.hevc ? 1 : 0
    biz.play_ability = 16782592 | (1 << 18) | (1 << 20)
    biz.master_m3u8 = 1
  }
  const steal = {
    ccode: CCODE, utid: options.utid, version: CLIENT_VERSION, ckey: options.ckey, client_ip: '192.168.1.1',
    client_ts: Math.floor((options.now ?? Date.now()) / 1000),
  }
  // UPS 要每组都是 JSON 字符串。
  return { biz_params: JSON.stringify(biz), steal_params: JSON.stringify(steal), ad_params: JSON.stringify({ vs: '1.0' }) }
}

export async function callUPS(client: MTOPClient, parameters: Record<string, string>, signal?: AbortSignal): Promise<J> {
  const data = await client.call('mtop.youku.play.ups.appinfo.get', '1.1', parameters, { host: UPS_HOST, signal })
  return data?.data
}

/** UPS 的错误转成协议的错误；没有错误时返回。 */
export function checkUPS(ups: J): void {
  if (ups?.error) {
    const code = int(ups.error.code) ?? 0
    const note = text(ups.error.note) ?? `错误码 ${code}`
    if (code === -6004) throw new UPSError('unavailable', `播放密钥被优酷拒绝：${note}`, code, { retryable: true })
    // 「DRM视频，不支持」：只有声明了 DRM 才给这些片子。
    if (code === -4008) throw new UPSError('unplayable', '这个视频只有加密的版本，取加密流也没成功', code)
    const reason = restriction(code)
    if (reason) throw new UPSError(code === -6005 ? 'login_required' : 'restricted', reason, code)
    throw new UPSError('unplayable', `优酷不给播放：${note}（${code}）`, code)
  }
  if (arr(ups?.stream).length === 0) throw new SourceError('upstream_changed', 'UPS 没有返回任何流')
  const trial = trialRestriction(ups)
  if (trial) throw new UPSError('restricted', trial, 0)
}

/**
 * 只给试看：UPS 给非会员（会员过期）的 VIP 片子不报错，流在 `trial.time` 秒（6 分钟）处截断。KuPlayer 把 `trial.time > 0`
 * 当试看，`type` 是 "time" 为会员试看，"subscribe" 为订阅者专享；会员的回答没有 `trial`。和其他平台的试看一样拒掉。
 */
export function trialRestriction(ups: J): string | undefined {
  const time = num(ups?.trial?.time)
  if (!time || time <= 0) return undefined
  const duration = num(ups?.video?.seconds)
  if (duration && duration > 0 && time >= duration - 5) return undefined
  if (ups.trial.type === 'subscribe') return restriction(-2004)
  // 会员也只给试看：单点付费（`fee.paid_type` 有 vod）或频道包月（mon）的片子，VIP 不包含（实测《庆余年2》疑点揭秘这类付费解读）。
  if (isVip(ups)) {
    const types = arr(ups?.fee?.paid_type).map((t: J) => text(t))
    const price = text(ups?.pay?.price)
    if (types.includes('vod') || types.includes('mon')) {
      return `这个视频要在优酷单独购买${price ? `（¥${price}）` : ''}${types.includes('mon') ? '或开通它的包月' : ''}，优酷 VIP 不包含`
    }
    return '这个视频优酷 VIP 也只能试看（可能要更高等级的会员或单独购买）'
  }
  return restriction(-3001)
}

/** UPS 认出的账号是不是会员：`user.vip`，或 `controller.pay_info_ext`（JSON 字符串）的 `is_vip`。 */
export function isVip(ups: J): boolean {
  if (bool(ups?.user?.vip) === true) return true
  try {
    return bool(JSON.parse(text(ups?.controller?.pay_info_ext) ?? '{}')?.is_vip) === true
  } catch {
    return false
  }
}

/** 按优酷的清晰度档位（KuPlayer 的标签）定档，认不出用画面高度。 */
export function quality(streamType: string, height: number): { rank: number; label: string } {
  const type = streamType.toLowerCase()
  if (type.includes('4k') || type.includes('hd4')) return { rank: 2160, label: '4K' }
  if (type.endsWith('hd3')) return { rank: 1080, label: '1080P' }
  if (type.endsWith('hd2')) return { rank: 720, label: '720P' }
  if (type === 'flvhd' || type.endsWith('sd') || type.endsWith('ld')) return { rank: 360, label: '360P' }
  if (type.endsWith('hd')) return { rank: 480, label: '480P' }
  if (height >= 1800) return { rank: 2160, label: '4K' }
  if (height >= 900) return { rank: 1080, label: '1080P' }
  if (height >= 600) return { rank: 720, label: '720P' }
  if (height >= 420) return { rank: 480, label: '480P' }
  return { rank: 360, label: '360P' }
}

/** 优酷 MPEG-TS 封装的 H.265（`mp5*`）；CMAF 的 HEVC（`cmfv5*`）是 fMP4，AVPlayer 能直接播。 */
export function isHEVCTransportStream(streamType: string): boolean {
  return streamType.toLowerCase().startsWith('mp5')
}

/** 播放列表地址里最早的 `ups_ts + expire`（秒 + 有效期秒数，如 18000）。按原样的 query 读，不重新编码。 */
export function expiry(urls: string[]): number | undefined {
  let earliest: number | undefined
  for (const url of urls) {
    const query = url.split('?')[1] ?? ''
    const fields = new Map(query.split('&').map((pair) => {
      const eq = pair.indexOf('=')
      return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)]
    }))
    const issued = Number(fields.get('ups_ts'))
    const lifetime = Number(fields.get('expire'))
    if (Number.isFinite(issued) && Number.isFinite(lifetime) && issued > 0 && lifetime > 0) {
      const at = (issued + lifetime) * 1000
      if (earliest === undefined || at < earliest) earliest = at
    }
  }
  return earliest
}

/**
 * 帧享 4K（CMAF `cmfv5hd4_hbr`）：KuPlayer 不再问 UPS，在同一个 `pl-ali.youku.com/playlist/m3u8` 地址上只换 `type`、
 * `streamcoding`，其余百分号编码的字段逐字保留（签名过的优酷地址重新编码就坏了）。
 */
export function private4KURL(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname !== 'pl-ali.youku.com' || parsed.pathname !== '/playlist/m3u8') return undefined
  const at = url.indexOf('?')
  if (at < 0) return undefined
  const replacements: Record<string, string> = { type: 'cmfv5hd4_hbr', streamcoding: 'cmfva5-hbr' }
  const found = new Set<string>()
  const query = url.slice(at + 1).split('&').map((field) => {
    const key = field.split('=')[0]
    const value = replacements[key]
    if (value === undefined) return field
    found.add(key)
    return `${key}=${value}`
  }).join('&')
  return found.size === 2 ? `${url.slice(0, at)}?${query}` : undefined
}

/**
 * `dvd.head` / `dvd.tail` 和 `dvd.point` 里的看点，都是毫秒（PLAYER.md §4）。没有 `head` 时片头在版权卡（`license_head`，
 * 剧集开头几秒）之后结束。`cut` / `contentad` 是网页插广告的地方，我们的流没有广告，不管。
 */
export function markers(dvd: J): Markers | undefined {
  const seconds = (value: J) => {
    const ms = num(value)
    return ms && ms > 0 ? ms / 1000 : undefined
  }
  const points = arr(dvd?.point)
  const licenseEnd = seconds(points.find((p: J) => p?.ctype === 'license_head')?.start)
  const chapters = points.filter((p: J) => p?.ctype === 'story' && seconds(p.start) !== undefined && text(p.title)).map((p: J) => compact({
    start: seconds(p.start)!, end: seconds(p.end), title: text(p.title)!, imageURL: webImage(p.capture_pic_url),
  }))
  const result = compact({ introEnd: seconds(dvd?.head) ?? licenseEnd, outroStart: seconds(dvd?.tail), chapters: chapters.length ? chapters : undefined })
  return Object.keys(result).length ? result : undefined
}

/** `lastpoint` 的单位没确认：超过时长的当毫秒。看完了的从头播，不从片尾续。 */
export function startPosition(lastPoint: number | undefined, duration: number): number | undefined {
  if (!lastPoint || lastPoint <= 0) return undefined
  const position = duration > 0 && lastPoint > duration + 1 ? lastPoint / 1000 : lastPoint
  if (position <= 5) return undefined
  if (duration > 0 && position > duration * 0.95) return undefined
  return position
}

/** 播放记录上报除了位置还要的：主语言的视频 id（配音版共用一条历史）、节目、时长。 */
export interface ReportContext {
  videoId: string
  showId?: string
  tp?: string
  stage?: string
  category?: string
  seconds?: string
  /** 选中流的档位（KuPlayer 的清晰度序号）和语言。 */
  hd?: number
  lang?: string
}

export function reportContext(ups: J, video: string): ReportContext {
  const main = arr(ups?.dvd?.audiolang).find((l: J) => bool(l?.show_mainlang) === true)
  const show = ups?.show ?? {}
  const seconds = num(ups?.video?.seconds)
  return compact({
    videoId: text(main?.vid) ?? text(ups?.video?.encodeid) ?? video,
    showId: text(show.encodeid),
    tp: text(show.video_type),
    stage: text(show.stage),
    category: text(show.showcategory),
    seconds: seconds !== undefined ? String(Math.trunc(seconds)) : undefined,
  })
}

/** KuPlayer 报的清晰度序号，1...3（其余 0）。 */
export function hdIndex(rank: number): number {
  if (rank >= 1080) return 3
  if (rank >= 720) return 2
  if (rank >= 480) return 1
  return 0
}

/** KuPlayer 的播放记录（PLAYER.md §6）：`point` 毫秒，`logType` 0 开始 / 1 进度 / 2 结束 / 3 拖动。 */
export function progressParameters(progress: ProgressRequest, cna: string, now = Date.now()): Record<string, unknown> {
  const context = (progress.reportContext ?? {}) as Partial<ReportContext>
  const logType = { start: 0, progress: 1, leave: 1, end: 2, seek: 3 }[progress.event] ?? 1
  const parameters: Record<string, unknown> = {
    videoId: context.videoId ?? progress.video, hwClass: 1, devicename: 'H5', mediaType: 1, appVersion: PLAYER_VERSION, autoPlay: 1,
    umid: cna, nlid: cna, hd: context.hd ?? 0, langName: context.lang ?? 'default',
    point: String(Math.round(Math.max(progress.position, 0) * 1000)), lastUpdate: Math.floor(now / 1000), logType, playTs: 0,
    timestamp: now, appKey: 'qPbb2hfIYugHjMaj', seconds: progress.duration ? Math.trunc(progress.duration) : Number(context.seconds ?? 0) || 0,
  }
  for (const key of ['showId', 'tp', 'stage', 'category'] as const) if (context[key]) parameters[key] = context[key]
  return parameters
}

// MARK: 流

export interface RawStream {
  id: string
  url: string
  streamType: string
  drm: string
  height: number
  size: number
  quality: { rank: number; label: string }
  languageCode: string
  /** 怎么给 App：直接给、服务端解密 / 转封装、给不了。 */
  path: 'direct' | 'cbcs' | 'private' | 'remux' | 'unsupported'
  /** cbcs：许可地址（`stream_ext.uri`，token 绑本次取流）。 */
  licenseURL?: string
  /** copyrightDRM：恢复出的内容密钥。 */
  key?: Buffer
  reason?: string
}

/**
 * UPS 的流按清晰度和语言各留一个：AVPlayer 能直接播的优先（明文 H.264 优先于要转封装的 HEVC TS），再挑大的。
 * - `canProcess`：服务端能不能解密 / 转封装（private.ts 可用时为 true）。
 */
/**
 * - `cbcs`：这次 UPS 声明了 cbcs 时，客户端能用的 DRM（`[]` 时 cbcs 档标不可用）；没声明时省略，cbcs 档给不了。
 */
export function pickStreams(ups: J, options: { privateClient?: PrivateClient; canProcess: boolean; cbcs?: DrmSystem[]; log?: (message: string) => void }): RawStream[] {
  const byKey = new Map<string, RawStream>()
  const rankOf = (s: RawStream) => streamRank(s, options.canProcess)
  for (const raw of arr(ups?.stream)) {
    const drm = text(raw?.drm_type) ?? 'default'
    const url = text(raw?.m3u8_url)
    if (!url || !/^https?:\/\//.test(url)) continue
    const streamType = text(raw.stream_type) ?? '?'
    const height = int(raw.height) ?? 0
    const languageCode = text(raw.audio_lang) ?? 'default'
    const stream: RawStream = {
      id: `${streamType}-${languageCode}`, url, streamType, drm, height, size: int(raw.size) ?? 0, quality: quality(streamType, height), languageCode, path: 'direct',
    }
    if (drm === 'copyrightDRM') {
      const server = text(raw.encryptR_server)
      const wrapped = text(raw?.stream_ext?.copyright_key)
      if (!options.canProcess || !options.privateClient?.recover) {
        stream.path = 'unsupported'
        stream.reason = '优酷私有加密的清晰度，自建源暂不支持'
      } else if (!server || !wrapped) {
        continue
      } else {
        try {
          stream.key = options.privateClient.recover(server, wrapped)
          stream.path = 'private'
        } catch {
          options.log?.(`youku private key recovery failed type=${streamType}`)
          continue
        }
      }
    } else if (drm === 'cbcs' && options.cbcs && text(raw?.stream_ext?.uri)?.startsWith('https://')) {
      if (options.cbcs.length) {
        stream.path = 'cbcs'
        stream.licenseURL = text(raw.stream_ext.uri)
      } else {
        stream.path = 'unsupported'
        stream.reason = NO_DRM
      }
    } else if (drm === 'cbcs' || drm === 'cenc' || drm === 'webDRM') {
      stream.path = 'unsupported'
      stream.reason = '加密的清晰度，自建源暂不支持'
    } else if (drm !== 'default' && drm !== '') {
      stream.path = 'unsupported'
      stream.reason = `不支持的加密（${drm}）`
    } else if (isHEVCTransportStream(streamType)) {
      // AVPlayer 的 HLS 只播 fMP4 里的 HEVC：TS 里的只解得出声音。
      stream.path = options.canProcess ? 'remux' : 'unsupported'
      stream.reason = options.canProcess ? undefined : 'MPEG-TS 封装的 H.265，自建源暂不支持'
    }
    const key = `${stream.quality.rank}-${languageCode}`
    const existing = byKey.get(key)
    if (existing) {
      const a = rankOf(existing)
      const b = rankOf(stream)
      if (a > b || (a === b && existing.size >= stream.size)) continue
    }
    byKey.set(key, stream)
  }
  // 帧享 4K：本语言的目录列出了 `cmfv5hd4_hbr` 且 `can_play_status=1`，又有能恢复密钥的 CMAF 基础流时才加（PRIVATE-PLAYBACK.md）。
  for (const base of [...byKey.values()]) {
    if (!base.streamType.startsWith('cmfv') || base.path !== 'private' || !base.key) continue
    const lang = base.languageCode
    const type = 'cmfv5hd4_hbr'
    const advertised = arr(ups?.video?.stream_types?.[lang]).some((t: J) => text(t) === type)
    if (!advertised || int(ups?.video?.stream_ext?.[lang]?.[type]?.can_play_status) !== 1 || byKey.has(`2160-${lang}`)) continue
    const url = private4KURL(base.url)
    if (!url) continue
    byKey.set(`2160-${lang}`, { ...base, id: `${type}-${lang}`, url, streamType: type, quality: { rank: 2160, label: '4K' }, size: 0, height: 2160 })
  }
  return [...byKey.values()].sort((a, b) => a.languageCode.localeCompare(b.languageCode) || b.quality.rank - a.quality.rank)
}

/**
 * 同一档里谁优先：CDN 直连的明文 > cbcs（客户端解密，服务端不费 CPU）> 服务端解密 / 转封装 > 给不了的。
 * - `canProcess`：服务端能不能解密 / 转封装。
 */
export function streamRank(s: RawStream, canProcess: boolean): number {
  switch (s.path) {
    case 'direct': return 4
    case 'cbcs': return 3
    case 'private':
    case 'remux': return canProcess ? 2 : 1
    default: return 0
  }
}

/** 几次 UPS（明文 / 私有、cbcs）挑出的流合在一起：每档每种语言留一个，按上面的优先级。 */
export function mergeStreams(lists: RawStream[][], canProcess: boolean): RawStream[] {
  const byKey = new Map<string, RawStream>()
  for (const list of lists) {
    for (const stream of list) {
      const key = `${stream.quality.rank}-${stream.languageCode}`
      const existing = byKey.get(key)
      if (existing && streamRank(existing, canProcess) >= streamRank(stream, canProcess)) continue
      byKey.set(key, stream)
    }
  }
  return [...byKey.values()].sort((a, b) => a.languageCode.localeCompare(b.languageCode) || b.quality.rank - a.quality.rank)
}

/** 多语言时每条流标上语言名（`dvd.audiolang`）。 */
export function languages(ups: J): { multi: boolean; names: Map<string, string>; main?: string } {
  const names = new Map<string, string>()
  for (const lang of arr(ups?.dvd?.audiolang)) {
    const code = text(lang?.langcode)
    if (code && !names.has(code)) names.set(code, text(lang.lang) ?? code)
  }
  const multi = new Set(arr(ups?.stream).map((s: J) => text(s?.audio_lang)).filter(Boolean)).size > 1
  const main = text(arr(ups?.dvd?.audiolang).find((l: J) => bool(l?.show_mainlang) === true)?.langcode)
  return { multi, names, main }
}

/** 选中的流：首选语言（否则主语言、否则第一个）里不超过最高清晰度的最好一档，给不了的不选。 */
export function selectStream(streams: Stream[], preferences: ResolveRequest['preferences'], main: string | undefined): Stream | undefined {
  const playable = streams.filter((s) => !s.unavailableReason)
  if (!playable.length) return undefined
  const wanted = preferences?.language
  const language = (wanted && playable.find((s) => s.language?.code === wanted)?.language?.code)
    ?? playable.find((s) => s.language?.code === main)?.language?.code ?? playable[0].language?.code
  const candidates = playable.filter((s) => s.language?.code === language)
  const max = preferences?.maxQualityRank ?? Number.POSITIVE_INFINITY
  const within = candidates.filter((s) => s.quality.rank <= max)
  const pool = within.length ? within : candidates
  return pool.reduce((best, s) => (s.quality.rank > best.quality.rank ? s : best))
}

export function mediaFrom(ups: J, video: string, streams: Stream[], preferences: ResolveRequest['preferences'], diagnostics: Record<string, string>, upstreamURLs: string[]): PlaybackMedia {
  const { main } = languages(ups)
  const selected = selectStream(streams, preferences, main)
  if (!selected) {
    const reason = streams.find((s) => s.unavailableReason)?.unavailableReason
    throw new SourceError('unplayable', reason ? `这个视频只有自建源暂不支持的清晰度：${reason}` : '这个视频没有能播放的流')
  }
  const duration = num(ups?.video?.seconds) ?? 0
  const context = reportContext(ups, video)
  context.hd = hdIndex(selected.quality.rank)
  context.lang = selected.language?.code ?? 'default'
  const expires = expiry(upstreamURLs)
  return compact({
    title: text(ups?.video?.title) ?? video,
    startPosition: startPosition(num(ups?.playlog?.lastpoint), duration),
    expiresAt: expires ? new Date(expires - 5 * 60_000).toISOString() : undefined,
    markers: markers(ups?.dvd),
    streams,
    selectedStream: selected.id,
    reportContext: context,
    diagnostics,
  })
}

export async function reportProgress(client: MTOPClient, progress: ProgressRequest, cna: string, signal?: AbortSignal): Promise<void> {
  await client.call('mtop.youku.playlog.open.push', '1.0', progressParameters(progress, cna), { signal })
}
