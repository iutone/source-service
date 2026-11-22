// 腾讯视频的登录态、设备号与请求（App 的 TencentSession）。登录后的账号（API.md §1）：`vusession` 只有 2 小时，用
// `vurefresh` 续期（`NewRefresh`），续期绑定设备 `video_guid` 和登录时的调用方 app id。凭证、设备号存在这个源的存储里。
import { randomBytes } from 'node:crypto'
import { SourceError, type KeyValueStore } from '@iyt-source/kit'
import type { Membership, Profile } from '@iyt-source/protocol'
import {
  GATEWAY, MOBILE_CALLER_APP_ID, ORIGIN, REFERER, USER_AGENT, VIP_HOST, WEB_CALLER_APP_ID,
} from './constants.ts'
import { int, isObject, num, str, text } from './json.ts'
import { Qimei } from './qimei.ts'

export interface TencentCredential {
  vuserid: string
  vusession: string
  vurefresh: string
  /** 账号体系：`wx`、`qq` 或 `phone`（cookie 的 `main_login`，续期的 `type`）。 */
  mainLogin: string
  appID?: string
  openID?: string
  /** 手机站的微信会话没有。 */
  accessToken?: string
  /** 登录绑定的设备号（换一个续期就失败）；没有时用这台服务自己的。 */
  guid?: string
  /** `3000010`（桌面站，扫码登录）或 `1000006`（手机站）：会话只能用自己的续期。 */
  callerAppID: string
  /** `vusession` 失效的时刻（毫秒）；不知道时第一次用之前先续期。 */
  sessionExpiry?: number
  nick?: string
  avatar?: string
}

/** 提前这么久续期。 */
const RENEWAL_MARGIN = 10 * 60_000
/** 续期答这些码表示登录没了（API.md §1.2）。 */
const LOGIN_GONE = new Set([1110001, 1100005])
/** 官方登录库遇到这些码会换另一个调用方 id 再试。 */
const CALLER_CODES = new Set([1110001, 1110002])
/** 会员信息多久重读一次。 */
const PROFILE_TTL = 3600_000
const TIMEOUT = 15_000

export const loginRequired = (message = '腾讯视频登录已失效，请重新登录') => new SourceError('login_required', message)
export const apiError = (code: unknown, message?: string) =>
  new SourceError('unavailable', message ? `${message}（${String(code)}）` : `腾讯视频暂时出错了，请稍后再试（${String(code)}）`)

export interface RequestOptions {
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  body?: unknown
  /** 原样发的请求体（表单）；有它就不用 `body`。 */
  rawBody?: string | Uint8Array
  contentType?: string
  headers?: Record<string, string>
  /** 省略时带登录 cookie（`loginCookies`）。 */
  cookies?: Record<string, string>
  signal?: AbortSignal
}

export function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 按键排序、表单编码的 `k=v`。 */
export function queryString(params: Record<string, string>): string {
  return Object.keys(params).sort().map((k) => `${encode(k)}=${encode(params[k]!)}`).join('&')
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.keys(cookies).sort().map((k) => `${k}=${cookies[k]}`).join('; ')
}

export function randomHex(count: number): string {
  return randomBytes(Math.ceil(count / 2)).toString('hex').slice(0, count)
}

/** 合上调用方的取消和超时。 */
export function withTimeout(signal: AbortSignal | undefined, ms = TIMEOUT): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

/** 读进来的凭证（存储里的，或测试用的 App 的 `TencentCredential` JSON）：App 的 Date 是 2001 年起的秒数，丢掉，先续期。 */
export function normalizeCredential(raw: unknown): TencentCredential | undefined {
  if (!isObject(raw)) return undefined
  const vuserid = str(raw.vuserid)
  const vusession = str(raw.vusession)
  const vurefresh = str(raw.vurefresh)
  if (!vuserid || !vurefresh) return undefined
  const expiry = num(raw.sessionExpiry)
  return {
    vuserid, vusession: vusession ?? '', vurefresh, mainLogin: str(raw.mainLogin) ?? 'wx',
    appID: str(raw.appID), openID: str(raw.openID), accessToken: str(raw.accessToken), guid: text(raw.guid),
    callerAppID: str(raw.callerAppID) ?? WEB_CALLER_APP_ID,
    sessionExpiry: expiry !== undefined && expiry > 1e12 ? expiry : undefined,
    nick: str(raw.nick), avatar: str(raw.avatar),
  }
}

export class TencentSession {
  readonly qimei: Qimei
  private readonly store: KeyValueStore
  private _credential?: TencentCredential
  /** 这台服务自己的 `video_guid`：网页端生成一次的 16 位十六进制。 */
  private readonly ownGUID: string
  private renewal?: Promise<void>
  private profileCache?: { profile: Profile; at: number }
  /** 有效会员（上次读会员信息时）。 */
  isVIP = false
  /** 历史列表最新的 `data_version`（`AddOrUpdate` 要它）。 */
  historyVersion?: string
  /** 登录没了（续期说的）时调用：源丢掉跟账号有关的缓存。 */
  onLogout?: () => void

  constructor(store: KeyValueStore) {
    this.store = store
    this.qimei = new Qimei(store)
    const saved = store.get<string>('device')
    if (typeof saved === 'string' && /^[0-9a-f]{16}$/.test(saved)) {
      this.ownGUID = saved
    } else {
      this.ownGUID = randomHex(16)
      store.set('device', this.ownGUID)
    }
    this._credential = normalizeCredential(store.get('credential'))
  }

  get credential(): TencentCredential | undefined {
    return this._credential
  }

  get loggedIn(): boolean {
    return this._credential !== undefined
  }

  /** 发出的设备号：凭证自己的（在浏览器里登录的），否则这台服务的。 */
  get guid(): string {
    return this._credential?.guid || this.ownGUID
  }

  apply(credential: TencentCredential): void {
    this._credential = credential
    this.store.set('credential', credential)
  }

  clear(): void {
    this._credential = undefined
    this.isVIP = false
    this.historyVersion = undefined
    this.profileCache = undefined
    this.renewal = undefined
    this.store.set('credential', null)
    this.onLogout?.()
  }

  // MARK: 续期

  /** 一个还能用一阵的 `vusession`：快到期（`RENEWAL_MARGIN` 内）就先续期。没登录、或续期说登录没了时抛 `login_required`。 */
  async ensureSession(signal?: AbortSignal): Promise<void> {
    const credential = this._credential
    if (!credential) throw loginRequired('需要登录腾讯视频')
    if (credential.sessionExpiry && credential.sessionExpiry - Date.now() > RENEWAL_MARGIN) return
    await this.renew(signal)
  }

  /** `NewRefresh`（API.md §1.2）：用 `vurefresh` 换新的 `vusession`，旧的到期前仍有效。并发的调用共用一次请求。 */
  renew(signal?: AbortSignal): Promise<void> {
    this.renewal ??= this.performRenewal(signal).finally(() => {
      this.renewal = undefined
    })
    return this.renewal
  }

  private async performRenewal(signal?: AbortSignal): Promise<void> {
    const original = this._credential
    if (!original) throw loginRequired('需要登录腾讯视频')
    const credential = { ...original }
    const callers = [credential.callerAppID, ...[WEB_CALLER_APP_ID, MOBILE_CALLER_APP_ID].filter((c) => c !== credential.callerAppID)]
    let lastCode = 0
    for (let index = 0; index < callers.length; index++) {
      const caller = callers[index]!
      const response = await this.gateway('trpc.video_account_login.web_login_trpc.WebLoginTrpc/NewRefresh', {
        query: { video_appid: caller, vversion_platform: '2' },
        body: { type: credential.mainLogin },
        cookies: this.renewalCookies(credential),
        signal,
      })
      const data = response?.data ?? {}
      const code = int(data.errcode) ?? int(response?.ret) ?? -1
      const session = text(data.vusession)
      if (code === 0 && session) {
        credential.vusession = session
        credential.vurefresh = text(data.vurefresh) ?? credential.vurefresh
        credential.vuserid = text(data.vuserid) ?? credential.vuserid
        if (typeof data.access_token === 'string') credential.accessToken = data.access_token
        credential.nick = text(data.nick) ?? credential.nick
        credential.avatar = text(data.head) ?? credential.avatar
        credential.callerAppID = caller
        const lifetime = num(data.next_refresh_time)
        credential.sessionExpiry = Date.now() + (lifetime && lifetime > 0 ? lifetime : 7200) * 1000
        // 不盖掉期间换上的新登录。
        if (this._credential && (this._credential.vurefresh === original.vurefresh || this._credential.vuserid === original.vuserid)) {
          this.apply(credential)
        }
        return
      }
      lastCode = code
      if (!CALLER_CODES.has(code) || index + 1 >= callers.length) break
    }
    if (LOGIN_GONE.has(lastCode)) {
      if (this._credential === original) this.clear()
      throw loginRequired()
    }
    throw apiError(lastCode, '腾讯视频登录续期失败')
  }

  /** `NewRefresh` 读的 `v_*` 一套 cookie，`vusession` 可有可无。 */
  private renewalCookies(credential: TencentCredential): Record<string, string> {
    return {
      video_guid: this.guid, v_vurefresh: credential.vurefresh, v_vuserid: credential.vuserid,
      v_vusession: credential.vusession, v_main_login: credential.mainLogin,
      v_t_appid: credential.appID ?? '', v_t_openid: credential.openID ?? '',
    }
  }

  // MARK: 账号

  /** 续期（顺便检查登录、拿到昵称），再读会员。结果缓存一小时。 */
  async profile(signal?: AbortSignal, force = false): Promise<Profile> {
    await this.ensureSession(signal)
    if (!force && this.profileCache && Date.now() - this.profileCache.at < PROFILE_TTL) return this.profileCache.profile
    const credential = this._credential
    if (!credential) throw loginRequired()
    const membership = await this.membership(signal)
    const profile: Profile = { name: credential.nick ?? '腾讯视频用户', avatarURL: imageOrUndefined(credential.avatar), membership }
    this.profileCache = { profile, at: Date.now() }
    return profile
  }

  /** 有效会员的档次（`VIP` / `SVIP`），没有时 undefined。 */
  get membershipTier(): string | undefined {
    const membership = this.profileCache?.profile.membership
    return membership?.active ? membership.tier : undefined
  }

  /** 会员状态（播放选清晰度用）：没读过就读一次。 */
  async ensureMembership(signal?: AbortSignal): Promise<void> {
    if (!this.loggedIn || this.profileCache) return
    await this.profile(signal).catch(() => undefined)
  }

  /** `GetVipUserInfoH5`（API.md §1.3）：`vip`、`endTime`，SVIP 在 `svip_info`。从没开过、或调用失败时给 undefined。 */
  private async membership(signal?: AbortSignal): Promise<Membership | undefined> {
    let info: any
    try {
      info = await this.request(`${VIP_HOST}/rpc/trpc.query_vipinfo.vipinfo.QueryVipInfo/GetVipUserInfoH5`, {
        method: 'POST', body: { geticon: 1, viptype: 'svip', platform: 3000 }, contentType: 'text/plain;charset=utf-8', signal,
      })
    } catch {
      return undefined
    }
    if (int(info?.result?.code) !== 0) return undefined
    const membership = membershipOf(info)
    this.isVIP = membership?.active === true
    return membership
  }

  // MARK: 请求

  /** 业务接口读的登录 cookie：无前缀的一套（QQ 账号是 `vqq_`）和 `v_*` 一套。 */
  get loginCookies(): Record<string, string> {
    const cookies: Record<string, string> = { video_guid: this.guid, video_platform: '2' }
    const credential = this._credential
    if (!credential) return cookies
    const prefix = credential.mainLogin === 'qq' ? 'vqq_' : ''
    cookies.main_login = credential.mainLogin
    cookies[`${prefix}vuserid`] = credential.vuserid
    cookies[`${prefix}vusession`] = credential.vusession
    cookies[`${prefix}appid`] = credential.appID ?? ''
    cookies[`${prefix}openid`] = credential.openID ?? ''
    cookies[`${prefix}access_token`] = credential.accessToken ?? ''
    cookies.v_main_login = credential.mainLogin
    cookies.v_vuserid = credential.vuserid
    cookies.v_vusession = credential.vusession
    cookies.v_vurefresh = credential.vurefresh
    cookies.v_t_appid = credential.appID ?? ''
    cookies.v_t_openid = credential.openID ?? ''
    cookies.v_t_access_token = credential.accessToken ?? ''
    return cookies
  }

  /** 播放请求的 `logintoken`（API.md §1.3），键排好序。 */
  get loginToken(): string {
    const credential = this._credential
    if (!credential) return ''
    const token: Record<string, string> = {
      access_token: credential.accessToken ?? '', appid: credential.appID ?? '', main_login: credential.mainLogin,
      openid: credential.openID ?? '', video_guid: this.guid, vuserid: credential.vuserid, vusession: credential.vusession,
    }
    return JSON.stringify(token)
  }

  /** 网关上的 tRPC 调用：`POST <gateway>/<method>?<query>`，JSON 体。 */
  gateway(method: string, options: RequestOptions = {}): Promise<any> {
    return this.request(`${GATEWAY}/${method}`, { method: 'POST', ...options })
  }

  /** 发一个请求，读回松散的 JSON。网络错误、非 2xx 抛 `unavailable`，读不懂抛 `upstream_changed`。 */
  async request(base: string, options: RequestOptions = {}): Promise<any> {
    const url = options.query && Object.keys(options.query).length ? `${base}?${queryString(options.query)}` : base
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT, referer: REFERER, origin: ORIGIN,
      cookie: cookieHeader(options.cookies ?? this.loginCookies),
    }
    let body: string | Uint8Array | undefined
    if (options.method === 'POST') {
      headers['content-type'] = options.contentType ?? 'application/json'
      body = options.rawBody ?? JSON.stringify(options.body ?? {})
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value
    let response: Response
    try {
      response = await fetch(url, { method: options.method ?? 'GET', headers, body: body as BodyInit | undefined, signal: withTimeout(options.signal) })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new SourceError('unavailable', '连不上腾讯视频', { cause: error })
    }
    const path = new URL(url).pathname
    if (!response.ok) throw new SourceError('unavailable', `腾讯视频返回 HTTP ${response.status}（${path}）`)
    const raw = await response.text()
    if (!raw) throw new SourceError('upstream_changed', `腾讯视频返回了空内容（${path}）`)
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new SourceError('upstream_changed', `读不懂腾讯视频的返回（${path}）`, { cause: error })
    }
  }
}

function imageOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://')
}

/** `2026-01-01 00:00:00`（北京时间）→ 毫秒。 */
function vipDate(value: unknown): number | undefined {
  const s = text(value)
  const match = s && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s)
  if (!match) return undefined
  const [, y, mo, d, h, mi, se] = match.map(Number) as number[]
  return Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, se!)
}

/** SVIP 有效时取它（或最晚到期的），否则 VIP；两者都从没开过时 undefined。 */
export function membershipOf(info: any, now = Date.now()): Membership | undefined {
  const tier = (json: any, title: string) => {
    const end = vipDate(json?.endTime)
    if (int(json?.vip) !== 1 && end === undefined) return undefined
    const active = int(json?.vip) === 1 && (end === undefined || end > now)
    return { tier: title, active, endsAt: end === undefined ? undefined : new Date(end).toISOString(), end: end ?? 0 }
  }
  const svip = tier(info?.svip_info, 'SVIP')
  const vip = tier(info, 'VIP')
  const pick = svip?.active ? svip : vip?.active ? vip : [svip, vip].filter((t) => t !== undefined).sort((a, b) => b!.end - a!.end)[0]
  if (!pick) return undefined
  return { tier: pick.tier, active: pick.active, endsAt: pick.endsAt }
}
