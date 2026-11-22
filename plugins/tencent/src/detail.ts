// 节目和视频的详情（API.md §3，App 的 TencentDetailService / TencentComments），照播放页的加载：
// `detail_page_introduction`（资料、简介、演员）和 `vsite_episode_list`（正片和预告，按 `tabs` 分段）；推荐是桌面播放页的
// 「为你推荐」（`getPage` scene `desk_detail` 第二页的 `pc_detail_rec`）；续播点来自观看历史。评论是播放页的「讨论」：
// 一部剧一个列表，`ip_doki_rec`（热门）/ `ip_doki_new`（最新），回复是 `feed_detail_comment`；字段里的字符串都是 base64。
import type { Comment, CommentPage, CommentSort, Credit, Episode, EpisodeList, EpisodeRange, MediaItem, ResumePoint, ShowDetail, Target } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import { badgeOf, imageTag, mediaItem } from './feed.ts'
import { coverID, parseID, videoID } from './ids.ts'
import { arr, imageURL, int, isObject, num, pageItems, parseJSON, str, text } from './json.ts'
import { apiError, type TencentSession } from './session.ts'
import { historyItem, type TencentHistory } from './history.ts'

/** 介绍的 `type`：1 电影、2 剧集、10 综艺…… */
const FILM_TYPE = '1'
const REPLIES_PAGE = 'feed_detail_comment'

export const notFoundShow = () => new SourceError('not_found', '找不到该节目')

// MARK: 解析

/** 条目的 params，演员（`sub_items.star_list`）放在 `stars` 下。 */
export function flatten(item: any): any {
  return { ...(isObject(item?.item_params) ? item.item_params : {}), stars: arr(item?.sub_items?.star_list?.item_datas).map((s) => s?.item_params).filter(Boolean) }
}

const isNumbered = (params: any) => /^\d+$/.test(text(params?.title) ?? '')

/** - Parameter extrasUnnumbered: 列表给正片编了号，没编号的就是花絮。 */
export function episodeOf(params: any, extrasUnnumbered = false): Episode | undefined {
  const vid = text(params?.vid)
  if (!vid) return undefined
  const isTrailer = str(params.is_trailer) === '1'
  const isExtra = !isTrailer && extrasUnnumbered && !isNumbered(params)
  const corner = imageTag(params.uni_imgtag, 'tag_2')
  const title = text(params.play_title) ?? text(params.union_title) ?? text(params.title) ?? ''
  const number = text(params.title) ?? ''
  const stage = isTrailer ? `${number}集预告` : isNumbered(params) || isExtra ? number : (text(params.c_title_output) ?? number)
  const output = text(params.c_title_output)
  const extraTitle = output && output !== number ? output : undefined
  return {
    id: videoID(vid),
    title: (isExtra ? extraTitle : undefined) ?? text(params.video_subtitle) ?? title,
    stage,
    isFeature: !isTrailer && !isExtra,
    kind: isTrailer ? '预告' : isExtra ? '花絮' : undefined,
    imageURL: imageURL(params.image_url),
    isPaid: corner?.includes('VIP') === true,
    badge: badgeOf(corner),
  }
}

/** 选集模块的视频（`item_type` 1 带 `vid`），`tabs` 作为分段。预告不算正片；编了号的列表里没编号的（彩蛋、采访）也不算。 */
export function episodeList(data: any, cid: string): EpisodeList {
  const modules = arr(data?.module_list_datas).flatMap((m) => arr(m?.module_datas))
  const module = modules.find((m) => text(m?.module_params?.page_id) === 'vsite_episode_list') ?? modules[0] ?? {}
  const entries = arr(module?.item_data_lists?.item_datas).filter((i) => str(i?.item_type) === '1').map((i) => i.item_params)
  const numbered = entries.some((e) => str(e?.is_trailer) !== '1' && isNumbered(e))
  const episodes = entries.map((e) => episodeOf(e, numbered)).filter(Boolean) as Episode[]
  const tabs = arr(parseJSON(module?.module_params?.tabs))
  const ranges: (EpisodeRange & { selected: boolean })[] = tabs.length > 1 ? tabs.flatMap((tab) => {
    const context = text(tab?.page_context)
    if (!context) return []
    const begin = text(tab.begin_text) ?? str(tab.begin) ?? ''
    const end = text(tab.end_text) ?? str(tab.end) ?? ''
    return [{ title: begin === end ? begin : `${begin}-${end}`, cursor: `ep:${cid}:${context}`, selected: tab.selected === true }]
  }) : []
  const plainRanges = ranges.map(({ title, cursor }) => ({ title, cursor }))
  const selected = ranges.findIndex((r) => r.selected)
  return { episodes, ranges: plainRanges, selectedRange: plainRanges[selected] ?? plainRanges[0] }
}

export function detailOf(intro: any, cid: string, options: { defaultVideoID?: string; episodes?: EpisodeList; isFilm?: boolean; recommendations?: MediaItem[] } = {}): ShowDetail {
  const genres = [text(intro.main_genres), text(intro.sub_genre)].filter((g): g is string => Boolean(g))
  const year = text(intro.year) ?? text(intro.cover_year)
  const attributes = [text(intro.area_name), year, genres[0]].filter(Boolean).join('·')
  const credits: Credit[] = arr(intro.stars).flatMap((star) => {
    const name = text(star?.name)
    return name ? [{ id: text(star.name_id) ?? name, name, avatarURL: imageURL(star.star_imgurl) }] : []
  })
  const tag = text(intro.tag_text)
  const paid = tag ? /VIP|付费|会员/.test(tag) : false
  const score = num(intro.score)
  const total = int(intro.episode_all)
  return {
    showID: coverID(cid),
    kind: options.isFilm ? 'standalone' : undefined,
    title: text(intro.title) ?? '',
    tagline: text(intro.short_description),
    shortSummary: text(intro.cover_description),
    summary: text(intro.cover_description),
    attributes: attributes || undefined,
    posterURL: imageURL(intro.new_pic_vt),
    landscapeURL: imageURL(intro.new_pic_hz),
    badge: badgeOf(tag),
    updateInfo: text(intro.update_notify_desc) ?? (total ? `共${total}集` : undefined),
    heat: int(intro.hot_num),
    ratings: score && score > 0 ? [{ source: 'platform', score: score.toFixed(1) }] : [],
    tags: genres,
    isPaid: paid,
    credits,
    defaultVideoID: options.defaultVideoID,
    episodes: options.episodes,
    series: [],
    recommendations: { tabs: [], items: options.recommendations ?? [] },
  }
}

/** `children_list` 的键是 "0"、"1"…，各装一张卡。 */
export function recommendationItems(card: any, excluding: string): MediaItem[] {
  const children = card?.children_list
  if (!isObject(children)) return []
  const seen = new Set<string>()
  return Object.keys(children).sort((a, b) => Number(a) - Number(b))
    .flatMap((key) => arr(children[key]?.cards))
    .map((c) => mediaItem(c?.params))
    .filter((item): item is MediaItem => item !== undefined && item.id !== coverID(excluding) && !seen.has(item.id) && Boolean(seen.add(item.id)))
}

/** protobuf JSON 里 base64 的字符串字段。 */
export function decoded(value: unknown): string | undefined {
  const s = text(value)
  if (!s) return undefined
  const out = Buffer.from(s, 'base64').toString('utf8')
  return out ? out : undefined
}

/** 「北京市」→「北京」，「广西壮族自治区」→「广西」，照页面显示。 */
export function province(name: string): string {
  for (const suffix of ['壮族自治区', '回族自治区', '维吾尔自治区', '特别行政区', '自治区', '省', '市']) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name
}

interface CommentCursor {
  page: string
  key: string
  context?: string
}

const encodeCursor = (cursor: CommentCursor) => JSON.stringify(cursor)

/** 一个帖子或一条回复（`item_type` 25）；它的热门回复在 `sub_items.comment_data_list` 里一起来。 */
export function commentOf(item: any, isReply: boolean): Comment | undefined {
  if (str(item?.item_type) !== '25') return undefined
  const post = parseJSON(item.complex_json)
  const base = post?.base
  const id = text(base?.id)
  if (!id) return undefined
  const user = post.user?.base ?? {}
  const content = decoded(post.content?.content) ?? ''
  const pictures = arr(post.photos).map((p) => imageURL(decoded(p?.url))).filter((u): u is string => Boolean(u))
  if (!content && !pictures.length) return undefined
  const replyCount = isReply ? 0 : (int(post.nums?.comments) ?? 0)
  const previews = isReply ? [] : arr(item.sub_items?.comment_data_list?.item_datas).map((r) => commentOf(r, true)).filter(Boolean) as Comment[]
  const key = decoded(post.ext?.msgDatakey)
  const relation = base.relation ?? {}
  const time = num(base.time)
  const area = text(post.area?.province)
  return {
    id,
    author: { name: decoded(user.name) ?? '腾讯视频用户', avatarURL: imageURL(decoded(user.image)), role: decoded(user.authLanguage) },
    text: content,
    pictures: pictures.length ? pictures : undefined,
    date: time ? new Date(time * 1000).toISOString() : undefined,
    location: area ? province(area) : undefined,
    likes: int(post.nums?.likes) ?? 0,
    replyCount,
    previewReplies: previews.length ? previews : undefined,
    replies: replyCount > 0 && key ? encodeCursor({ page: REPLIES_PAGE, key }) : undefined,
    repliesTo: isReply && text(relation.parentId) !== text(relation.rootId) ? decoded(relation.parentUser?.base?.name) : undefined,
  }
}

// MARK: 请求

export class TencentDetail {
  private readonly session: TencentSession
  private readonly history: TencentHistory
  /** 加载过详情的视频所属的节目：评论按节目，不用再查。 */
  private readonly shows = new Map<string, string>()

  constructor(session: TencentSession, history: TencentHistory) {
    this.session = session
    this.history = history
  }

  async detail(target: Target, signal?: AbortSignal): Promise<ShowDetail> {
    const parsed = parseID('show' in target ? target.show : target.video)
    if (!parsed) throw notFoundShow()
    let cid = parsed.kind === 'cover' ? parsed.id : ''
    const playing = parsed.kind === 'video' ? parsed.id : undefined
    const intro = await this.introduction(cid, playing ?? '', signal)
    if (!cid) cid = text(intro['report.cid']) ?? ''
    if (!cid) throw notFoundShow()
    const recommended = this.recommendations(cid, playing ?? '', signal)
    const resume = !playing && this.session.loggedIn ? await this.resumePoint(cid, signal) : undefined
    const episodes = await this.episodes(cid, playing ?? '', '', signal).catch((error) => {
      if (signal?.aborted) throw error
      return undefined
    })
    const isFilm = str(intro.type) === FILM_TYPE
    const defaultVideoID = (playing ? videoID(playing) : undefined) ?? resume?.videoID
      ?? episodes?.episodes.find((e) => e.isFeature)?.id ?? episodes?.episodes[0]?.id
    // 电影的几个版本（普通话版 / 粤语版）是条目，但读起来是一部。
    const entries = isFilm && (episodes?.episodes.length ?? 0) <= 1 ? undefined : episodes
    if (playing) this.shows.set(playing, cid)
    const detail = detailOf(intro, cid, { defaultVideoID, episodes: entries, isFilm, recommendations: await recommended })
    if (resume) detail.resume = resume
    return detail
  }

  /** `ep:<cid>:<page_context>`：一个节目的一段选集。 */
  async episodesAt(cursor: string, signal?: AbortSignal): Promise<EpisodeList> {
    const match = /^ep:([^:]+):(.*)$/s.exec(cursor)
    if (!match) return { episodes: [] }
    return this.episodes(match[1]!, '', match[2]!, signal)
  }

  async resume(show: string | undefined, video: string | undefined, signal?: AbortSignal): Promise<ResumePoint | null> {
    if (!this.session.loggedIn) return null
    let cid = parseID(show)?.kind === 'cover' ? parseID(show)!.id : undefined
    const vid = parseID(video)?.kind === 'video' ? parseID(video)!.id : undefined
    if (!cid && vid) cid = await this.showOf(vid, signal).catch(() => undefined)
    if (!cid) return null
    return (await this.resumePoint(cid, signal)) ?? null
  }

  /** `vid` 所属的节目：记住的，否则查它的介绍的 `report.cid`。 */
  async showOf(vid: string, signal?: AbortSignal): Promise<string> {
    const known = this.shows.get(vid)
    if (known) return known
    const intro = await this.introduction('', vid, signal)
    const cid = text(intro['report.cid'])
    if (!cid) throw notFoundShow()
    this.shows.set(vid, cid)
    if (this.shows.size > 2000) this.shows.delete(this.shows.keys().next().value!)
    return cid
  }

  async resumePoint(cid: string, signal?: AbortSignal): Promise<ResumePoint | undefined> {
    const record = await this.history.record(cid, signal)
    const vid = text(record?.msg?.vid)
    if (!vid) return undefined
    return { videoID: videoID(vid), progress: historyItem(record)?.progress }
  }

  private async pageData(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const response = await this.session.gateway('trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData', {
      query: { video_appid: '3000010', vplatform: '2', vversion_name: '8.2.96' },
      body: { page_params: params, has_cache: 1 },
      signal,
    })
    if (int(response?.ret) !== 0) throw apiError(response?.ret, text(response?.msg))
    return response.data
  }

  /** 介绍的条目：资料、简介、`star_list`；`report.cid` 说出单个 vid 所属的节目。 */
  async introduction(cid: string, vid: string, signal?: AbortSignal): Promise<any> {
    const data = await this.pageData({ req_from: 'web', cid, vid, lid: '', page_type: 'detail_operation', page_id: 'detail_page_introduction' }, signal)
    const item = pageItems(data).find((i) => text(i?.item_params?.title))
    if (!item) throw notFoundShow()
    return flatten(item)
  }

  /** 为你推荐：播放页的第二页卡片（`desk_detail`），其中 `pc_detail_rec` 一个子项一部；失败时没有。 */
  async recommendations(cid: string, vid: string, signal?: AbortSignal): Promise<MediaItem[]> {
    let context: unknown = {}
    for (let i = 0; i < 3; i++) {
      let response: any
      try {
        response = await this.session.gateway('trpc.vector_layout.page_view.PageService/getPage', {
          query: { video_appid: '3000010', vversion_platform: '2' },
          body: {
            page_params: { cid, vid, lid: '', req_from: 'web_vsite', new_mark_label_enabled: '1' },
            page_context: context,
            page_bypass_params: { params: { caller_id: '3000010', platform_id: '2' }, scene: 'desk_detail', abtest_bypass_id: this.session.guid },
          },
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        return []
      }
      if (int(response?.ret) !== 0) return []
      const data = response.data ?? {}
      const card = arr(data.CardList).find((c) => text(c?.type) === 'pc_detail_rec')
      if (card) return recommendationItems(card, cid)
      if (data.has_next_page !== true || data.page_context === undefined) return []
      context = data.page_context
    }
    return []
  }

  /** 一段选集；`context` 为空时是含 `vid` 的那段（或第一段）。 */
  async episodes(cid: string, vid: string, context: string, signal?: AbortSignal): Promise<EpisodeList> {
    const data = await this.pageData({
      req_from: 'web_vsite', page_id: 'vsite_episode_list', page_type: 'detail_operation', id_type: '1', page_size: '',
      cid, vid, lid: '', page_num: '', page_context: context, detail_page_type: '1',
    }, signal)
    return episodeList(data, cid)
  }

  // MARK: 评论

  async comments(video: string, sort: CommentSort, signal?: AbortSignal): Promise<CommentPage> {
    const parsed = parseID(video)
    if (!parsed) throw new SourceError('not_found', '找不到这个视频的评论')
    const cid = parsed.kind === 'cover' ? parsed.id : await this.showOf(parsed.id, signal)
    return this.commentPage({ page: sort === 'hot' ? 'ip_doki_rec' : 'ip_doki_new', key: `cid=${cid}` }, signal)
  }

  async commentsAt(cursor: string, signal?: AbortSignal): Promise<CommentPage> {
    let parsed: CommentCursor
    try {
      parsed = JSON.parse(cursor)
    } catch {
      throw new SourceError('bad_request', '评论游标不对')
    }
    if (typeof parsed?.page !== 'string' || typeof parsed.key !== 'string') throw new SourceError('bad_request', '评论游标不对')
    return this.commentPage(parsed, signal)
  }

  private async commentPage(cursor: CommentCursor, signal?: AbortSignal): Promise<CommentPage> {
    const isReplies = cursor.page === REPLIES_PAGE
    const params: Record<string, string> = { page_id: cursor.page, page_type: 'channel_operation' }
    params[isReplies ? 'dataKey' : 'data_key'] = cursor.key
    const body: Record<string, unknown> = { page_params: params, has_cache: 0 }
    const context = cursor.context ? parseJSON(cursor.context) : undefined
    if (context !== undefined) body.page_context = context
    // 页面跟着设备号翻：不带 guid 时下一页还是第一页。
    const response = await this.session.gateway('trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData', {
      query: { video_appid: '1000005', vversion_name: '1.0.0', vversion_platform: '2', guid: this.session.guid, video_omgid: this.session.guid },
      body,
      signal,
    })
    if (int(response?.ret) !== 0) throw apiError(response?.ret, text(response?.msg))
    const data = response.data ?? {}
    const comments = pageItems(data).map((item) => commentOf(item, isReplies)).filter(Boolean) as Comment[]
    const next = data.has_next_page === true && comments.length && data.next_page_context !== undefined
      ? encodeCursor({ page: cursor.page, key: cursor.key, context: JSON.stringify(data.next_page_context) })
      : null
    return { comments, next }
  }
}
