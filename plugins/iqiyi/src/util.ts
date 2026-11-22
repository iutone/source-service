// 爱奇艺网页接口的公共小工具：签名（docs/iqiyi-web/API.md §3）、id（App 的 IQiyiID）、图片地址、宽松 JSON 读取。
// 照 App 的 `App/Core/IQiyi`（IQiyiSigner / IQiyiID / IQImage / IQJSON）移植。
import { createHash } from 'node:crypto'

/** 网页版（pcw）的身份：Safari，播放接口按 Safari 的能力给流。 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
export const REFERER = 'https://www.iqiyi.com/'
export const APP_VERSION = '17.102.26596'
/** 网页登录的平台 id。 */
export const LOGIN_PTID = '01010021010000000000'
/** 网页播放器的 `src`。 */
export const PLAYER_SOURCE = '01080031010000000000'
export const MESH = 'https://mesh.if.iqiyi.com'
export const PASSPORT = 'https://passport.iqiyi.com'
export const PCW_API = 'https://pcw-api.iqiyi.com'

// MARK: 签名

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** `mesh.if.iqiyi.com/tvg/*`：按 key 排序、不编码的 `k=v` 加密钥做 MD5，大写。 */
export function tvgSign(params: Record<string, string>): string {
  const joined = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&')
  return md5(`${joined}&secret_key=howcuteitis`).toUpperCase()
}

/** `dash` 的 `authKey`：MD5(MD5(authcookie) + tm + tvid)。 */
export function authKey(authCookie: string, time: string, tvid: string): string {
  return md5(md5(authCookie) + time + tvid)
}

/** 网页播放器在 `dash` 路径和参数后面加的盐（它的 `ka()`）。 */
export const VF_SALT = (() => {
  let salt = ''
  for (let t = 0; t < 4; t++) {
    for (let i = 0; i < 2; i++) {
      for (let r = 0; r < 4; r++) {
        let n = (70 * t + 677 * i + 21 * r + 87 * t * i * r + 59) % 30
        n += n < 9 ? 48 : 88
        salt += String.fromCharCode(n)
      }
    }
  }
  return salt
})()

/** `vf`：发出去的路径和参数原文（`/dash?...&ut=1`）加盐的 MD5。 */
export function vf(pathAndQuery: string): string {
  return md5(pathAndQuery + VF_SALT)
}

/** 按给定顺序拼 `k=v&…`，值像 `encodeURIComponent` 那样编码（签名对这段原文算）。 */
export function query(pairs: [string, string][] | Record<string, string>): string {
  const list = Array.isArray(pairs) ? pairs : Object.keys(pairs).sort().map((key): [string, string] => [key, pairs[key]])
  return list.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

// MARK: id

/** 交给 App 的不透明 id：`v<tvid>` 一个视频，`a<albumId>` 一部剧。裸的 qipu id 也认：专辑以 01 结尾，视频以 00 结尾。 */
export type IQiyiID = { kind: 'video'; id: string } | { kind: 'album'; id: string }

export function parseID(raw: string | undefined | null): IQiyiID | null {
  if (!raw) return null
  if (/^v\d+$/.test(raw)) return { kind: 'video', id: raw.slice(1) }
  if (/^a\d+$/.test(raw)) return { kind: 'album', id: raw.slice(1) }
  if (/^\d+$/.test(raw)) return raw.endsWith('01') ? { kind: 'album', id: raw } : { kind: 'video', id: raw }
  return null
}

export const videoID = (tvid: string) => `v${tvid}`
export const albumID = (id: string) => `a${id}`

/** `qips://tvid=…;vid=…;albumid=…;` 里的一项。 */
export function qipsValue(key: string, link: string | undefined | null): string | undefined {
  if (!link || !link.startsWith('qips://')) return undefined
  for (const part of link.slice('qips://'.length).split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at) === key) return part.slice(at + 1)
  }
  return undefined
}

// MARK: 图片

/**
 * 爱奇艺的图片：`…_m_601_m5.jpg` 可以在扩展名前加尺寸（`…_m_601_m5_260_360.jpg`）；AVIF 地址也有 JPEG 版。
 * 一律给 https。
 */
export function image(raw: unknown, width?: number, height?: number): string | undefined {
  let url = text(raw)
  if (!url) return undefined
  if (url.startsWith('//')) url = `https:${url}`
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`
  if (url.endsWith('.avif')) url = `${url.slice(0, -5)}.jpg`
  const dot = url.lastIndexOf('.')
  if (width && height && dot > 0 && url.length - dot <= 5 && url.includes('iqiyipic.com/image/')) {
    const stem = url.slice(0, dot).replace(/_\d{2,4}_\d{2,4}$/, '')
    url = `${stem}_${width}_${height}${url.slice(dot)}`
  }
  return url
}

// MARK: 宽松 JSON

/** 解析 JSON，超过 2^53 的整数保留成字符串（qipu id 可能很长）。 */
export function parseJSON(body: string): any {
  return (JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown)(
    body,
    (_key, value, context) => (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source ? context.source : value),
  )
}

export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return undefined
}

/** 非空字符串。 */
export function text(value: unknown): string | undefined {
  const s = str(value)
  return s ? s : undefined
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function int(value: unknown): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.trunc(n)
}

/** id：数字的原样数字、非空字符串。 */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : undefined
  return text(value)
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.toLowerCase())
  return undefined
}

export function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

export function isNull(value: unknown): boolean {
  return value === undefined || value === null
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

/** "40集全" / "更新至12集"；单集或不知道集数时 undefined。 */
export function updateStatus(count: number, latest: number): string | undefined {
  if (count <= 1 || latest <= 0) return undefined
  return latest >= count ? `${count}集全` : `更新至${latest}集`
}
