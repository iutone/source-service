// 字幕文件（timedtext）：缓存、合并并发、被限流后冷却（docs/remote-source/SERVER.md §15）。
// YouTube 会按出口 IP 单独限 `/api/timedtext`（429 + Google 的「Sorry」页，播放和浏览不受影响；换客户端身份、
// 带登录、yt-dlp 自己下载、浏览器指纹伪装都一样，2026-11-21 在 NAS 上实测）。所以同一条字幕只取一次，
// 播放器的字幕文件和 App 翻译用的原文共用这一份；被限后一段时间内不再去取，直接告诉 App 稍后再试。
import { SourceError } from '@iyt-source/kit'

/** `timedtext` 的 `fmt=json3` 回答。 */
export type CaptionAnswer = unknown

export interface CaptionFetcherOptions {
  /** 缓存多少条（按最近使用）。 */
  limit?: number
  /** 一条缓存多久，毫秒。 */
  ttl?: number
  /** 被限流后冷却多久，毫秒。 */
  cooldown?: number
  fetch?: typeof fetch
  now?: () => number
}

export class CaptionFetcher {
  private readonly cache = new Map<string, { answer: CaptionAnswer; expires: number }>()
  private readonly pending = new Map<string, Promise<CaptionAnswer>>()
  /** 被限流后，到这个时间之前不再请求 timedtext。 */
  private blockedUntil = 0

  private readonly options: CaptionFetcherOptions

  constructor(options: CaptionFetcherOptions = {}) {
    this.options = options
  }

  private get now() { return (this.options.now ?? Date.now)() }

  /**
   * `key`（视频 + 字幕轨）的 json3：有缓存用缓存，同一条正在取就等它，冷却中直接报 `throttled`。
   * - Parameter url: 这条字幕的 timedtext 地址（会改成 `fmt=json3`）。
   */
  /**
   * - Parameter send: 发请求的方式（出口池）；省略用全局 fetch。它自己处理限流时，这里拿不到 429。
   */
  async get(key: string, url: string, signal?: AbortSignal,
            send?: (url: URL, signal?: AbortSignal) => Promise<Response>): Promise<CaptionAnswer> {
    const hit = this.cache.get(key)
    if (hit && hit.expires > this.now) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.answer
    }
    const running = this.pending.get(key)
    if (running) return running
    if (this.blockedUntil > this.now) throw CaptionFetcher.throttled(this.blockedUntil - this.now)
    const work = this.fetchJSON(url, signal, send).finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    const answer = await work
    this.cache.set(key, { answer, expires: this.now + (this.options.ttl ?? 6 * 3600_000) })
    while (this.cache.size > (this.options.limit ?? 200)) this.cache.delete(this.cache.keys().next().value!)
    return answer
  }

  private async fetchJSON(raw: string, signal?: AbortSignal,
                          send?: (url: URL, signal?: AbortSignal) => Promise<Response>): Promise<CaptionAnswer> {
    const url = new URL(raw)
    url.searchParams.set('fmt', 'json3')
    let response: Response
    try {
      response = send ? await send(url, signal) : await (this.options.fetch ?? fetch)(url, { signal })
    } catch (error) {
      if (signal?.aborted || error instanceof SourceError) throw error
      throw new SourceError('unavailable', '连不上 YouTube 的字幕服务，请稍后再试', { retryable: true, cause: error })
    }
    if (response.status === 429) {
      const cooldown = this.options.cooldown ?? 15 * 60_000
      this.blockedUntil = this.now + cooldown
      throw CaptionFetcher.throttled(cooldown)
    }
    if (!response.ok) throw new SourceError('unavailable', `YouTube 的字幕暂时取不到（${response.status}），请稍后再试`, { retryable: true })
    try {
      return await response.json()
    } catch (error) {
      throw new SourceError('upstream_changed', 'YouTube 的字幕格式读不懂', { cause: error })
    }
  }

  static throttled(remaining: number): SourceError {
    const minutes = Math.max(1, Math.ceil(remaining / 60_000))
    return new SourceError('throttled', `YouTube 暂时限制了这台服务取字幕，请约 ${minutes} 分钟后再试`,
      { retryable: true, retryAfter: Math.ceil(remaining / 1000) })
  }
}
