// TED 的公开 GraphQL 接口（www.ted.com/graphql，网站自己用的，不用登录）：查询照网站前端里的写法。
// 列表的标题默认英文；带 `language` 的查询给出译文（没有这门语言译文的演讲不返回），所以先取列表、再按 id 批量取译文。
import { SourceError } from '@iyt-source/kit'

export const ENDPOINT = 'https://www.ted.com/graphql'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

export interface Image {
  url: string
  aspectRatioName: string
}

/** 列表里的一场演讲（网站的 `VideoInfo` 片段）。 */
export interface Video {
  id: string
  slug: string
  title: string
  primaryImageSet?: Image[]
  presenterDisplayName?: string
  duration?: number
  videoContext?: string
  viewedCount?: number
  publishedAt?: string
  description?: string
  type?: { name: string }
}

export interface Playlist {
  id: string
  slug: string
  title: string
  description?: string
  author?: string
  primaryImageSet?: Image[]
  videos?: { totalCount: number; nodes?: Video[] }
}

export const VIDEO_FIELDS = 'id slug title primaryImageSet { url aspectRatioName } presenterDisplayName duration videoContext viewedCount publishedAt'
export const PLAYLIST_FIELDS = 'id slug title description author primaryImageSet { url aspectRatioName } videos { totalCount }'

export async function gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, origin: 'https://www.ted.com', referer: 'https://www.ted.com/' },
      body: JSON.stringify({ query, variables }),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new SourceError('unavailable', `连不上 TED：${String((error as Error).message ?? error)}`, { retryable: true, cause: error })
  }
  if (response.status === 429) throw new SourceError('throttled', 'TED 请求太频繁，请稍后再试')
  const text = await response.text()
  let json: { data?: T; errors?: { message: string }[] }
  try {
    json = JSON.parse(text)
  } catch {
    throw new SourceError('unavailable', `TED 返回 ${response.status}`, { retryable: true })
  }
  if (json.errors?.length) {
    // 查询字段对不上：网站改了接口。
    throw new SourceError('upstream_changed', `TED 接口报错：${json.errors[0].message}`, { cause: json.errors })
  }
  if (!json.data) throw new SourceError('unavailable', `TED 返回 ${response.status}`, { retryable: true })
  return json.data
}

/**
 * 按 id 取这些演讲在 `language` 下的标题、演讲者、简介。没有译文的不返回（调用方用原文）。
 */
export async function translations(ids: string[], language: string, signal?: AbortSignal): Promise<Map<string, Pick<Video, 'title' | 'presenterDisplayName' | 'description'>>> {
  const map = new Map<string, Pick<Video, 'title' | 'presenterDisplayName' | 'description'>>()
  const numeric = [...new Set(ids)].map(Number).filter((id) => Number.isInteger(id) && id > 0)
  if (!numeric.length || language === 'en') return map
  for (let i = 0; i < numeric.length; i += 100) {
    const chunk = numeric.slice(i, i + 100)
    const data = await gql<{ videos: { nodes: (Video & { id: string })[] } }>(
      'query($id:[Int!],$language:String,$first:Int){videos(id:$id,language:$language,first:$first,channel:ALL,isPublished:[true]){nodes{id title presenterDisplayName description}}}',
      { id: chunk, language, first: chunk.length },
      signal,
    )
    for (const node of data.videos.nodes) map.set(String(node.id), node)
  }
  return map
}

/** 把列表的标题换成译文（有的话）。 */
export async function localize<V extends Video>(videos: V[], language: string, signal?: AbortSignal): Promise<V[]> {
  let found: Awaited<ReturnType<typeof translations>>
  try {
    found = await translations(videos.map((v) => v.id), language, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    // 取不到译文就用原文，列表照常显示。
    return videos
  }
  return videos.map((video) => {
    const text = found.get(String(video.id))
    return text ? { ...video, title: text.title || video.title, presenterDisplayName: text.presenterDisplayName || video.presenterDisplayName, description: text.description || video.description } : video
  })
}

/** 图片：横图优先（16:9，再 2:1、4:3），`w` 让 TED 的图片服务缩小。 */
export function picture(images: Image[] | undefined, prefer: string[] = ['16x9', '2x1', '4x3'], width = 640): string | undefined {
  if (!images?.length) return undefined
  const image = prefer.map((ratio) => images.find((i) => i.aspectRatioName === ratio)).find(Boolean) ?? images[0]
  if (!image.url.startsWith('https://pi.tedcdn.com/')) return image.url
  return `${image.url}${image.url.includes('?') ? '&' : '?'}w=${width}`
}
