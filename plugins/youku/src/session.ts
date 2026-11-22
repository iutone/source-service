// 优酷的账号、设备 id 与 ckey（服务端持有，全家共用）。登录两种：
// - 扫码（qr）：阿里 Havana 登录页的「优酷 App 扫码」。实测 `qrcode/generate.do` / `query.do` 不带 baxia 头也能用（2026-11-22），
//   服务端拿二维码给电视显示，自己轮询，确认后按登录组件的做法依次请求 `asyncUrls` 等地址种下 youku.com 的登录 cookie。
// - 网页（webCookie）：App 在 WebView 里打开优酷的手机登录页（同 App 的 YoukuWebAuth），把 cookie 交过来。
// 凭证存在 ctx.store（`session`）；接口说登录失效（FAIL_SYS_SESSION_EXPIRED、个人信息没有 ytid）就当作退出。
import type { CookieInput, LoginStep, Membership, Profile } from '@iyt-source/protocol'
import { SourceError, type Ctx, type KeyValueStore } from '@iyt-source/kit'
import { fetchCollina, generateCkey, scriptIsFresh, type CollinaScript } from './ckey.ts'
import { bool, first, firstText, num, text, webImage, type J } from './json.ts'
import { CookieJar, MTOPClient, request, type StoredCookie } from './mtop.ts'

/** Havana 登录完成后种下的 cookie（App 的 `YoukuWebCookies.loginCookieNames`）。 */
export const LOGIN_COOKIES = ['P_pck_rm', 'P_sck']
/** 手机版登录页（短信 / 密码），和 App 的 YoukuWebAuth 用的同一个。 */
export const WEB_LOGIN_URL = 'https://cnpassport.youku.com/mini_login.htm?lang=zh_cn&appName=youku&appEntrance=youku_new_dark&styleType=vertical&notLoadSsoView=true&notKeepLogin=false&isMobile=true&returnUrl=https%3A%2F%2Fm.youku.com%2F'
const QR_PAGE_URL = 'https://cnpassport.youku.com/mini_login.htm?lang=zh_cn&appName=youku&appEntrance=youku&styleType=vertical&isMobile=false&returnUrl=https%3A%2F%2Fwww.youku.com%2F'
const PASSPORT = 'https://cnpassport.youku.com'
const DESKTOP_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
/** 账号信息缓存多久再向优酷核对一次（manifest 每次都要账号状态）。 */
const PROFILE_TTL = 10 * 60_000
/** ckey 用多久换新的：网页端认为 7 天内有效，这里保守些。 */
const CKEY_TTL = 12 * 3600_000

interface SavedSession {
  cookies: StoredCookie[]
  /** 设备 id（`utid` / `nlid` / `utdid`）：手机交来的 cookie `cna`，没有就向 log.mmstat.com 要一个。 */
  cna?: string
  ckey?: string
  ckeyTime?: number
  profile?: YoukuProfile
}

export interface YoukuProfile extends Profile {
  /** `ytid`：历史接口的 uid。 */
  id: string
}

export class YoukuSession {
  readonly jar = new CookieJar()
  readonly mtop = new MTOPClient(this.jar)
  private store?: KeyValueStore
  private saved: SavedSession = { cookies: [] }
  private profileCheckedAt = 0
  private profileTask?: Promise<YoukuProfile>
  private cnaTask?: Promise<string>
  private ckeyTask?: Promise<string>
  private collina?: CollinaScript

  constructor() {
    this.mtop.onSessionExpired = () => {
      if (this.loggedIn) this.clearLogin()
    }
    this.jar.onChange = () => this.persist()
  }

  /** 第一次用到时从 ctx.store 读回。 */
  attach(ctx: Ctx): this {
    if (this.store) return this
    this.store = ctx.store
    const saved = ctx.store.get<SavedSession>('session')
    if (saved && Array.isArray(saved.cookies)) {
      this.saved = saved
      for (const cookie of saved.cookies) this.jar.set(cookie, false)
    }
    this.collina = ctx.store.get<CollinaScript>('collina') ?? undefined
    return this
  }

  get loggedIn(): boolean {
    return LOGIN_COOKIES.some((name) => Boolean(this.jar.get(name)))
  }

  get profile(): YoukuProfile | undefined {
    return this.saved.profile
  }

  get cna(): string | undefined {
    return this.jar.get('cna') ?? this.saved.cna
  }

  private persist(): void {
    if (!this.store) return
    this.saved.cookies = this.jar.all().filter((c) => !CookieJar.volatile(c.name))
    this.store.set('session', this.saved)
  }

  private clearLogin(): void {
    for (const cookie of this.jar.all()) {
      // 设备 id 留着：匿名浏览、播放也要。
      if (cookie.name !== 'cna') this.jar.set({ ...cookie, expires: 0 }, false)
    }
    this.saved.profile = undefined
    this.profileCheckedAt = 0
    this.persist()
  }

  logout(): void {
    this.clearLogin()
  }

  // MARK: 设备 id

  /** 确保 cookie 里有 `cna`：搜索没有它会要验证码，UPS 的 `utid` 也是它（docs/youku-web/SEARCH.md §1）。 */
  async ensureCna(_signal?: AbortSignal): Promise<string> {
    const existing = this.cna
    if (existing) {
      if (!this.jar.get('cna')) this.jar.set({ name: 'cna', value: existing, domain: '.youku.com', path: '/' }, false)
      return existing
    }
    // 共用的活：不跟着发起它的那个请求取消。
    this.cnaTask ??= fetchCna().then((cna) => {
      this.saved.cna = cna
      this.jar.set({ name: 'cna', value: cna, domain: '.youku.com', path: '/', expires: Math.floor(Date.now() / 1000) + 365 * 86400 })
      this.persist()
      return cna
    }).finally(() => { this.cnaTask = undefined })
    return this.cnaTask
  }

  // MARK: ckey

  get ckeyAge(): number | undefined {
    return this.saved.ckey && this.saved.ckeyTime ? Date.now() - this.saved.ckeyTime : undefined
  }

  /** 存着的 ckey，过期或 `force` 时重新生成。 */
  async ckey(ctx: Ctx, force = false): Promise<string> {
    const age = this.ckeyAge
    if (!force && this.saved.ckey && age !== undefined && age < CKEY_TTL) return this.saved.ckey
    // 共用的活：不跟着发起它的那个请求取消。
    this.ckeyTask ??= this.makeCkey({ ...ctx, signal: new AbortController().signal }).finally(() => { this.ckeyTask = undefined })
    return this.ckeyTask
  }

  private async makeCkey(ctx: Ctx): Promise<string> {
    const cna = await this.ensureCna(ctx.signal)
    if (!scriptIsFresh(this.collina)) {
      try {
        this.collina = await fetchCollina(ctx.signal)
        this.store?.set('collina', this.collina)
      } catch (error) {
        // 取不到新版就用上次的。
        if (!this.collina?.code) throw error
        ctx.log.warn('youku collina refresh failed', { error: String(error) })
      }
    }
    const started = Date.now()
    const ckey = await generateCkey(this.collina!, { cna })
    ctx.log.info('youku ckey generated', { ms: Date.now() - started, script: this.collina!.path })
    this.saved.ckey = ckey
    this.saved.ckeyTime = Date.now()
    this.persist()
    return ckey
  }

  /** UPS 拒了这个 ckey（-6004）：丢掉，下次重新生成。 */
  dropCkey(): void {
    this.saved.ckey = undefined
    this.saved.ckeyTime = undefined
    this.persist()
  }

  // MARK: 账号

  /** 当前账号；缓存 10 分钟。登录失效时清掉登录并抛 `login_required`。 */
  async refreshProfile(force = false): Promise<YoukuProfile> {
    if (!this.loggedIn) throw new SourceError('login_required', '请先登录优酷')
    if (!force && this.saved.profile && Date.now() - this.profileCheckedAt < PROFILE_TTL) return this.saved.profile
    this.profileTask ??= (async () => {
      await this.ensureCna()
      // 共用的请求：不跟着某一个请求取消。
      const profile = await fetchProfile(this.mtop)
      if (!profile) {
        this.clearLogin()
        throw new SourceError('login_required', '优酷登录已失效，请重新登录')
      }
      this.saved.profile = profile
      this.profileCheckedAt = Date.now()
      this.persist()
      return profile
    })().finally(() => { this.profileTask = undefined })
    return this.profileTask
  }

  /** 网页登录：App 交来的 youku.com cookie。先在一个临时罐里核对，确认登录了才换上。 */
  async acceptCookies(cookies: CookieInput[], ctx: Ctx): Promise<YoukuProfile> {
    const youku = cookies.filter((c) => /(^|\.)youku\.com$/i.test(c.domain.replace(/^\./, '')))
    if (!youku.some((c) => LOGIN_COOKIES.includes(c.name) && c.value)) {
      throw new SourceError('bad_request', '没有读到优酷的登录信息，请在登录页完成登录')
    }
    const stored = youku.map((c): StoredCookie => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires ? Math.floor(Date.parse(c.expires) / 1000) || undefined : undefined,
    }))
    return this.adopt(stored, ctx)
  }

  private async adopt(cookies: StoredCookie[], ctx: Ctx): Promise<YoukuProfile> {
    const trial = new CookieJar(cookies)
    if (!trial.get('cna')) {
      const cna = this.cna ?? await this.ensureCna(ctx.signal)
      trial.set({ name: 'cna', value: cna, domain: '.youku.com', path: '/' }, false)
    }
    const profile = await fetchProfile(new MTOPClient(trial), ctx.signal)
    if (!profile) throw new SourceError('login_required', '这些 cookie 没有登录优酷，请重新登录')
    // 换上新的登录：旧的 cookie 全部丢掉（设备 id 用新的那份）。
    this.jar.clear()
    for (const cookie of trial.all()) this.jar.set(cookie, false)
    const cna = this.jar.get('cna')
    if (cna && cna !== this.saved.cna) {
      // ckey 和设备 id 一起交给 UPS：换了设备 id 就重新生成。
      this.saved.cna = cna
      this.saved.ckey = undefined
      this.saved.ckeyTime = undefined
    }
    this.saved.profile = profile
    this.profileCheckedAt = Date.now()
    this.persist()
    // 生成 ckey 要一两秒：登录完就先做，不等到按播放。
    void this.ckey(ctx).catch((error) => ctx.log.warn('youku ckey after login failed', { error: String(error) }))
    return profile
  }

  // MARK: 扫码登录

  /** Havana 的「优酷 App 扫码」：生成二维码、轮询，确认后种 cookie、核对账号。过期了自动换新码（最多 5 次）。 */
  async *qrLogin(ctx: Ctx): AsyncGenerator<LoginStep> {
    const jar = new CookieJar()
    const signal = ctx.signal
    const page = await passport(jar, QR_PAGE_URL, { signal })
    const html = await page.text()
    const form = loginFormData(html)
    if (!form) throw new SourceError('upstream_changed', '优酷登录页改版了，读不到扫码登录的参数')
    for (let round = 0; round < 5; round++) {
      const generated = await passportJSON(jar, `${PASSPORT}/newlogin/qrcode/generate.do?` + new URLSearchParams({ appName: 'youku', fromSite: '23', ...form, umidTag: 'SERVER' }), { signal })
      const code = generated?.content?.data
      const content = text(code?.codeContent)
      if (!content || !code?.ck || !code?.t) throw new SourceError('upstream_changed', '优酷没有给出登录二维码')
      const expires = Date.now() + 5 * 60_000
      yield {
        kind: 'showCode', content, title: '用优酷 App 扫码登录',
        message: '打开优酷 App，用「扫一扫」扫这个码，再在手机上确认登录', expiresAt: new Date(expires).toISOString(),
      }
      let scanned = false
      while (!signal.aborted) {
        await sleep(2000, signal)
        const body = new URLSearchParams({ t: String(code.t), ck: String(code.ck), ...form, navlanguage: 'zh-CN', navUserAgent: DESKTOP_SAFARI, navPlatform: 'MacIntel' })
        const answer = await passportJSON(jar, `${PASSPORT}/newlogin/qrcode/query.do?appName=youku&fromSite=23`, {
          signal, method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
        const data = answer?.content?.data ?? {}
        const status = text(data.qrCodeStatus)
        if (status === 'SCANED') {
          if (!scanned) yield { kind: 'waiting', message: '已扫码，请在手机上确认登录' }
          scanned = true
        } else if (status === 'CONFIRMED') {
          yield { kind: 'waiting', message: '已确认，正在登录' }
          await followLoginResult(jar, data, signal, ctx)
          const cookies = jar.all().filter((c) => c.domain.replace(/^\./, '').endsWith('youku.com'))
          if (!cookies.some((c) => LOGIN_COOKIES.includes(c.name))) {
            ctx.log.warn('youku qr login: no login cookie', { fields: Object.keys(data).join(','), cookies: cookies.map((c) => c.name).join(',') })
            yield { kind: 'failed', message: '扫码确认了，但没有拿到优酷的登录信息，请改用手机网页登录', restartable: true }
            return
          }
          const profile = await this.adopt(cookies, ctx)
          yield { kind: 'completed', profile: publicProfile(profile) }
          return
        } else if (status === 'EXPIRED' || Date.now() > expires) {
          break
        } else if (status === 'CANCELED') {
          yield { kind: 'failed', message: '已在手机上取消登录', restartable: true }
          return
        } else if (status && status !== 'NEW') {
          yield { kind: 'failed', message: `扫码登录失败（${status}）`, restartable: true }
          return
        }
      }
    }
    yield { kind: 'failed', message: '二维码已过期', restartable: true }
  }
}

export function publicProfile(profile: YoukuProfile): Profile {
  const { id: _id, ...rest } = profile
  return rest
}

/** 登录页里 `viewData.loginFormData`（`_csrf_token`、`umidToken`、`hsiz` 等），扫码接口都要带上。 */
export function loginFormData(html: string): Record<string, string> | undefined {
  const match = /"loginFormData":(\{[^{}]*\})/.exec(html)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    const form: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) if (value !== null && value !== undefined) form[key] = String(value)
    return form._csrf_token ? form : undefined
  } catch {
    return undefined
  }
}

async function passport(jar: CookieJar, url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const response = await request(url, {
    ...init,
    redirect: 'manual',
    headers: { 'user-agent': DESKTOP_SAFARI, referer: QR_PAGE_URL, cookie: jar.header(url), ...(init.headers as Record<string, string> | undefined) },
  }, '优酷登录')
  jar.absorb(url, response)
  return response
}

async function passportJSON(jar: CookieJar, url: string, init: RequestInit & { signal: AbortSignal }): Promise<J> {
  const response = await passport(jar, url, init)
  try {
    return await response.json()
  } catch {
    throw new SourceError('upstream_changed', `优酷登录接口返回的不是 JSON（HTTP ${response.status}）`)
  }
}

/** 登录组件的 handleLoginResult：依次打开它给的地址（跨域种 cookie），一路跟随跳转收下 cookie。 */
async function followLoginResult(jar: CookieJar, data: J, signal: AbortSignal, ctx: Ctx): Promise<void> {
  const urls: string[] = []
  for (const key of ['asyncUrls', 'miniVsts']) for (const value of Array.isArray(data[key]) ? data[key] : Object.values(data[key] ?? {})) urls.push(String(value))
  for (const key of ['iframeRedirectUrl', 'redirectUrl', 'returnUrl']) if (text(data[key])) urls.push(text(data[key])!)
  urls.push('https://www.youku.com/')
  for (const raw of urls) {
    let url = raw.startsWith('//') ? 'https:' + raw : raw
    for (let hop = 0; hop < 8 && /^https?:/.test(url); hop++) {
      let response: Response
      try {
        response = await passport(jar, url, { signal })
      } catch (error) {
        if (signal.aborted) throw error
        ctx.log.warn('youku qr login hop failed', { host: new URL(url).hostname })
        break
      }
      await response.arrayBuffer().catch(() => undefined)
      const location = response.headers.get('location')
      if (!location || response.status < 300 || response.status >= 400) break
      url = new URL(location, url).toString()
    }
  }
}

/** log.mmstat.com 的 eg.js 发一个设备 id（ETag 和 Set-Cookie 里的 cna），网页第一次打开时就是这样拿到 cookie `cna` 的。 */
export async function fetchCna(signal?: AbortSignal): Promise<string> {
  const response = await request('https://log.mmstat.com/eg.js', { headers: { 'user-agent': DESKTOP_SAFARI, referer: 'https://www.youku.com/' }, signal }, '阿里日志服务')
  const body = await response.text()
  const fromCookie = response.headers.getSetCookie().map((line) => /^cna=([^;]+)/.exec(line)?.[1]).find(Boolean)
  const cna = fromCookie ?? response.headers.get('etag')?.replace(/"/g, '') ?? /Etag="([^"]+)"/.exec(body)?.[1]
  if (cna && /^[A-Za-z0-9+/=]{16,}$/.test(cna)) return cna
  // 拿不到就照 App 的做法造一个同样形状的（24 个 base64 字符）：浏览和搜索都认。
  const { randomBytes } = await import('node:crypto')
  return randomBytes(18).toString('base64')
}

/** `member.profile.get`：只有登录了才有非空的 `ytid`（REPORT.md §8.4）。没登录返回 undefined。 */
export async function fetchProfile(client: MTOPClient, signal?: AbortSignal): Promise<YoukuProfile | undefined> {
  let data: J
  try {
    data = await client.call('mtop.youku.vip.xtop.member.profile.get', '1.0', { req: '{"deviceType":"pc","show":1}' }, { signal })
  } catch (error) {
    if (error instanceof SourceError && error.code === 'login_required') return undefined
    throw error
  }
  const id = text(data?.ytid)
  if (!id) return undefined
  const profile: YoukuProfile = {
    id,
    name: text(data.uname) ?? text(data.nickName) ?? '优酷用户',
    avatarURL: webImage(data.user_icon_large ?? data.user_icon_big),
  }
  const membership = parseMembership(data)
  if (membership) profile.membership = membership
  if (!profile.avatarURL) delete profile.avatarURL
  return profile
}

/** 会员字段没有文档（REPORT.md §8.4）：在个人信息里按可能的名字找。 */
export function parseMembership(data: J, now = Date.now()): Membership | undefined {
  let end: number | undefined
  for (const key of ['exptime', 'expireTime', 'expire_time', 'vipExpireTime', 'vip_expire_time', 'endTime', 'end_time']) {
    const value = first(data, key)
    if (value === undefined) continue
    const epoch = num(value)
    if (epoch && epoch > 0) {
      end = epoch > 1e11 ? epoch : epoch * 1000
      break
    }
    const parsed = typeof value === 'string' ? beijingDate(value) : undefined
    if (parsed) {
      end = parsed
      break
    }
  }
  let flagged = false
  for (const key of ['is_vip', 'isVip', 'isvip', 'vip']) {
    const value = bool(first(data, key))
    if (value !== undefined) {
      flagged = value
      break
    }
  }
  if (!flagged && end === undefined) return undefined
  const tier = firstText(data, ['vipName', 'vip_name', 'memberName', 'levelName', 'grade_name', 'vipLevelName']) ?? '优酷 VIP'
  const membership: Membership = { tier, active: end !== undefined ? end > now : flagged }
  if (end !== undefined) membership.endsAt = new Date(end).toISOString()
  return membership
}

/** "2026-12-01 10:00:00" / "2026-12-01" / "2026.12.01"，北京时间；只有日期的算到当天结束。 */
function beijingDate(value: string): number | undefined {
  const match = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}):(\d{2}))?$/.exec(value.trim())
  if (!match) return undefined
  const [, y, m, d, hh, mm, ss] = match
  const base = Date.UTC(Number(y), Number(m) - 1, Number(d), hh ? Number(hh) : 23, hh ? Number(mm) : 59, hh ? Number(ss) : 59)
  return base - 8 * 3600_000
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
}
