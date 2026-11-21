// 出口池（SERVER.md §18）：同一台服务手里有几个固定的上游代理出口（比如代理软件里各绑一个节点的端口），
// 按用途分组。请求按顺序用第一个没在冷却的出口；平台按 IP 限流（YouTube 的字幕 429、yt-dlp 的「不是机器人」验证）时
// 把那个出口冷却一段时间、换下一个；都在冷却就报 `throttled`。每个请求单独指定出口，不改任何全局状态，
// 正在播放的流不受影响。没配某个用途时照旧走全局代理（`HTTPS_PROXY`）。
import { SourceError } from './errors.ts'
import type { Logger } from './plugin.ts'

/** 一个出口：代理地址（`http://host:port`），以及按它发请求用的 fetch `dispatcher`（由 CLI 用 undici 造）。 */
export interface Exit {
  url: string
  dispatcher?: unknown
}

export interface ExitStatus {
  url: string
  /** 冷却到这个时间（ISO 8601）；没在冷却时省略。 */
  coolingUntil?: string
  lastFailure?: string
  lastFailureAt?: string
  lastSuccessAt?: string
  /** 被限次数（服务启动以来）。 */
  limited: number
}

export interface ExitPoolOptions {
  /** 用途 → 出口，按优先顺序。 */
  pools: Record<string, Exit[]>
  /** 被限后冷却多久，毫秒；默认 30 分钟。 */
  cooldownMs?: number
  log?: Logger
  now?: () => number
}

interface State {
  coolingUntil: number
  lastFailure?: string
  lastFailureAt?: number
  lastSuccessAt?: number
  limited: number
}

export class ExitPool {
  private readonly pools: Record<string, Exit[]>
  private readonly cooldownMs: number
  private readonly log?: Logger
  private readonly now: () => number
  /** 按出口地址：同一个出口在几个用途里共用冷却（被限的是那个 IP）。 */
  private readonly states = new Map<string, State>()

  constructor(options: ExitPoolOptions) {
    this.pools = options.pools
    this.cooldownMs = options.cooldownMs ?? 30 * 60_000
    this.log = options.log
    this.now = options.now ?? Date.now
  }

  /** 没有出口的池。 */
  static none(): ExitPool {
    return new ExitPool({ pools: {} })
  }

  /** 这个用途配了出口。 */
  has(purpose: string): boolean {
    return (this.pools[purpose]?.length ?? 0) > 0
  }

  private state(url: string): State {
    let state = this.states.get(url)
    if (!state) {
      state = { coolingUntil: 0, limited: 0 }
      this.states.set(url, state)
    }
    return state
  }

  /** 这个用途现在可用的出口，按优先顺序。 */
  available(purpose: string): Exit[] {
    const now = this.now()
    return (this.pools[purpose] ?? []).filter((exit) => this.state(exit.url).coolingUntil <= now)
  }

  /** 最早恢复的那个出口还要等多久，毫秒。 */
  private soonest(purpose: string): number {
    const now = this.now()
    const times = (this.pools[purpose] ?? []).map((exit) => this.state(exit.url).coolingUntil - now)
    return Math.max(0, Math.min(...times))
  }

  /** 出口被平台限了：冷却，记日志。 */
  limited(purpose: string, exit: Exit, reason: string): void {
    const state = this.state(exit.url)
    const now = this.now()
    state.coolingUntil = now + this.cooldownMs
    state.lastFailure = reason
    state.lastFailureAt = now
    state.limited += 1
    const left = this.available(purpose).length
    this.log?.warn('出口被限，冷却', {
      exit: exit.url, purpose, reason, cooldownMinutes: Math.round(this.cooldownMs / 60_000), available: left,
    })
    if (left === 0) this.log?.error('这个用途的出口都在冷却', { purpose, retryInSeconds: Math.ceil(this.soonest(purpose) / 1000) })
  }

  /** 出口这次好用。冷却过又恢复的，记一条日志。 */
  succeeded(purpose: string, exit: Exit): void {
    const state = this.state(exit.url)
    const recovered = state.lastFailureAt !== undefined && (state.lastSuccessAt ?? Number.NEGATIVE_INFINITY) <= state.lastFailureAt
    state.lastSuccessAt = this.now()
    if (recovered) this.log?.info('出口恢复', { exit: exit.url, purpose })
  }

  /** 都在冷却时的错误。 */
  throttled(purpose: string, message: string): SourceError {
    const wait = this.soonest(purpose)
    const minutes = Math.max(1, Math.ceil(wait / 60_000))
    return new SourceError('throttled', message.replace('{minutes}', String(minutes)),
      { retryable: true, retryAfter: Math.max(1, Math.ceil(wait / 1000)) })
  }

  /**
   * 按这个用途的出口依次请求，`isLimited` 说是被限就冷却它、换下一个。没配这个用途时直接请求（全局代理）。
   * - Parameter throttledMessage: 都在冷却时给 App 的话，`{minutes}` 换成还要等的分钟数。
   */
  async fetch(purpose: string, input: string | URL, init: RequestInit & { signal?: AbortSignal },
              isLimited: (response: Response) => boolean, throttledMessage: string): Promise<Response> {
    if (!this.has(purpose)) return fetch(input, init)
    const exits = this.available(purpose)
    if (exits.length === 0) throw this.throttled(purpose, throttledMessage)
    let last: Response | undefined
    for (const exit of exits) {
      let response: Response
      try {
        response = await fetch(input, { ...init, dispatcher: exit.dispatcher } as RequestInit)
      } catch (error) {
        if (init.signal?.aborted) throw error
        // 出口本身连不上（代理挂了）：也冷却，换下一个。
        this.limited(purpose, exit, `连不上：${String(error).slice(0, 120)}`)
        continue
      }
      if (isLimited(response)) {
        this.limited(purpose, exit, `HTTP ${response.status}`)
        last = response
        await response.body?.cancel().catch(() => {})
        continue
      }
      this.succeeded(purpose, exit)
      return response
    }
    if (last && this.available(purpose).length === 0) throw this.throttled(purpose, throttledMessage)
    throw this.throttled(purpose, throttledMessage)
  }

  /**
   * 按这个用途的出口依次运行 `work`（拿到出口：代理地址给 yt-dlp 的 `--proxy`，`dispatcher` 给之后取这次结果的请求），`isLimited` 说是被限就换下一个。
   * 没配这个用途时以 `undefined` 运行一次。
   */
  async run<T>(purpose: string, work: (exit: Exit | undefined) => Promise<T>, isLimited: (error: unknown) => string | undefined,
               throttledMessage: string): Promise<T> {
    if (!this.has(purpose)) return work(undefined)
    const exits = this.available(purpose)
    if (exits.length === 0) throw this.throttled(purpose, throttledMessage)
    let lastError: unknown
    for (const exit of exits) {
      try {
        const result = await work(exit)
        this.succeeded(purpose, exit)
        return result
      } catch (error) {
        const reason = isLimited(error)
        if (!reason) throw error
        this.limited(purpose, exit, reason)
        lastError = error
      }
    }
    if (this.available(purpose).length === 0) throw this.throttled(purpose, throttledMessage)
    throw lastError
  }

  /** 每个用途的出口状态：调试页、日志用。 */
  status(): Record<string, ExitStatus[]> {
    const iso = (time?: number) => (time ? new Date(time).toISOString() : undefined)
    const now = this.now()
    return Object.fromEntries(Object.entries(this.pools).map(([purpose, exits]) => [purpose, exits.map((exit) => {
      const state = this.state(exit.url)
      return {
        url: exit.url,
        coolingUntil: state.coolingUntil > now ? iso(state.coolingUntil) : undefined,
        lastFailure: state.lastFailure,
        lastFailureAt: iso(state.lastFailureAt),
        lastSuccessAt: iso(state.lastSuccessAt),
        limited: state.limited,
      }
    })]))
  }
}
