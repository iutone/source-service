// 播放（API.md §4，App 的 TencentPlaybackService / TencentHLSAsset）。照网页播放器的首播：`vinfo_proxy`（服务端签名，
// 登录和想要的清晰度在发去的 cookie 里，`userSetting.defn`），答复被混淆（`cipher.ts`）；它失败时才 `proxyhttp` + 这里算的
// cKey（App 用 8.5；这里先 9.2 再 8.5，见 `signedVinfo`）。能力位照 Safari：只要 H.264（HEVC 只给 TS 分片，AVPlayer 放不了），
// 声明 FairPlay（版权方加密片答 FairPlay HLS，服务端暂不支持）。每档清晰度一次请求：解析时只取答复选中的那档，
// 其他档在 App 第一次请求它的播放列表时才去要（媒体网关的 `generated`）。播放列表从第一个能应答的 CDN 节点取
// （smtcdns 优先），分片改成绝对地址，App 直接从那个节点拉（`via: proxy` 时经网关转发）。进度写进观看历史（`AddOrUpdate`）。
import type { Ctx } from '@iyt-source/kit'
import { rewritePlaylist, SourceError } from '@iyt-source/kit'
import type { Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream } from '@iyt-source/protocol'
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

/** 一档是 FairPlay 加密的（`drm` 4；5 是 Widevine，从不要）。 */
export const isFairPlay = (format: any) => int(format?.drm) === 4

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

/** 只要 `video` 21 H.264：8（HEVC）、23（HEVC 10-bit）只有 TS 分片，AVPlayer 放不了；20 VVC 解不了。 */
export const isPlayableCodec = (format: any) => (int(format?.video) ?? 21) === 21

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
    let answer = await this.vinfo(vid, cid, isVIP ? 'fhd' : 'shd', signal)
    if (int(answer.info?.em) === MEMBERSHIP_QUALITY) answer = await this.vinfo(vid, cid, 'shd', signal)
    const info = answer.info
    checkInfo(info)
    const video = info.vl?.vi?.[0] ?? {}
    const note = restriction(info)
    if (note) throw new SourceError('restricted', note)
    if (isProtected(info) && (info.play?.master != null || !arr(info.fl?.fi).some((f) => !isFairPlay(f)))) {
      throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
    }
    const ttl = Math.min(Math.max(num(video.ct) ?? 7200, 600), 21600) - 300
    const streams = this.streams(info, vid, cid, isVIP, ttl, ctx)
    const available = streams.filter((s) => !s.unavailableReason)
    if (!available.length) {
      throw new SourceError('unplayable', streams.some((s) => s.description.includes('FairPlay')) ? '该片为版权加密内容，暂不支持播放' : '没有可播放的清晰度')
    }
    const max = request.preferences?.maxQualityRank
    const answered = arr(info.fl?.fi).find((f) => int(f?.sl) === 1)
    const selected = (max ? available.find((s) => s.quality.rank <= max) : undefined)
      ?? available.find((s) => s.id === str(answered?.id)) ?? available[0]!
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
      diagnostics: { path: answer.path, via: this.via, login: str(info.login) ?? '-' },
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

  /** 每档一条流，好的在前：答复选中的那档带地址，其他免费（会员则全部）档播放时才要，别人的会员档锁着。 */
  private streams(info: any, vid: string, cid: string | undefined, isVIP: boolean, ttl: number, ctx: Ctx): Stream[] {
    const formats = arr(info.fl?.fi).filter((f) => qualityRank(f) !== undefined && isPlayableCodec(f))
    const answered = formats.find((f) => int(f.sl) === 1)
    const answeredURLs = playlistURLs(info)
    const streams: Stream[] = []
    for (const format of formats) {
      const rank = qualityRank(format)!
      const name = text(format.name)!
      const label = qualityLabel(format)
      const id = str(format.id) ?? name
      const quality = { rank, label }
      const isAnswered = answered !== undefined && str(answered.id) === str(format.id)
      if (isFairPlay(format)) {
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description: `H.264 ${label} FairPlay`, unavailableReason: '版权加密，暂不支持', keepable: false })
        continue
      }
      if ((int(format.lmt) ?? 0) > 0 && !isVIP) {
        streams.push({ id, url: this.unavailableURL(ctx), format: 'hls', quality, description: `H.264 ${label}`, unavailableReason: '需要腾讯视频 VIP', keepable: false })
        continue
      }
      if (isAnswered && !answeredURLs.length) continue
      let urls: Promise<string[]> | undefined = isAnswered ? Promise.resolve(answeredURLs) : undefined
      const addresses = () => {
        urls ??= this.vinfo(vid, cid, name, undefined).then(async (answer) => {
          let fetched = answer
          // vinfo_proxy 超出权限时给它能给的最高档（未登录时 shd 也降成 hd）：不是要的那档就自己签名再要一次。
          if (selectedName(fetched.info) !== name && fetched.path === 'vinfo_proxy') {
            const signed = await this.signedVinfo(vid, name, undefined).catch(() => undefined)
            if (signed && selectedName(signed.info) === name) fetched = signed
          }
          checkInfo(fetched.info)
          if (isProtected(fetched.info)) throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
          const list = playlistURLs(fetched.info)
          if (!list.length) throw new SourceError('unplayable', '没有返回播放信息')
          return list
        })
        // 失败的不留着：App 重试时再要一次。
        urls.catch(() => {
          urls = undefined
        })
        return urls
      }
      let playlist: Promise<string> | undefined
      const produce = () => {
        playlist ??= addresses().then((list) => this.playlist(list, ctx, ttl))
        playlist.catch(() => {
          playlist = undefined
        })
        return playlist
      }
      streams.push({
        id,
        url: ctx.media.generated(produce, { name: `${name}.m3u8`, ttl, contentType: 'application/vnd.apple.mpegurl' }),
        format: 'hls',
        quality,
        description: `H.264 ${label}${isAnswered ? '' : '（播放时取地址）'}`,
        keepable: true,
      })
    }
    return streams.sort((a, b) => b.quality.rank - a.quality.rank)
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
    let last: unknown
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal: AbortSignal.timeout(10_000) })
        const body = await response.text()
        if (!response.ok || !body.startsWith('#EXTM3U')) {
          last = new Error(`HTTP ${response.status} ${new URL(url).hostname}`)
          continue
        }
        const base = response.url || url
        if (this.via === 'direct') return rewritePlaylist(body, base, (absolute) => absolute)
        const headers = { 'user-agent': USER_AGENT, referer: REFERER }
        return rewritePlaylist(body, base, (absolute) => ctx.media.proxy(absolute, { headers, playlist: 'no', ttl }))
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
  async vinfo(vid: string, cid: string | undefined, defn: string, signal: AbortSignal | undefined): Promise<Answer> {
    try {
      return await this.proxiedVinfo(vid, cid, defn, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return this.signedVinfo(vid, defn, signal)
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
  async proxiedVinfo(vid: string, cid: string | undefined, defn: string, signal?: AbortSignal): Promise<Answer> {
    const capability = { mse: false, wasm: false, hevc: false, h10: false, av1: false, hls: true, drm: 16, mdrm: 16, hdr: 0, da: false, dv: false, hwacc: true, sab: false }
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
  async signedVinfo(vid: string, defn: string, signal?: AbortSignal): Promise<Answer> {
    const h38 = await this.h38()
    if (h38) {
      try {
        const answer = await this.proxyhttp(vid, defn, h38, '9.2', signal)
        if (int(answer.em) !== 85) return { info: answer, path: 'proxyhttp-9.2' }
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return { info: await this.proxyhttp(vid, defn, h38, '8.5', signal), path: 'proxyhttp-8.5' }
  }

  private async proxyhttp(vid: string, defn: string, h38: string, version: '8.5' | '9.2', signal?: AbortSignal): Promise<any> {
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
      ['logintoken', this.session.loginToken], ['qimei', ''], ['spvvpay', '1'], ['spadseg', '3'], ['spvideo', '0'],
      ['spm3u8tag', '67'], ['spmasterm3u8', '3'], ['spcaptiontrack', '1'], ['spcaptiontype', '1'],
      ['appctrl', '16384'], ['drm', '16'], ['multidrm', '16'],
    ]
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
