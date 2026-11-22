// id 沿用 App（TencentID）：`c<cid>` 一个节目（剧集、电影、综艺；网站上 15 个字符），`v<vid>` 一个视频（一集、一个
// 片段；11 个字符）。

export type TencentID = { kind: 'cover'; id: string } | { kind: 'video'; id: string }

export function parseID(raw: string | undefined | null): TencentID | undefined {
  if (!raw || raw.length < 2) return undefined
  const id = raw.slice(1)
  if (!/^[A-Za-z0-9]+$/.test(id)) return undefined
  if (raw[0] === 'c') return { kind: 'cover', id }
  if (raw[0] === 'v') return { kind: 'video', id }
  return undefined
}

export const coverID = (cid: string) => `c${cid}`
export const videoID = (vid: string) => `v${vid}`

/** 播放页地址里的节目和视频：`/x/cover/<cid>/<vid>.html`、`/x/cover/<cid>.html`、`/x/page/<vid>.html`。 */
export function pageIDs(url: string | undefined): { cover?: string; video?: string } | undefined {
  if (!url) return undefined
  const cover = /\/x\/cover\/([a-z0-9]+)(?:\/([a-z0-9]+))?\.html/i.exec(url)
  if (cover) return { cover: cover[1], video: cover[2] }
  const page = /\/x\/page\/([a-z0-9]+)\.html/i.exec(url)
  if (page) return { video: page[1] }
  return undefined
}

/** 链接解析认的地址（SERVER.md §5.10）：v.qq.com 和手机站 m.v.qq.com 的播放页（`/x/cover/…`、`/x/page/…`、`/x/m/play?cid=&vid=`）。 */
export const LINK_PATTERNS = ['^https?://(?:www\\.|m\\.)?v\\.qq\\.com/(?:x/(?:cover|page)/|x/m/play|cover/)']

/** 链接 → 节目 / 视频。认不出返回 undefined。 */
export function linkTarget(raw: string): { show: string } | { video: string } | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (!/^(?:www\.|m\.)?v\.qq\.com$/.test(url.hostname)) return undefined
  const page = pageIDs(url.pathname)
  // 手机站的 `/x/m/play?cid=…&vid=…`、`/cover/m/…` 等用查询参数。
  const vid = page?.video ?? url.searchParams.get('vid') ?? undefined
  const cid = page?.cover ?? url.searchParams.get('cid') ?? undefined
  const mobileCover = /\/cover\/[a-z]\/([a-z0-9]{15})\.html/i.exec(url.pathname)?.[1]
  const valid = (id: string | undefined) => (id && /^[A-Za-z0-9]+$/.test(id) ? id : undefined)
  const video = valid(vid)
  if (video) return { video: videoID(video) }
  const cover = valid(cid) ?? valid(mobileCover)
  if (cover) return { show: coverID(cover) }
  return undefined
}
