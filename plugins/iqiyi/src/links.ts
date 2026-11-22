// 链接解析（照 App 的 link-resolver `web/packages/link-resolver/src/sources/iqiyi.ts`）：
// - `www.iqiyi.com/v_<slug>.html`（还有 `w_` / `p_`）：slug 编码了 tvid，照播放页的 `fastPlay.patchToID` 解；以 01 结尾的是专辑；
// - `?shareId=` / `?positiveId=`：base64 的 tvid；`?tvid=` / `?tvId=`、`?curid=<tvid>_<vid>`：tvid；
// - `/a_<slug>.html`（一部剧）和其他：取页面，读里面嵌的 `tvId` / `albumId`；
// - `qy.net/<code>`：App 的分享短链，跟到 `playShare?shareId=` 页。
import type { LinkResolution } from '@iyt-source/protocol'
import type { IQiyiSession } from './session.ts'

export const LINK_PATTERNS = ['^https?://([a-z0-9-]+\\.)*(iqiyi\\.com|qy\\.net)(:\\d+)?/']

const isHost = (host: string, ...domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`))

/** `/v_<slug>.html` 播放的 tvid：36 进制的 slug 异或一个常数；太小的结果放大。 */
export function slugID(path: string): string | undefined {
  const slug = /\/[vwp]_([0-9a-z]+)\.html/i.exec(path)?.[1]?.toLowerCase()
  if (!slug) return undefined
  let value = 0n
  for (const char of slug) value = value * 36n + BigInt(parseInt(char, 36))
  let id = value ^ 0x75706971676cn
  if (id < 900000n) id = 100n * (id + 900000n)
  return id > 0n ? id.toString() : undefined
}

/** `?shareId=` / `?positiveId=`：base64 的 tvid。 */
function sharedID(url: URL): string | undefined {
  const encoded = url.searchParams.get('shareId') ?? url.searchParams.get('positiveId')
  if (!encoded) return undefined
  const id = /^\d+/.exec(Buffer.from(encoded, 'base64').toString('latin1'))?.[0]
  return id && id !== '0' ? id : undefined
}

/** 不用取页面就认得出的链接。 */
export function matchLink(raw: string): LinkResolution | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!isHost(url.hostname, 'iqiyi.com')) return null
  const tvid = /^(\d+)$/.exec(url.searchParams.get('tvid') ?? url.searchParams.get('tvId') ?? '')?.[1]
    ?? /^(\d+)_/.exec(url.searchParams.get('curid') ?? '')?.[1]
  if (tvid) return { target: { video: `v${tvid}` } }
  const id = sharedID(url) ?? slugID(url.pathname)
  // `…14` 的 id 是页面经接口才认得的实体：交给页面自己的数据。
  if (!id || id.endsWith('14')) return null
  return id.endsWith('01') ? { target: { show: `a${id}` } } : { target: { video: `v${id}` } }
}

/** 页面里嵌 id 的地方：播放页的 JSON（`"tvId":123`）、旧的内联参数、播放器属性。 */
const TVID_PATTERNS = [/"tvId"\s*:\s*"?(\d{5,})/, /"tvid"\s*:\s*"?(\d{5,})/, /\btvid\s*[=:]\s*["']?(\d{5,})/i, /data-player-tvid\s*=\s*"(\d{5,})"/]
const ALBUM_PATTERNS = [/"albumId"\s*:\s*"?(\d{5,})/, /"albumid"\s*:\s*"?(\d{5,})/i, /data-player-albumid\s*=\s*"(\d{5,})"/]

function firstNumber(body: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match && match[1] !== '0') return match[1]
  }
  return undefined
}

/** 从页面内容认：`v_` 页先找 tvid，`a_` 页找专辑。 */
export function inspectPage(url: URL, body: string): LinkResolution | null {
  const isAlbum = /\/a_[0-9a-z]+\.html/i.test(url.pathname)
  const isVideo = /\/v_[0-9a-z]+\.html/i.test(url.pathname)
  if (!isAlbum && !isVideo) return null
  const tvid = isVideo ? firstNumber(body, TVID_PATTERNS) : undefined
  if (tvid) return { target: { video: `v${tvid}` } }
  const album = firstNumber(body, ALBUM_PATTERNS)
  return album ? { target: { show: `a${album}` } } : null
}

export async function resolveLink(raw: string, session: IQiyiSession, signal: AbortSignal | undefined): Promise<LinkResolution | null> {
  const direct = matchLink(raw)
  if (direct) return direct
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!isHost(url.hostname, 'iqiyi.com', 'qy.net')) return null
  // 短链和认不出的页面：取页面（跟着跳转）再认。
  const response = await session.fetch(url.toString(), signal)
  if (!response.ok) return null
  const final = new URL(response.url || url.toString())
  const redirected = final.toString() !== url.toString() ? matchLink(final.toString()) : null
  if (redirected) return redirected
  return inspectPage(final, await response.text())
}
