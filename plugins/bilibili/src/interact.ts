// 互动与评论（照 App 的 BilibiliVideoActions / BilibiliComments）：点赞 / 投币 / 收藏 / 关注走网页接口（cookie + csrf），
// 「不喜欢」走 app 接口（TV 登录的 access_key）。视频按 aid 操作：投稿视频的，或番剧那一集的。
// 评论：`x/v2/reply/wbi/main` 按游标翻页，楼中楼按页 `x/v2/reply/reply`。
import type { CommentPage, CommentSort, FavoriteFolder, VideoActionState } from '@iyt-source/protocol'
import { badRequest, notFound } from '@iyt-source/kit'
import type { Catalog } from './catalog.ts'
import { parseID } from './ids.ts'
import { replyComment, type BiliReply } from './models.ts'
import { API } from './sign.ts'

const COINS_PER_DAY = 5
const REPLIES_PAGE = 20

interface ActionTarget {
  aid: number
  /** 原创 2，转载或番剧 1。 */
  maxCoins: number
  /** 番剧的一集是追番，不是收藏；也不能「不喜欢」。 */
  canFavorite: boolean
}

export class Interactions {
  private readonly catalog: Catalog

  constructor(catalog: Catalog) {
    this.catalog = catalog
  }

  private get session() {
    return this.catalog.session
  }

  /** 视频 id 背后的 aid，尽量用已经取过的详情。 */
  async target(video: string, signal: AbortSignal): Promise<ActionTarget> {
    const id = parseID(video)
    if (id?.kind === 'video') {
      const view = await this.catalog.view(id.bvid, signal)
      return { aid: view.aid, maxCoins: view.copyright === 2 ? 1 : 2, canFavorite: true }
    }
    if (id?.kind === 'episode') {
      const { episode } = await this.catalog.episode(id.epid, signal)
      if (!episode.aid) throw notFound('这个视频')
      return { aid: episode.aid, maxCoins: 1, canFavorite: false }
    }
    throw badRequest(`无法操作 ${video}`)
  }

  async state(video: string, uploader: string | undefined, signal: AbortSignal): Promise<VideoActionState> {
    const target = await this.target(video, signal)
    const aid = String(target.aid)
    // 读不到的那一项当作未知。
    const optional = <T>(path: string, params: Record<string, string> = {}) =>
      this.session.get<T>(`${API}${path}`, params, { signal, sign: 'none' }).catch((error) => {
        if (signal.aborted) throw error
        return undefined
      })
    const [liked, coins, todayExp, favoured, relation] = await Promise.all([
      optional<number>('/x/web-interface/archive/has/like', { aid }),
      optional<{ multiply?: number }>('/x/web-interface/archive/coins', { aid }),
      // 今天投币得的经验：一个币 10 点。
      optional<number>('/x/web-interface/coin/today/exp'),
      target.canFavorite ? optional<{ favoured?: boolean }>('/x/v2/fav/video/favoured', { aid }) : undefined,
      // `attribute`：0 没关注，1 悄悄关注，2 关注，6 互关，128 拉黑。
      uploader ? optional<{ attribute?: number }>('/x/relation', { fid: uploader }) : undefined,
    ])
    const state: VideoActionState = {
      isLiked: liked === 1,
      coins: coins?.multiply ?? 0,
      maxCoins: target.maxCoins,
      coinsPerDay: COINS_PER_DAY,
    }
    if (typeof todayExp === 'number') state.coinsToday = Math.min(Math.floor(todayExp / 10), COINS_PER_DAY)
    if (target.canFavorite) state.isFavorited = favoured?.favoured ?? false
    if (uploader && relation) state.isFollowingUploader = [1, 2, 6].includes(relation.attribute ?? 0)
    // app 接口要 TV 登录的 token；参考 App 也读不到状态，从「没点」开始。
    if (target.canFavorite && this.session.credential?.token) state.isDisliked = false
    return state
  }

  async like(video: string, value: boolean, signal: AbortSignal): Promise<void> {
    const target = await this.target(video, signal)
    await this.session.action(`${API}/x/web-interface/archive/like`, { aid: String(target.aid), like: value ? '1' : '2' }, signal)
  }

  /** 「不喜欢」：app 接口，`dislike` 0 标记、1 取消。 */
  async dislike(video: string, value: boolean, signal: AbortSignal): Promise<void> {
    const target = await this.target(video, signal)
    if (!target.canFavorite) throw badRequest('番剧不能标记不喜欢')
    await this.session.appAction('https://app.biliapi.net/x/v2/view/dislike', { aid: String(target.aid), dislike: value ? '0' : '1' }, signal)
  }

  async coins(video: string, count: number, signal: AbortSignal): Promise<void> {
    const target = await this.target(video, signal)
    if (count < 1 || count > target.maxCoins) throw badRequest(`最多投 ${target.maxCoins} 个币`)
    await this.session.action(`${API}/x/web-interface/coin/add`, { aid: String(target.aid), multiply: String(count), select_like: '1' }, signal)
  }

  async favorites(video: string, signal: AbortSignal): Promise<FavoriteFolder[]> {
    const target = await this.target(video, signal)
    const data = await this.session.get<{ list?: { id: number; title: string; fav_state?: number }[] | null }>(`${API}/x/v3/fav/folder/created/list-all`, {
      up_mid: this.session.mid, rid: String(target.aid), type: '2',
    }, { signal, sign: 'none' })
    return (data.list ?? []).map((folder) => ({ id: String(folder.id), title: folder.title, containsVideo: folder.fav_state === 1 }))
  }

  async updateFavorites(video: string, adding: string[], removing: string[], signal: AbortSignal): Promise<void> {
    const target = await this.target(video, signal)
    await this.session.action(`${API}/x/v3/fav/resource/deal`, {
      rid: String(target.aid), type: '2', add_media_ids: adding.join(','), del_media_ids: removing.join(','),
    }, signal)
  }

  async follow(uploader: string, value: boolean, signal: AbortSignal): Promise<void> {
    await this.session.action(`${API}/x/relation/modify`, { fid: uploader, act: value ? '1' : '2', re_src: '14' }, signal)
  }

  // MARK: 评论

  /** 视频（每个分P共用）或那一集的 aid。 */
  private async aid(video: string, signal: AbortSignal): Promise<number> {
    return (await this.target(video, signal)).aid
  }

  async comments(video: string, sort: CommentSort, signal: AbortSignal): Promise<CommentPage> {
    return this.mainPage({ kind: 'main', oid: await this.aid(video, signal), mode: sort === 'hot' ? 3 : 2, offset: '' }, signal)
  }

  async commentPage(raw: string, signal: AbortSignal): Promise<CommentPage> {
    const cursor = decodeCursor(raw)
    return cursor.kind === 'main' ? this.mainPage(cursor, signal) : this.repliesPage(cursor, signal)
  }

  /** 一页评论；第一页还带置顶的（列表里不重复）。没登录时 B 站只给前 3 条。 */
  private async mainPage(cursor: CommentCursor, signal: AbortSignal): Promise<CommentPage> {
    const data = await this.session.get<{
      cursor?: { is_end?: boolean; all_count?: number; pagination_reply?: { next_offset?: string } }
      replies?: BiliReply[] | null
      top_replies?: BiliReply[] | null
    }>(`${API}/x/v2/reply/wbi/main`, {
      oid: String(cursor.oid), type: '1', mode: String(cursor.mode ?? 3), pagination_str: JSON.stringify({ offset: cursor.offset ?? '' }),
      plat: '1', web_location: '1315875',
    }, { signal })
    const pinned = cursor.offset ? [] : data.top_replies ?? []
    const pinnedIDs = new Set(pinned.map((reply) => reply.rpid))
    const replies = (data.replies ?? []).filter((reply) => !pinnedIDs.has(reply.rpid))
    const next = data.cursor?.pagination_reply?.next_offset ?? ''
    const end = data.cursor?.is_end ?? true
    return {
      comments: [...pinned.map((r) => replyComment(r, true, repliesCursor)), ...replies.map((r) => replyComment(r, false, repliesCursor))],
      next: end || !next ? null : encodeCursor({ ...cursor, offset: next }),
      total: data.cursor?.all_count,
    }
  }

  /** 一条评论下的一页回复，旧的在前。 */
  private async repliesPage(cursor: CommentCursor, signal: AbortSignal): Promise<CommentPage> {
    const page = cursor.page ?? 1
    const data = await this.session.get<{ page?: { count?: number }; replies?: BiliReply[] | null }>(`${API}/x/v2/reply/reply`, {
      oid: String(cursor.oid), type: '1', root: String(cursor.root ?? 0), pn: String(page), ps: String(REPLIES_PAGE),
    }, { signal, sign: 'none' })
    const replies = data.replies ?? []
    const total = data.page?.count ?? 0
    return {
      comments: replies.map((r) => replyComment(r, false, repliesCursor)),
      next: replies.length > 0 && page * REPLIES_PAGE < total ? encodeCursor({ ...cursor, page: page + 1 }) : null,
      total: data.page?.count,
    }
  }
}

/** 一页评论或回复从哪开始（`offset` 本身是不透明的字符串）。 */
export interface CommentCursor {
  kind: 'main' | 'replies'
  oid: number
  /** 评论：3 最热，2 最新。 */
  mode?: number
  /** 评论：`pagination_reply.next_offset`，第一页为空。 */
  offset?: string
  /** 回复：所回复的评论。 */
  root?: number
  /** 回复：从 1 起。 */
  page?: number
}

export function encodeCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeCursor(raw: string): CommentCursor {
  try {
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CommentCursor
    if ((cursor.kind === 'main' || cursor.kind === 'replies') && Number.isInteger(cursor.oid)) return cursor
  } catch {
    // 落到下面
  }
  throw badRequest('评论游标不对')
}

const repliesCursor = (reply: BiliReply) => encodeCursor({ kind: 'replies', oid: reply.oid, root: reply.rpid, page: 1 })
