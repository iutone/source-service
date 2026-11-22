// 观看历史（照 App 的 IQiyiHistoryService）：`tvg/my/lw/v2/play_history`，一部剧一条（最新看的那集和进度）；
// 删除按集的 tvid（`del_play_history`）、清空（`clear_play_history`）。
import type { HistoryPage, VideoItem, WatchDevice } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { apiError, type IQiyiSession } from './session.ts'
import { albumID, APP_VERSION, arr, bool, idOf, image, int, MESH, num, text, videoID } from './util.ts'

const PAGE_SIZE = 30

export class IQiyiHistory {
  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  async page(page: number, signal: AbortSignal | undefined): Promise<HistoryPage> {
    this.session.requireLogin()
    const response = await this.session.tvgJSON(`${MESH}/tvg/my/lw/v2/play_history`, {
      app_version: APP_VERSION, device_id: this.session.deviceID, only_long: '0', page_num: String(page), page_size: String(PAGE_SIZE), src: 'pcw',
    }, signal)
    if (int(response?.status_code) !== 0) {
      // 分不清是凭证失效还是接口问题：读一下账号。
      return this.session.explain(apiError(response?.status_code, response?.msg, '观看历史加载失败'), signal)
    }
    const records = arr(response.data?.records)
    const isEnd = bool(response.data?.is_end)
    return {
      items: records.map(historyItem).filter((i): i is VideoItem => Boolean(i)),
      hasMore: isEnd === false || (isEnd === undefined && records.length >= PAGE_SIZE),
    }
  }

  async delete(keys: string[], signal: AbortSignal | undefined): Promise<void> {
    const tvids = keys.filter((k) => /^\d+$/.test(k))
    if (tvids.length === 0) throw new SourceError('bad_request', '没有可删除的记录')
    await this.change('del_play_history', { tv_id: tvids.join(',') }, signal)
  }

  clear(signal: AbortSignal | undefined): Promise<void> {
    return this.change('clear_play_history', {}, signal)
  }

  /** 网页历史页那样的签名 GET（时间戳用秒）；`status_code` 0 表示成功。 */
  private async change(path: string, params: Record<string, string>, signal: AbortSignal | undefined): Promise<void> {
    const auth = this.session.authCookie
    if (!auth) throw new SourceError('login_required', '需要登录爱奇艺')
    const response = await this.session.tvgJSON(`${MESH}/tvg/my/lw/${path}`, {
      ...params, app_version: APP_VERSION, device_id: this.session.deviceID, auth_cookie: auth,
    }, signal, true)
    if (int(response?.status_code) !== 0) {
      await this.session.explain(apiError(response?.status_code, response?.msg, '删除失败'), signal)
    }
  }
}

export function historyItem(record: any): VideoItem | undefined {
  const tvid = idOf(record?.episodeId)
  if (!tvid) return undefined
  const duration = num(record.duration) ?? 0
  const position = num(record.play_time) ?? 0
  const album = text(record.album_name)
  const rawAlbum = idOf(record.albumId)
  const isSeries = rawAlbum !== undefined && rawAlbum !== tvid && rawAlbum !== '0'
  const added = num(record.add_time)
  return {
    id: videoID(tvid),
    showID: isSeries ? albumID(rawAlbum!) : undefined,
    title: text(record.title) ?? album ?? '',
    subtitle: isSeries ? text(record.album_order) : undefined,
    coverURL: image(record.image_url, 480, 270),
    posterURL: image(record.image_url_vertical, 260, 360),
    progress: duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : undefined,
    watchedPercent: int(record.watch_progress_percent),
    caption: text(record.update_info),
    lastWatched: added ? new Date(added * 1000).toISOString() : undefined,
    device: device(int(record.terminal_id)),
    historyKey: tvid,
  }
}

/** `terminal_id` 11 是网站（这个源上报时用的）；别的终端还没对上。 */
function device(terminal: number | undefined): WatchDevice | undefined {
  return terminal === 11 ? { kind: 'computer', name: '电脑' } : undefined
}
