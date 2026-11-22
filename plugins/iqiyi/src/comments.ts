// 评论（照 App 的 IQiyiComments）：网页播放器的 `sns-comment.iqiyi.com/v3`——评论 `get_baseline_comments`、回复
// `get_second_comments`，都按最后一条的 id 翻页，无签名。连续十来次请求后会有一两分钟回空列表，靠它多带的键
// （`hot`、`hotRemaining`）和真的没有评论区分开。
import type { Comment, CommentPage, CommentSort } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import type { IQiyiSession } from './session.ts'
import { arr, idOf, int, isNull, num, parseID, str, text } from './util.ts'

const HOST = 'https://sns-comment.iqiyi.com/v3/comment'
const PAGE_SIZE = 20

interface Cursor {
  kind: 'comments' | 'replies'
  /** 评论：tvid；回复：那条评论。 */
  id: string
  /** 评论：`HOT` / `TIMEDESC`。 */
  sort?: string
  lastID?: string
  /** 回复：最后一条的 `addTime`。 */
  lastScore?: string
}

const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

export class IQiyiComments {
  private emotes?: Record<string, string>

  private readonly session: IQiyiSession

  constructor(session: IQiyiSession) {
    this.session = session
  }

  first(video: string, sort: CommentSort, signal: AbortSignal | undefined): Promise<CommentPage> {
    const id = parseID(video)
    // 电影的专辑 id 就是它的 tvid。
    if (!id) throw new SourceError('not_found', '找不到这个视频的评论')
    return this.comments({ kind: 'comments', id: id.id, sort: sort === 'hot' ? 'HOT' : 'TIMEDESC' }, signal)
  }

  page(raw: string, signal: AbortSignal | undefined): Promise<CommentPage> {
    let cursor: Cursor
    try {
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    } catch {
      throw new SourceError('bad_request', '评论游标不对')
    }
    return cursor.kind === 'replies' ? this.replies(cursor, signal) : this.comments(cursor, signal)
  }

  private base(): Record<string, string> {
    return {
      business_type: '17', agent_type: '118', agent_version: '10.2', authcookie: this.session.authCookie ?? '',
      device_id: this.session.deviceID, qyid: this.session.deviceID,
    }
  }

  private async comments(cursor: Cursor, signal: AbortSignal | undefined): Promise<CommentPage> {
    const [data, emotes] = await Promise.all([
      this.data('get_baseline_comments.action', {
        ...this.base(), content_id: cursor.id, sort: cursor.sort ?? 'HOT', page_size: String(PAGE_SIZE), last_id: cursor.lastID ?? '', hot_size: '0',
      }, signal),
      this.loadEmotes(signal),
    ])
    const comments = arr(data.comments).map((c) => comment(c, undefined, emotes))
    const last = comments.at(-1)?.id
    return {
      comments,
      next: int(data.remaining) === 1 && last ? encode({ ...cursor, lastID: last }) : null,
      total: int(data.totalCount),
    }
  }

  /** 新的在前；第一页以评论本身开头，去掉。 */
  private async replies(cursor: Cursor, signal: AbortSignal | undefined): Promise<CommentPage> {
    const [data, emotes] = await Promise.all([
      this.data('get_second_comments.action', {
        ...this.base(), content_id: cursor.id, page_size: String(PAGE_SIZE), last_id: cursor.lastID ?? '', last_score: cursor.lastScore ?? '',
      }, signal),
      this.loadEmotes(signal),
    ])
    const raw = arr(data.comments)
    const replies = raw.filter((c) => idOf(c?.id) !== cursor.id).map((c) => comment(c, cursor.id, emotes))
    const last = raw.at(-1)
    return {
      comments: replies,
      next: int(data.remaining) === 1 && last ? encode({ ...cursor, lastID: idOf(last.id), lastScore: idOf(last.addTime) }) : null,
      total: int(data.totalCount),
    }
  }

  /** 评论接口的 `data`；被限流的回答（空列表加 `hot` 键）抛 `throttled`。 */
  private async data(action: string, params: Record<string, string>, signal: AbortSignal | undefined): Promise<any> {
    const json = await this.session.json(`${HOST}/${action}`, params, signal)
    if (str(json?.code) !== 'A00000') throw new SourceError('upstream_changed', `评论加载失败（${str(json?.code) ?? '?'}）`)
    const data = json.data ?? {}
    if (arr(data.comments).length === 0 && (!isNull(data.hot) || !isNull(data.hotRemaining))) {
      throw new SourceError('throttled', '评论刷得太快了，请过一两分钟再试', { retryAfter: 90 })
    }
    return data
  }

  /** 官方表情（`[微笑]` → 图片），只取一次；取不到就空着（留名字）。 */
  private async loadEmotes(signal: AbortSignal | undefined): Promise<Record<string, string>> {
    if (this.emotes) return this.emotes
    try {
      const json = await this.session.json('https://bar-i.iqiyi.com/myna-api/officialEmoji/getAllYellowFaceEmojis', {}, signal)
      const emotes: Record<string, string> = {}
      for (const emoji of arr(json?.data)) {
        const name = text(emoji?.name)
        const url = imageURL(text(emoji?.url) ?? text(emoji?.previewUrl) ?? text(emoji?.staticUrl))
        if (name && url) emotes[name] = url
      }
      if (Object.keys(emotes).length > 0) this.emotes = emotes
      return emotes
    } catch (error) {
      if (signal?.aborted) throw error
      return {}
    }
  }
}

function imageURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return raw.startsWith('//') ? `https:${raw}` : raw
}

export function comment(json: any, root: string | undefined, emotes: Record<string, string>): Comment {
  const user = json?.userInfo ?? {}
  const id = idOf(json?.id) ?? ''
  const content = str(json?.content) ?? ''
  const replyCount = root === undefined ? (int(json?.replyCount) ?? 0) : 0
  // 回复只在回的是另一条回复（不是它所在的那条评论）时写回的是谁。
  const source = json?.replySource ?? {}
  const rootID = root ?? idOf(json?.rootCommentId)
  const sourceID = idOf(source.id)
  const repliesTo = sourceID && sourceID !== rootID ? text(source.userInfo?.uname) : undefined
  const added = num(json?.addTime)
  const used: Record<string, string> = {}
  if (content.includes('[')) {
    for (const match of content.matchAll(/\[[^[\]]{1,8}\]/g)) if (emotes[match[0]]) used[match[0]] = emotes[match[0]]
  }
  return {
    id,
    author: { name: text(user.uname) ?? '爱奇艺用户', avatarURL: imageURL(text(user.icon)) },
    text: content,
    emotes: Object.keys(used).length > 0 ? used : undefined,
    pictures: arr(json?.pictures).map((p) => imageURL(text(p?.url))).filter((p): p is string => Boolean(p)),
    date: added ? new Date(added * 1000).toISOString() : undefined,
    location: text(json?.location),
    likes: int(json?.likes) ?? 0,
    replyCount,
    previewReplies: root === undefined ? arr(json?.replies).map((r) => comment(r, id, emotes)) : undefined,
    replies: replyCount > 0 ? encode({ kind: 'replies', id }) : undefined,
    repliesTo,
  }
}
