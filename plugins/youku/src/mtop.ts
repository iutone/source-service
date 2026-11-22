// H5 MTOP 网关（docs/youku-web/REPORT.md §2）：签名 md5(token&t&appKey&data)，token 是 cookie `_m_h5_tk` 第一个 `_` 前的部分；
// 第一次请求没有 token，网关种下它并报 FAIL_SYS_TOKEN，重试一次。照 App 的 MTOPClient / MTOPSigner 移植。
import { createHash } from 'node:crypto'
import { SourceError } from '@iyt-source/kit'
import type { J } from './json.ts'

export const APP_KEY = '24679788'
export const JSV = '2.6.1'
export const ACS_HOST = 'acs.youku.com'
export const UPS_HOST = 'un-acs.youku.com'
export const CCODE = '0502'
export const CLIENT_VERSION = '9.0.21'
/** KuPlayer 自己的版本，播放记录上报的 `appVersion`。 */
export const PLAYER_VERSION = '9.4.116'
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const REFERER = 'https://www.youku.com/'

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

export function mtopSign(token: string, timestamp: string, appKey: string, data: string): string {
  return md5(`${token}&${timestamp}&${appKey}&${data}`)
}

export function tokenFromCookie(value: string | undefined): string {
  if (!value) return ''
  return value.split('_')[0] ?? ''
}

/** 严格的 RFC 3986 编码：网关把 `+` 当空格，ckey 里有 `+`。 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

export function mtopURL(api: string, version: string, payload: string, token: string, timestamp: string, host = ACS_HOST, appKey = APP_KEY): string {
  const sign = mtopSign(token, timestamp, appKey, payload)
  const query: [string, string][] = [
    ['jsv', JSV], ['appKey', appKey], ['t', timestamp], ['sign', sign], ['api', api], ['v', version],
    ['timeout', '15000'], ['type', 'originaljson'], ['dataType', 'json'], ['data', payload],
  ]
  return `https://${host}/h5/${api}/${version}/?` + query.map(([k, v]) => `${k}=${percentEncode(v)}`).join('&')
}

// MARK: Cookie

export interface StoredCookie {
  name: string
  value: string
  domain: string
  path?: string
  /** Unix 秒；没有就是会话 cookie。 */
  expires?: number
}

/** 按域名区分的简单 cookie 罐（登录要经过 passport、youku、可能还有 taobao 的几跳）。 */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>()
  /** 登录相关的 cookie 变了（不算 `_m_h5_tk` 这类网关 token）：调用方据此保存。 */
  onChange?: () => void

  constructor(cookies: StoredCookie[] = []) {
    for (const cookie of cookies) this.set(cookie, false)
  }

  private static key(cookie: { name: string; domain: string }) {
    return `${cookie.domain.replace(/^\./, '').toLowerCase()}|${cookie.name}`
  }

  set(cookie: StoredCookie, notify = true): void {
    const key = CookieJar.key(cookie)
    const previous = this.cookies.get(key)
    if (cookie.expires !== undefined && cookie.expires * 1000 < Date.now()) {
      if (previous) {
        this.cookies.delete(key)
        if (notify && !CookieJar.volatile(cookie.name)) this.onChange?.()
      }
      return
    }
    this.cookies.set(key, cookie)
    if (notify && previous?.value !== cookie.value && !CookieJar.volatile(cookie.name)) this.onChange?.()
  }

  /** 网关每次都可能换的 token，不值得为它写盘。 */
  static volatile(name: string): boolean {
    return name === '_m_h5_tk' || name === '_m_h5_tk_enc' || name === 'XSRF-TOKEN'
  }

  get(name: string, domainSuffix = 'youku.com'): string | undefined {
    let found: StoredCookie | undefined
    for (const cookie of this.cookies.values()) {
      if (cookie.name !== name) continue
      const domain = cookie.domain.replace(/^\./, '')
      if (domain === domainSuffix || domain.endsWith('.' + domainSuffix)) {
        // 越具体的域越优先。
        if (!found || domain.length > found.domain.replace(/^\./, '').length) found = cookie
      }
    }
    return found?.value
  }

  all(): StoredCookie[] {
    return [...this.cookies.values()]
  }

  /** 发往 `url` 的 Cookie 头。 */
  header(url: string): string {
    const host = new URL(url).hostname.toLowerCase()
    const now = Date.now()
    const pairs = new Map<string, string>()
    // 宽的域先放，窄的域覆盖。
    const matching = [...this.cookies.values()]
      .filter((c) => {
        const domain = c.domain.replace(/^\./, '').toLowerCase()
        return (host === domain || host.endsWith('.' + domain)) && !(c.expires !== undefined && c.expires * 1000 < now)
      })
      .sort((a, b) => a.domain.replace(/^\./, '').length - b.domain.replace(/^\./, '').length)
    for (const c of matching) pairs.set(c.name, c.value)
    return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 收下响应的 Set-Cookie。 */
  absorb(url: string, response: Response): void {
    const host = new URL(url).hostname
    for (const line of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(line, host)
      if (parsed) this.set(parsed)
    }
  }

  clear(): void {
    this.cookies.clear()
  }
}

export function parseSetCookie(line: string, host: string): StoredCookie | undefined {
  const parts = line.split(';').map((p) => p.trim())
  const pair = parts.shift()
  if (!pair) return undefined
  const eq = pair.indexOf('=')
  if (eq <= 0) return undefined
  const cookie: StoredCookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host }
  for (const attribute of parts) {
    const i = attribute.indexOf('=')
    const key = (i < 0 ? attribute : attribute.slice(0, i)).toLowerCase()
    const value = i < 0 ? '' : attribute.slice(i + 1)
    if (key === 'domain' && value) cookie.domain = value.startsWith('.') ? value : '.' + value
    else if (key === 'path') cookie.path = value
    else if (key === 'max-age') cookie.expires = Math.floor(Date.now() / 1000) + Number(value)
    else if (key === 'expires' && cookie.expires === undefined) {
      const time = Date.parse(value)
      if (Number.isFinite(time)) cookie.expires = Math.floor(time / 1000)
    }
  }
  return cookie
}

// MARK: 请求

export function withTimeout(signal: AbortSignal | undefined, ms = 20_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** fetch：网络错误、超时转成 `unavailable`；调用方取消时原样抛出。 */
export async function request(url: string, init: RequestInit & { signal?: AbortSignal }, what = '优酷'): Promise<Response> {
  const caller = init.signal
  try {
    return await fetch(url, { ...init, signal: withTimeout(caller) })
  } catch (error) {
    if (caller?.aborted) throw error
    throw new SourceError('unavailable', `连不上${what}`, { cause: error, retryable: true })
  }
}

export class MTOPError extends SourceError {
  readonly ret: string
  constructor(code: ConstructorParameters<typeof SourceError>[0], message: string, ret: string) {
    super(code, message)
    this.ret = ret
  }
}

export interface MTOPOptions {
  host?: string
  appKey?: string
  signal?: AbortSignal
}

/** 带 cookie 调签名的 MTOP 接口，返回响应的 `data`。 */
export class MTOPClient {
  /** 登录态过期（FAIL_SYS_SESSION_EXPIRED）：会话据此视为退出。 */
  onSessionExpired?: () => void

  readonly jar: CookieJar

  constructor(jar: CookieJar) {
    this.jar = jar
  }

  async call(api: string, version: string, data: Record<string, unknown>, options: MTOPOptions = {}): Promise<J> {
    const payload = JSON.stringify(data)
    let response = await this.send(api, version, payload, options)
    if (response.ret.startsWith('FAIL_SYS_TOKEN')) response = await this.send(api, version, payload, options)
    const ret = response.ret
    if (ret.startsWith('SUCCESS')) return response.data
    if (ret.startsWith('FAIL_SYS_SESSION_EXPIRED')) {
      this.onSessionExpired?.()
      throw new MTOPError('login_required', '优酷登录已失效，请重新登录', ret)
    }
    // 网关的滑块验证（RGV587_ERROR），只有浏览器过得去。
    if (ret.startsWith('FAIL_SYS_USER_VALIDATE')) throw new MTOPError('throttled', '请求太频繁，优酷要求验证，请稍后再试', ret)
    if (ret.startsWith('FAIL_SYS_ILLEGAL_ACCESS') || ret.startsWith('FAIL_SYS_TRAFFIC_LIMIT')) throw new MTOPError('throttled', '优酷限流了，请稍后再试', ret)
    throw new MTOPError('upstream_changed', `优酷接口出错（${api}：${ret.slice(0, 80)}）`, ret)
  }

  private async send(api: string, version: string, payload: string, options: MTOPOptions): Promise<{ ret: string; data: J }> {
    const timestamp = String(Date.now())
    const token = tokenFromCookie(this.jar.get('_m_h5_tk'))
    const url = mtopURL(api, version, payload, token, timestamp, options.host ?? ACS_HOST, options.appKey ?? APP_KEY)
    const response = await request(url, {
      headers: { 'user-agent': USER_AGENT, referer: REFERER, accept: 'application/json', cookie: this.jar.header(url) },
      signal: options.signal,
    })
    this.jar.absorb(url, response)
    let json: J
    try {
      json = await response.json()
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new SourceError('upstream_changed', `优酷接口返回的不是 JSON（${api}，HTTP ${response.status}）`)
    }
    const ret = Array.isArray(json?.ret) ? json.ret.map(String).join(';') : ''
    return { ret, data: json?.data }
  }
}
