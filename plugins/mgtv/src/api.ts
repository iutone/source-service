// 芒果TV 网页端（pcweb）接口的公共部分：常量、宽松的 JSON 读取、编码、搜索签名、会话（设备 id、登录凭证、请求）。
// 照 App 的 `App/Core/Mgtv`（MgtvConstants / MGJSON / MgtvSession / MgtvSigner）移植；接口调研见 docs/mgtv-web/API.md。
import { createHash, randomUUID } from 'node:crypto'
import type { Profile } from '@iyt-source/protocol'
import { SourceError, type KeyValueStore } from '@iyt-source/kit'

/** Safari：取流接口按 Safari 的能力回答它（和 AVPlayer）能播的格式。 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
export const REFERER = 'https://www.mgtv.com/'
export const ORIGIN = 'https://www.mgtv.com'
export const APP_VERSION = '9.0.9'
/** 几乎每个请求都带；不带时部分接口退化。 */
export const SUPPORT = '10000000'

export const HOST = {
  account: 'https://nuc.api.mgtv.com',
  channel: 'https://dc.bz.mgtv.com',
  library: 'https://pianku.api.mgtv.com',
  vod: 'https://mobile-thor.api.mgtv.com',
  mobile: 'https://mobile.api.mgtv.com',
  recommend: 'https://vod-box.bz.mgtv.com',
  pcweb: 'https://pcweb.api.mgtv.com',
  search: 'https://mobileso.bz.mgtv.com',
  history: 'https://playhistory.bz.mgtv.com',
  danmaku: 'https://galaxy.bz.mgtv.com',
  comment: 'https://comment.mgtv.com/v4/comment',
} as const

const TIMEOUT = 15_000

// MARK: 宽松的 JSON：网页接口的数字常是字符串，反之亦然。

/** 非空字符串（数字转成字符串）。 */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function int(value: unknown): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.trunc(n)
}

/** id：数字或字符串；`0` 和空串算没有。 */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? String(Math.trunc(value)) : undefined
  if (typeof value === 'string') return value !== '' && value !== '0' ? value : undefined
  return undefined
}

export function list(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

/** 图片地址：常是 `http://` 或省略协议的，统一成 https。 */
export function image(value: unknown): string | undefined {
  let url = text(value)
  if (!url) return undefined
  if (url.startsWith('//')) url = `https:${url}`
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`
  return /^https:\/\//.test(url) ? url : undefined
}

// MARK: id（与 App 的 MgtvID 一致）：`v<videoId>` 一个视频，`c<clipId>` 一个节目。

export type MgtvID = { kind: 'video'; id: string } | { kind: 'clip'; id: string }

export function parseID(raw: string): MgtvID | undefined {
  const match = /^([vc])(\d+)$/.exec(raw)
  if (!match) return undefined
  return { kind: match[1] === 'v' ? 'video' : 'clip', id: match[2] }
}

export const videoID = (id: string) => `v${id}`
export const clipID = (id: string) => `c${id}`

/** 播放页地址里的节目和视频：`/b/<clipId>/<videoId>.html`、`/b/<clipId>.html`、`/h/<clipId>.html`。 */
export function pageIDs(url: unknown): { clip: string; video?: string } | undefined {
  const value = text(url)
  if (!value) return undefined
  const match = /\/(?:b|h)\/(\d+)(?:\/(\d+))?(?:\.html|\/)?/.exec(value)
  if (!match) return undefined
  return { clip: match[1], video: match[2] }
}

// MARK: 编码与签名

/** 表单编码（只留 RFC 3986 的非保留字符），按 key 排序的 `k=v&…`。 */
export function query(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${encode(key)}=${encode(params[key])}`).join('&')
}

export function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export const SEARCH_SALT = 'xHAa3YZflWLogZUOzl'

export const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex')

/**
 * 搜索的签名（`mobileso.bz.mgtv.com/pc/search/v2`，API.md §6）：去掉空值，按 key 排序，key / value 用 encodeURI 编码，
 * `k=v&…`；MD5(盐 + 它 + 盐)。返回带 `&signature=` 的完整 query。
 */
export function signedQuery(params: Record<string, string>): string {
  const canonical = Object.keys(params)
    .filter((key) => params[key].trim() !== '')
    .sort()
    .map((key) => `${encodeURI(key)}=${encodeURI(params[key])}`)
    .join('&')
  return `${canonical}&signature=${md5(SEARCH_SALT + canonical + SEARCH_SALT)}`
}

/** ISO 8601 UTC，到秒（搜索的 `timestamp`）。 */
export function timestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// MARK: 错误

export const SIGNED_OUT = '账号已在其他设备登录，当前设备已下线，请重新登录'
export const EXPIRED = '芒果TV登录已失效，请重新登录'

/** 接口失败的 `code`：101 过期、2001 历史接口的 token 无效、620 被更多设备的登录挤下线 → 需要重新登录。 */
export function isSignedOutCode(code: number | undefined): boolean {
  return code === 101 || code === 2001 || code === 620
}

export function apiError(json: any, fallback: string): SourceError {
  const code = int(json?.code)
  if (code === 101 || code === 2001) return new SourceError('login_required', EXPIRED)
  if (code === 620) return new SourceError('login_required', text(json?.msg) ?? SIGNED_OUT)
  const message = text(json?.msg)
  return new SourceError('unavailable', message ? `${message}（${json?.code ?? '?'}）` : fallback, { retryable: false })
}

// MARK: 会话

/** 扫码登录得到的凭证：`ticket`（60 天，不续期）和账号的 `uuid`。 */
export interface Credential {
  ticket: string
  uuid: string
}

/** 资料缓存多久：manifest 每次都问账号状态，不必每次都去芒果TV。 */
const PROFILE_TTL = 10 * 60_000

/** 一个源的芒果TV会话：设备 id（`__STKUUID`）、凭证（存在 `ctx.store`）、请求。 */
export class MgtvSession {
  readonly deviceID: string
  private readonly store: KeyValueStore
  private credentialValue: Credential | undefined
  private cachedProfile: { profile: Profile; at: number } | undefined
  /** 最近一次读到的有效会员；取流响应的 `user.isvip` 更可靠。 */
  isVIP = false

  constructor(store: KeyValueStore) {
    this.store = store
    let device = store.get<string>('device')
    if (typeof device !== 'string' || device.length !== 36) {
      device = randomUUID().toLowerCase()
      store.set('device', device)
    }
    this.deviceID = device
    const saved = store.get<Credential>('credential')
    this.credentialValue = saved?.ticket && saved.uuid ? saved : undefined
  }

  get credential(): Credential | undefined {
    return this.credentialValue
  }

  get ticket(): string | undefined {
    return this.credentialValue?.ticket
  }

  get uuid(): string | undefined {
    return this.credentialValue?.uuid
  }

  apply(credential: Credential): void {
    this.credentialValue = credential
    this.cachedProfile = undefined
    this.store.set('credential', credential)
  }

  clear(): void {
    this.credentialValue = undefined
    this.cachedProfile = undefined
    this.isVIP = false
    this.store.set('credential', null)
  }

  requireLogin(): Credential {
    if (!this.credentialValue) throw new SourceError('login_required', '需要登录芒果TV')
    return this.credentialValue
  }

  /** 接口说凭证失效了（101 / 2001 / 620）：丢掉它，再抛给 App 去登录。 */
  fail(json: any, fallback: string): SourceError {
    const error = apiError(json, fallback)
    if (error.code === 'login_required' && this.credentialValue) this.clear()
    return error
  }

  /**
   * 网页接口读的 cookie：`HDCN`（ticket；取流和历史心跳只认 cookie 里的）、`uuid` 和设备 id。
   */
  cookie(): string {
    const cookies: Record<string, string> = { __STKUUID: this.deviceID }
    if (this.credentialValue) {
      cookies.HDCN = this.credentialValue.ticket
      cookies.uuid = this.credentialValue.uuid
    }
    return Object.keys(cookies).sort().map((key) => `${key}=${cookies[key]}`).join('; ')
  }

  /** 多数接口要的身份参数。 */
  common(): Record<string, string> {
    return {
      allowedRC: '1', _support: SUPPORT, did: this.deviceID, device: 'pc', osType: 'mac', osVersion: '10_15',
      appVersion: APP_VERSION, platform: '4', src: 'mgtv', uuid: this.uuid ?? '', ticket: this.ticket ?? '',
    }
  }

  /** GET，返回 JSON。`params` 是对象时按 key 排序编码；是字符串时原样当 query（签名的请求）。 */
  async get(base: string, params: Record<string, string> | string, signal?: AbortSignal): Promise<any> {
    const search = typeof params === 'string' ? params : query(params)
    return this.json(search ? `${base}?${search}` : base, { method: 'GET' }, signal)
  }

  /** 表单 POST。 */
  async post(base: string, search: Record<string, string>, form: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const qs = query(search)
    return this.json(qs ? `${base}?${qs}` : base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: query(form),
    }, signal)
  }

  /** 原样的响应文本（调度接口）。 */
  async text(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.send(url, { method: 'GET' }, signal)
    const body = await response.text()
    if (!response.ok) throw this.httpError(response.status, body)
    return body
  }

  private async json(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
    const response = await this.send(url, init, signal)
    const body = await response.text()
    if (!response.ok) throw this.httpError(response.status, body)
    // 参数不对时有时回空体。
    if (body.trim() === '') throw new SourceError('upstream_changed', '芒果TV返回了空内容，请稍后重试')
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new SourceError('upstream_changed', '芒果TV返回了读不懂的内容', { cause: error })
    }
  }

  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT)
    try {
      return await fetch(url, {
        ...init,
        headers: {
          'user-agent': USER_AGENT, referer: REFERER, origin: ORIGIN, cookie: this.cookie(),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new SourceError('unavailable', '连不上芒果TV，请稍后重试', { cause: error, retryable: true })
    }
  }

  /** 非 2xx：响应体里有 `code` + `msg` 时用接口自己的话（HTTP 401 + 40005 地区限制），否则按状态。 */
  private httpError(status: number, body: string): SourceError {
    try {
      const json = JSON.parse(body)
      if (int(json?.code) !== undefined && text(json?.msg)) {
        const code = int(json.code)
        if (code === 40005) return new SourceError('restricted', text(json.msg)!)
        return this.fail(json, `芒果TV返回 ${status}`)
      }
    } catch {
      // 不是 JSON。
    }
    if (status === 429) return new SourceError('throttled', '芒果TV请求太频繁，请稍后再试')
    return new SourceError('unavailable', `芒果TV返回 ${status}`, { retryable: status >= 500 })
  }

  // MARK: 账号

  /** 缓存的资料（未过期时）。 */
  get profile(): Profile | undefined {
    const cached = this.cachedProfile
    return cached && Date.now() - cached.at < PROFILE_TTL ? cached.profile : undefined
  }

  /** 过期也给：读不到账号时用。 */
  get staleProfile(): Profile | undefined {
    return this.cachedProfile?.profile
  }

  /** 凭证对应的账号和会员（`GetUserInfo`）。凭证失效时清掉并抛 `login_required`。 */
  async refreshProfile(signal?: AbortSignal): Promise<Profile> {
    const ticket = this.requireLogin().ticket
    const info = await this.get(`${HOST.account}/GetUserInfo`, { invoker: 'pcweb', ticket, _support: SUPPORT }, signal)
    if (int(info?.code) !== 200) throw this.fail(info, '读不到芒果TV账号信息')
    const user = info.data ?? {}
    this.isVIP = isVIP(user)
    const profile: Profile = {
      name: text(user.nickname) ?? '芒果TV用户',
      avatarURL: avatar(user.avatar),
      membership: membership(user),
    }
    if (!profile.avatarURL) delete profile.avatarURL
    if (!profile.membership) delete profile.membership
    this.cachedProfile = { profile, at: Date.now() }
    return profile
  }
}

/** `yyyy-MM-dd HH:mm:ss`（北京时间）→ 毫秒。 */
export function shanghaiTime(value: unknown): number | undefined {
  const raw = text(value)
  const match = raw && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw)
  if (!match) return undefined
  const time = Date.parse(`${match[1]}T${match[2]}+08:00`)
  return Number.isNaN(time) ? undefined : time
}

/** 有效会员：`vipinfo.isvip` 过期后仍是 1，以到期时间为准。 */
export function isVIP(user: any, now = Date.now()): boolean {
  const info = user?.vipinfo ?? {}
  if (int(info.isvip) !== 1 && int(user?.isvip) !== 1) return false
  const end = shanghaiTime(info.vip_end_time)
  if (end !== undefined) return end > now
  const seconds = num(user?.vipExpiretime)
  if (seconds !== undefined && seconds > 0) return seconds * 1000 > now
  return false
}

/** 会员：到期时间取 `vipinfo.vip_end_time`（否则 `vipExpiretime`）；不是会员时没有。 */
export function membership(user: any, now = Date.now()): Profile['membership'] {
  const info = user?.vipinfo ?? {}
  const seconds = num(user?.vipExpiretime)
  const end = shanghaiTime(info.vip_end_time) ?? (seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined)
  const flagged = int(info.isvip) === 1 || int(user?.isvip) === 1 || int(user?.isVip) === 1
  if (!flagged && end === undefined) return undefined
  const result: NonNullable<Profile['membership']> = { tier: '会员', active: isVIP(user, now) }
  if (end !== undefined) result.endsAt = new Date(end).toISOString()
  return result
}

/** 头像：普通地址，或各尺寸的 JSON 串（`s` / `m` / `l` / `xl`）。 */
export function avatar(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  if (raw.startsWith('{')) {
    try {
      const sizes = JSON.parse(raw)
      return image(sizes.l ?? sizes.m ?? sizes.xl)
    } catch {
      return undefined
    }
  }
  return image(raw)
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort)
    resolve()
  }, ms)
  const abort = () => {
    clearTimeout(timer)
    reject(signal!.reason)
  }
  signal?.addEventListener('abort', abort, { once: true })
})
