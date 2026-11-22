// 播放（照 App 的 IQiyiPlaybackService / IQiyiDash / IQiyiHLSAsset）：网页播放器的 `cache.video.iqiyi.com/dash`，
// 能力位按客户端能用的 DRM（`preferences.drm`，SERVER.md §6.4）声明：FairPlay 照 Safari，Widevine 照 Chrome，都不能用时
// 两种都不声明。明文片源每档给一份内联的 HLS 媒体播放列表（分片是绝对地址的 TS），经媒体网关的 `text` / `generated`
// 提供；分片由客户端直接从 CDN 拉。版权方要求加密的片源（迪士尼等）：Safari 能力位下是 FairPlay（`drmType 9`，fMP4 +
// SAMPLE-AES，`skd://<contentId>`），Chrome 能力位下是 Widevine（`drmType 7`，cenc，JSON 描述做成 HLS，widevine.ts）。
// 播放列表经网关提供，流的 `drm` 按播放列表里实际的 key 标签给；证书和许可经服务端转发（drm.ts）。
// 进度写进观看历史（`l-rcd …/upload.action`）。
import type { Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream } from '@iyt-source/protocol'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DrmSystem } from '@iyt-source/protocol'
import { clientDrm, drmEndpoints, rewritePlaylist, SourceError, type Ctx } from '@iyt-source/kit'
import { drmRef } from './drm.ts'

/** 对外声明的 DRM。Widevine 已写好、请求格式已验证，但安卓真机未验证，先不启用（SERVER.md §21 待办）。 */
export const IQIYI_DRM_SYSTEMS: DrmSystem[] = ['fairplay']
import { keySystems, widevineMaster, widevineMediaPlaylist, widevineTracks } from './widevine.ts'
import { apiError, type IQiyiSession } from './session.ts'
import { arr, authKey, bool, idOf, int, num, parseID, parseJSON, PCW_API, PLAYER_SOURCE, query, str, text, vf } from './util.ts'

/** 离结尾不到这么多秒的进度算看完，从头播。 */
const FINISHED_MARGIN = 10
/** 先要的清晰度；回答里会列出这部片的全部清晰度。 */
const PREFERRED_BID = 600
/** 进度上报的最短间隔（网页播放器一分钟一次；App 约 15 秒发一次）。 */
const REPORT_INTERVAL = 30_000
const ENCRYPTED = '加密片源，暂不支持'
const FAIRPLAY = 9
const WIDEVINE = 7

/** 向 `dash` 声明的 DRM：`none` 两种都不声明（客户端都不能用）。 */
export type DashDrm = DrmSystem | 'none'

/** 客户端能用的 DRM → 声明哪种。爱奇艺一次只给一种加密流（两种都声明时给 Widevine），能用 FairPlay 就要 FairPlay。 */
export function dashDrm(client: DrmSystem[]): DashDrm {
  return client.includes('fairplay') ? 'fairplay' : client.includes('widevine') ? 'widevine' : 'none'
}

/**
 * 能力位（`k_ft<组>`，第 n 位 = 1 << (n - 1)）。基础是 Safari 播放器的 H.264 TS；FairPlay 加第 4 组 10/11/12/29（Safari 的）；
 * Widevine 加第 1 组 42、第 4 组 20/21、第 7 组 3（Chrome 的，docs/iqiyi-web/API.md §6；只加第 4 组的回 702）。
 * 明文片源两种声明下都是同一份 H.264 TS。
 */
export function capabilities(drm: DashDrm): [string, string][] {
  const mask = (bits: number[]) => bits.reduce((value, bit) => value | (1n << BigInt(bit - 1)), 0n).toString()
  const group1 = [3, 40, 48, 50]
  const group4 = [3, 14, 27, 38, 44, 46, 51]
  const group7 = [26, 29, 36, 44, 45]
  if (drm === 'fairplay') group4.push(10, 11, 12, 29)
  if (drm === 'widevine') {
    group1.push(42)
    group4.push(20, 21)
    group7.push(3)
  }
  return [
    ['k_ft1', mask(group1)], ['k_ft4', mask(group4)], ['k_ft5', mask([1, 25, 28, 45])],
    ['k_ft7', mask(group7)], ['k_ftx2', 'g'],
  ]
}

/** 签名后的 `dash` 地址：`vf` 对发出去的路径和参数原文算。 */
export function dashURL(options: { tvid: string; bid: number; drm?: DashDrm; authCookie?: string; uid?: string; deviceID: string; vipType: string; time?: number }): string {
  const time = String(options.time ?? Date.now())
  const pairs: [string, string][] = [
    ['tvid', options.tvid], ['bid', String(options.bid)], ['src', PLAYER_SOURCE], ['vt', '0'], ['rs', '1'],
    ['uid', options.uid ?? ''], ['ori', 'pcw'], ['ps', '0'], ['k_uid', options.deviceID], ['pt', '0'], ['d', '0'], ['s', ''],
    ['lid', '0'], ['cf', '0'], ['ct', '0'],
    ['authKey', authKey(options.authCookie ?? '', time, options.tvid)],
    ['k_tag', '1'], ['dfp', ''], ['locale', 'zh_cn'], ['pck', options.authCookie ?? ''], ['up', ''], ['qd_v', 'a1'],
    ['tm', time],
    ...capabilities(options.drm ?? 'none'),
    ['sr', '1'], ['ost', '0'], ['ut', options.vipType],
  ]
  const pathAndQuery = `/dash?${query(pairs)}`
  return `https://cache.video.iqiyi.com${pathAndQuery}&vf=${vf(pathAndQuery)}`
}

export interface Rendition {
  bid: number
  /** "1920x1080"。 */
  size?: string
  /** 1 明文，9 FairPlay，7 Widevine，8 / 5 其他 DRM。 */
  drmType: number
  selected: boolean
  /** 明文：内联的 HLS 媒体播放列表。 */
  playlist?: string
  /** Widevine：`m3u8` 字段里的 JSON 描述（widevine.ts）。 */
  widevine?: string
  /** FairPlay：回答里内联的视频媒体播放列表（只用来看 key 标签）。 */
  keyPlaylist?: string
  /** FairPlay：主播放列表地址。许可地址（`drm.license_host`）两种 DRM 都有。 */
  url?: string
  licenseHost?: string
  /** FairPlay 的试看（非会员看会员片，`drm.preview`，约 6 分钟）。 */
  preview?: boolean
}

export interface DashAnswer {
  /** 101 可播，110 要会员（或单独购买），502 未登录 / 非会员看新上线的会员片。 */
  status: number
  bossCode?: string
  renditions: Rendition[]
  introEnd?: number
  outroStart?: number
  duration?: number
  albumID?: string
}

/** 一次 `dash` 回答。 */
export function parseDash(response: any): DashAnswer {
  if (str(response?.code) !== 'A00000') throw apiError(response?.code, response?.msg, '播放信息获取失败')
  const data = response.data ?? {}
  const renditions: Rendition[] = []
  for (const video of arr(data.program?.video)) {
    const bid = int(video?.bid)
    if (bid === undefined) continue
    const m3u8 = text(video.m3u8)
    const rendition: Rendition = {
      bid, size: text(video.scrsz), drmType: int(video.drmType) ?? 1, selected: bool(video._selected) === true,
      playlist: m3u8?.startsWith('#EXTM3U') ? m3u8 : undefined,
      widevine: m3u8?.startsWith('{') ? m3u8 : undefined,
      keyPlaylist: text(video.drm?.videoM3u8Content),
      url: text(video.url),
      licenseHost: text(video.drm?.license_host),
      preview: bool(video.drm?.preview) === true ? true : undefined,
    }
    // 一个清晰度可能有几种编码：留选中的，否则明文的，否则第一个。
    const index = renditions.findIndex((r) => r.bid === bid)
    if (index < 0) renditions.push(rendition)
    else if (rendition.selected || (!renditions[index].selected && renditions[index].drmType !== 1 && rendition.drmType === 1)) renditions[index] = rendition
  }
  const positive = (value: unknown) => {
    const n = num(value)
    return n && n > 0 ? n : undefined
  }
  return {
    status: int(data.st) ?? 0,
    bossCode: text(data.ctl?.boss_status_code),
    renditions,
    introEnd: positive(data.p?.bt),
    outroStart: positive(data.p?.et),
    duration: positive(arr(data.program?.video)[0]?.duration),
    albumID: idOf(data.aid),
  }
}

export function selectedRendition(dash: DashAnswer): Rendition | undefined {
  return dash.renditions.find((r) => r.selected) ?? dash.renditions.find((r) => r.playlist || r.widevine || (r.drmType === FAIRPLAY && r.url))
}

export function qualityLabel(bid: number): string {
  switch (bid) {
    case 100: return '极速'
    case 200: return '360P'
    case 300: return '480P'
    case 500: return '720P'
    case 600: return '1080P'
    case 610: return '1080P 50帧'
    case 700: return '2K'
    case 800: return '4K'
    default: return String(bid)
  }
}

/** 清晰度的像素高度（App 的「最高清晰度」按它比较）。 */
export function qualityRank(bid: number): number {
  switch (bid) {
    case 100: return 240
    case 200: return 360
    case 300: return 480
    case 500: return 720
    case 600:
    case 610: return 1080
    case 700: return 1440
    case 800: return 2160
    default: return bid
  }
}

/** App 的最高清晰度（像素高度）→ 先要的 `bid`。 */
export function bidFor(rank: number | null | undefined): number {
  if (!rank || rank >= 1080) return PREFERRED_BID
  if (rank >= 720) return 500
  if (rank >= 480) return 300
  if (rank >= 360) return 200
  return 100
}

/**
 * 内联的播放列表没有版本和类型：声明是完整的点播，AVPlayer 才能随意拖动。分片改走 HTTP：HTTPS 下 CDN 会随机跳到
 * `*.inter.71edge.com` 节点，其中 `bscdnct`（2026-10）的证书已被吊销，Apple 的 TLS 拒绝（-1202）；HTTP 跳到纯 HTTP 的
 * `*.inter.iqiyi.com` 节点（App 的 ATS 允许）。临时措施，CDN 修好后改回 HTTPS（docs/iqiyi/PLAN.md §6）。
 */
export function normalizePlaylist(playlist: string): string {
  const lines = playlist.split(/\r?\n/).map((line) => (line.startsWith('https://') ? `http://${line.slice('https://'.length)}` : line))
  if (!playlist.includes('#EXT-X-PLAYLIST-TYPE') && lines[0] === '#EXTM3U') lines.splice(1, 0, '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD')
  return lines.join('\n')
}

/**
 * FairPlay 的媒体播放列表（SERVER.md §6.4）：分片、`EXT-X-MAP` 改成绝对地址（App 直连 CDN）；`skd://` 的
 * `EXT-X-KEY` 补齐 `METHOD=SAMPLE-AES`、`KEYFORMAT="com.apple.streamingkeydelivery"`、`KEYFORMATVERSIONS="1"`。
 * skd 地址原样保留：它的主机部分就是爱奇艺 KSM 认的 content id（App 的 FairPlayKit 默认这么取，已端到端验证）。
 */
export function normalizeFairPlayMedia(playlist: string, base: string): string {
  return rewritePlaylist(playlist, base, (absolute) => absolute)
    .split('\n')
    .map((line) => {
      if (!/^#EXT-X-(SESSION-)?KEY:/.test(line) || !/URI="skd:\/\//.test(line)) return line
      const [tag, rest] = [line.slice(0, line.indexOf(':') + 1), line.slice(line.indexOf(':') + 1)]
      const attributes = splitAttributes(rest).filter(([key]) => !['METHOD', 'KEYFORMAT', 'KEYFORMATVERSIONS'].includes(key))
      const method = /METHOD=(SAMPLE-AES(-CTR)?)/.exec(rest)?.[1] ?? 'SAMPLE-AES'
      const others = attributes.map(([key, value]) => `${key}=${value}`)
      return `${tag}${[`METHOD=${method}`, ...others, 'KEYFORMAT="com.apple.streamingkeydelivery"', 'KEYFORMATVERSIONS="1"'].join(',')}`
    })
    .join('\n')
}

/** HLS 属性列表 `A=1,B="x,y"` → 键值对（引号里的逗号不拆）。 */
function splitAttributes(list: string): [string, string][] {
  const out: [string, string][] = []
  for (const match of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out.push([match[1], match[2]])
  return out
}

/** 还没取播放列表的加密档按 `drmType` 估计它的 DRM。 */
function expectedSystems(rendition: Rendition): DrmSystem[] {
  return rendition.drmType === FAIRPLAY ? ['fairplay'] : rendition.drmType === WIDEVINE ? ['widevine'] : []
}

const drmName = (system: DrmSystem) => (system === 'fairplay' ? 'FairPlay' : 'Widevine')

/** init 段写成临时文件（按内容命名，重复的不再写），经网关提供。 */
function initFile(init: Uint8Array, ctx: Ctx): string {
  const directory = join(tmpdir(), 'iyt-iqiyi-init')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${createHash('sha1').update(init).digest('hex')}.mp4`)
  writeFileSync(path, init)
  return ctx.media.file(path, { name: 'init.mp4', contentType: 'video/mp4' })
}

/** 不能播的 `dash` 回答 → 给用户看的错误。 */
export function unavailable(dash: DashAnswer, isVIP: boolean): SourceError {
  if ((dash.status === 110 || dash.status === 502) && !isVIP) return new SourceError('restricted', '该集需要爱奇艺 VIP 会员')
  if (dash.status === 110) return new SourceError('restricted', `该内容需要更高等级的会员或单独购买（${dash.bossCode ?? '110'}）`)
  // 702：按声明的能力位没有能给的流——这部片只有加密版本，客户端不支持它的加密方式（或什么 DRM 都不支持）。
  if (dash.status === 702) return new SourceError('unplayable', `${ENCRYPTED}（这台设备不支持这部片的加密方式）`)
  return new SourceError('unplayable', `该视频暂不支持播放（${dash.status}）`)
}

export class IQiyiPlayback {
  private readonly reported = new Map<string, number>()
  /** 许可地址，按 `<DRM>:<ref>`（ref 是 tvid + 清晰度）记下；没有时许可转发再问一次 `dash`。 */
  readonly licenseHosts = new Map<string, string>()

  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  async dash(tvid: string, bid: number, drm: DashDrm, signal: AbortSignal | undefined): Promise<DashAnswer> {
    const s = this.session
    const url = dashURL({ tvid, bid, drm, authCookie: s.authCookie, uid: s.uid, deviceID: s.deviceID, vipType: s.vipType })
    const response = await s.fetch(url, signal)
    if (!response.ok) throw new SourceError('unavailable', `爱奇艺播放接口返回 HTTP ${response.status}`, { retryable: true })
    try {
      return parseDash(parseJSON(await response.text()))
    } catch (error) {
      if (error instanceof SourceError) throw error
      throw new SourceError('upstream_changed', '播放信息读不懂', { cause: error })
    }
  }

  /** 不登录也能解析（`dash` 不带 `pck` / `uid`，网页未登录时就这么发）。 */
  async resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia> {
    const s = this.session
    // 会员类型随账号信息缓存；还没读过时先读一次，免得把会员当普通账号。
    if (s.loggedIn && !s.profile) await s.state(ctx.signal)
    const id = parseID(request.video) ?? parseID(request.show)
    if (!id) throw new SourceError('not_found', `无法识别的视频 ${request.video}`)
    const client = clientDrm(request).filter((system) => IQIYI_DRM_SYSTEMS.includes(system))
    const drm = dashDrm(client)
    const history = s.historyRecords(ctx.signal)
    const tvid = id.kind === 'video' ? id.id : await this.defaultVideo(id.id, await history, ctx.signal)
    const wanted = bidFor(request.preferences?.maxQualityRank)
    // 标题：视频的 baseinfo（失败就空着，App 用它自己的）。
    const info = s.json(`${PCW_API}/video/video/baseinfo/${tvid}`, '', ctx.signal).then((r) => r?.data, () => undefined)
    const [dash, records, video] = await Promise.all([this.dash(tvid, wanted, drm, ctx.signal), history, info])
    if (dash.status !== 101) throw unavailable(dash, s.isVIP)
    const selected = selectedRendition(dash)
    if (!selected) throw unavailable(dash, s.isVIP)

    const streams: Stream[] = []
    for (const rendition of dash.renditions) {
      const quality = { rank: qualityRank(rendition.bid), label: qualityLabel(rendition.bid) }
      const description = `bid ${rendition.bid}${rendition.size ? ` ${rendition.size}` : ''} drm ${rendition.drmType}${rendition.preview ? ' 试看' : ''}`
      const base = { id: String(rendition.bid), format: 'hls' as const, quality, description }
      const encrypted = rendition.drmType === FAIRPLAY || rendition.drmType === WIDEVINE
      if (rendition.bid >= PREFERRED_BID && !s.isVIP) {
        streams.push({ ...base, url: 'about:blank', unavailableReason: 'VIP' })
      } else if (encrypted) {
        const bid = rendition.bid
        const ref = drmRef(tvid, bid)
        // 这档用哪种 DRM：选中档看播放列表里实际的 key 标签，别的档（还没取）按 drmType。
        let systems = expectedSystems(rendition)
        let url: string
        if (rendition.bid === selected.bid) {
          const built = await this.encryptedMaster(rendition, ref, ctx)
          systems = built.systems
          url = ctx.media.text(built.master, { name: 'master.m3u8' })
        } else {
          // 别的加密清晰度要单独请求：主播放列表在客户端第一次拉时才问 `dash`。
          let master: Promise<string> | undefined
          url = ctx.media.generated(() => {
            master ??= this.dash(tvid, bid, drm, undefined).then(async (answer) => {
              const chosen = selectedRendition(answer)
              if (answer.status !== 101) throw unavailable(answer, s.isVIP)
              if (!chosen || chosen.drmType !== rendition.drmType) throw new SourceError('unplayable', '这个清晰度暂时拿不到加密播放地址')
              return (await this.encryptedMaster(chosen, ref, ctx)).master
            })
            master.catch(() => (master = undefined))
            return master
          }, { name: 'master.m3u8' })
        }
        const usable = systems.filter((system) => client.includes(system))
        if (usable.length === 0) {
          streams.push({ ...base, url: 'about:blank', unavailableReason: `${ENCRYPTED}（这台设备不支持 ${systems.map(drmName).join(' / ') || '这种加密'}）` })
        } else {
          streams.push({ ...base, url, ...drmEndpoints(ctx.sourceId, ref, usable), keepable: false })
        }
      } else if (rendition.drmType !== 1) {
        streams.push({ ...base, url: 'about:blank', unavailableReason: ENCRYPTED })
      } else if (rendition.bid === selected.bid && rendition.playlist) {
        streams.push({ ...base, url: ctx.media.text(normalizePlaylist(rendition.playlist), { name: 'media.m3u8' }), keepable: true })
      } else {
        // 别的清晰度要单独请求：App 第一次拉它的播放列表时才问 `dash`，问到后留着。
        const bid = rendition.bid
        let playlist: Promise<string> | undefined
        const produce = () => {
          playlist ??= this.dash(tvid, bid, drm, undefined).then((answer) => {
            const chosen = selectedRendition(answer)
            if (answer.status !== 101 || !chosen?.playlist) throw answer.status !== 101 ? unavailable(answer, s.isVIP) : new SourceError('unplayable', ENCRYPTED)
            return normalizePlaylist(chosen.playlist)
          })
          playlist.catch(() => (playlist = undefined))
          return playlist
        }
        streams.push({ ...base, url: ctx.media.generated(produce, { name: 'media.m3u8' }), keepable: true })
      }
    }
    streams.sort((l, r) => r.quality.rank - l.quality.rank || Number(r.id) - Number(l.id))
    const available = streams.filter((stream) => !stream.unavailableReason)
    if (available.length === 0) {
      if (dash.renditions.every((r) => r.drmType !== 1)) {
        throw new SourceError('unplayable', client.length === 0 ? `${ENCRYPTED}（这台设备不能播放加密片源）` : `${ENCRYPTED}（这台设备不支持这部片的加密方式）`)
      }
      throw new SourceError('restricted', '没有可播放的清晰度')
    }
    const cap = request.preferences?.maxQualityRank ?? Number.POSITIVE_INFINITY
    const chosen = available.find((stream) => stream.id === String(selected.bid) && stream.quality.rank <= cap)
      ?? available.find((stream) => stream.quality.rank <= cap)
      ?? available.at(-1)!

    // 账号里的进度：历史里这一集的 `play_time`。
    let startPosition: number | undefined
    const record = records?.find((r) => idOf(r?.episodeId) === tvid)
    const position = num(record?.play_time)
    const duration = dash.duration ?? num(record?.duration)
    if (position && position > 0 && (!duration || position < duration - FINISHED_MARGIN)) startPosition = position

    const markers: Markers | undefined = dash.introEnd || dash.outroStart ? { introEnd: dash.introEnd, outroStart: dash.outroStart } : undefined
    return {
      title: text(video?.name) ?? text(record?.title) ?? '',
      startPosition,
      streams,
      selectedStream: chosen.id,
      markers,
      reportContext: { tvid, albumID: dash.albumID },
      diagnostics: { tvid, bid: String(selected.bid), vipType: s.vipType, loggedIn: String(s.loggedIn) },
    }
  }

  /**
   * 一档加密流的主播放列表和它实际带的 DRM，许可地址记下（按 DRM + ref）：
   * - FairPlay：取平台的主播放列表，变体 / 音频组的媒体播放列表改成网关的 `generated` 地址（第一次请求时去取、补齐 key 标签、
   *   分片改成绝对的 CDN 地址，客户端直连）。取播放列表时带网页的头和登录 cookie，和 App 的 AVURLAsset 一样。
   * - Widevine：JSON 描述做成 fMP4 HLS，init 段经网关提供，分片直连 CDN（不要请求头，实测）。
   */
  async encryptedMaster(rendition: Rendition, ref: string, ctx: Ctx): Promise<{ master: string; systems: DrmSystem[] }> {
    if (rendition.drmType === WIDEVINE) {
      if (!rendition.widevine) throw new SourceError('upstream_changed', 'Widevine 片源没有给分片描述')
      if (rendition.licenseHost) this.licenseHosts.set(`widevine:${ref}`, rendition.licenseHost)
      let tracks: ReturnType<typeof widevineTracks>
      try {
        tracks = widevineTracks(rendition.widevine)
      } catch (error) {
        throw new SourceError('upstream_changed', 'Widevine 片源的分片描述读不懂', { cause: error })
      }
      const media = (track: NonNullable<typeof tracks.audio>) => {
        const playlist = widevineMediaPlaylist(track, initFile(track.init, ctx))
        return { playlist, url: ctx.media.text(playlist, { name: `${track.kind}.m3u8` }) }
      }
      const video = media(tracks.video)
      const audio = tracks.audio ? media(tracks.audio) : undefined
      return {
        master: widevineMaster(tracks, { video: video.url, audio: audio?.url }, rendition.size),
        systems: keySystems(video.playlist),
      }
    }
    if (!rendition.url) throw new SourceError('upstream_changed', 'FairPlay 片源没有给播放地址')
    if (rendition.licenseHost) this.licenseHosts.set(`fairplay:${ref}`, rendition.licenseHost)
    const master = await this.fairPlayMasterText(rendition.url, ctx)
    const systems = rendition.keyPlaylist ? keySystems(rendition.keyPlaylist) : []
    return { master, systems: systems.length > 0 ? systems : ['fairplay'] }
  }

  private async fairPlayMasterText(url: string, ctx: Ctx): Promise<string> {
    const { text: master, url: base } = await this.playlistText(url, undefined)
    // 平台直接给了媒体播放列表（没有变体）：补齐 key 标签就行。
    if (!master.includes('#EXT-X-STREAM-INF')) return normalizeFairPlayMedia(master, base)
    return rewritePlaylist(master, base, (absolute) => ctx.media.generated(
      async () => {
        const media = await this.playlistText(absolute, undefined)
        return normalizeFairPlayMedia(media.text, media.url)
      },
      { name: absolute.split('?')[0].split('/').pop() || 'media.m3u8' },
    ))
  }

  private async playlistText(url: string, signal: AbortSignal | undefined): Promise<{ text: string; url: string }> {
    const response = await this.session.fetch(url, signal)
    if (response.status === 403 || response.status === 410) throw new SourceError('unplayable', '加密播放地址已过期，请重新打开', { retryable: true })
    if (!response.ok) throw new SourceError('unavailable', `取加密播放列表失败（HTTP ${response.status}）`, { retryable: true })
    const body = await response.text()
    if (!body.trimStart().startsWith('#EXTM3U')) throw new SourceError('upstream_changed', '加密播放列表读不懂')
    return { text: body, url: response.url || url }
  }

  /** 剧要播的那集：历史里最新看的，否则第一集。 */
  private async defaultVideo(album: string, records: any[] | undefined, signal: AbortSignal | undefined): Promise<string> {
    const record = records?.find((r) => idOf(r?.albumId) === album)
    const fromHistory = idOf(record?.episodeId)
    if (fromHistory) return fromHistory
    const info = await this.session.json(`${PCW_API}/album/album/baseinfo/${album}`, '', signal)
    const first = idOf(info?.data?.firstVideoId)
    if (!first) throw new SourceError('unplayable', '该剧集暂无可播放的视频')
    return first
  }

  /** 把进度写进观看历史，像网页播放器那样（它一分钟一次）。 */
  async progress(request: ProgressRequest, ctx: Ctx): Promise<void> {
    const s = this.session
    const auth = s.authCookie
    if (!auth) return
    const context = (request.reportContext ?? {}) as { tvid?: string }
    const tvid = context.tvid ?? (parseID(request.video)?.kind === 'video' ? parseID(request.video)!.id : undefined)
    if (!tvid) return
    const now = Date.now()
    if (request.event === 'progress' && now - (this.reported.get(tvid) ?? 0) < REPORT_INTERVAL) return
    this.reported.set(tvid, now)
    if (this.reported.size > 200) this.reported.delete(this.reported.keys().next().value!)
    let position = Math.floor(request.position)
    if (request.event === 'end' && request.duration) position = Math.floor(request.duration)
    const records = JSON.stringify([{ type: '1', rid: tvid, videoPlayTime: position, addtime: Math.floor(now / 1000), terminalId: 11, ex: '1' }])
    const response = await s.json('https://l-rcd.iqiyi.com/apis/mbd/v2/upload.action', {
      auth, ckuid: s.deviceID, agent_type: '1', version: '1', terminalId: '11', upload_records: records, scene: 'timer',
    }, ctx.signal)
    if (str(response?.code) !== 'A00000') throw apiError(response?.code, response?.msg, '进度上报失败')
  }
}
