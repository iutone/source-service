// 爱奇艺的账号、设备 id 与请求（照 App 的 IQiyiSession / IQiyiAccountService）：登录凭证是网页登录的 cookie
// （`P00001` authcookie、`P00003` uid …），存这个源的 ctx.store；设备 id `QC005` 首次生成后也存下来。
import { randomUUID } from 'node:crypto'
import type { LoginStep, Membership, Profile } from '@iyt-source/protocol'
import { SourceError, type Ctx, type KeyValueStore } from '@iyt-source/kit'
import { APP_VERSION, idOf, image, LOGIN_PTID, MESH, parseJSON, PASSPORT, query, REFERER, sleep, str, text, tvgSign, USER_AGENT } from './util.ts'

export interface Credential {
  cookies: Record<string, string>
}

const CREDENTIAL_KEY = 'credential'
const DEVICE_KEY = 'device'
/** 账号信息（昵称、会员）缓存这么久再问一次：manifest 每次都读账号状态。 */
const PROFILE_TTL = 10 * 60_000
const POLL_INTERVAL = 2_000
/** 没扫的码每 2 分钟换一个（服务端 300 秒过期），免得手机扫到快过期的码；扫了的码留到过期。 */
const REFRESH_INTERVAL = 120_000
const TIMEOUT = 15_000

export const notLoggedIn = () => new SourceError('login_required', '爱奇艺登录已失效，请重新扫码登录')

/** 一次 API 返回的非成功 code。 */
export function apiError(code: unknown, message: unknown, fallback = '爱奇艺暂时出错了，请稍后再试'): SourceError {
  const c = str(code) ?? '?'
  if (c === 'A00111') return new SourceError('restricted', '爱奇艺只在中国大陆提供这个内容（服务的出口不在大陆）')
  const m = text(message)
  return new SourceError('upstream_changed', m ? `${m}（${c}）` : `${fallback}（${c}）`)
}

export class IQiyiSession {
  private readonly store: KeyValueStore
  private credential?: Credential
  private cached?: { profile: Profile; vipType: string; at: number }
  private readonly ownDeviceID: string

  constructor(store: KeyValueStore) {
    this.store = store
    const saved = store.get<string>(DEVICE_KEY)
    if (typeof saved === 'string' && /^[0-9a-f]{32}$/.test(saved)) {
      this.ownDeviceID = saved
    } else {
      this.ownDeviceID = randomUUID().replaceAll('-', '')
      store.set(DEVICE_KEY, this.ownDeviceID)
    }
    const credential = store.get<Credential>(CREDENTIAL_KEY)
    if (credential?.cookies?.P00001) this.credential = credential
  }

  get loggedIn(): boolean {
    return Boolean(this.authCookie)
  }

  get authCookie(): string | undefined {
    return this.credential?.cookies.P00001 || undefined
  }

  get uid(): string | undefined {
    return this.credential?.cookies.P00003 || undefined
  }

  /** 发出去的设备 id：登录凭证自带的（别处浏览器的登录带着它的 `QC005`），否则这台服务自己的。 */
  get deviceID(): string {
    return this.credential?.cookies.QC005 || this.ownDeviceID
  }

  /** 会员类型（`1` 黄金 …），非会员 `0`；播放请求作 `ut` 发出。 */
  get vipType(): string {
    return this.cached?.vipType ?? '0'
  }

  get isVIP(): boolean {
    return this.vipType !== '0'
  }

  get profile(): Profile | undefined {
    return this.cached?.profile
  }

  apply(credential: Credential): void {
    this.credential = credential
    this.cached = undefined
    this.store.set(CREDENTIAL_KEY, credential)
  }

  clear(): void {
    this.credential = undefined
    this.cached = undefined
    this.store.delete(CREDENTIAL_KEY)
  }

  requireLogin(): void {
    if (!this.loggedIn) throw new SourceError('login_required', '需要登录爱奇艺')
  }

  // MARK: 请求

  private cookieHeader(): string {
    const cookies: Record<string, string> = { ...(this.credential?.cookies ?? {}), QC005: this.deviceID }
    return Object.keys(cookies).sort().map((key) => `${key}=${cookies[key]}`).join('; ')
  }

  /** 原始请求：带网页的头和 cookie。连不上转成 `unavailable`。 */
  async fetch(url: string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('user-agent', USER_AGENT)
    headers.set('referer', REFERER)
    headers.set('origin', 'https://www.iqiyi.com')
    headers.set('cookie', this.cookieHeader())
    const timeout = AbortSignal.timeout(TIMEOUT)
    try {
      return await fetch(url, { ...init, headers, redirect: 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new SourceError('unavailable', '连不上爱奇艺，请稍后再试', { cause: error, retryable: true })
    }
  }

  /** GET，返回 JSON。`params` 是对象时按 key 排序；字符串时原样（签名对原文算）。 */
  async json(base: string, params: Record<string, string> | string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<any> {
    const q = typeof params === 'string' ? params : query(params)
    const response = await this.fetch(q ? `${base}?${q}` : base, signal, init)
    if (!response.ok) {
      throw new SourceError('unavailable', `爱奇艺返回 HTTP ${response.status}，请稍后再试`, { retryable: true })
    }
    const body = await response.text()
    try {
      return parseJSON(body)
    } catch (error) {
      throw new SourceError('upstream_changed', '爱奇艺的返回读不懂', { cause: error })
    }
  }

  /** `mesh.if.iqiyi.com/tvg` 的签名 GET（`timestamp` + `sign`）。`seconds`：时间戳用秒（网页有的接口这样发）。 */
  tvgJSON(base: string, params: Record<string, string>, signal: AbortSignal | undefined, seconds = false): Promise<any> {
    const signed: Record<string, string> = { ...params, timestamp: String(seconds ? Math.floor(Date.now() / 1000) : Date.now()) }
    signed.sign = tvgSign(signed)
    return this.json(base, signed, signal)
  }

  postJSON(base: string, params: Record<string, string>, body: string, signal: AbortSignal | undefined): Promise<any> {
    return this.json(base, params, signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  }

  /** 门户接口（mesh portal）共用的身份参数。 */
  portalParams(): Record<string, string> {
    return {
      uid: this.uid ?? '0', vip: this.isVIP ? '1' : '0', auth: this.authCookie ?? '', device: this.deviceID,
      v: APP_VERSION, pcv: APP_VERSION,
    }
  }

  /** 观看历史的第一页（详情的继续播放、剧的默认集都从它找；一部剧只留最新一集）。未登录或失败时 undefined。 */
  async historyRecords(signal: AbortSignal | undefined, pageSize = 50): Promise<any[] | undefined> {
    if (!this.loggedIn) return undefined
    try {
      const response = await this.tvgJSON(`${MESH}/tvg/my/lw/v2/play_history`, {
        app_version: APP_VERSION, device_id: this.deviceID, only_long: '0', page_num: '1', page_size: String(pageSize), src: 'pcw',
      }, signal)
      return Array.isArray(response?.data?.records) ? response.data.records : undefined
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }

  // MARK: 账号

  /** 服务端持有的账号（缓存 10 分钟）。凭证失效时清掉并返回 undefined；网络问题不算退出，返回上次的。 */
  async state(signal: AbortSignal | undefined): Promise<Profile | undefined> {
    if (!this.loggedIn) return undefined
    if (this.cached && Date.now() - this.cached.at < PROFILE_TTL) return this.cached.profile
    try {
      return await this.refreshProfile(signal)
    } catch (error) {
      if (error instanceof SourceError && error.code === 'login_required') return undefined
      return this.cached?.profile ?? { name: '爱奇艺用户' }
    }
  }

  /** 读昵称和会员；`P0…` 表示 authcookie 失效：清掉凭证，抛 login_required。 */
  async refreshProfile(signal: AbortSignal | undefined): Promise<Profile> {
    const auth = this.authCookie
    if (!auth) throw notLoggedIn()
    const info = await this.json(`${PASSPORT}/apis/user/info.action`, { authcookie: auth, fields: 'userinfo,qiyi_vip', agenttype: '1' }, signal)
    const code = str(info?.code)
    if (code !== 'A00000') {
      if (code?.startsWith('P0')) {
        this.clear()
        throw notLoggedIn()
      }
      throw apiError(code, info?.msg)
    }
    const user = info.data?.userinfo ?? {}
    const vip = info.data?.qiyi_vip_info ?? {}
    // status 1：有效；其他（过期）按普通账号播放。
    const vipType = str(vip.status) === '1' ? (str(vip.vipType) ?? '1') : '0'
    const profile: Profile = {
      name: text(user.nickname) ?? text(user.user_name) ?? '爱奇艺用户',
      avatarURL: image(user.icon),
      membership: membership(vip),
    }
    this.cached = { profile, vipType, at: Date.now() }
    return profile
  }

  /**
   * 凭证可能失效时确认一下（读账号）：确实失效就抛 login_required，否则抛 `fallback`。
   * 用于历史等需要登录、但失败时分不清原因的接口。
   */
  async explain(fallback: SourceError, signal: AbortSignal | undefined): Promise<never> {
    if (!this.loggedIn) throw notLoggedIn()
    this.cached = undefined
    await this.refreshProfile(signal)
    throw fallback
  }

  // MARK: 扫码登录（网页登录框的「扫码登录」，docs/iqiyi-web/API.md §2）

  private loginParams(): Record<string, string> {
    return { agenttype: '1', app_version: APP_VERSION, device_id: this.deviceID, fromSDK: '1', ptid: LOGIN_PTID, sdk_version: '1.0.0' }
  }

  async *login(ctx: Ctx): AsyncIterable<LoginStep> {
    const signal = ctx.signal
    let isRefresh = false
    for (;;) {
      let generated: any
      try {
        generated = await this.json(`${PASSPORT}/apis/qrcode/gen_login_token.action`, { ...this.loginParams(), device_name: 'pcw', surl: '1' }, signal)
      } catch (error) {
        // 只有第一个码失败才结束登录；换码时失败就过一会儿再试。
        if (!isRefresh || signal.aborted) throw error
        yield { kind: 'waiting', message: '正在刷新二维码…' }
        await sleep(5_000, signal)
        continue
      }
      isRefresh = true
      const token = text(generated?.data?.token)
      if (str(generated?.code) !== 'A00000' || !token) throw apiError(generated?.code, generated?.msg, '取不到登录二维码')
      const content = text(generated.data.url) ?? `${PASSPORT}/apis/qrcode/token_login.action?token=${token}`
      const generatedAt = Date.now()
      const expiry = generatedAt + ((Number(generated.data.expire) || 300) - 5) * 1000
      const showCode = (message: string): LoginStep => ({
        kind: 'showCode', content, title: '爱奇艺扫码登录', message, expiresAt: new Date(expiry).toISOString(),
      })
      yield showCode('打开爱奇艺 App，扫一扫登录')
      let scanned = false
      polling: while (Date.now() < (scanned ? expiry : Math.min(expiry, generatedAt + REFRESH_INTERVAL))) {
        await sleep(POLL_INTERVAL, signal)
        let response: Response
        let result: any
        try {
          response = await this.fetch(`${PASSPORT}/apis/qrcode/is_token_login.action?${query({ ...this.loginParams(), token, qyid: this.deviceID })}`, signal)
          result = parseJSON(await response.text())
        } catch (error) {
          // 一次轮询断了（网络切换）只跳过这一次，码还在屏幕上。
          if (signal.aborted) throw error
          continue
        }
        const code = str(result?.code)
        if (code === 'A00000') {
          yield { kind: 'waiting', message: '登录成功，正在获取账号信息…' }
          this.apply(credentialFrom(response.headers.getSetCookie(), result))
          yield { kind: 'completed', profile: await this.refreshProfile(signal) }
          return
        }
        if (code === 'A00001') continue
        if (code === 'P01006') {
          if (!scanned) yield { kind: 'waiting', message: '已扫码，请在手机上确认登录' }
          scanned = true
          continue
        }
        // P00501 / P01007 过期，或别的码错误：换一个码重来。
        if (code?.startsWith('P0')) break polling
        throw apiError(code, result?.msg, '登录失败')
      }
    }
  }
}

/** 登录 cookie：先取 `Set-Cookie` 里的 `P0…`，没有再从响应体的 `authcookie` / `userinfo` 取。 */
export function credentialFrom(setCookies: string[], result: any): Credential {
  const cookies: Record<string, string> = {}
  for (const line of setCookies) {
    const pair = line.split(';', 1)[0]
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (name.startsWith('P0') && value && value !== 'deleted') cookies[name] = value
  }
  const data = result?.data ?? {}
  cookies.P00001 ??= text(data.authcookie) ?? text(data.P00001) ?? ''
  cookies.P00003 ??= idOf(data.userinfo?.uid) ?? idOf(data.uid) ?? text(data.P00003) ?? ''
  if (!cookies.P00001) throw new SourceError('upstream_changed', '登录失败，请重试')
  if (!cookies.P00003) delete cookies.P00003
  return { cookies }
}

/** `qiyi_vip_info`：`status` 1 有效，`deadline` `{date, t}` 过期后也留着；非会员 undefined。 */
export function membership(vip: any): Membership | undefined {
  const deadline = vip?.deadline ?? {}
  let end: Date | undefined
  const t = Number(deadline.t)
  if (Number.isFinite(t) && t > 0) end = new Date(t > 1e11 ? t : t * 1000)
  else if (typeof deadline.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadline.date)) {
    // 只有日期：当天有效（北京时间）。
    end = new Date(`${deadline.date}T23:59:59+08:00`)
  }
  const active = str(vip?.status) === '1'
  if (!active && !end) return undefined
  return {
    // `name` 有时是用户昵称（实测 2026-11：过期会员返回的就是昵称），像会员名的才用它。
    tier: text(vip?.vipTypeName) ?? (/会员|VIP|vip|星钻|钻石|黄金|白金/.test(text(vip?.name) ?? '') ? text(vip?.name) : undefined) ?? '会员',
    active: active && (!end || end.getTime() > Date.now()),
    endsAt: end?.toISOString(),
  }
}
