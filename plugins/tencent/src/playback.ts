// 播放（API.md §4，App 的 TencentPlaybackService / TencentHLSAsset）。照网页播放器的首播：`vinfo_proxy`（服务端签名，
// 登录和想要的清晰度在发去的 cookie 里，`userSetting.defn`），答复被混淆（`cipher.ts`）；它失败时才 `proxyhttp` + 这里算的
// cKey（App 用 8.5；这里先 9.2 再 8.5，见 `signedVinfo`）。能力位照 Safari：只要 H.264（HEVC 只给 TS 分片，AVPlayer 放不了），
// 声明 FairPlay（版权方加密片答 FairPlay HLS，服务端暂不支持）。每档清晰度一次请求：解析时只取答复选中的那档，
// 其他档在 App 第一次请求它的播放列表时才去要（媒体网关的 `generated`）。播放列表从第一个能应答的 CDN 节点取
// （smtcdns 优先），分片改成绝对地址，App 直接从那个节点拉（`via: proxy` 时经网关转发）。进度写进观看历史（`AddOrUpdate`）。
// 会员 4K（uhd / suhd，HEVC 10-bit，只有 TS）：另发一次声明 HEVC 的 proxyhttp（cKey 9.2），分片在服务端转封装成 fMP4
// （`transmux.ts`），经网关给 App；列出但不自动选中，客户端说不能解 HEVC 时不能选。
import type { Ctx } from '@iyt-source/kit'
import { clientDrm, codecSupported, drmEndpoints, rewritePlaylist, SourceError } from '@iyt-source/kit'
import type { DrmSystem, Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream } from '@iyt-source/protocol'
import { decryptVinfo, vinfoKey } from './cipher.ts'
import { CKEY85_VERSION, CKEY92_APP_VERSION, CKEY92_VERSION, cKey85, cKey92 } from './ckey.ts'
import {
  PLAY_HOST, PLAYER_PLATFORM, PLAYER_VERSION, REFERER, USER_AGENT, VINFO_AD_PROTO_VER, VINFO_AD_VERSION,
  VINFO_PLAYER_VERSION, VINFO_PROTO_VER, VINFO_SALT,
} from './constants.ts'
import type { TencentDetail } from './detail.ts'
import type { TencentHistory } from './history.ts'
import { parseID } from './ids.ts'
import { arr, int, isObject, num, str, text } from './json.ts'
import { encode, randomHex, withTimeout, type TencentSession } from './session.ts'
import { hevcCodecString, transmuxAvailable, TransmuxPipeline, videoRange } from './transmux.ts'

/** 播放请求的 DRM 能力位（API.md §4.2.1，网页播放器的 `RE`）：FairPlay 16（Safari）、Widevine 32（Chrome）。 */
export const DRM_FAIRPLAY = 16
export const DRM_WIDEVINE = 32

/** 离结尾这么近的续播点算看完了，从头放。 */
const FINISHED_MARGIN = 10
/** `em` 91：这档清晰度要会员。 */
const MEMBERSHIP_QUALITY = 91

export interface PlaybackOptions {
  /** 分片直连 CDN（默认）还是经服务的媒体网关转发（App 连不上腾讯的 CDN、或 CDN 要求请求头时）。 */
  via?: 'direct' | 'proxy'
}

// MARK: 解析答复

/** `em` 不是 0：网站的提示带码（`85.-3` / `85.-12` / `85.-16` 是 cKey 不对，80 地区版权……）。 */
/** 对外声明的 DRM。Widevine 的许可格式确认之前不加入（SERVER.md §21）。 */
export const TENCENT_DRM_SYSTEMS: DrmSystem[] = ['fairplay']

export function checkInfo(info: any): void {
  const code = int(info?.em)
  if (!code) return
  const message = `${text(info.msg) ?? '该视频暂时无法播放'}（${text(info.code) ?? String(code)}）`
  if (code === 80 || code === MEMBERSHIP_QUALITY) throw new SourceError('restricted', message)
  if (code === 85) throw new SourceError('upstream_changed', message)
  throw new SourceError('unplayable', message)
}

/**
 * 只能试看或根本不能看：`st` 8（会员的，或单独购买的）。只看 `preview` 说明不了什么：会员看 VIP 集也是 `preview` 300、
 * `st` 2、整集可播（2026-11-12）；只有没有 `st` 时，`preview` 短于全长才算。
 */
export function restriction(info: any): string | undefined {
  const video = info?.vl?.vi?.[0] ?? {}
  const status = int(video.st)
  let restricted: boolean
  if (status !== undefined) {
    restricted = status === 8
  } else {
    const preview = num(info?.preview) ?? 0
    const duration = num(video.td) ?? 0
    restricted = preview > 0 && duration > 0 && preview < duration - FINISHED_MARGIN
  }
  if (!restricted) return undefined
  // 完全没有试看：单独购买（会员也不行）；会员剧集试看 300 秒。
  if (int(info?.preview) === 0) return '该视频需要在腾讯视频单独购买（会员也不能直接看）'
  return '该集需要腾讯视频 VIP'
}

/** 一档是 FairPlay 加密的（`drm` 4：TS + SAMPLE-AES，Safari 的能力位答它）。 */
export const isFairPlay = (format: any) => int(format?.drm) === 4

/** 一档用的 DRM：`drm` 4 FairPlay（Safari 能力位），5 Widevine（Chrome 能力位，CENC fMP4）；其他是明文。 */
export function formatSystem(format: any): DrmSystem | undefined {
  const drm = int(format?.drm)
  return drm === 4 ? 'fairplay' : drm === 5 ? 'widevine' : undefined
}

/**
 * 加密档的许可（API.md §4.2.1）：`vl.vi[0].ckc` 是「许可地址|证书地址」。FairPlay 的在 `…/vod/fairplay/v1/getckc`，
 * 带证书；Widevine 的在 `…/vod/widevine/v1/getlicense`，证书那半是空的。key id 取许可地址的 `link_vid`（否则视频的 `lnk`）。
 */
export interface TencentDRM {
  system: DrmSystem
  licenseURL: string
  certificateURL?: string
  /** 密钥 id：FairPlay 播放列表 `skd://` 的主机、许可请求的 `assetId`；Widevine PSSH 里的 content id。 */
  assetID: string
}

export function drmOf(info: any): TencentDRM | undefined {
  const video = info?.vl?.vi?.[0] ?? {}
  const ckc = text(video.ckc)
  if (!ckc) return undefined
  const [licenseURL = '', certificateURL = ''] = ckc.split('|')
  let linked: string | undefined
  let path: string
  try {
    const url = new URL(licenseURL)
    path = url.pathname
    linked = url.searchParams.get('link_vid') ?? undefined
  } catch {
    return undefined
  }
  const system: DrmSystem = path.includes('/widevine/') ? 'widevine' : 'fairplay'
  if (system === 'fairplay') {
    try {
      new URL(certificateURL)
    } catch {
      return undefined
    }
  }
  const assetID = linked || text(video.lnk)
  return assetID ? { system, licenseURL, certificateURL: certificateURL || undefined, assetID } : undefined
}

/** 媒体播放列表里的密钥标签对应的 DRM（按 KEYFORMAT，不按平台）。 */
export function playlistSystems(playlist: string): DrmSystem[] {
  const systems: DrmSystem[] = []
  const keys = playlist.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-KEY:') || l.startsWith('#EXT-X-SESSION-KEY:'))
  if (keys.some((l) => /KEYFORMAT="com\.apple\.streamingkeydelivery"/i.test(l) || /URI="skd:\/\//.test(l))) systems.push('fairplay')
  if (keys.some((l) => /KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/i.test(l))) systems.push('widevine')
  return systems
}

export const systemName = (system: DrmSystem) => (system === 'fairplay' ? 'FairPlay' : 'Widevine')

/** 许可请求体：`spc=<base64>&assetId=<key id>`（表单）。 */
export function licenseBody(spc: Uint8Array, assetID: string): string {
  return `spc=${encode(Buffer.from(spc).toString('base64'))}&assetId=${encode(assetID)}`
}

/**
 * 许可应答 `{"code":0,"ckc":"<base64>"}` → 许可（FairPlay 的 CKC、Widevine 的 license，都在 `ckc` 里）；code 不是 0 是平台拒绝
 * （`restricted`）。Widevine 的应答也可能只给 `anc`（`{rc, aanc, anc}`，像 vinfo_proxy 的那样，给网页播放器自己的可信 JS 解，
 * 这里打不开）：报 `upstream_changed`。
 */
export function ckcOf(answer: any): Uint8Array {
  const code = int(answer?.code)
  const encoded = code === 0 ? text(answer?.ckc) : undefined
  const ckc = encoded ? Buffer.from(encoded, 'base64') : undefined
  if (ckc?.length) return ckc
  if (code === 0 && text(answer?.anc)) throw new SourceError('upstream_changed', '腾讯视频只给了封装过的许可（anc），这里还解不开')
  throw new SourceError('restricted', `腾讯视频拒绝了播放许可：${text(answer?.msg) ?? 'DRM'}（${str(answer?.code) ?? '?'}）`)
}

/**
 * FairPlay 档的播放列表：TS + `SAMPLE-AES`，`URI="skd://<key id>"`（App 的 FairPlayKeySession 用的就是列表自带的这个）。
 * skd 的主机就是 `link_vid`，KSM 认它，不改；列表没写密钥标签时照 §6.4 补一个。
 */
export function ensureKeyTag(playlist: string, assetID: string): string {
  if (/#EXT-X-KEY:[^\n]*URI="skd:\/\//.test(playlist)) return playlist
  const lines = playlist.split('\n')
  const first = lines.findIndex((l) => l.startsWith('#EXTINF:'))
  lines.splice(first < 0 ? 1 : first, 0, `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://${assetID}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`)
  return lines.join('\n')
}

/** 版权方加密：答复内联的主播放列表，或视频 / 选中那档的 `drm` 4。 */
export function isProtected(info: any): boolean {
  return info?.play?.master != null || int(info?.vl?.vi?.[0]?.drm) === 4
    || arr(info?.fl?.fi).some((f) => int(f?.sl) === 1 && isFairPlay(f))
}

/** `vinfo_proxy` 对单片付费的片只给封起来的 `anc`（这里打不开）：当失败，改走 `proxyhttp`（它答 `st` 8、`preview` 0）。 */
export function plain(info: any): any {
  if (isObject(info) && info.vl === undefined && info.em === undefined && info.anc !== undefined) {
    throw new SourceError('upstream_changed', 'vinfo_proxy 只给了 anc')
  }
  return info
}

/**
 * 只要 H.264：`video` 21（TS），以及 Widevine 档的 1（CENC fMP4，CODECS 是 avc1）。8（HEVC）、23（HEVC 10-bit）只有 TS 分片，
 * AVPlayer 放不了；20 VVC 解不了。
 */
export const isPlayableCodec = (format: any) => {
  const video = int(format?.video) ?? 21
  return video === 21 || (video === 1 && formatSystem(format) === 'widevine')
}

/** `name`：hd 480P、shd 720P、fhd 1080P、uhd 4K；`hdr10` / `suhd`（臻彩）不要。协议的 rank 是像素高度。 */
export function qualityRank(format: any): number | undefined {
  switch (text(format?.name)) {
    case 'sd': return 270
    case 'hd': return 480
    case 'shd': return 720
    case 'fhd': return 1080
    case 'uhd': return 2160
    default: return undefined
  }
}

/** 转封装出来的 4K 流的 id 前缀：没指定清晰度时不自动选它们（和 App 一样）。 */
export const HEVC_PREFIX = 'hevc-'

/** 会员 4K：`uhd` 4K、`suhd` 4K 60 帧，HEVC（`video` 8 / 23），不是 FairPlay。 */
export function transmuxRank(format: any): number | undefined {
  if (![8, 23].includes(int(format?.video) ?? 0) || isFairPlay(format)) return undefined
  const name = text(format?.name)
  return name === 'uhd' || name === 'suhd' ? 2160 : undefined
}

/** 「准高清;(720P)」→「720P 准高清」。 */
export function qualityLabel(format: any): string {
  const name = text(format?.cname)
  if (!name) return text(format?.resolution) ?? text(format?.name) ?? ''
  const at = name.indexOf(';')
  const head = at >= 0 ? name.slice(0, at) : name
  const resolution = at >= 0 ? name.slice(at + 1).replace(/^\(+|\)+$/g, '') : ''
  return [resolution, head].filter(Boolean).join(' ')
}

/** 每个 CDN 节点的播放列表（`url` 是完整的 m3u8 地址，或试看时加 `hls.pt` 的前缀），好的在前：`*.v.smtcdns.com`，
 *  其他，`omexts.tc.qq.com`（分给某些移动网络：播放列表和分片开头能来，整片来不了），`apdcdn` 最后（对 AVPlayer 答 418）。 */
export function playlistURLs(info: any): string[] {
  const urls = arr(info?.vl?.vi?.[0]?.ul?.ui).flatMap((entry) => {
    const base = text(entry?.url)
    if (!base) return []
    const address = base.endsWith('/') ? base + (text(entry.hls?.pt) ?? '') : base
    return address.includes('.m3u8') ? [address] : []
  })
  const rank = (url: string) => {
    const host = new URL(url).hostname
    if (host.endsWith('smtcdns.com')) return 0
    if (host.startsWith('omexts.')) return 2
    if (host.includes('apdcdn')) return 3
    return 1
  }
  return urls.map((url, index) => ({ url, index })).sort((a, b) => rank(a.url) - rank(b.url) || a.index - b.index).map((e) => e.url)
}

/** `head`：片头结束；`tail`：片尾的长度（1 表示没有）。 */
export function markersOf(video: any): Markers {
  const head = num(video?.head)
  const duration = num(video?.td) ?? 0
  const tail = num(video?.tail)
  return {
    introEnd: head && head > 1 ? head : undefined,
    outroStart: tail && tail > 5 && duration > tail ? duration - tail : undefined,
  }
}

/** `vinfoConfig.xs`：播放页启动配置里的盐。 */
export function saltFromPage(html: string): string | undefined {
  return /"vinfoConfig":\{[^}]*?"xs":"([^"]+)"/.exec(html)?.[1]
}

export function pageURL(vid: string, cid?: string): string {
  return cid ? `https://v.qq.com/x/cover/${cid}/${vid}.html` : `https://v.qq.com/x/page/${vid}.html`
}

// MARK: 播放

interface Answer {
  info: any
  /** `vinfo_proxy` 答的账号里的观看进度（秒）。 */
  startTime?: number
  path: 'vinfo_proxy' | 'proxyhttp-9.2' | 'proxyhttp-8.5'
}

export class TencentPlayback {
  private readonly session: TencentSession
  private readonly detail: TencentDetail
  private readonly history: TencentHistory
  private readonly via: 'direct' | 'proxy'
  private readonly pipeline = new TransmuxPipeline()
  /** 加密流的 ref → 这档的许可（播放时才取到地址的档，到时候才有）。服务重启后丢了就按 ref 里的视频重新要。 */
  private readonly drmRefs = new Map<string, { at: number; drm: () => Promise<TencentDRM> }>()
  private readonly certificates = new Map<string, Promise<Uint8Array>>()
  /** `vinfo_proxy` 的盐：已知的，解不开时换播放页上的。 */
  private salt = VINFO_SALT

  constructor(session: TencentSession, detail: TencentDetail, history: TencentHistory, options: PlaybackOptions = {}) {
    this.session = session
    this.detail = detail
    this.history = history
    this.via = options.via ?? 'direct'
  }

  /** 不登录也能用：免费的能放，会员的拒绝。 */
  async resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const signal = ctx.signal
    let cid = parseID(request.show)?.kind === 'cover' ? parseID(request.show)!.id : undefined
    const parsed = parseID(request.video)
    if (!parsed) throw new SourceError('not_found', `无法识别的视频：${request.video}`)
    let vid: string
    if (parsed.kind === 'video') {
      vid = parsed.id
    } else {
      cid = parsed.id
      vid = await this.defaultVideo(parsed.id, signal)
    }
    if (this.session.loggedIn) {
      await this.session.ensureSession(signal)
      await this.session.ensureMembership(signal)
    }
    const isVIP = this.session.isVIP
    // 客户端能用的 DRM 决定按谁的能力位要：FairPlay（Safari，16）照旧；只会 Widevine（安卓，Chrome 的 32）就按 Chrome 要；
    // 都不会也按 Safari 要（明文档一样），加密档标不可用。
    // 只用这个源声明了的 DRM（Widevine 暂未启用，见 TENCENT_DRM_SYSTEMS）：只支持 Widevine 的客户端拿到的加密档标不可用。
    const systems = clientDrm(request).filter((system) => TENCENT_DRM_SYSTEMS.includes(system))
    const bits = systems.includes('widevine') && !systems.includes('fairplay') ? DRM_WIDEVINE : DRM_FAIRPLAY
    // 会员的 4K 只在声明了 HEVC 的答复里（`hevcVinfo`），和 H.264 那次一起要。
    const hevc = isVIP && this.session.loggedIn && transmuxAvailable() ? this.hevcVinfo(vid, signal) : Promise.resolve<{ info?: any; note?: string }>({ note: isVIP ? 'no-engine' : 'not-vip' })
    let answer = await this.vinfo(vid, cid, isVIP ? 'fhd' : 'shd', signal, bits)
    if (int(answer.info?.em) === MEMBERSHIP_QUALITY) answer = await this.vinfo(vid, cid, 'shd', signal, bits)
    const info = answer.info
    checkInfo(info)
    const video = info.vl?.vi?.[0] ?? {}
    const note = restriction(info)
    if (note) throw new SourceError('restricted', note)
    // 加密档却没有许可地址（没有权限）：放不了。有许可的（会员）照常给加密档。
    if (isProtectedSelection(info) && !drmOf(info)) {
      throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
    }
    const ttl = Math.min(Math.max(num(video.ct) ?? 7200, 600), 21600) - 300
    const fourK = await hevc
    const streams = [...(await this.streams(info, vid, cid, isVIP, ttl, ctx, systems, bits)), ...this.transmuxedStreams(fourK.info, vid, ttl, ctx, request.preferences?.codecs)]
      .sort((a, b) => b.quality.rank - a.quality.rank)
    const available = streams.filter((s) => !s.unavailableReason)
    if (!available.length) {
      const reason = streams.find((s) => s.unavailableReason?.includes('加密'))?.unavailableReason
      throw new SourceError('unplayable', reason ?? '没有可播放的清晰度')
    }
    const max = request.preferences?.maxQualityRank
    const answered = arr(info.fl?.fi).find((f) => int(f?.sl) === 1)
    // 没要求清晰度时不选转封装的 4K：它们经服务转发、占 NAS 的带宽和 CPU。
    const automatic = available.filter((s) => !s.id.startsWith(HEVC_PREFIX))
    const selected = (max ? available.find((s) => s.quality.rank <= max) : undefined)
      ?? automatic.find((s) => s.id === str(answered?.id)) ?? automatic[0] ?? available[0]!
    const duration = num(video.td)
    let start = answer.startTime
    if (start === undefined && this.session.loggedIn && cid) {
      const record = await this.history.record(cid, signal)
      if (text(record?.msg?.vid) === vid) start = num(record.msg.video_time)
    }
    const startPosition = start && start > 0 && (!duration || start < duration - FINISHED_MARGIN) ? start : undefined
    return {
      title: text(video.ti) ?? vid,
      startPosition,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      markers: markersOf(video),
      streams,
      selectedStream: selected.id,
      reportContext: { vid, cid: cid ?? text(video.cid) ?? '' },
      diagnostics: { path: answer.path, via: this.via, login: str(info.login) ?? '-', hevc: fourK.note ?? 'ok' },
    }
  }

  /** 网页播放器写历史的时机：开始、定时、暂停 / 拖动 / 离开、结束。 */
  async progress(request: ProgressRequest, ctx: Ctx): Promise<void> {
    if (!this.session.loggedIn) return
    const context = isObject(request.reportContext) ? request.reportContext : {}
    const vid = text(context.vid) ?? (parseID(request.video)?.kind === 'video' ? parseID(request.video)!.id : undefined)
    let cid = text(context.cid) ?? (parseID(request.show)?.kind === 'cover' ? parseID(request.show)!.id : undefined)
    if (!vid) return
    if (!cid) cid = await this.detail.showOf(vid, ctx.signal).catch(() => undefined)
    if (!cid) return
    let position = request.position
    if (request.event === 'end' && request.duration) position = request.duration
    await this.history.report(cid, vid, position, ctx.signal)
  }

  // MARK: 流

  /**
   * 每档一条流，好的在前：答复选中的那档带地址，其他免费（会员则全部）档播放时才要，别人的会员档锁着。加密档的 `drm` 按它播放列表
   * 里实际的密钥标签给（选中那档解析时就读播放列表；播放时才要的档按 `drm` 字段推断，同一次请求的各档一样），客户端不会的标不可用。
   */
  private async streams(info: any, vid: string, cid: string | undefined, isVIP: boolean, ttl: number, ctx: Ctx,
                        systems: DrmSystem[], bits: number): Promise<Stream[]> {
    const formats = arr(info.fl?.fi).filter((f) => qualityRank(f) !== undefined && isPlayableCodec(f))
    const answered = formats.find((f) => int(f.sl) === 1)
    const answeredURLs = playlistURLs(info)
    // 选中的加密档：先读它的播放列表，看实际有哪些密钥标签。
    let answeredSystems: DrmSystem[] | undefined
    let answeredPlaylist: Promise<{ body: string; base: string }> | undefined
    if (answered && formatSystem(answered) && answeredURLs.length) {
      answeredPlaylist = this.fetchPlaylist(answeredURLs)
      answeredSystems = await answeredPlaylist.then(({ body }) => playlistSystems(body), () => undefined)
      answeredPlaylist.catch(() => undefined)
    }
    const streams: Stream[] = []
    for (const format of formats) {
      const rank = qualityRank(format)!
      const name = text(format.name)!
      const label = qualityLabel(format)
      const id = str(format.id) ?? name
      const quality = { rank, label }
      const isAnswered = answered !== undefined && str(answered.id) === str(format.id)
      const system = formatSystem(format)
      const keySystems = system ? ((isAnswered ? answeredSystems : undefined) ?? [system]) : []
      const usable = keySystems.filter((k) => systems.includes(k))
      const description = `H.264 ${label}${keySystems.length ? ` ${keySystems.map(systemName).join(' / ')}` : ''}${isAnswered ? '' : '（播放时取地址）'}`
      if ((int(format.lmt) ?? 0) > 0 && !isVIP) {
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description, unavailableReason: '需要腾讯视频 VIP', keepable: false })
        continue
      }
      if (keySystems.length && !usable.length) {
        const reason = systems.length ? `这台设备不支持 ${keySystems.map(systemName).join(' / ')} 加密` : '这台设备不能播放加密内容'
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description, unavailableReason: reason, keepable: false })
        continue
      }
      if (isAnswered && !answeredURLs.length) continue
      let urls: Promise<{ list: string[]; drm?: TencentDRM; info: any }> | undefined = isAnswered ? Promise.resolve({ list: answeredURLs, drm: drmOf(info), info }) : undefined
      const addresses = () => {
        urls ??= this.vinfo(vid, cid, name, undefined, bits).then(async (answer) => {
          let fetched = answer
          // vinfo_proxy 超出权限时给它能给的最高档（未登录时 shd 也降成 hd）：不是要的那档就自己签名再要一次。
          if (selectedName(fetched.info) !== name && fetched.path === 'vinfo_proxy') {
            const signed = await this.signedVinfo(vid, name, undefined, bits).catch(() => undefined)
            if (signed && selectedName(signed.info) === name) fetched = signed
          }
          checkInfo(fetched.info)
          const drm = drmOf(fetched.info)
          if (isProtectedSelection(fetched.info) && !drm) throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
          const list = playlistURLs(fetched.info)
          if (!list.length) throw new SourceError('unplayable', '没有返回播放信息')
          return { list, drm, info: fetched.info }
        })
        // 失败的不留着：App 重试时再要一次。
        urls.catch(() => {
          urls = undefined
        })
        return urls
      }
      let playlist: Promise<string> | undefined
      const produce = () => {
        playlist ??= addresses().then(async ({ list, drm, info: answer }) => {
          if (system === 'widevine') return this.widevineMaster(answer, list, isAnswered ? answeredPlaylist : undefined, ctx, ttl)
          const fetched = isAnswered && answeredPlaylist ? await answeredPlaylist.catch(() => this.fetchPlaylist(list)) : await this.fetchPlaylist(list)
          const text = this.absolutized(fetched, ctx, ttl)
          return system === 'fairplay' && drm ? ensureKeyTag(text, drm.assetID) : text
        })
        playlist.catch(() => {
          playlist = undefined
        })
        return playlist
      }
      const stream: Stream = {
        id,
        url: ctx.media.generated(produce, { name: `${name}.m3u8`, ttl, contentType: 'application/vnd.apple.mpegurl' }),
        format: 'hls',
        quality,
        description,
        keepable: !system,
      }
      if (system) {
        const ref = this.registerDRM(vid, cid, name, bits, async () => {
          const { drm } = await addresses()
          if (!drm) throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
          return drm
        })
        Object.assign(stream, drmEndpoints(ctx.sourceId, ref, usable))
      }
      streams.push(stream)
    }
    return streams.sort((a, b) => b.quality.rank - a.quality.rank)
  }

  /**
   * Widevine 档（Chrome 的能力位）：答复的 `play.master` 是视频 + 单独音轨的 CMAF（`SAMPLE-AES-CTR`，PSSH 在 data URI 里），
   * 只是它的视频地址在 `omexts` 节点上。这里照它写一个 master：视频用 `ul.ui` 里最好的节点，音轨用 master 给的，两条媒体
   * 播放列表都改成绝对地址经网关提供（密钥标签原样）。
   */
  private async widevineMaster(info: any, list: string[], prefetched: Promise<{ body: string; base: string }> | undefined, ctx: Ctx, ttl: number): Promise<string> {
    const video = prefetched ? await prefetched.catch(() => this.fetchPlaylist(list)) : await this.fetchPlaylist(list)
    const master = text(info?.play?.master) ?? ''
    const streamInf = master.split(/\r?\n/).find((l) => l.startsWith('#EXT-X-STREAM-INF:'))
    const audioURI = /#EXT-X-MEDIA:TYPE=AUDIO,[^\n]*URI="([^"]+)"/.exec(master)?.[1]
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS']
    let attributes = streamInf ? streamInf.slice('#EXT-X-STREAM-INF:'.length) : 'BANDWIDTH=4000000'
    attributes = attributes.replace(/,?AUDIO="[^"]*"/, '')
    if (audioURI) {
      const audio = await this.fetchPlaylist([audioURI])
      const audioURL = ctx.media.text(this.absolutized(audio, ctx, ttl), { name: 'audio.m3u8', ttl, contentType: 'application/vnd.apple.mpegurl' })
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="stream_0",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${audioURL}"`)
      attributes += ',AUDIO="audio"'
    }
    lines.push(`#EXT-X-STREAM-INF:${attributes}`)
    lines.push(ctx.media.text(this.absolutized(video, ctx, ttl), { name: 'video.m3u8', ttl, contentType: 'application/vnd.apple.mpegurl' }))
    return lines.join('\n') + '\n'
  }

  // MARK: DRM 许可

  /** ref：`<随机>~<vid>~<cid>~<清晰度>~<能力位>`。登记里有就用登记的（和客户端播的播放列表同一次答复），没有就按后半段重新要。 */
  private registerDRM(vid: string, cid: string | undefined, defn: string, bits: number, drm: () => Promise<TencentDRM>): string {
    const ref = `${randomHex(12)}~${vid}~${cid ?? ''}~${defn}~${bits}`
    const now = Date.now()
    for (const [key, entry] of this.drmRefs) if (now - entry.at > 12 * 3600_000) this.drmRefs.delete(key)
    if (this.drmRefs.size > 500) this.drmRefs.delete(this.drmRefs.keys().next().value!)
    this.drmRefs.set(ref, { at: now, drm })
    return ref
  }

  private async drmFor(system: DrmSystem, ref: string, signal?: AbortSignal): Promise<TencentDRM> {
    const entry = this.drmRefs.get(ref)
    let drm: TencentDRM | undefined
    if (entry) {
      drm = await entry.drm()
    } else {
      const [, vid, cid, defn, bits] = ref.split('~')
      if (!vid || !defn || !/^[A-Za-z0-9]+$/.test(vid)) throw new SourceError('bad_request', 'DRM 的 ref 不对')
      const answer = await this.vinfo(vid, cid || undefined, defn, signal, Number(bits) || (system === 'widevine' ? DRM_WIDEVINE : DRM_FAIRPLAY))
      checkInfo(answer.info)
      drm = drmOf(answer.info)
      if (!drm) throw new SourceError('unplayable', '没有返回播放许可，请重新解析', { retryable: true })
    }
    if (drm.system !== system) throw new SourceError('bad_request', `这条流不是 ${systemName(system)} 加密的`)
    return drm
  }

  /** FairPlay 证书（DER）：答复给的地址（一般是 `fairplay.l.qq.com/static/fairplay.cer`），按地址缓存。Widevine 没有证书接口。 */
  async certificate(system: DrmSystem, ref: string, ctx: Ctx): Promise<Uint8Array> {
    if (system !== 'fairplay') throw new SourceError('bad_request', 'Widevine 没有证书接口')
    const { certificateURL } = await this.drmFor(system, ref, ctx.signal)
    if (!certificateURL) throw new SourceError('upstream_changed', '答复里没有 FairPlay 证书地址')
    let task = this.certificates.get(certificateURL)
    if (!task) {
      task = (async () => {
        const response = await fetch(certificateURL, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) })
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!response.ok || !bytes.length) throw new SourceError('unavailable', `取不到 FairPlay 证书（HTTP ${response.status}）`)
        return bytes
      })()
      this.certificates.set(certificateURL, task)
      task.catch(() => this.certificates.delete(certificateURL))
    }
    return task
  }

  /**
   * 照网页播放器（superplayer 1.80.0 的 `createFPSLicenseRequest` / `createWidevineLicenseRequest`）：
   * - FairPlay：`POST <许可地址>`，表单 `spc=<base64>&assetId=<key id>`；
   * - Widevine：`POST <许可地址>`，体是 challenge 原始字节（Content-Type 仍写表单）；
   * 都答 JSON，许可是 `ckc` 的 base64。许可地址绑了视频、清晰度和那次请求。
   */
  async license(system: DrmSystem, ref: string, request: Uint8Array, ctx: Ctx): Promise<Uint8Array> {
    const drm = await this.drmFor(system, ref, ctx.signal)
    const response = system === 'fairplay'
      ? await this.session.request(drm.licenseURL, {
        method: 'POST', contentType: 'application/x-www-form-urlencoded', rawBody: licenseBody(request, drm.assetID), signal: ctx.signal,
      })
      : await this.session.request(drm.licenseURL, {
        method: 'POST', contentType: 'application/x-www-form-urlencoded', rawBody: Buffer.from(request), signal: ctx.signal,
      })
    return ckcOf(response)
  }

  /** 会员 4K 的答复：`proxyhttp` 声明 HEVC（`sphevcfps`、`spvideo` 4096），cKey 9.2 带 h38 签名（分片才不限速）。失败时没有。 */
  private async hevcVinfo(vid: string, signal: AbortSignal): Promise<{ info?: any; note?: string }> {
    try {
      const h38 = await this.h38()
      if (!h38) return { note: 'no-h38' }
      const info = await this.proxyhttp(vid, 'uhd', h38, '9.2', signal, true)
      checkInfo(info)
      if (restriction(info) || isProtected(info)) return { note: 'restricted' }
      return { info }
    } catch (error) {
      if (signal.aborted) throw error
      return { note: error instanceof SourceError ? `${error.code}: ${error.message}` : String(error) }
    }
  }

  /**
   * HEVC 答复里的 4K 档：答复选中的那档带地址，另一档播放时再要。每条流是网关上的 master，第一次被请求时才取播放列表、
   * 转第一片（读 CODECS 和动态范围）；分片按需转封装成 fMP4（`transmux.ts`）。客户端说了能解的编码又不含 HEVC 时只列出、不能播。
   */
  private transmuxedStreams(info: any, vid: string, ttl: number, ctx: Ctx, codecs: string[] | null | undefined): Stream[] {
    if (!info) return []
    const answeredURLs = playlistURLs(info)
    const seen = new Set<string>()
    const streams: Stream[] = []
    for (const format of arr(info.fl?.fi)) {
      const rank = transmuxRank(format)
      const name = text(format.name)
      const id = `${HEVC_PREFIX}${str(format.id) ?? name}`
      if (!rank || !name || seen.has(id)) continue
      seen.add(id)
      const quality = { rank, label: qualityLabel(format) }
      const description = `HEVC ${quality.label}（服务端转封装）`
      // `lmt` 5 是 SVIP 的档（推断，API.md §4.2）。
      if ((int(format.lmt) ?? 0) >= 5 && this.session.membershipTier !== 'SVIP') {
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description, unavailableReason: '需要腾讯视频 SVIP', keepable: false })
        continue
      }
      if (!codecSupported(codecs, 'hvc1')) {
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description, unavailableReason: '这台设备不能解 HEVC', keepable: false })
        continue
      }
      const isAnswered = int(format.sl) === 1
      if (isAnswered && !answeredURLs.length) continue
      const size = (answer: any) => ({ width: int(answer?.vl?.vi?.[0]?.vw), height: int(answer?.vl?.vi?.[0]?.vh) })
      let urls: Promise<{ list: string[]; width?: number; height?: number }> | undefined = isAnswered ? Promise.resolve({ list: answeredURLs, ...size(info) }) : undefined
      const addresses = () => {
        urls ??= this.h38().then((h38) => this.proxyhttp(vid, name, h38, '9.2', undefined, true)).then((fetched) => {
          checkInfo(fetched)
          if (isProtected(fetched)) throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
          const list = playlistURLs(fetched)
          if (!list.length) throw new SourceError('unplayable', '没有返回播放信息')
          return { list, ...size(fetched) }
        })
        urls.catch(() => {
          urls = undefined
        })
        return urls
      }
      let master: Promise<string> | undefined
      const produce = () => {
        master ??= addresses().then((answer) => this.hevcMaster(answer, format, ttl, ctx))
        master.catch(() => {
          master = undefined
        })
        return master
      }
      streams.push({
        id,
        url: ctx.media.generated(produce, { name: `${name}.m3u8`, ttl, contentType: 'application/vnd.apple.mpegurl' }),
        format: 'hls',
        quality,
        description,
        keepable: true,
      })
    }
    return streams
  }

  /** 4K 的 master：一个变体，CODECS 从第一片的 `hvcC` 算、`VIDEO-RANGE` 从 SPS 的传输特性来，指向改写成 fMP4 的媒体播放列表。 */
  private async hevcMaster(answer: { list: string[]; width?: number; height?: number }, format: any, ttl: number, ctx: Ctx): Promise<string> {
    const { body, base } = await this.fetchPlaylist(answer.list)
    const rewritten = this.pipeline.rewrite(body, base, ctx.media, ttl)
    if (!rewritten.first) throw new SourceError('upstream_changed', '腾讯视频 4K 的播放列表是空的')
    const media = ctx.media.text(rewritten.text, { name: 'video.m3u8', ttl, contentType: 'application/vnd.apple.mpegurl' })
    const first = await this.pipeline.output(rewritten.first)
    const audio = first.codecs.split(',').filter((c) => c.startsWith('mp4a'))
    const codecs = [hevcCodecString(first.initialization) ?? 'hvc1.2.4.L150.90', ...audio].join(',')
    const declared = (num(format?.bandwidth) ?? 0) + (num(format?.audiobandwidth) ?? 0)
    const bandwidth = Math.round(declared > 0 ? declared * 1.5 : 30_000_000)
    // 答复的 vw / vh（模块报的是编码尺寸，没减去裁边）。
    const width = answer.width || first.width
    const height = answer.height || first.height
    const resolution = width && height ? `,RESOLUTION=${width}x${height}` : ''
    const fps = num(format?.vfps)
    const frameRate = fps ? `,FRAME-RATE=${fps.toFixed(3)}` : ''
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs}"${resolution}${frameRate},VIDEO-RANGE=${videoRange(first.transfer)}`,
      media,
      '',
    ].join('\n')
  }

  /** 不能播的档也要一个地址：请求时说明原因。 */
  private unavailableURL(ctx: Ctx): string {
    return ctx.media.generated(async () => {
      throw new SourceError('restricted', '这档清晰度不能播放')
    }, { name: 'unavailable.m3u8', ttl: 3600 })
  }

  /**
   * 第一个能答出播放列表的节点给的播放列表，相对地址改成绝对的（分片随后从这个节点来）；`via: proxy` 时分片地址都指回网关。
   */
  async playlist(urls: string[], ctx: Ctx, ttl: number): Promise<string> {
    return this.absolutized(await this.fetchPlaylist(urls), ctx, ttl)
  }

  /** 相对地址（分片、`EXT-X-MAP`）改成绝对的，`via: proxy` 时指回网关；`skd://`、`data:` 的密钥地址不动。 */
  absolutized({ body, base }: { body: string; base: string }, ctx: Ctx, ttl: number): string {
    if (this.via === 'direct') return rewritePlaylist(body, base, (absolute) => absolute)
    const headers = { 'user-agent': USER_AGENT, referer: REFERER }
    return rewritePlaylist(body, base, (absolute) => ctx.media.proxy(absolute, { headers, playlist: 'no', ttl }))
  }

  /** 按顺序问节点，第一个答出播放列表的。 */
  async fetchPlaylist(urls: string[]): Promise<{ body: string; base: string }> {
    let last: unknown
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal: AbortSignal.timeout(10_000) })
        const body = await response.text()
        if (!response.ok || !body.startsWith('#EXTM3U')) {
          last = new Error(`HTTP ${response.status} ${new URL(url).hostname}`)
          continue
        }
        return { body, base: response.url || url }
      } catch (error) {
        last = error
      }
    }
    throw new SourceError('unavailable', '腾讯视频的节点都取不到播放列表', { cause: last, retryable: true })
  }

  // MARK: 请求

  /** 节目要放的视频：观看历史里最近的那集，否则第一集正片。 */
  private async defaultVideo(cid: string, signal: AbortSignal): Promise<string> {
    if (this.session.loggedIn) {
      const record = await this.history.record(cid, signal)
      const vid = text(record?.msg?.vid)
      if (vid) return vid
    }
    const list = await this.detail.episodes(cid, '', '', signal)
    const first = list.episodes.find((e) => e.isFeature) ?? list.episodes[0]
    const id = parseID(first?.id)
    if (id?.kind !== 'video') throw new SourceError('unplayable', '该节目没有可播放的视频')
    return id.id
  }

  /** 一档清晰度的播放信息：`vinfo_proxy`，不行就 `proxyhttp` 自己签。 */
  async vinfo(vid: string, cid: string | undefined, defn: string, signal: AbortSignal | undefined, drm = DRM_FAIRPLAY): Promise<Answer> {
    try {
      return await this.proxiedVinfo(vid, cid, defn, signal, drm)
    } catch (error) {
      if (signal?.aborted) throw error
      return this.signedVinfo(vid, defn, signal, drm)
    }
  }

  /** 这台服务的 h38：一天问一次；第一次问不到时不等太久（没有也能播，只是 9.2 签不了）。 */
  private async h38(): Promise<string> {
    const cached = this.session.qimei.cached
    const fresh = this.session.qimei.h38()
    if (cached) return fresh.catch(() => cached)
    return Promise.race([fresh, new Promise<string>((resolve) => setTimeout(() => resolve(''), 4000).unref())])
  }

  /**
   * `vinfo_proxy`：页面自己的请求，播放器能力（H.264 HLS、FairPlay）和清晰度在 `vsite_ssr_cookie` 里；`useVCookie` 让
   * `vqqcookie` 里的登录算数（答复 `login` 3）。手机 UA 被拒（`ret` 6002），所以发桌面 Safari 的。
   */
  async proxiedVinfo(vid: string, cid: string | undefined, defn: string, signal?: AbortSignal, drm = DRM_FAIRPLAY): Promise<Answer> {
    const capability = { mse: false, wasm: false, hevc: false, h10: false, av1: false, hls: true, drm, mdrm: drm, hdr: 0, da: false, dv: false, hwacc: true, sab: false }
    const ssr = { capability, deviceInfo: {}, userSetting: { defn } }
    const cookies = this.session.loginCookies
    cookies.vsite_ssr_cookie = encode(JSON.stringify(ssr))
    const h38 = await this.h38()
    if (h38) {
      cookies._qimei_h38 = h38
      cookies.a_pk__04 = h38
    }
    const page = pageURL(vid, cid)
    const response = await this.session.request(`${PLAY_HOST}/vinfo_proxy`, {
      method: 'POST',
      headers: { referer: page },
      body: {
        cid: cid ?? '', vid, playParams: {},
        vqqcookie: Object.keys(cookies).sort().map((k) => `${k}=${cookies[k]}`).join('; '),
        vinfoParams: {
          playerVersion: VINFO_PLAYER_VERSION, adVersion: VINFO_AD_VERSION, vinfoProtoVer: VINFO_PROTO_VER, adProtoVer: VINFO_AD_PROTO_VER,
          href: page, dynamicConfig: { tvkConfig: { useVCookie: true } },
        },
      },
      signal,
    })
    if (int(response?.ret) !== 0) throw new SourceError('upstream_changed', `vinfo_proxy ${str(response?.ret)} ${text(response?.message) ?? ''}`)
    const data = response.data ?? {}
    const start = num(data.playInfo?.startTime)
    const startTime = start && start > 0 && text(data.playInfo?.startTimeType) !== 'default' ? start : undefined
    const proxy = data.proxyhttp ?? {}
    if (isObject(proxy.vinfo)) return { info: plain(proxy.vinfo), startTime, path: 'vinfo_proxy' }
    const raw = typeof proxy.vinfo === 'string' ? proxy.vinfo : undefined
    if (!raw) throw new SourceError('upstream_changed', '没有返回播放信息')
    if (int(proxy.enc) !== 1) return { info: plain(JSON.parse(raw)), startTime, path: 'vinfo_proxy' }
    // 按服务端认的用户做密钥：账号，没认 cookie 时是 guest。
    const flowid = text(data.flowid) ?? ''
    const keys = [...new Set([this.session.credential?.vuserid, undefined].map((user) => vinfoKey(user, this.session.guid, cid ?? '', vid, flowid)))]
    const known = this.salt
    let info = decodeWith(raw, keys, known)
    if (!info) {
      const fresh = await this.freshSalt(page, signal)
      if (fresh && fresh !== known) {
        info = decodeWith(raw, keys, fresh)
        if (info) this.salt = fresh
      }
    }
    if (!info) throw new SourceError('upstream_changed', `vinfo_proxy enc ${str(proxy.enc)} 解不开`)
    return { info: plain(info), startTime, path: 'vinfo_proxy' }
  }

  private async freshSalt(page: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await fetch(page, { headers: { 'user-agent': USER_AGENT }, signal: withTimeout(signal, 10_000) })
      return saltFromPage(await response.text())
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  /**
   * `proxyhttp`（`buid=onlyvinfo`）的一档：解出的 `vinfo`。App 只用 8.5（带登录时分片 64 KB 后就卡住）；服务端能直接跑
   * 网页的 wasm，有 h38 时先用 9.2（网页自己切画质用的，分片不限速），9.2 失败再用 8.5。
   */
  async signedVinfo(vid: string, defn: string, signal?: AbortSignal, drm = DRM_FAIRPLAY): Promise<Answer> {
    const h38 = await this.h38()
    if (h38) {
      try {
        const answer = await this.proxyhttp(vid, defn, h38, '9.2', signal, false, drm)
        if (int(answer.em) !== 85) return { info: answer, path: 'proxyhttp-9.2' }
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return { info: await this.proxyhttp(vid, defn, h38, '8.5', signal, false, drm), path: 'proxyhttp-8.5' }
  }

  async proxyhttp(vid: string, defn: string, h38: string, version: '8.5' | '9.2', signal?: AbortSignal, hevc = false, drm = DRM_FAIRPLAY): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000)
    const page = pageURL(vid)
    const guid = this.session.guid
    const key = version === '9.2' ? cKey92({ vid, guid, h38, page, timestamp }) : cKey85(vid, guid, timestamp, h38)
    const params: [string, string][] = [
      ['charge', '0'], ['otype', 'ojson'], ['defnpayver', '3'], ['spau', '1'], ['spaudio', '0'], ['spwm', '1'],
      ['sphls', '6'], ['host', 'v.qq.com'], ['refer', page], ['ehost', page], ['sphttps', '1'],
      ['encryptVer', version === '9.2' ? CKEY92_VERSION : CKEY85_VERSION], ['cKey', key],
      ['clip', '4'], ['guid', guid], ['flowid', randomHex(32)], ['platform', PLAYER_PLATFORM], ['sdtfrom', 'v1010'],
      ['appVer', version === '9.2' ? CKEY92_APP_VERSION : PLAYER_VERSION],
      ['unid', ''], ['auth_from', ''], ['auth_ext', ''], ['vid', vid], ['defn', defn], ['fhdswitch', '1'],
      ['dtype', '3'], ['spsrt', '3'], ['tm', String(timestamp)], ['lang_code', '0'],
      ['logintoken', this.session.loginToken], ['qimei', ''], ['spvvpay', '1'], ['spadseg', '3'], ['spvideo', hevc ? '4096' : '0'],
      ['spm3u8tag', '67'], ['spmasterm3u8', '3'], ['spcaptiontrack', '1'], ['spcaptiontype', '1'],
      ['appctrl', '16384'], ['drm', String(drm)], ['multidrm', String(drm)],
    ]
    // 不带 `sphevcfps` 只答 H.264。
    if (hevc) params.push(['sphevcfps', '52776560789311'])
    const query = params.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&')
    const response = await this.session.request(`${PLAY_HOST}/proxyhttp`, {
      method: 'POST', body: { buid: 'onlyvinfo', vinfoparam: query }, cookies: {}, signal,
    })
    const raw = text(response?.vinfo)
    if (!raw) throw new SourceError('upstream_changed', '没有返回播放信息')
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new SourceError('upstream_changed', '读不懂播放信息', { cause: error })
    }
  }
}

/** 答复选中的那档的名字（`hd`、`shd`…）。 */
export function selectedName(info: any): string | undefined {
  return text(arr(info?.fl?.fi).find((f) => int(f?.sl) === 1)?.name)
}

/** 答复选中的那档是不是加密的（FairPlay 或 Widevine）。 */
function isProtectedSelection(info: any): boolean {
  return int(info?.vl?.vi?.[0]?.drm) === 4 || arr(info?.fl?.fi).some((f) => int(f?.sl) === 1 && formatSystem(f) !== undefined)
}

function decodeWith(raw: string, keys: string[], salt: string): any {
  for (const key of keys) {
    try {
      const info = JSON.parse(decryptVinfo(raw, key, salt))
      if (isObject(info)) return info
    } catch {
      // 下一个密钥
    }
  }
  return undefined
}
