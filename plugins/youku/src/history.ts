// 观看历史 `mtop.youku.playlog.open.get`（docs/youku-web/REPORT.md §8.5），删除 `open.delete`（一次一条）/ 清空 `open.clear`（§8.6）；
// 弹幕 `mopen.youku.danmu.list`，一次一分钟（docs/youku-web/PLAYER.md §7）。照 App 的 YoukuHistoryService / YoukuDanmakuService 移植。
import type { Danmaku, HistoryPage, VideoItem, WatchDevice } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { compact, int, num, sortedJSON, text, tone, webImage, type J } from './json.ts'
import { CCODE, md5, type MTOPClient } from './mtop.ts'

const PAGE_LENGTH = 100
const PLAYLOG_APP_KEY = 'qPbb2hfIYugHjMaj'

/** `deviceName` 是名字；`hwClass` 1 电脑、2 电视（OTT）、3 平板、4 手机。 */
function device(entry: J): WatchDevice | undefined {
  const name = text(entry?.deviceName)
  if (!name) return undefined
  const kinds: Record<number, WatchDevice['kind']> = { 1: 'computer', 2: 'tv', 3: 'tablet', 4: 'phone' }
  return { kind: kinds[int(entry.hwClass) ?? 0] ?? 'other', name }
}

export function historyItem(entry: J): VideoItem | undefined {
  const videoId = text(entry?.videoId)
  if (!videoId) return undefined
  // `point`（秒）/ `duration` 是准的；`playPercent`（0-100）对看过的也常是 0。
  let progress: number | undefined
  const point = num(entry.point)
  const duration = num(entry.duration)
  const percent = num(entry.playPercent)
  if (point && duration && point > 0 && duration > 0) progress = point / duration
  else if (percent && percent > 0) progress = percent > 1 ? percent / 100 : percent
  const lastUpdate = num(entry.lastUpdate)
  const mark = text(entry.cornerMark)
  const reason = text(entry.unplayableReason)
  // 节目海报（16:9 1366×768、3:4 960×1280）；`imgHd` 是 490×367 的截图，没有节目的短视频只有它（HOME.md §4）。
  return compact({
    id: videoId,
    showID: text(entry.showId),
    title: text(entry.displayTitle) ?? text(entry.title) ?? videoId,
    subtitle: text(entry.rcTitle) ?? text(entry.showUpdateStatus),
    coverURL: webImage(entry.showImgHd ?? entry.imgHd ?? entry.img),
    posterURL: webImage(entry.showVimgHd ?? entry.showVimg),
    progress: progress === undefined ? undefined : Math.min(Math.max(progress, 0), 1),
    watchedPercent: int(entry.playPercent),
    badge: mark ? { text: mark, tone: tone(entry.markColor) } : undefined,
    caption: text(entry.showUpdateStatus),
    lastWatched: lastUpdate ? new Date(lastUpdate * 1000).toISOString() : undefined,
    device: device(entry),
    // 版权片的 `isPlayable` 多半是 0，UPS 却照样能播（PLAYER.md §6），也没有原因：只有写明原因的才锁，其余播放时由 UPS 定。
    isPlayable: reason === undefined,
    unplayableReason: reason,
    historyKey: videoId,
  })
}

export class YoukuHistory {
  private readonly client: MTOPClient
  private readonly identity: (signal?: AbortSignal) => Promise<{ uid: string; cna: string }>

  constructor(client: MTOPClient, identity: (signal?: AbortSignal) => Promise<{ uid: string; cna: string }>) {
    this.client = client
    this.identity = identity
  }

  async page(page: number, signal?: AbortSignal): Promise<HistoryPage> {
    const { uid, cna } = await this.identity(signal)
    const data = await this.client.call('mtop.youku.playlog.open.get', '1.0', {
      nlid: cna, uid, pageLength: PAGE_LENGTH, currentPage: page, timestamp: String(Date.now()), appKey: PLAYLOG_APP_KEY, appName: 'pc',
      hwClass: 1, deviceName: 'web', isPlayController: 1, ccode: CCODE, clientDrmAbility: 3,
    }, { signal })
    const list = findKey(data, 'dataList')
    const items = (Array.isArray(list) ? list : []).map(historyItem).filter((x): x is VideoItem => Boolean(x))
    const hasMore = findKey(data, 'hasMore')
    return { items, hasMore: hasMore === true || hasMore === 1 || hasMore === 'true' }
  }

  /** 一条一条删（`open.batch.delete` 也有，没验证过）。 */
  async delete(keys: string[], signal?: AbortSignal): Promise<void> {
    const base = await this.playlogParameters(signal)
    for (const videoId of keys) await this.client.call('mtop.youku.playlog.open.delete', '1.0', { ...base, videoId }, { signal })
  }

  async clear(signal?: AbortSignal): Promise<void> {
    await this.client.call('mtop.youku.playlog.open.clear', '1.0', await this.playlogParameters(signal), { signal })
  }

  private async playlogParameters(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { uid, cna } = await this.identity(signal)
    return { nlid: cna, uid, timestamp: String(Date.now()), appKey: PLAYLOG_APP_KEY, appName: 'pc', hwClass: 1, deviceName: 'web' }
  }
}

function findKey(value: J, key: string): J {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKey(item, key)
      if (found !== undefined) return found
    }
  } else if (value && typeof value === 'object') {
    if (value[key] !== undefined && value[key] !== null) return value[key]
    for (const item of Object.values(value)) {
      const found = findKey(item, key)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// MARK: 弹幕

/** 弹幕组件的密钥，接在 `msg` 后面做 md5。 */
const DANMAKU_SIGN_KEY = 'MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr'

/** 请求字段，加上 `msg`（键排序 JSON 的 base64）和 `sign`（`md5(msg + key)`）。 */
export function danmakuParameters(vid: string, minute: number, guid: string, now = Date.now()): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    pid: 0, ctype: 10004, sver: '3.1.0', cver: 'v1.0', ctime: now, guid, vid, mat: minute, mcount: 1, type: 1,
  }
  const msg = Buffer.from(sortedJSON(parameters), 'utf8').toString('base64')
  return { ...parameters, msg, sign: md5(msg + DANMAKU_SIGN_KEY) }
}

/** `data.result` 是 JSON 字符串，其中 `data.result[]` 是弹幕：`content`、`playat`（毫秒）、`propertis`（又一个 JSON 字符串：`pos` 3 滚动、4 顶部、6 底部，`color`）。 */
export function parseDanmaku(data: J): Danmaku[] {
  const result = text(data?.result)
  if (!result) throw new SourceError('upstream_changed', '优酷的弹幕接口没有返回结果')
  let inner: J
  try {
    inner = JSON.parse(result)
  } catch {
    throw new SourceError('upstream_changed', '优酷的弹幕读不了')
  }
  if (int(inner?.code) !== 1) throw new SourceError('upstream_changed', `优酷的弹幕出错（${text(inner?.code) ?? '?'}）`)
  const out: Danmaku[] = []
  for (const raw of Array.isArray(inner?.data?.result) ? inner.data.result : []) {
    const id = text(raw?.id)
    const playat = num(raw?.playat)
    const content = text(raw?.content)
    if (!id || playat === undefined || !content) continue
    const body = content.replace(/\n/g, ' ').trim()
    if (!body) continue
    let properties: J = {}
    try { properties = JSON.parse(text(raw.propertis) ?? '{}') } catch { /* 空 */ }
    if (properties?.isBrandAdDanmu === true || properties?.isBrandAdDanmu === 1) continue
    const pos = int(properties?.pos)
    const colorValue = num(properties?.color)
    const color = colorValue === undefined ? 0xffffff : Number(BigInt.asUintN(32, BigInt(Math.trunc(colorValue))) & 0xffffffn)
    out.push({
      id, time: playat / 1000, text: body, position: pos === 4 ? 'top' : pos === 6 ? 'bottom' : 'scroll',
      color: '#' + color.toString(16).padStart(6, '0').toUpperCase(),
    })
  }
  return out
}

export async function fetchDanmaku(client: MTOPClient, vid: string, minute: number, guid: string, signal?: AbortSignal): Promise<Danmaku[]> {
  return parseDanmaku(await client.call('mopen.youku.danmu.list', '1.0', danmakuParameters(vid, minute, guid), { signal }))
}
