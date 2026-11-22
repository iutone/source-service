// B 站的两种请求签名（照 App 的 BilibiliSigner）：
// - App 签名：appkey + appsec 的 md5，用于 TV 扫码登录、续期和 app 接口（不喜欢）。
// - 网页 WBI：`nav` 的 `wbi_img` 两个文件名按混淆表拼成 mixin key，参数加 `wts` 后取 md5 作 `w_rid`。
import { createHash, createHmac } from 'node:crypto'

/** TV / pad 端的 appkey：扫码登录和续期都是 app 签名（docs/bilibili/PLAN.md §3.1）。 */
export const APP_KEY = '5ae412b53418aac5'
export const APP_SECRET = '5b9cf6c9786efd204dcf0c1ce2d08436'
/** 网页接口对非浏览器 UA 回 412。 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
export const REFERER = 'https://www.bilibili.com'
export const API = 'https://api.bilibili.com'
export const PASSPORT = 'https://passport.bilibili.com'

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** 和 JavaScript 的 `encodeURIComponent` 一样（两种签名都按它算）。 */
export function encode(value: string): string {
  return encodeURIComponent(value)
}

/** `k=v&…`，按键排序。签过名的请求必须原样发这个串。 */
export function query(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${encode(key)}=${encode(params[key])}`).join('&')
}

/** 加上 `appkey`、`ts` 和 app 身份，再 `sign = md5(排序后的 query + appsec)`。 */
export function appSigned(params: Record<string, string>, now = Date.now()): Record<string, string> {
  const signed: Record<string, string> = {
    ...params,
    appkey: APP_KEY,
    ts: String(Math.floor(now / 1000)),
    local_id: '0',
    mobi_app: 'iphone',
    device: 'pad',
    device_name: 'iPad',
  }
  signed.sign = md5(query(signed) + APP_SECRET)
  return signed
}

/** `img_key + sub_key` 的字符按这个顺序组成 mixin key。 */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

export function mixinKey(imgKey: string, subKey: string): string {
  const raw = [...(imgKey + subKey)]
  return MIXIN_TABLE.filter((index) => index < raw.length).map((index) => raw[index]).slice(0, 32).join('')
}

/** 加 `wts` 和 `w_rid`。参数值先去掉 `!'()*`，和网页端一样。 */
export function wbiSigned(params: Record<string, string>, key: string, now = Date.now()): Record<string, string> {
  const signed: Record<string, string> = {}
  for (const [name, value] of Object.entries(params)) signed[name] = value.replace(/[!'()*]/g, '')
  signed.wts = String(Math.floor(now / 1000))
  signed.w_rid = md5(query(signed) + key)
  return signed
}

/** `wbi_img` 地址的文件名（去掉扩展名）。 */
export function wbiKey(imageURL: string | undefined): string | undefined {
  const name = imageURL?.split('/').pop()?.split('.')[0]
  return name || undefined
}

/** 网页空间页调 `space/wbi/arc/search` 时带的浏览器指纹；不带时更常 -352。常见显卡的固定值就行。 */
export const SPACE_FINGERPRINT: Record<string, string> = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKUdvb2dsZSBJbmMuIChJbnRlbC',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
}

/** `GenWebTicket` 的 `hexsign`：`ts<秒>` 用网页端的密钥做 HMAC-SHA256。 */
export function ticketSign(ts: string): string {
  return createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex')
}
