// 网页的「腾讯视频 App 扫码登录」（API.md §1.1，App 的 TencentAccountService）：用腾讯视频 App 扫码并在手机上确认，
// 确认过的码再换成会话。纯 HTTP，不用签名。
import type { LoginStep } from '@iyt-source/protocol'
import { SourceError, type Ctx } from '@iyt-source/kit'
import { WEB_CALLER_APP_ID } from './constants.ts'
import { int, num, str, text } from './json.ts'
import type { TencentCredential, TencentSession } from './session.ts'

/** 网页登录用的 QQ / 微信 app id，换码时一起发。 */
const QQ_APP_ID = '101483052'
const WECHAT_APP_ID = 'wx5ed58254bc0d6b7f'
const POLL_INTERVAL = 1000

/** 二维码内容：腾讯视频 App 对这个码的授权页。 */
export function qrContent(code: string, expiresAt: number): string {
  return `https://m.v.qq.com/z/app/auth-page/index.html?qr_code_id=${code}&qr_expire_at=${expiresAt}&_pc=web&_env=&ovscroll=1&hideLoading=true&hideMoreButton=1`
}

/** 登录响应（`vuid`、`vusession`、`vurefresh`、`third_info`、`user_info`）：`third_type` 1 QQ、2 微信。 */
export function credentialFromLogin(login: any, guid: string, now = Date.now()): TencentCredential | undefined {
  const user = str(login?.vuid)
  const session = text(login?.vusession)
  const refresh = text(login?.vurefresh)
  if (!user || user === '0' || !session || !refresh) return undefined
  const third = login.third_info ?? {}
  const lifetime = num(login.vusession_expire_in)
  return {
    vuserid: user, vusession: session, vurefresh: refresh,
    mainLogin: int(third.third_type) === 1 ? 'qq' : 'wx',
    appID: text(third.app_id), openID: text(third.open_id), accessToken: typeof third.access_token === 'string' ? third.access_token : undefined,
    guid, callerAppID: WEB_CALLER_APP_ID, sessionExpiry: now + (lifetime && lifetime > 0 ? lifetime : 7200) * 1000,
    nick: text(login.user_info?.user_nick), avatar: text(login.user_info?.user_head),
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

export async function* qrLogin(session: TencentSession, ctx: Ctx): AsyncIterable<LoginStep> {
  let isRefresh = false
  let lastCode = ''
  for (;;) {
    let generated: any
    try {
      generated = await session.gateway('trpc.anywhere_door.account.QRCode/GenQRCode', {
        query: { video_appid: WEB_CALLER_APP_ID, vversion_platform: '2', vdevice_guid: session.guid },
        body: { qrcode_id_type: 1, last_qr_code_id: lastCode },
        cookies: { video_guid: session.guid },
        signal: ctx.signal,
      })
    } catch (error) {
      // 只有第一个码取不到才结束登录；换码时一直重试。
      if (!isRefresh || ctx.signal.aborted) throw error
      yield { kind: 'waiting', message: '正在刷新二维码…' }
      await sleep(5000, ctx.signal)
      continue
    }
    isRefresh = true
    const code = text(generated?.data?.qr_code_id)
    if (!code) throw new SourceError('upstream_changed', `取不到登录二维码（${str(generated?.ret) ?? '?'} ${str(generated?.msg) ?? ''}）`)
    lastCode = code
    const expireSeconds = num(generated?.data?.expire_time)
    const expiresAt = expireSeconds ? expireSeconds * 1000 : Date.now() + 300_000
    yield {
      kind: 'showCode',
      content: qrContent(code, expiresAt),
      title: '扫码登录腾讯视频',
      message: '打开腾讯视频 App 扫码登录',
      expiresAt: new Date(expiresAt).toISOString(),
    }
    let scanned = false
    polling: while (Date.now() < expiresAt - 5000) {
      await sleep(POLL_INTERVAL, ctx.signal)
      let result: any
      try {
        result = await session.gateway('trpc.anywhere_door.account.QRCode/QRCodeStatus', {
          query: { video_appid: WEB_CALLER_APP_ID, vversion_platform: '2' },
          body: { qr_code_id: code },
          cookies: { video_guid: session.guid },
          signal: ctx.signal,
        })
      } catch (error) {
        // 断网、休眠只跳过这一次轮询，码留在屏幕上。
        if (ctx.signal.aborted) throw error
        continue
      }
      switch (int(result?.data?.status)) {
        case 1:
          continue
        case 2:
          if (!scanned) yield { kind: 'waiting', message: '已扫码，请在手机上确认登录' }
          scanned = true
          continue
        case 3: {
          yield { kind: 'waiting', message: '登录成功，正在读取账号…' }
          session.apply(await exchange(session, code, ctx))
          yield { kind: 'completed', profile: await session.profile(ctx.signal, true) }
          return
        }
        default:
          // 4 取消、5 已用过、6 过期、1113001 已删除：换一个码。
          break polling
      }
    }
  }
}

/** `WebAccount/Login`，带确认过的码（`login_type` 4，不带风控签名）。 */
async function exchange(session: TencentSession, code: string, ctx: Ctx): Promise<TencentCredential> {
  const response = await session.gateway('trpc.anywhere_door.account.WebAccount/Login', {
    query: { video_appid: WEB_CALLER_APP_ID },
    body: {
      main_login: '',
      device_info: { platform: '2', guid: session.guid, appid: WEB_CALLER_APP_ID, version: '1.1' },
      login_request: {
        login_type: 4,
        sign_info: { sign: '', original_data: '', h38: '', qimei36: '' },
        qr_code_login_request: { qr_code_id: code, qq_app_id: QQ_APP_ID, wx_app_id: WECHAT_APP_ID },
      },
    },
    cookies: { video_guid: session.guid },
    signal: ctx.signal,
  })
  const data = response?.data ?? {}
  const credential = (int(data.error_code) ?? 0) === 0 ? credentialFromLogin(data.login_response, session.guid) : undefined
  if (!credential) {
    throw new SourceError('unavailable', `登录失败：${text(data.error_msg) ?? text(response?.msg) ?? ''}（${str(data.error_code) ?? str(response?.ret) ?? '?'}）`)
  }
  return credential
}
