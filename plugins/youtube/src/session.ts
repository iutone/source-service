// YouTube 的登录与 InnerTube 请求，照 App 的 Core/YouTube（YouTubeSession / YouTubeAccountService）在服务端重写：
// TV 版的设备码登录、access token 续期、以 TV 身份请求 youtubei/v1、读 TV 页（OAuth client、播放器 JS）、
// 观看记录的上报地址。身份与 OAuth client 取自 App 的规则包（web/apps/youtube/public/clients.json）。
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CookieInput, LoginStep, Profile } from '@iyt-source/protocol'
import { SourceError, type Ctx, type KeyValueStore } from '@iyt-source/kit'
import * as adapter from '../rules/adapter.ts'

export const HOST = 'https://www.youtube.com'

export interface Client {
  name: string
  version: string
  nameID: number
  userAgent: string
  referer?: string
  acceptsAuthorization: boolean
  context?: Record<string, string>
}

export interface Clients {
  tvPage: string
  pageClient: string
  accountClient: string
  playerClients: string[]
  oauth: { clientID: string; clientSecret: string; scope: string; deviceModel: string }
  clients: Record<string, Client>
}

export interface Credential {
  accessToken: string
  refreshToken: string
  /** ms since epoch. */
  expiresAt: number
  clientID: string
  clientSecret: string
}

export interface SessionOptions {
  /** clients.json 的路径；默认 App 规则包里的那份。 */
  clientsPath?: string
  /** InnerTube 的 `hl`；默认 zh-CN。 */
  language?: string
  /** `acceptRegion`；默认不发。 */
  region?: string
}

const REFRESH_MARGIN = 300_000
const TV_PAGE_LIFETIME = 6 * 3600_000

/** YouTube 账号与请求。每个源一个（账号存在这个源的存储里，全家共用）。 */
export class YouTubeSession {
  readonly clients: Clients
  private readonly store: KeyValueStore
  private readonly language: string
  private readonly region?: string
  private credential?: Credential
  private refreshing?: Promise<Credential>
  private visitorData?: string
  private tvPageCache?: { at: number; page: Promise<{ playerURL: string; clientID?: string; clientSecret?: string }> }
  private signatureCache?: { playerURL: string; value: Promise<number> }
  profile?: Profile
  readonly deviceID: string

  constructor(store: KeyValueStore, options: SessionOptions = {}) {
    const path = options.clientsPath ?? new URL('../rules/clients.json', import.meta.url).pathname
    this.clients = JSON.parse(readFileSync(path, 'utf8')) as Clients
    this.store = store
    this.language = options.language ?? 'zh-CN'
    this.region = options.region
    this.credential = store.get<Credential>('credential') ?? undefined
    let device = store.get<string>('device')
    if (!device) {
      device = randomUUID()
      store.set('device', device)
    }
    this.deviceID = device
  }

  get loggedIn(): boolean {
    return Boolean(this.credential)
  }

  client(key: string): Client {
    const client = this.clients.clients[key]
    if (!client) throw new SourceError('upstream_changed', `规则里没有身份 ${key}`)
    return client
  }

  apply(credential: Credential): void {
    this.credential = credential
    this.store.set('credential', credential)
  }

  clear(): void {
    this.credential = undefined
    this.profile = undefined
    this.refreshing = undefined
    this.store.set('credential', null)
    this.clearCookies()
  }

  // MARK: 网页登录的 cookie（只给 yt-dlp 取要账号的视频用）

  /** yt-dlp 的 `--cookies` 文件；没有网页登录时 undefined。 */
  get cookiesFile(): string | undefined {
    const path = join(this.store.directory, 'cookies.txt')
    return existsSync(path) ? path : undefined
  }

  /**
   * 收下 App 网页登录得到的 cookie，写成 Netscape 格式（yt-dlp 读的）。要有 YouTube 的登录 cookie。
   * 只在匿名取流说要登录时才用它重试，平时不带：频繁以账号取流容易被风控。
   */
  saveCookies(cookies: CookieInput[]): void {
    const youtube = cookies.filter((cookie) => /(^|\.)(youtube|google)\.com$/.test(cookie.domain.replace(/^\./, '')))
    const names = new Set(youtube.map((cookie) => cookie.name))
    if (!['SAPISID', '__Secure-3PAPISID', '__Secure-3PSID', 'SID'].some((name) => names.has(name))) {
      throw new SourceError('bad_request', '没有 YouTube 的登录 cookie，请登录完成后再提交')
    }
    const lines = ['# Netscape HTTP Cookie File', '# 由 iyt-source-youtube 写入，yt-dlp 取需要账号的视频时用']
    for (const cookie of youtube) {
      const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`
      const expires = cookie.expires ? Math.floor(Date.parse(cookie.expires) / 1000) : 0
      lines.push([domain, 'TRUE', cookie.path ?? '/', cookie.secure === false ? 'FALSE' : 'TRUE', String(expires || 0), cookie.name, cookie.value].join('\t'))
    }
    writeFileSync(join(this.store.directory, 'cookies.txt'), `${lines.join('\n')}\n`, { mode: 0o600 })
  }

  clearCookies(): void {
    rmSync(join(this.store.directory, 'cookies.txt'), { force: true })
  }

  // MARK: access token

  async accessToken(force = false, signal?: AbortSignal): Promise<string> {
    const credential = this.credential
    if (!credential) throw new SourceError('login_required', '需要登录 YouTube')
    if (!force && credential.expiresAt - Date.now() > REFRESH_MARGIN) return credential.accessToken
    this.refreshing ??= this.refresh(credential, signal).finally(() => {
      this.refreshing = undefined
    })
    return (await this.refreshing).accessToken
  }

  private async refresh(credential: Credential, signal?: AbortSignal): Promise<Credential> {
    const answer = await this.oauth('token', {
      client_id: credential.clientID,
      client_secret: credential.clientSecret,
      refresh_token: credential.refreshToken,
      grant_type: 'refresh_token',
    }, signal)
    if (typeof answer.error === 'string') {
      // 用户在账号里移除了设备，或 token 过期作废：只有这种才算退出登录（一次 401 不算）。
      if (answer.error === 'invalid_grant' || answer.error === 'unauthorized_client') {
        this.clear()
        throw new SourceError('login_required', 'YouTube 登录已失效，请重新登录')
      }
      throw new SourceError('unavailable', `续期失败：${answer.error}`, { retryable: true })
    }
    if (typeof answer.access_token !== 'string') throw new SourceError('upstream_changed', '续期的回复读不懂')
    const renewed: Credential = {
      ...credential,
      accessToken: answer.access_token,
      expiresAt: Date.now() + (Number(answer.expires_in) || 3600) * 1000,
      refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : credential.refreshToken,
    }
    if (this.credential?.refreshToken === credential.refreshToken) this.apply(renewed)
    return renewed
  }

  // MARK: 设备码登录

  /** TV 版的设备码登录：给出 google.com/device 的码，轮询到拿到 token，再读账号。 */
  async *login(ctx: Ctx): AsyncIterable<LoginStep> {
    const oauth = this.clients.oauth
    for (;;) {
      const client = await this.oauthClient(ctx.signal)
      const code = await this.oauth('device/code', { client_id: client.id, scope: oauth.scope, device_id: this.deviceID, device_model: oauth.deviceModel }, ctx.signal)
      if (typeof code.user_code !== 'string' || typeof code.device_code !== 'string') {
        throw new SourceError('upstream_changed', `取不到登录码：${String(code.error ?? '')}`)
      }
      const url = `https://www.google.com/device?user_code=${encodeURIComponent(code.user_code)}`
      const expires = Date.now() + (Number(code.expires_in) || 1800) * 1000
      yield {
        kind: 'showCode',
        content: url,
        title: '用手机扫码登录 YouTube',
        message: `或在浏览器打开 google.com/device，输入 ${code.user_code}`,
        openURL: url,
        expiresAt: new Date(expires).toISOString(),
      }
      let interval = Math.max(Number(code.interval) || 5, 1) * 1000
      while (Date.now() < expires) {
        await sleep(interval, ctx.signal)
        let answer: Record<string, unknown>
        try {
          answer = await this.oauth('token', {
            client_id: client.id,
            client_secret: client.secret,
            code: code.device_code,
            grant_type: 'http://oauth.net/grant_type/device/1.0',
          }, ctx.signal)
        } catch (error) {
          if (ctx.signal.aborted) throw error
          continue
        }
        if (typeof answer.access_token === 'string' && typeof answer.refresh_token === 'string') {
          yield { kind: 'waiting', message: '已授权，正在读取账号' }
          this.apply({
            accessToken: answer.access_token,
            refreshToken: answer.refresh_token,
            expiresAt: Date.now() + (Number(answer.expires_in) || 3600) * 1000,
            clientID: client.id,
            clientSecret: client.secret,
          })
          yield { kind: 'completed', profile: await this.refreshProfile(ctx.signal) }
          return
        }
        if (answer.error === 'authorization_pending') continue
        if (answer.error === 'slow_down') interval += 5000
        else if (answer.error === 'access_denied') {
          yield { kind: 'failed', message: '已拒绝授权', restartable: true }
          return
        } else if (answer.error === 'expired_token') break
        else throw new SourceError('unavailable', `登录失败：${String(answer.error)}`)
      }
      // 码过期：换一个。
    }
  }

  async refreshProfile(signal?: AbortSignal): Promise<Profile> {
    const answer = await this.innertube('account/accounts_list', {}, this.clients.accountClient, { signal })
    const read = adapter.profile(answer)
    if (!read) throw new SourceError('upstream_changed', '读不懂账号信息')
    this.profile = { name: read.name, avatarURL: read.avatar }
    return this.profile
  }

  // MARK: TV 页

  private tvPage(signal?: AbortSignal) {
    if (!this.tvPageCache || Date.now() - this.tvPageCache.at > TV_PAGE_LIFETIME) {
      const page = (async () => {
        const client = this.client(this.clients.pageClient)
        const response = await fetch(this.clients.tvPage, { headers: { 'user-agent': client.userAgent }, signal })
        if (!response.ok) throw new SourceError('unavailable', `TV 页返回 ${response.status}`, { retryable: true })
        const read = adapter.tvPage(await response.text())
        if (!read) throw new SourceError('upstream_changed', '读不懂 TV 页')
        if (read.visitorData) this.visitorData = read.visitorData
        return { playerURL: new URL(read.playerPath, HOST).toString(), clientID: read.clientID, clientSecret: read.clientSecret }
      })()
      this.tvPageCache = { at: Date.now(), page }
      page.catch(() => {
        if (this.tvPageCache?.page === page) this.tvPageCache = undefined
      })
    }
    return this.tvPageCache.page
  }

  /** TV 页自己的 OAuth client，读不到就用规则里的。 */
  private async oauthClient(signal?: AbortSignal): Promise<{ id: string; secret: string }> {
    try {
      const page = await this.tvPage(signal)
      if (page.clientID && page.clientSecret) return { id: page.clientID, secret: page.clientSecret }
    } catch {
      // 用规则里的
    }
    return { id: this.clients.oauth.clientID, secret: this.clients.oauth.clientSecret }
  }

  /** `player` 请求要带的播放器 JS 的 signatureTimestamp。 */
  async signatureTimestamp(signal?: AbortSignal): Promise<number> {
    const { playerURL } = await this.tvPage(signal)
    if (this.signatureCache?.playerURL !== playerURL) {
      const value = (async () => {
        const response = await fetch(playerURL, { signal })
        const read = adapter.playerJS(await response.text())
        if (!read) throw new SourceError('upstream_changed', '读不懂播放器 JS')
        return read.signatureTimestamp
      })()
      this.signatureCache = { playerURL, value }
      value.catch(() => {
        if (this.signatureCache?.value === value) this.signatureCache = undefined
      })
    }
    return this.signatureCache.value
  }

  // MARK: 请求

  async oauth(path: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const client = this.client(this.clients.pageClient)
    const response = await fetch(`${HOST}/o/oauth2/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': client.userAgent },
      body: JSON.stringify(body),
      signal,
    })
    try {
      return (await response.json()) as Record<string, unknown>
    } catch {
      throw new SourceError('unavailable', `oauth ${path} 返回 ${response.status}`, { retryable: true })
    }
  }

  /**
   * `POST youtubei/v1/<endpoint>`，以 `clientKey` 的身份；身份接受且已登录时带上登录。401 续期后重发一次。
   */
  async innertube(endpoint: string, body: Record<string, unknown>, clientKey: string,
                  options: { authorized?: boolean; signal?: AbortSignal } = {}): Promise<any> {
    const client = this.client(clientKey)
    const sendsToken = (options.authorized ?? true) && client.acceptsAuthorization && this.loggedIn
    for (let retried = false; ; retried = true) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': client.userAgent,
        'x-youtube-client-name': String(client.nameID),
        'x-youtube-client-version': client.version,
        origin: HOST,
      }
      if (client.referer) headers.referer = client.referer
      if (this.visitorData) headers['x-goog-visitor-id'] = this.visitorData
      if (sendsToken) headers.authorization = `Bearer ${await this.accessToken(retried, options.signal)}`
      const context: Record<string, unknown> = {
        clientName: client.name,
        clientVersion: client.version,
        userAgent: client.userAgent,
        hl: this.language,
        acceptLanguage: this.language,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        ...(this.region ? { acceptRegion: this.region } : {}),
        ...(this.visitorData ? { visitorData: this.visitorData } : {}),
        ...client.context,
      }
      const response = await fetch(`${HOST}/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, context: { client: context, user: { enableSafetyMode: false, lockedSafetyMode: false } } }),
        signal: options.signal,
      })
      if (response.status === 401 && sendsToken && !retried) continue
      const text = await response.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      if (!response.ok) {
        const message = json?.error?.message ?? `HTTP ${response.status}`
        if (response.status === 429) throw new SourceError('throttled', 'YouTube 请求太频繁，请稍后再试')
        if (response.status === 401 || response.status === 403) throw new SourceError('login_required', `YouTube 拒绝了请求：${message}`)
        throw new SourceError('unavailable', `YouTube ${endpoint} 失败：${message}`, { retryable: true })
      }
      const visitor = json?.responseContext?.visitorData
      if (typeof visitor === 'string' && visitor) this.visitorData = visitor
      return json
    }
  }

  /** 以账号身份 `browse`。 */
  browse(args: { browseId?: string; params?: string; continuation?: string }, signal?: AbortSignal) {
    return this.innertube('browse', adapter.browseRequest(args), this.clients.accountClient, { signal })
  }

  /** 观看记录的上报地址加上参数，以账号身份带登录发出（App 的 `YouTubeSession.track`）。 */
  async track(address: string, parameters: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const url = new URL(address)
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
    const client = this.client(this.clients.accountClient)
    for (let retried = false; ; retried = true) {
      const response = await fetch(url, {
        headers: { 'user-agent': client.userAgent, authorization: `Bearer ${await this.accessToken(retried, signal)}` },
        signal,
      })
      if (response.status === 401 && !retried) continue
      if (!response.ok && response.status !== 204) throw new SourceError('unavailable', `上报观看记录返回 ${response.status}`)
      return
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SourceError('unavailable', '已取消'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new SourceError('unavailable', '已取消'))
    }, { once: true })
  })
}
