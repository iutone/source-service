// B 站接口返回的条目 → 协议模型（照 App 的 BiliArchive / BiliPGCSeason / BiliSearchHit / BiliReply …）。纯函数，便于测试。
import type { Badge, Comment, Cue, Danmaku, MediaItem, Stats, Uploader, VideoItem } from '@iyt-source/protocol'
import { episodeFromRedirect, episodeID, seasonID, videoID } from './ids.ts'
import { image } from './session.ts'

/** 去掉值为 undefined 的键（JSON 里本来也不会有，测试里比较起来干净）。 */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key]
  return value
}

const nonEmpty = (text: string | undefined | null) => (text ? text : undefined)
const positive = (value: number | undefined | null) => (value && value > 0 ? value : undefined)
const date = (seconds: number | undefined | null) => (seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined)

/** 「9876」「1.2万」「3.4亿」。 */
export function parseCount(text: string | number | undefined | null): number | undefined {
  if (typeof text === 'number') return text
  if (!text) return undefined
  if (/^\d+$/.test(text)) return Number(text)
  for (const [unit, scale] of [['亿', 100_000_000], ['万', 10_000]] as const) {
    if (text.endsWith(unit)) {
      const value = Number(text.slice(0, -1))
      return Number.isFinite(value) ? Math.round(value * scale) : undefined
    }
  }
  return undefined
}

/** 「03:07」「1:02:03」→ 秒。 */
export function parseDuration(text: string | undefined | null): number | undefined {
  if (!text) return undefined
  const parts = text.split(':').map(Number)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return undefined
  return parts.reduce((total, n) => total * 60 + n, 0)
}

export function stats(stat: Record<string, number | undefined> | undefined | null): Stats | undefined {
  if (!stat) return undefined
  return compact({
    views: stat.view ?? stat.play ?? stat.views,
    danmaku: stat.danmaku ?? stat.danmakus,
    likes: stat.like ?? stat.likes,
    coins: stat.coin ?? stat.coins,
    favorites: stat.favorite ?? stat.favorites,
    replies: stat.reply,
  })
}

export interface Owner {
  mid: number | string
  name: string
  face?: string
}

export function uploader(owner: Owner | undefined | null, followers?: number): Uploader | undefined {
  if (!owner?.name) return undefined
  return compact({ id: String(owner.mid ?? ''), name: owner.name, avatarURL: image(owner.face, 96, 96), followers })
}

/** 投稿视频（稿件），各个列表里的样子：`popular`、`ranking/v2`、`index/top/feed/rcmd`、`view/detail` 的 `Related`。 */
export interface BiliArchive {
  aid?: number
  /** `rcmd` 把 aid 叫 `id`。 */
  id?: number
  bvid?: string
  cid?: number
  pic?: string
  title: string
  duration?: number
  pubdate?: number
  owner?: Owner
  stat?: Record<string, number>
  /** feed 里是 `{content}`，`Related` 里是字符串。 */
  rcmd_reason?: { content?: string } | string
  /** 其实是番剧的一集时：`https://www.bilibili.com/bangumi/play/ep123`。 */
  redirect_url?: string
  /** 只有 `rcmd` 有：视频是 "av"；广告、直播不要。 */
  goto?: string
}

export function archiveItem(archive: BiliArchive): MediaItem | undefined {
  if ((archive.goto && archive.goto !== 'av') || !archive.bvid || !archive.title) return undefined
  const epid = episodeFromRedirect(archive.redirect_url)
  const reason = typeof archive.rcmd_reason === 'string' ? archive.rcmd_reason : archive.rcmd_reason?.content
  return compact({
    id: archive.bvid,
    title: archive.title,
    subtitle: nonEmpty(reason),
    landscapeURL: image(archive.pic, 672, 378),
    uploader: uploader(archive.owner),
    stats: stats(archive.stat),
    duration: positive(archive.duration),
    publishedAt: date(archive.pubdate),
    target: { video: epid ? episodeID(epid) : archive.bvid },
  })
}

/** 一季（PGC 列表的样子）：`rank/list`、`season/index/result`、`bangumi/follow/list`。 */
export interface BiliSeasonCard {
  season_id: number
  title: string
  cover?: string
  ss_horizontal_cover?: string
  badge?: string
  /** 「更新至第21话」（索引）。 */
  index_show?: string
  new_ep?: { index_show?: string }
  /** 「看到第12话」（追番列表）。 */
  progress?: string
  /** 索引按当前排序给的数字：「553.1万追番」「9.9分」。 */
  order?: string
}

export function seasonItem(season: BiliSeasonCard): MediaItem | undefined {
  if (!season.season_id || !season.title) return undefined
  const id = seasonID(season.season_id)
  const badge: Badge | undefined = season.badge ? { text: season.badge, tone: season.badge.includes('会员') ? 'red' : 'blue' } : undefined
  return compact({
    id,
    title: season.title,
    subtitle: nonEmpty(season.progress),
    posterURL: image(season.cover, 360, 480),
    landscapeURL: image(season.ss_horizontal_cover, 672, 378),
    badge,
    caption: nonEmpty(season.index_show ?? season.new_ep?.index_show),
    target: { show: id },
  })
}

export function ranked(items: MediaItem[], limit = 20): MediaItem[] {
  return items.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 }))
}

/** `x/polymer/web-dynamic/v1/feed/all` 的一条动态；视频动态带 `major.archive`。 */
export interface DynamicItem {
  modules?: {
    module_author?: { mid?: number | string; name?: string; face?: string; pub_ts?: number | string }
    module_dynamic?: { major?: { archive?: { bvid?: string; cover?: string; title?: string; duration_text?: string; stat?: { play?: string; danmaku?: string } } } }
  }
}

export function dynamicItem(item: DynamicItem): MediaItem | undefined {
  const archive = item.modules?.module_dynamic?.major?.archive
  if (!archive?.bvid) return undefined
  const author = item.modules?.module_author
  return compact({
    id: archive.bvid,
    title: archive.title || archive.bvid,
    landscapeURL: image(archive.cover, 672, 378),
    uploader: author?.name ? uploader({ mid: author.mid ?? '', name: author.name, face: author.face }) : undefined,
    // 数字是排好版的（「1.2万」），能读的读出来。
    stats: compact({ views: parseCount(archive.stat?.play), danmaku: parseCount(archive.stat?.danmaku) }),
    duration: parseDuration(archive.duration_text),
    publishedAt: date(Number(author?.pub_ts ?? 0)),
    target: { video: archive.bvid },
  })
}

/** 搜索的一条：一季（`media_bangumi` / `media_ft`）或投稿视频（`video`）。标题带 `<em class="keyword">` 高亮，去掉。 */
export interface SearchHit {
  type?: string
  title?: string
  season_id?: number
  cover?: string
  index_show?: string
  season_type_name?: string
  bvid?: string
  pic?: string
  author?: string
  mid?: number
  upic?: string
  play?: number | string
  video_review?: number | string
  duration?: string
  pubdate?: number
}

export function plainTitle(title: string | undefined): string {
  return (title ?? '').replace(/<[^>]+>/g, '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'")
}

export function searchSeason(hit: SearchHit): MediaItem | undefined {
  if (!hit.season_id) return undefined
  const id = seasonID(hit.season_id)
  return compact({
    id, title: plainTitle(hit.title), subtitle: nonEmpty(hit.season_type_name), posterURL: image(hit.cover, 360, 480),
    caption: nonEmpty(hit.index_show), target: { show: id },
  })
}

export function searchVideo(hit: SearchHit): MediaItem | undefined {
  if (!hit.bvid) return undefined
  return compact({
    id: hit.bvid,
    title: plainTitle(hit.title),
    landscapeURL: image(hit.pic, 672, 378),
    uploader: hit.author ? compact({ id: hit.mid ? String(hit.mid) : '', name: hit.author, avatarURL: image(hit.upic) }) : undefined,
    stats: compact({ views: parseCount(hit.play), danmaku: parseCount(hit.video_review) }),
    duration: parseDuration(hit.duration),
    publishedAt: date(hit.pubdate),
    target: { video: hit.bvid },
  })
}

/** `history/cursor` 的一条：投稿视频和番剧，直播、专栏不要。 */
export interface HistoryEntry {
  title: string
  cover?: string
  /** 番剧：这一集的标题（「第3话 …」）。 */
  show_title?: string
  new_desc?: string
  history: { oid?: number; epid?: number; bvid?: string; cid?: number; page?: number; business: string }
  /** 秒；看完是 -1。 */
  progress?: number
  duration?: number
  view_at?: number
  badge?: string
  /** 番剧：season id。 */
  kid?: number
  author_name?: string
}

export function historyItem(entry: HistoryEntry): VideoItem | undefined {
  let id: string
  let showID: string | undefined
  let historyKey: string | undefined
  const history = entry.history
  if (history.business === 'archive') {
    if (!history.bvid) return undefined
    // 后面的分P就播那个分P。
    id = videoID(history.bvid, (history.page ?? 1) > 1 ? history.cid : undefined)
    historyKey = history.oid ? `archive_${history.oid}` : undefined
  } else if (history.business === 'pgc') {
    if (!history.epid || history.epid <= 0) return undefined
    id = episodeID(history.epid)
    showID = entry.kid ? seasonID(entry.kid) : undefined
    historyKey = entry.kid ? `pgc_${entry.kid}` : undefined
  } else {
    return undefined
  }
  let fraction: number | undefined
  if (entry.progress !== undefined && entry.duration && entry.duration > 0) {
    fraction = entry.progress < 0 ? 1 : Math.min(entry.progress / entry.duration, 1)
  }
  return compact({
    id,
    showID,
    title: entry.title,
    subtitle: nonEmpty(entry.show_title) ?? nonEmpty(entry.author_name),
    coverURL: image(entry.cover, 672, 378),
    progress: fraction,
    watchedPercent: fraction === undefined ? undefined : Math.round(fraction * 100),
    badge: entry.badge ? { text: entry.badge, tone: 'red' as const } : undefined,
    caption: nonEmpty(entry.new_desc),
    lastWatched: date(entry.view_at),
    historyKey,
  })
}

/** `x/v2/reply/*` 的一条评论或回复。 */
export interface BiliReply {
  rpid: number
  oid: number
  ctime?: number
  like?: number
  rcount?: number
  member: { uname: string; avatar?: string; vip?: { vipStatus?: number; nickname_color?: string } }
  content: { message: string; emote?: Record<string, { url?: string }>; pictures?: { img_src?: string }[] }
  replies?: BiliReply[] | null
  reply_control?: { location?: string }
}

export function replyComment(reply: BiliReply, isPinned: boolean, repliesCursor: (reply: BiliReply) => string): Comment {
  const rcount = reply.rcount ?? 0
  // 回复别人的回复以「回复 @名字 :」开头：名字挪到 `repliesTo`。
  let text = reply.content.message
  let repliesTo: string | undefined
  const match = /^回复 @(.+?) :/.exec(text)
  if (match) {
    repliesTo = match[1]
    text = text.slice(match[0].length).trimStart()
  }
  const emotes: Record<string, string> = {}
  for (const [name, emote] of Object.entries(reply.content.emote ?? {})) {
    const url = image(emote.url)
    if (url) emotes[name] = url
  }
  const pictures = (reply.content.pictures ?? []).map((picture) => image(picture.img_src)).filter((url): url is string => Boolean(url))
  return compact({
    id: String(reply.rpid),
    author: compact({
      name: reply.member.uname,
      avatarURL: image(reply.member.avatar, 96, 96),
      nameColor: reply.member.vip?.vipStatus === 1 ? nonEmpty(reply.member.vip?.nickname_color) : undefined,
    }),
    text,
    emotes: Object.keys(emotes).length ? emotes : undefined,
    pictures: pictures.length ? pictures : undefined,
    date: date(reply.ctime),
    location: reply.reply_control?.location?.replace('IP属地：', ''),
    likes: reply.like ?? 0,
    replyCount: rcount,
    previewReplies: (reply.replies ?? []).length ? (reply.replies ?? []).map((r) => replyComment(r, false, repliesCursor)) : undefined,
    replies: rcount > 0 ? repliesCursor(reply) : undefined,
    isPinned: isPinned || undefined,
    repliesTo,
  })
}

// MARK: 弹幕（protobuf）

/** 最小的 protobuf 读取：varint 和变长字段；定长的跳过。 */
function* protobufFields(bytes: Uint8Array): Generator<{ field: number; varint?: bigint; bytes?: Uint8Array }> {
  let position = 0
  const varint = (): bigint => {
    let result = 0n
    let shift = 0n
    while (position < bytes.length && shift < 64n) {
      const byte = bytes[position++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
    throw new Error('坏的 protobuf')
  }
  while (position < bytes.length) {
    const key = varint()
    const field = Number(key >> 3n)
    switch (Number(key & 7n)) {
      case 0:
        yield { field, varint: varint() }
        break
      case 1:
        position += 8
        break
      case 2: {
        const length = Number(varint())
        if (position + length > bytes.length) throw new Error('坏的 protobuf')
        yield { field, bytes: bytes.subarray(position, position + length) }
        position += length
        break
      }
      case 5:
        position += 4
        break
      default:
        throw new Error('坏的 protobuf')
    }
  }
}

/** `DmSegMobileReply`（`x/v2/dm/wbi/web/seg.so`）：只读 `elems`（字段 1），每条 `DanmakuElem` 取几个字段。 */
export function parseDanmakuSegment(bytes: Uint8Array): Danmaku[] {
  const decoder = new TextDecoder()
  const list: Danmaku[] = []
  for (const element of protobufFields(bytes)) {
    if (element.field !== 1 || !element.bytes) continue
    let id = ''
    let progress = 0
    let mode = 1
    let color = 0xffffff
    let content = ''
    for (const field of protobufFields(element.bytes)) {
      if (field.field === 1 && field.varint !== undefined && !id) id = String(field.varint)
      else if (field.field === 2 && field.varint !== undefined) progress = Number(field.varint)
      else if (field.field === 3 && field.varint !== undefined) mode = Number(field.varint)
      else if (field.field === 5 && field.varint !== undefined) color = Number(field.varint & 0xffffffn) & 0xffffff
      else if (field.field === 7 && field.bytes) content = decoder.decode(field.bytes)
      else if (field.field === 12 && field.bytes) id = decoder.decode(field.bytes)
    }
    // 1–3 滚动、6 逆向当滚动；4 底部、5 顶部；高级、代码、BAS 弹幕要专门的渲染，不要。
    const position = mode === 4 ? 'bottom' : mode === 5 ? 'top' : [1, 2, 3, 6].includes(mode) ? 'scroll' : undefined
    if (!position || !content) continue
    list.push({ id, time: progress / 1000, text: content, position, color: `#${color.toString(16).padStart(6, '0').toUpperCase()}` })
  }
  return list
}

// MARK: 字幕

/** B 站的 CC 字幕 JSON（`body: [{from, to, content}]`，秒）。 */
export interface SubtitleFile {
  body?: { from: number; to: number; content: string }[]
}

export function subtitleCues(file: SubtitleFile): Cue[] {
  return (file.body ?? []).filter((line) => line.content).map((line) => ({ start: line.from, end: line.to, text: line.content }))
}

export function vttTimestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

export function cuesToVTT(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((cue) => `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${cue.text}\n`).join('\n')}`
}
