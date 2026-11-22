// 网易公开课的接口：网站和手机站自己用的（c.open.163.com，不用登录、不签名）。它们和视频 CDN 拒绝 curl 的 UA，
// 所以请求都带浏览器的 UA。
import { SourceError } from '@iyt-source/kit'

export const API = 'https://c.open.163.com'
export const SITE = 'https://open.163.com'
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

/** 一节课（`movie/list.do` 的 `videoList`）。 */
export interface Movie {
  mid: string
  plid: string
  title: string
  mLength?: number
  imgPath?: string
  pNumber?: number
  hits?: number
  subtitle?: string
  subtitleLanguage?: string
  description?: string
  subList?: { subName: string; subUrl?: string; subVttUrl?: string }[]
  [field: string]: unknown
}

/** 一门课程（`movie/list.do`）。 */
export interface Course {
  plid: string
  title: string
  subtitle?: string
  imgPath?: string
  largeImgurl?: string
  school?: string
  director?: string
  type?: string
  tags?: string
  description?: string
  hits?: number
  firstClassify?: string
  secondClassify?: string
  subscribeName?: string
  source?: string
  videoList: Movie[]
}

/** 搜索结果的一项（`searchv2/v2/queryAll.do`）：`type` 1 / 13 是课程（`plid`），其余（订阅号、音频、学习计划）不要。 */
export interface SearchEntry {
  contentId: string
  type: number
  title: string
  plid?: string | null
  image?: string
  quantity?: string
  playAmount?: number | null
  subscribeName?: string
  description?: string | null
}

export interface Comment {
  id: number
  content: string
  voteCount: number
  replyCount: number
  userName: string
  userPhoto?: string
  dbCreateTime: number
  imageList?: string[]
  replyList?: { id: number; content: string; userNameFrom: string; userPhotoFrom?: string; userNameTo?: string; voteCount: number; dbCreateTime: number }[]
}

export async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal, base = API): Promise<T> {
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  let response: Response
  try {
    response = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: `${SITE}/` }, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new SourceError('unavailable', `连不上网易公开课：${String((error as Error).message ?? error)}`, { retryable: true, cause: error })
  }
  if (response.status === 429) throw new SourceError('throttled', '网易公开课请求太频繁，请稍后再试')
  const text = await response.text()
  let json: { code?: number; data?: T; message?: string } & Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    throw new SourceError('unavailable', `网易公开课返回 ${response.status}`, { retryable: true })
  }
  if (json.code !== 200) throw new SourceError('unavailable', `网易公开课：${json.message ?? json.code}`, { retryable: true })
  return json as unknown as T
}

/** 搜索结果的标题带 `<em>` 高亮。 */
export const plain = (text: string | null | undefined) => (text ?? '').replace(/<[^>]+>/g, '').trim()

/** `"12' 34''"` → 秒。 */
export function quantitySeconds(text: string | undefined): number | undefined {
  const match = text?.match(/^(\d+)'\s*(\d+)''$/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

/** 首页的一栏：网站首页（open.163.com）服务端渲染的 HTML。 */
export interface HomeBlock {
  id: string
  title: string
  keywords: string[]
  items: { plid: string; mid?: string; title: string; image?: string; note?: string }[]
}

/** 读网站首页各栏（`#j-category-*`）：栏名、栏旁的关键词、栏里的课程。 */
export function parseHome(html: string): HomeBlock[] {
  const starts = [...html.matchAll(/id="j-category-([a-z0-9]+)"/g)].map((m) => ({ at: m.index!, id: m[1] }))
  const blocks: HomeBlock[] = []
  for (const [index, { at, id }] of starts.entries()) {
    const body = html.slice(at, starts[index + 1]?.at ?? html.length)
    const title = body.match(/class="ciTitle">([^<]+)/)?.[1]?.trim()
    if (!title) continue
    const keywords = [...body.matchAll(/<li><a href="[^"]*\/newview\/search\/[^"]*">([^<]+)<\/a>/g)].map((m) => decode(m[1].trim()))
    const items: HomeBlock['items'] = []
    for (const m of body.matchAll(/<a href="https?:\/\/open\.163\.com\/newview\/movie\/[a-z]+\?pid=([A-Z0-9]+)(?:&(?:amp;)?mid=([A-Z0-9]+))?"[^>]*class="f-db[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
      const inner = m[3]
      const name = inner.match(/alt="([^"]*)"/)?.[1]
      if (!name || items.some((item) => item.plid === m[1])) continue
      const note = inner.match(/class="[^"]*oviImgText[^"]*"[^>]*>([^<]*)/)?.[1]?.trim()
      items.push({ plid: m[1], mid: m[2], title: decode(name), image: inner.match(/data-original="([^"]+)"/)?.[1], note: note ? decode(note) : undefined })
    }
    if (items.length) blocks.push({ id, title: decode(title), keywords, items })
  }
  return blocks
}

function decode(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
