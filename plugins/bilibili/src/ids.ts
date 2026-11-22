// id 规则沿用 App 的 BiliID（docs/bilibili/PLAN.md §3.3）：
// - `BV1xx…`：投稿视频（第一个分P）；`BV1xx…#<cid>`：某个分P。
// - `ep123`：番剧 / 影视的一集；`ss456`：一季（节目）。
import type { LinkResolution } from '@iyt-source/protocol'

export type BiliID =
  | { kind: 'video'; bvid: string; cid?: number }
  | { kind: 'episode'; epid: number }
  | { kind: 'season'; sid: number }

export function parseID(raw: string): BiliID | undefined {
  if (raw.startsWith('BV')) {
    const [bvid, part] = raw.split('#', 2)
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return undefined
    const cid = part !== undefined && /^\d+$/.test(part) ? Number(part) : undefined
    return { kind: 'video', bvid, cid }
  }
  const pgc = /^(ep|ss)(\d+)$/.exec(raw)
  if (pgc) return pgc[1] === 'ep' ? { kind: 'episode', epid: Number(pgc[2]) } : { kind: 'season', sid: Number(pgc[2]) }
  return undefined
}

export const videoID = (bvid: string, cid?: number) => (cid ? `${bvid}#${cid}` : bvid)
export const episodeID = (epid: number) => `ep${epid}`
export const seasonID = (sid: number) => `ss${sid}`

/** `redirect_url`（…/bangumi/play/ep123）指向的那一集。 */
export function episodeFromRedirect(url: string | undefined | null): number | undefined {
  const last = url?.split('?')[0].split('/').filter(Boolean).pop()
  const match = last && /^ep(\d+)$/.exec(last)
  return match ? Number(match[1]) : undefined
}

const XOR_CODE = 23442827791579n
const MASK_CODE = 2251799813685247n
const MAX_AID = 1n << 51n
const BASE = 58n
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'

/** av 号 → BV 号（2024 年的算法，任意 aid 都适用）。 */
export function av2bv(aid: bigint | number): string {
  const chars = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0']
  let index = chars.length - 1
  let value = (MAX_AID | BigInt(aid)) ^ XOR_CODE
  while (value > 0n) {
    chars[index] = ALPHABET[Number(value % BASE)]
    value /= BASE
    index -= 1
  }
  ;[chars[3], chars[9]] = [chars[9], chars[3]]
  ;[chars[4], chars[7]] = [chars[7], chars[4]]
  return chars.join('')
}

/** BV 号 → av 号。 */
export function bv2av(bvid: string): number {
  const chars = [...bvid]
  ;[chars[3], chars[9]] = [chars[9], chars[3]]
  ;[chars[4], chars[7]] = [chars[7], chars[4]]
  let value = 0n
  for (const char of chars.slice(3)) value = value * BASE + BigInt(ALPHABET.indexOf(char))
  return Number((value & MASK_CODE) ^ XOR_CODE)
}

/** 短链接的域名：要先跟一次跳转。 */
export function isShortLink(url: URL): boolean {
  return /(^|\.)(b23\.tv|bili2233\.cn)$/i.test(url.hostname)
}

/**
 * 认 B 站的链接（和 App 的 link-resolver 一样）：`/video/BV…`、`/video/av123`、`?bvid=` / `?aid=`（嵌入播放器）、
 * `/bangumi/play/ep…` / `ss…`、`/bangumi/media/md…` 不认（要另查）。分P（`?p=2`）只能在知道 cid 后才定位，这里打开第一个分P。
 */
export function linkTarget(raw: string): LinkResolution | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return null
  const path = url.pathname
  const bv = /\/(BV1[0-9A-Za-z]{9})(?:[/?]|$)/.exec(path) ?? /^(BV1[0-9A-Za-z]{9})$/.exec(url.searchParams.get('bvid') ?? '')
  if (bv) return { target: { video: bv[1] } }
  const av = /\/video\/av(\d+)/i.exec(path) ?? /^(\d+)$/.exec(url.searchParams.get('aid') ?? '')
  if (av) return { target: { video: av2bv(BigInt(av[1])) } }
  const pgc = /\/bangumi\/play\/(ep|ss)(\d+)/.exec(path)
  if (pgc) return pgc[1] === 'ep' ? { target: { video: `ep${pgc[2]}` } } : { target: { show: `ss${pgc[2]}` } }
  return null
}

/** manifest 里声明的链接（§5.10）：App 本地匹配，匹配上才交给这里。 */
export const LINK_PATTERNS = [
  '^https?://([a-z0-9-]+\\.)?bilibili\\.com/',
  '^https?://(www\\.)?(b23\\.tv|bili2233\\.cn)/',
]
