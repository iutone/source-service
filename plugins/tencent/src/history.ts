// 观看历史（API.md §5，App 的 TencentHistoryService）：`GetList` 每部一条（它最近看的视频和位置），一页 20 条，按
// `page_context` 往下翻；进度经 `AddOrUpdate` 写进去（要列表最新的 `data_version`）；删除 `Del`（按 `record_id`，带新取的
// `GetDataVersionV2`），清空 `DelAll`——个人中心的调用。都要登录。
import type { VideoItem } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { HISTORY_HEAD } from './constants.ts'
import { coverID, videoID } from './ids.ts'
import { imageURL, int, num, str, text } from './json.ts'
import { apiError, loginRequired, type TencentSession } from './session.ts'

const SERVICE = 'trpc.video_history.interface_server.InterfaceService'
const HEADERS = { 'trpc-trans-info': HISTORY_HEAD }
const FIRST_CONTEXT = { new_mark_label_enabled: '1' }

/** `ret` 15006（和网关的登录错误）：会话登录不上了。 */
export function checkHistory(response: any): void {
  const ret = int(response?.ret)
  if (ret === 0) return
  if (ret === 15006 || ret === 1110001 || ret === 1100005) throw loginRequired()
  throw apiError(response?.ret, text(response?.msg))
}

export function historyItem(record: any): VideoItem | undefined {
  const msg = record?.msg ?? {}
  const poster = record?.poster ?? {}
  const vid = text(msg.vid)
  if (!vid) return undefined
  const position = num(msg.video_time) ?? 0
  const duration = num(poster.video_duration) ?? 0
  const fraction = duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : undefined
  const cid = text(msg.cid)
  const viewed = num(msg.view_date)
  return {
    id: videoID(vid),
    showID: cid ? coverID(cid) : undefined,
    title: text(poster.series_title) ?? text(poster.title) ?? '',
    subtitle: text(poster.content_title) ?? text(poster.third_title),
    coverURL: imageURL(poster.image_url),
    posterURL: imageURL(poster.vertical_image_url),
    progress: fraction,
    watchedPercent: fraction === undefined ? undefined : Math.round(fraction * 100),
    caption: text(poster.third_title),
    lastWatched: viewed ? new Date(viewed * 1000).toISOString() : undefined,
    isPlayable: record.can_not_play !== true,
    historyKey: text(msg.record_id),
  }
}

export class TencentHistory {
  private readonly session: TencentSession
  /** 第二页起每页的 `page_context`，翻到时记下。 */
  private readonly cursors = new Map<number, unknown>()

  constructor(session: TencentSession) {
    this.session = session
  }

  forget(): void {
    this.cursors.clear()
  }

  async page(page: number, signal?: AbortSignal): Promise<{ items: VideoItem[]; hasMore: boolean }> {
    let context: unknown = FIRST_CONTEXT
    if (page > 1) {
      if (!this.cursors.has(page)) return { items: [], hasMore: false }
      context = this.cursors.get(page)
    }
    const data = await this.list(context, signal)
    const items = (data?.msgs ?? []).map(historyItem).filter(Boolean) as VideoItem[]
    const hasMore = data?.has_next === true && items.length > 0
    if (hasMore && data.page_context !== undefined) this.cursors.set(page + 1, data.page_context)
    return { items, hasMore }
  }

  /** 一部剧最近的记录（详情页的「继续播放」）。 */
  async record(cid: string, signal?: AbortSignal): Promise<any | undefined> {
    try {
      const data = await this.list(FIRST_CONTEXT, signal)
      return (data?.msgs ?? []).find((m: any) => text(m?.msg?.cid) === cid)
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  /** `GetList` 的一页；顺便记下列表的 `data_version`（上报进度要它）。会话被拒（15006）时先续期再试一次。 */
  async list(context: unknown, signal?: AbortSignal): Promise<any> {
    return this.call(async () => {
      const response = await this.session.gateway(`${SERVICE}/GetList`, {
        query: { video_appid: '1200022', vversion_platform: '2' },
        headers: HEADERS,
        body: {
          union_req: [
            { table_id: 2003, fields: { episode_updated: '', last_period: '', uni_imgtag: '', last_update_time: '', content_form_id: '', type: '' } },
            { table_id: 2010, fields: { playing_status: '' } },
            { table_id: 2001, fields: { duration: '', uni_imgtag: '' } },
            { table_id: 1006, fields: { video_duration: '' } },
          ],
          page_context: context, scene: 2, data_version: 0,
        },
        signal,
      })
      checkHistory(response)
      const version = str(response.data?.data_version)
      if (version) this.session.historyVersion = version
      return response.data
    }, signal)
  }

  /** `AddOrUpdate`：`cid` 里 `vid` 的位置（秒）。 */
  async report(cid: string, vid: string, position: number, signal?: AbortSignal): Promise<void> {
    await this.session.ensureSession(signal)
    if (!this.session.historyVersion) await this.list(FIRST_CONTEXT, signal).catch(() => undefined)
    await this.call(async () => {
      const response = await this.session.gateway(`${SERVICE}/AddOrUpdate`, {
        query: { video_appid: '3000010', vversion_platform: '2', vversion_name: '8.2.95' },
        headers: HEADERS,
        body: {
          data_version: this.session.historyVersion ?? '0', operation_scene: 11,
          msgs: [{ scene: 0, cid, vid, view_date: Math.floor(Date.now() / 1000), video_time: Math.round(position), play_from: 2 }],
        },
        signal,
      })
      checkHistory(response)
      const version = str(response.data?.data_version)
      if (version) this.session.historyVersion = version
    }, signal)
  }

  /** `Del`，带记录的 id（`historyKey`，`cid_<cid>`）。 */
  async delete(keys: string[], signal?: AbortSignal): Promise<void> {
    if (!keys.length) return
    await this.call(async () => {
      const version = await this.dataVersion(signal)
      const response = await this.session.gateway(`${SERVICE}/Del`, {
        query: { video_appid: '1200022', vversion_platform: '2' },
        headers: HEADERS,
        body: { record_ids: keys, data_version: version },
        signal,
      })
      checkHistory(response)
      const next = str(response.data?.data_version)
      if (next) this.session.historyVersion = next
    }, signal)
    this.cursors.clear()
  }

  /** `DelAll`，scene 2（全部，同个人中心的「清空」）。 */
  async clear(signal?: AbortSignal): Promise<void> {
    await this.call(async () => {
      const response = await this.session.gateway(`${SERVICE}/DelAll`, {
        query: { video_appid: '1200022', vversion_platform: '2' },
        headers: HEADERS,
        body: { scene: 2 },
        signal,
      })
      checkHistory(response)
    }, signal)
    this.cursors.clear()
  }

  private async dataVersion(signal?: AbortSignal): Promise<string> {
    const response = await this.session.gateway(`${SERVICE}/GetDataVersionV2`, {
      query: { video_appid: '3000010', vversion_platform: '2' },
      headers: HEADERS,
      body: {},
      signal,
    })
    checkHistory(response)
    return str(response.data?.data_version) ?? this.session.historyVersion ?? '0'
  }

  /** 要登录的调用：先确保会话；答 15006 时续期一次再试（续期说登录没了就是真退出了）。 */
  private async call<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.session.ensureSession(signal)
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof SourceError) || error.code !== 'login_required') throw error
      await this.session.renew(signal)
      return run()
    }
  }
}
