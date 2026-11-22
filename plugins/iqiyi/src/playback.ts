// 播放（照 App 的 IQiyiPlaybackService / IQiyiDash / IQiyiHLSAsset）：网页播放器的 `cache.video.iqiyi.com/dash`，
// 按 Safari 的能力位请求（不声明 Widevine）。明文片源每档给一份内联的 HLS 媒体播放列表（分片是绝对地址的 TS），
// 经媒体网关的 `text` / `generated` 提供；分片由 App 直接从 CDN 拉。FairPlay 档服务端还不支持（manifest 的
// features.fairPlay 是 false），所以不声明 FairPlay 能力位，加密档给 `unavailableReason`。进度写进观看历史
// （`l-rcd …/upload.action`）。
import type { Markers, PlaybackMedia, ProgressRequest, ResolveRequest, Stream } from '@iyt-source/protocol'
import { SourceError, type Ctx } from '@iyt-source/kit'
import { apiError, type IQiyiSession } from './session.ts'
import { arr, authKey, bool, idOf, int, num, parseID, parseJSON, PCW_API, PLAYER_SOURCE, query, str, text, vf } from './util.ts'

/** 离结尾不到这么多秒的进度算看完，从头播。 */
const FINISHED_MARGIN = 10
/** 先要的清晰度；回答里会列出这部片的全部清晰度。 */
const PREFERRED_BID = 600
/** 进度上报的最短间隔（网页播放器一分钟一次；App 约 15 秒发一次）。 */
const REPORT_INTERVAL = 30_000
const ENCRYPTED = '加密片源，暂不支持'

/** 能力位（`k_ft<组>`，第 n 位 = 1 << (n - 1)），照 Safari 播放器：H.264 TS，可选 FairPlay，不要 Widevine（会让独播剧改发 Widevine）。 */
export function capabilities(fairPlay: boolean): [string, string][] {
  const mask = (bits: number[]) => bits.reduce((value, bit) => value | (1n << BigInt(bit - 1)), 0n).toString()
  const group4 = [3, 14, 27, 38, 44, 46, 51]
  if (fairPlay) group4.push(10, 11, 12, 29)
  return [
    ['k_ft1', mask([3, 40, 48, 50])], ['k_ft4', mask(group4)], ['k_ft5', mask([1, 25, 28, 45])],
    ['k_ft7', mask([26, 29, 36, 44, 45])], ['k_ftx2', 'g'],
  ]
}

/** 签名后的 `dash` 地址：`vf` 对发出去的路径和参数原文算。 */
export function dashURL(options: { tvid: string; bid: number; fairPlay?: boolean; authCookie?: string; uid?: string; deviceID: string; vipType: string; time?: number }): string {
  const time = String(options.time ?? Date.now())
  const pairs: [string, string][] = [
    ['tvid', options.tvid], ['bid', String(options.bid)], ['src', PLAYER_SOURCE], ['vt', '0'], ['rs', '1'],
    ['uid', options.uid ?? ''], ['ori', 'pcw'], ['ps', '0'], ['k_uid', options.deviceID], ['pt', '0'], ['d', '0'], ['s', ''],
    ['lid', '0'], ['cf', '0'], ['ct', '0'],
    ['authKey', authKey(options.authCookie ?? '', time, options.tvid)],
    ['k_tag', '1'], ['dfp', ''], ['locale', 'zh_cn'], ['pck', options.authCookie ?? ''], ['up', ''], ['qd_v', 'a1'],
    ['tm', time],
    ...capabilities(options.fairPlay ?? false),
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
  return dash.renditions.find((r) => r.selected) ?? dash.renditions.find((r) => r.playlist)
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

/** 不能播的 `dash` 回答 → 给用户看的错误。 */
export function unavailable(dash: DashAnswer, isVIP: boolean): SourceError {
  if ((dash.status === 110 || dash.status === 502) && !isVIP) return new SourceError('restricted', '该集需要爱奇艺 VIP 会员')
  if (dash.status === 110) return new SourceError('restricted', `该内容需要更高等级的会员或单独购买（${dash.bossCode ?? '110'}）`)
  return new SourceError('unplayable', `该视频暂不支持播放（${dash.status}）`)
}

export class IQiyiPlayback {
  private readonly reported = new Map<string, number>()

  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  private async dash(tvid: string, bid: number, signal: AbortSignal | undefined): Promise<DashAnswer> {
    const s = this.session
    const url = dashURL({ tvid, bid, authCookie: s.authCookie, uid: s.uid, deviceID: s.deviceID, vipType: s.vipType })
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
    const history = s.historyRecords(ctx.signal)
    const tvid = id.kind === 'video' ? id.id : await this.defaultVideo(id.id, await history, ctx.signal)
    const wanted = bidFor(request.preferences?.maxQualityRank)
    // 标题：视频的 baseinfo（失败就空着，App 用它自己的）。
    const info = s.json(`${PCW_API}/video/video/baseinfo/${tvid}`, '', ctx.signal).then((r) => r?.data, () => undefined)
    const [dash, records, video] = await Promise.all([this.dash(tvid, wanted, ctx.signal), history, info])
    if (dash.status !== 101) throw unavailable(dash, s.isVIP)
    const selected = selectedRendition(dash)
    if (!selected) throw unavailable(dash, s.isVIP)

    const streams: Stream[] = []
    for (const rendition of dash.renditions) {
      const quality = { rank: qualityRank(rendition.bid), label: qualityLabel(rendition.bid) }
      const description = `bid ${rendition.bid}${rendition.size ? ` ${rendition.size}` : ''} drm ${rendition.drmType}`
      const base = { id: String(rendition.bid), format: 'hls' as const, quality, description }
      if (rendition.bid >= PREFERRED_BID && !s.isVIP) {
        streams.push({ ...base, url: 'about:blank', unavailableReason: 'VIP' })
      } else if (rendition.drmType !== 1) {
        streams.push({ ...base, url: 'about:blank', unavailableReason: ENCRYPTED })
      } else if (rendition.bid === selected.bid && rendition.playlist) {
        streams.push({ ...base, url: ctx.media.text(normalizePlaylist(rendition.playlist), { name: 'media.m3u8' }), keepable: true })
      } else {
        // 别的清晰度要单独请求：App 第一次拉它的播放列表时才问 `dash`，问到后留着。
        const bid = rendition.bid
        let playlist: Promise<string> | undefined
        const produce = () => {
          playlist ??= this.dash(tvid, bid, undefined).then((answer) => {
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
      if (dash.renditions.some((r) => r.drmType !== 1) && !dash.renditions.some((r) => r.drmType === 1)) throw new SourceError('unplayable', `${ENCRYPTED}（该片只有 FairPlay 加密版本）`)
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
