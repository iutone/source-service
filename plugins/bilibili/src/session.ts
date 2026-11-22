// 请求层（照 App 的 BilibiliSession）：网页接口带账号 cookie、风控要的设备 cookie（buvid3 / buvid4 / b_nut、bili_ticket）
// 和 WBI 签名；passport 是 app 签名。登录态和设备 cookie 存在这个源的 `ctx.store` 里。
import type { LoginStep, Membership, Profile } from '@iyt-source/protocol'
import { SourceError, type KeyValueStore, type Logger } from '@iyt-source/kit'
import { API, appSigned, mixinKey, PASSPORT, query, REFERER, ticketSign, USER_AGENT, wbiKey, wbiSigned } from './sign.ts'

export interface Cookie {
  name: string
  value: string
  /** Unix 秒；会话 cookie 为 0 或省略。 */
  expires?: number
}

/** 一个登录：网页接口用的 cookie（SESSDATA、bili_jct、DedeUserID…），加上 TV 扫码登录给的 app token。 */
export interface Credential {
  mid: string
  cookies: Cookie[]
  token?: { accessToken: string; refreshToken: string; /** Unix 秒。 */ expiresAt: number }
}

type DeviceCookies = Record<string, string>

export interface Envelope<T> {
  code: number
  message?: string
  data?: T
  /** PGC 接口给 `result` 而不是 `data`。 */
  result?: T
}

const CREDENTIAL_KEY = 'credential'
const DEVICE_KEY = 'device'
/** token 有效 180 天；剩不到这么多秒就续期。 */
const REFRESH_MARGIN = 30 * 3600
const PROFILE_TTL = 5 * 60_000
const TIMEOUT = 15_000

export const MESSAGES = {
  expired: '哔哩哔哩登录已失效，请重新登录',
  loginRequired: '需要先登录哔哩哔哩',
  riskControl: '哔哩哔哩暂时限制了访问，请稍后再试',
  unreachable: '连不上哔哩哔哩，请稍后再试',
  unexpected: '哔哩哔哩的返回看不懂了，请稍后再试',
}

/** B 站的错误码 → 协议的错误。 */
export function apiError(code: number, message: string | undefined): SourceError {
  const text = message && message !== '0' ? message : ''
  switch (code) {
    case -101:
      return new SourceError('login_required', MESSAGES.loginRequired)
    case -352:
    case -412:
    case -509:
    case -799:
      return new SourceError('throttled', MESSAGES.riskControl)
    case -404:
    case 62002:
    case 62004:
    case 62012:
      return new SourceError('not_found', text || '找不到这个视频')
    case -400:
      return new SourceError('bad_request', text || '请求参数不对')
    case -403:
    case -10403:
    case 6002003:
      return new SourceError('restricted', text || '没有权限观看')
    default:
      return new SourceError('unavailable', text ? `${text}（${code}）` : `哔哩哔哩暂时出错了（${code}）`, { retryable: false })
  }
}

export interface RequestOptions {
  signal: AbortSignal
  /** `wbi`：带 WBI 签名；`none`：只带 cookie。 */
  sign?: 'wbi' | 'none'
  referer?: string
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason)
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort)
    resolve()
  }, ms)
  const abort = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  signal.addEventListener('abort', abort, { once: true })
})

export class BiliSession {
  private readonly store: KeyValueStore
  private readonly log: Logger
  private _credential: Credential | undefined
  private device: DeviceCookies
  private mixin: { key: string; day: string } | undefined
  private devicePromise: Promise<void> | undefined
  private refreshing: Promise<void> | undefined
  private profileCache: { profile: Profile; at: number } | undefined
  /** 大会员：能看 1080P+ / 4K。 */
  isVIP = false

  constructor(store: KeyValueStore, log: Logger) {
    this.store = store
    this.log = log
    this._credential = store.get<Credential>(CREDENTIAL_KEY) ?? undefined
    this.device = store.get<DeviceCookies>(DEVICE_KEY) ?? {}
  }

  get credential(): Credential | undefined {
    return this._credential
  }

  get loggedIn(): boolean {
    return this._credential !== undefined
  }

  get mid(): string {
    if (!this._credential) throw new SourceError('login_required', MESSAGES.loginRequired)
    return this._credential.mid
  }

  /** `bili_jct`：网页 POST 都要带上作 `csrf`。 */
  get csrf(): string | undefined {
    return this._credential?.cookies.find((cookie) => cookie.name === 'bili_jct')?.value
  }

  apply(credential: Credential): void {
    this._credential = credential
    this.profileCache = undefined
    this.store.set(CREDENTIAL_KEY, credential)
  }

  clear(): void {
    this._credential = undefined
    this.profileCache = undefined
    this.isVIP = false
    this.store.delete(CREDENTIAL_KEY)
  }

  cookieHeader(): string {
    const now = Date.now() / 1000
    const pairs = new Map<string, string>(Object.entries(this.device).filter(([name]) => name !== 'bili_ticket_expires'))
    for (const cookie of this._credential?.cookies ?? []) {
      if (cookie.expires && cookie.expires > 0 && cookie.expires < now) continue
      pairs.set(cookie.name, cookie.value)
    }
    return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  // MARK: 请求

  /** 网页 GET：解出 `data`（PGC 接口是 `result`）。 */
  async get<T>(url: string, params: Record<string, string>, options: RequestOptions): Promise<T> {
    return this.riskRetry(options.signal, async () => {
      const signed = options.sign === 'none' ? params : wbiSigned(params, await this.wbiMixinKey(options.signal), Date.now())
      const response = await this.perform(withQuery(url, signed), { signal: options.signal, referer: options.referer })
      return this.unwrap<T>(response, url, options.signal)
    })
  }

  /** 带 `csrf` 的网页 POST 表单。 */
  async post<T>(url: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
    const csrf = this.csrf
    if (!csrf) throw new SourceError('login_required', MESSAGES.loginRequired)
    return this.riskRetry(signal, async () => {
      const response = await this.perform(url, { signal, form: { ...params, csrf } })
      return this.unwrap<T>(response, url, signal, true)
    })
  }

  /** 只看返回码的网页 POST（点赞、投币、收藏、关注、删历史）。 */
  async action(url: string, params: Record<string, string>, signal: AbortSignal): Promise<void> {
    await this.post<unknown>(url, params, signal)
  }

  /** 带 `access_key`（TV 登录的 app token）的 app 签名 POST，只看返回码：app 接口的「不喜欢」。 */
  async appAction(url: string, params: Record<string, string>, signal: AbortSignal): Promise<void> {
    const token = this._credential?.token
    if (!token) throw new SourceError('login_required', MESSAGES.loginRequired)
    const response = await this.perform(url, { signal, form: appSigned({ ...params, access_key: token.accessToken }) })
    await this.unwrap<unknown>(response, url, signal, true)
  }

  /** app 签名的 passport POST，非零的码是状态而不是失败（扫码轮询）。 */
  async appPostEnvelope<T>(url: string, params: Record<string, string>, signal: AbortSignal): Promise<Envelope<T>> {
    const response = await this.perform(url, { signal, form: appSigned(params) })
    return this.envelope<T>(response, url)
  }

  /** 原始字节（protobuf 弹幕），带网页的头和 cookie。 */
  async bytes(url: string, params: Record<string, string>, options: RequestOptions): Promise<Uint8Array> {
    return this.riskRetry(options.signal, async () => {
      const signed = options.sign === 'none' ? params : wbiSigned(params, await this.wbiMixinKey(options.signal), Date.now())
      const response = await this.perform(withQuery(url, signed), { signal: options.signal, referer: options.referer })
      checkStatus(response)
      return new Uint8Array(await response.arrayBuffer())
    })
  }

  /** 不带账号的 JSON GET（字幕文件等 CDN 上的东西）。 */
  async json<T>(url: string, signal: AbortSignal): Promise<T> {
    const response = await this.fetch(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal })
    checkStatus(response)
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new SourceError('upstream_changed', MESSAGES.unexpected, { cause: error })
    }
  }

  private async perform(url: string, options: { signal: AbortSignal; referer?: string; form?: Record<string, string> }): Promise<Response> {
    await this.ensureDeviceCookies(options.signal)
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      referer: options.referer ?? REFERER,
      origin: REFERER,
      cookie: this.cookieHeader(),
    }
    if (options.form) headers['content-type'] = 'application/x-www-form-urlencoded'
    return this.fetch(url, { method: options.form ? 'POST' : 'GET', headers, body: options.form ? query(options.form) : undefined, signal: options.signal })
  }

  private async fetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT)]) })
    } catch (error) {
      if (init.signal.aborted) throw error
      throw new SourceError('unavailable', MESSAGES.unreachable, { cause: error })
    }
  }

  private async envelope<T>(response: Response, url: string): Promise<Envelope<T>> {
    checkStatus(response)
    try {
      return (await response.json()) as Envelope<T>
    } catch (error) {
      this.log.warn('bilibili bad json', { path: new URL(url).pathname })
      throw new SourceError('upstream_changed', MESSAGES.unexpected, { cause: error })
    }
  }

  private async unwrap<T>(response: Response, url: string, signal: AbortSignal, allowEmpty = false): Promise<T> {
    const envelope = await this.envelope<T>(response, url)
    if (envelope.code === 0) {
      const value = envelope.data ?? envelope.result
      if (value === undefined || value === null) {
        if (allowEmpty) return undefined as T
        throw new SourceError('upstream_changed', MESSAGES.unexpected)
      }
      return value
    }
    if (envelope.code === -101) {
      // 会话失效：用 nav 确认一次，确实没登录就当作退出。
      const had = this._credential !== undefined
      if (had && !url.includes('/x/web-interface/nav')) await this.confirmLoggedOut(signal)
      throw new SourceError('login_required', had ? MESSAGES.expired : MESSAGES.loginRequired)
    }
    throw apiError(envelope.code, envelope.message)
  }

  private async confirmLoggedOut(signal: AbortSignal): Promise<void> {
    try {
      const nav = await this.envelope<NavData>(await this.perform(`${API}/x/web-interface/nav`, { signal }), `${API}/x/web-interface/nav`)
      if (nav.data?.isLogin !== true) {
        this.log.warn('bilibili session expired')
        this.clear()
      }
    } catch (error) {
      if (signal.aborted) throw error
    }
  }

  /** 风控常是 WBI key 或 ticket 旧了：都换新再试一次。 */
  private async riskRetry<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      if (!(error instanceof SourceError) || error.code !== 'throttled') throw error
      this.mixin = undefined
      await this.refreshTicket(signal)
      // 风控常按频率：稍等一下再试。
      await sleep(1000, signal)
      return body()
    }
  }

  // MARK: WBI

  /** `nav` 的 `wbi_img` 算出的 mixin key，每天取一次（风控时也重取）。 */
  async wbiMixinKey(signal: AbortSignal): Promise<string> {
    const day = new Date().toDateString()
    if (this.mixin?.day === day) return this.mixin.key
    // 没登录时 nav 回 -101，但仍带着 key。
    const nav = await this.envelope<NavData>(await this.perform(`${API}/x/web-interface/nav`, { signal }), `${API}/x/web-interface/nav`)
    const image = nav.data?.wbi_img
    const img = wbiKey(image?.img_url)
    const sub = wbiKey(image?.sub_url)
    if (!img || !sub) throw new SourceError('upstream_changed', MESSAGES.unexpected)
    this.mixin = { key: mixinKey(img, sub), day }
    return this.mixin.key
  }

  // MARK: 设备 cookie

  /** `finger/spi` 给的 buvid3 / buvid4 / b_nut，和一张 `bili_ticket`：没有它们网页接口更常 -352。 */
  private ensureDeviceCookies(signal: AbortSignal): Promise<void> {
    const expires = Number(this.device.bili_ticket_expires ?? 0)
    if (this.devicePromise && expires > Date.now() / 1000) return this.devicePromise
    this.devicePromise = this.setUpDeviceCookies(signal).catch((error) => {
      this.devicePromise = undefined
      if (signal.aborted) throw error
    })
    return this.devicePromise
  }

  private async setUpDeviceCookies(signal: AbortSignal): Promise<void> {
    if (!this.device.buvid3) {
      try {
        const response = await this.fetch(`${API}/x/frontend/finger/spi`, { headers: { 'user-agent': USER_AGENT }, signal })
        const spi = (await response.json()) as Envelope<{ b_3: string; b_4: string }>
        if (spi.data?.b_3) {
          this.setDevice({ buvid3: spi.data.b_3, buvid4: spi.data.b_4, b_nut: String(Math.floor(Date.now() / 1000)) })
        }
      } catch (error) {
        if (signal.aborted) throw error
        this.log.warn('bilibili finger/spi failed', { error: String(error) })
      }
    }
    if (Number(this.device.bili_ticket_expires ?? 0) > Date.now() / 1000) return
    await this.refreshTicket(signal)
  }

  /** `GenWebTicket`：`ts<秒>` 的 HMAC-SHA256。 */
  private async refreshTicket(signal: AbortSignal): Promise<void> {
    const ts = String(Math.floor(Date.now() / 1000))
    const params = { key_id: 'ec02', hexsign: ticketSign(ts), 'context[ts]': ts, csrf: this.csrf ?? '' }
    try {
      const response = await this.fetch(`${API}/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?${query(params)}`, {
        method: 'POST', headers: { 'user-agent': USER_AGENT }, signal,
      })
      const ticket = (await response.json()) as Envelope<{ ticket: string; created_at: number; ttl: number }>
      if (ticket.data?.ticket) {
        this.setDevice({ bili_ticket: ticket.data.ticket, bili_ticket_expires: String(ticket.data.created_at + ticket.data.ttl) })
      }
    } catch (error) {
      if (signal.aborted) throw error
      this.log.warn('bilibili ticket failed', { error: String(error) })
      // 拿不到 ticket 也不要每个请求都重试：一小时后再说。
      this.setDevice({ bili_ticket_expires: String(Math.floor(Date.now() / 1000) + 3600) })
    }
  }

  private setDevice(values: DeviceCookies): void {
    this.device = { ...this.device, ...values }
    this.store.set(DEVICE_KEY, this.device)
  }

  // MARK: 账号

  /** 当前 cookie 背后的账号（缓存 5 分钟）。没登录抛 `login_required`。 */
  async profile(signal: AbortSignal, fresh = false): Promise<Profile> {
    if (!fresh && this.profileCache && Date.now() - this.profileCache.at < PROFILE_TTL) return this.profileCache.profile
    const nav = await this.envelope<NavData>(await this.perform(`${API}/x/web-interface/nav`, { signal }), `${API}/x/web-interface/nav`)
    if (nav.code !== 0 && nav.code !== -101) throw apiError(nav.code, nav.message)
    if (nav.data?.isLogin !== true) throw new SourceError('login_required', MESSAGES.expired)
    const profile: Profile = { name: nav.data.uname || '哔哩哔哩用户', avatarURL: image(nav.data.face) }
    const membership = navMembership(nav.data)
    if (membership) profile.membership = membership
    this.isVIP = nav.data.vipStatus === 1
    this.profileCache = { profile, at: Date.now() }
    return profile
  }

  /** 账号状态：token 快过期先续期；cookie 已失效就当作退出。 */
  async state(signal: AbortSignal): Promise<{ loggedIn: boolean; profile?: Profile }> {
    if (!this._credential) return { loggedIn: false }
    await this.refreshIfNeeded(signal)
    try {
      return { loggedIn: true, profile: await this.profile(signal) }
    } catch (error) {
      if (error instanceof SourceError && error.code === 'login_required') {
        this.log.warn('bilibili login expired, cleared')
        this.clear()
        return { loggedIn: false }
      }
      if (signal.aborted) throw error
      // 读不到账号不算退出：登录还在。
      return { loggedIn: true, profile: this.profileCache?.profile ?? { name: '哔哩哔哩用户' } }
    }
  }

  private refreshIfNeeded(signal: AbortSignal): Promise<void> {
    const token = this._credential?.token
    if (!token || token.expiresAt - Date.now() / 1000 > REFRESH_MARGIN) return Promise.resolve()
    this.refreshing ??= (async () => {
      try {
        const result = await this.appPostEnvelope<LoginResult>(`${PASSPORT}/api/v2/oauth2/refresh_token`,
          { access_key: token.accessToken, refresh_token: token.refreshToken }, signal)
        if (result.code === 0 && result.data) this.apply(credentialOf(result.data))
        else this.log.warn('bilibili token refresh refused', { code: result.code, message: result.message })
      } catch (error) {
        // 续期失败时旧 cookie 多半还能用。
        this.log.warn('bilibili token refresh failed', { error: String(error) })
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  /** TV 扫码登录（`passport-tv-login`）：用哔哩哔哩 App 扫码，轮询拿到网页 cookie 和 app token；码过期换新码。 */
  async *login(signal: AbortSignal): AsyncIterable<LoginStep> {
    for (;;) {
      const code = await this.appPostEnvelope<{ url: string; auth_code: string }>(`${PASSPORT}/x/passport-tv-login/qrcode/auth_code`, {}, signal)
      if (code.code !== 0 || !code.data) throw apiError(code.code, code.message)
      const show = (message: string): LoginStep => ({
        kind: 'showCode', content: code.data!.url, title: '哔哩哔哩扫码登录', message,
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      })
      yield show('打开哔哩哔哩 App，扫一扫登录')
      let scanned = false
      polling: for (;;) {
        await sleep(3000, signal)
        const result = await this.appPostEnvelope<LoginResult>(`${PASSPORT}/x/passport-tv-login/qrcode/poll`, { auth_code: code.data.auth_code }, signal)
        switch (result.code) {
          case 0: {
            if (!result.data) throw new SourceError('upstream_changed', MESSAGES.unexpected)
            yield { kind: 'waiting', message: '登录成功，正在获取账号信息…' }
            this.apply(credentialOf(result.data))
            yield { kind: 'completed', profile: await this.profile(signal, true) }
            return
          }
          case 86039:
            continue
          case 86090:
            if (!scanned) {
              scanned = true
              yield { kind: 'waiting', message: '已扫码，请在手机上确认登录' }
            }
            continue
          case 86038:
            // 过期：换一张新码。
            break polling
          default:
            throw apiError(result.code, result.message)
        }
      }
    }
  }

  async logout(signal: AbortSignal): Promise<void> {
    const csrf = this.csrf
    if (csrf) {
      try {
        await this.post(`${PASSPORT}/login/exit/v2`, { biliCSRF: csrf }, signal)
      } catch (error) {
        this.log.warn('bilibili logout failed', { error: String(error) })
      }
    }
    this.clear()
  }
}

export interface NavData {
  isLogin?: boolean
  mid?: number
  uname?: string
  face?: string
  vipStatus?: number
  /** 0 没有，1 月度大会员，2 年度大会员。 */
  vipType?: number
  /** 毫秒；过期后仍保留。 */
  vipDueDate?: number
  vip_label?: { text?: string }
  wbi_img?: { img_url: string; sub_url: string }
}

export function navMembership(nav: NavData): Membership | undefined {
  if (!((nav.vipType ?? 0) > 0 || (nav.vipDueDate ?? 0) > 0)) return undefined
  const membership: Membership = { tier: nav.vip_label?.text || '大会员', active: nav.vipStatus === 1 }
  if (nav.vipDueDate && nav.vipDueDate > 0) membership.endsAt = new Date(nav.vipDueDate).toISOString()
  return membership
}

/** `qrcode/poll` 和 `oauth2/refresh_token` 的返回。 */
export interface LoginResult {
  mid?: number
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_info?: { mid: number; access_token: string; refresh_token: string; expires_in: number }
  cookie_info?: { cookies: { name: string; value: string; expires?: number }[]; domains?: string[] }
}

export function credentialOf(result: LoginResult, now = Date.now()): Credential {
  const mid = result.token_info?.mid ?? result.mid ?? 0
  const access = result.token_info?.access_token ?? result.access_token
  const cookies = (result.cookie_info?.cookies ?? []).map((cookie) => ({ name: cookie.name, value: cookie.value, expires: cookie.expires }))
  const credential: Credential = { mid: String(mid || cookies.find((c) => c.name === 'DedeUserID')?.value || 0), cookies }
  if (access) {
    credential.token = {
      accessToken: access,
      refreshToken: result.token_info?.refresh_token ?? result.refresh_token ?? '',
      expiresAt: Math.floor(now / 1000) + (result.token_info?.expires_in ?? result.expires_in ?? 0),
    }
  }
  return credential
}

export function withQuery(url: string, params: Record<string, string>): string {
  const text = query(params)
  return text ? `${url}${url.includes('?') ? '&' : '?'}${text}` : url
}

function checkStatus(response: Response): void {
  if (response.status === 412) throw new SourceError('throttled', MESSAGES.riskControl)
  if (response.status === 404) throw new SourceError('not_found', '找不到这个内容')
  if (!response.ok) throw new SourceError('unavailable', `哔哩哔哩返回 ${response.status}`)
}

/** 图片地址：`//` 和 `http://` 换成 `https://`；`hdslb.com` 的图加 `@<宽>w_<高>h_1c.jpg` 由服务端缩放。 */
export function image(raw: string | undefined | null, width?: number, height?: number): string | undefined {
  if (!raw) return undefined
  let url = raw
  if (url.startsWith('//')) url = `https:${url}`
  if (url.startsWith('http://')) url = `https://${url.slice(7)}`
  if (width && height && url.includes('hdslb.com') && !url.includes('@')) url += `@${width}w_${height}h_1c.jpg`
  return url
}
