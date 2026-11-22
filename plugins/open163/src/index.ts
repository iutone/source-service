// IUTone 自建源：网易公开课（docs/remote-source/SERVER.md §20）。首页是网站首页的各栏（服务端渲染的 HTML），频道是手机站
// 的分类，分类和搜索都走网站的搜索接口（网站的分类导航本身就是搜索关键词）；课程、分集、评论、相关推荐走手机站 / 网站的
// JSON 接口。播放直接给课程的 HLS（无需请求头，国内直连），字幕交给 App 加进主列表。
// 随镜像发布在 /app/plugins/open163，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import type { Channel, Comment, Cue, Episode, FeedPage, MediaItem, PlaybackMedia, ShowDetail, Stream, SubtitleTrack } from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { notFound, parseWebVTT, SourceError, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { get, parseHome, plain, quantitySeconds, SITE, USER_AGENT, type Comment as RawComment, type Course, type HomeBlock, type Movie, type SearchEntry } from './api.ts'

export interface Open163Options {
  name?: string
}

const KEYWORD = 'kw:'
/** 置顶的分类（手机站分类的名字）。 */
const PINNED = ['演讲', '大学课程', '纪录片']
const COURSE_TYPES = new Set([1, 13])
const COMMENTS_PAGE = 20

const factory: SourceFactory = (options) => createOpen163Source(options as Open163Options)
export default factory

/** 节目是课程（`plid`），视频是课程里的一节：`<plid>_<mid>`（和网站旧地址 `PLID_MID.html` 一样）。 */
export const videoID = (plid: string, mid: string) => `${plid}_${mid}`
export function splitVideoID(id: string): { plid: string; mid: string } | null {
  const match = id.match(/^([A-Z0-9]+)_([A-Z0-9]+)$/)
  return match ? { plid: match[1], mid: match[2] } : null
}

/** 链接：网站的 `newview/movie/free?pid=&mid=`、旧地址 `movie/…/PLID_MID.html`、手机站和分享页的 `plid=&mid=`。 */
export function linkTarget(raw: string): { target: { video: string } | { show: string } } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)open\.163\.com$/.test(url.hostname)) return null
  const old = url.pathname.match(/\/([A-Z0-9]{9})_([A-Z0-9]{9})\.html$/)
  if (old) return { target: { video: videoID(old[1], old[2]) } }
  const plid = url.searchParams.get('pid') ?? url.searchParams.get('plid') ?? url.searchParams.get('newurl')
  if (!plid || !/^[A-Z0-9]+$/.test(plid)) return null
  const mid = url.searchParams.get('mid')
  return mid && /^[A-Z0-9]+$/.test(mid) ? { target: { video: videoID(plid, mid) } } : { target: { show: plid } }
}

export function entryItem(entry: SearchEntry): MediaItem | undefined {
  const plid = entry.plid ?? entry.contentId
  if (!COURSE_TYPES.has(entry.type) || !plid) return undefined
  return {
    id: plid,
    title: plain(entry.title),
    subtitle: plain(entry.subscribeName) || undefined,
    landscapeURL: entry.image || undefined,
    caption: entry.quantity || undefined,
    stats: entry.playAmount ? { views: entry.playAmount } : undefined,
    target: { show: plid },
  }
}

export function createOpen163Source(options: Open163Options = {}): SourcePlugin {
  const courses = new Map<string, { at: number; course: Promise<Course> }>()
  let classes: { at: number; list: Promise<Channel[]> } | undefined
  let homeCache: { at: number; blocks: Promise<HomeBlock[]> } | undefined

  /** 一门课程（十分钟内重复用：详情、播放、字幕都要它）。 */
  function course(plid: string, ctx: Ctx): Promise<Course> {
    const known = courses.get(plid)
    if (known && Date.now() - known.at < 10 * 60_000) return known.course
    const fresh = get<{ data: Course | null }>('/open/mob/movie/list.do', { plid }, ctx.signal).then((answer) => {
      if (!answer.data?.videoList?.length) throw notFound('这门课程')
      return answer.data
    })
    courses.set(plid, { at: Date.now(), course: fresh })
    fresh.catch(() => { if (courses.get(plid)?.course === fresh) courses.delete(plid) })
    if (courses.size > 300) courses.delete(courses.keys().next().value!)
    return fresh
  }

  /** 手机站的分类：一级是频道，二级是它的子频道（一天读一次）。 */
  function classifications(ctx: Ctx): Promise<Channel[]> {
    if (!classes || Date.now() - classes.at > 24 * 3600_000) {
      const list = get<{ data: { name: string; sons?: { name: string }[] }[] }>('/open/mob/classify/applet/list.do', {}, ctx.signal).then((answer) =>
        answer.data.map((top) => ({
          id: KEYWORD + top.name,
          title: top.name,
          subchannels: (top.sons ?? []).map((son) => ({ id: KEYWORD + son.name, title: son.name })),
        })))
      classes = { at: Date.now(), list }
      list.catch(() => { if (classes?.list === list) classes = undefined })
    }
    return classes.list
  }

  function homeBlocks(ctx: Ctx): Promise<HomeBlock[]> {
    if (!homeCache || Date.now() - homeCache.at > 30 * 60_000) {
      const blocks = (async () => {
        let response: Response
        try {
          response = await fetch(`${SITE}/`, { headers: { 'user-agent': USER_AGENT }, signal: ctx.signal })
        } catch (error) {
          if (ctx.signal.aborted) throw error
          throw new SourceError('unavailable', '连不上网易公开课', { retryable: true, cause: error })
        }
        if (!response.ok) throw new SourceError('unavailable', `网易公开课首页返回 ${response.status}`, { retryable: true })
        const found = parseHome(await response.text())
        if (!found.length) throw new SourceError('upstream_changed', '读不懂网易公开课的首页')
        return found
      })()
      homeCache = { at: Date.now(), blocks }
      blocks.catch(() => { if (homeCache?.blocks === blocks) homeCache = undefined })
    }
    return homeCache.blocks
  }

  /** 按关键词搜课程（分类和搜索都是它）：游标是接口的 `cursor` 加 `searchId`。 */
  async function keyword(word: string, cursor: string | undefined, ctx: Ctx) {
    const [apiCursor, searchId] = cursor ? splitCursor(cursor) : ['', undefined]
    const answer = await get<{ data: { list?: SearchEntry[]; cursor?: string; searchId?: string; total?: number } }>(
      '/open/mob/searchv2/v2/queryAll.do', { keyword: word, tabType: 0, cursor: apiCursor, searchId, mixSpider: 1 }, ctx.signal,
    )
    const list = answer.data.list ?? []
    const items = list.map(entryItem).filter((item): item is MediaItem => item !== undefined)
    const next = list.length && answer.data.cursor ? `${answer.data.cursor}|${answer.data.searchId ?? ''}` : null
    return { items, next }
  }

  const episode = (movie: Movie): Episode => ({
    id: videoID(movie.plid, movie.mid),
    title: movie.title,
    stage: String(movie.pNumber ?? ''),
    isFeature: true,
    imageURL: movie.imgPath,
    isPaid: false,
    duration: movie.mLength,
    views: movie.hits,
  })

  return {
    info: {
      name: options.name ?? '网易公开课',
      brand: { tint: '#2E8B57', tabIconIsWordmark: true },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    feed: {
      homeShowsHistory: false,
      channelBrowser: true,
      async channels(ctx) {
        const list = await classifications(ctx).catch((error) => {
          if (ctx.signal.aborted) throw error
          ctx.log.warn('open163 classify failed', { error: String(error) })
          return PINNED.map((title) => ({ id: KEYWORD + title, title }))
        })
        const home = { id: 'home', title: '推荐' }
        return {
          home,
          pinned: PINNED.map((title) => list.find((c) => c.title === title) ?? { id: KEYWORD + title, title }),
          channels: [home, ...list],
          library: [],
        }
      },
      async channel(id, cursor, ctx): Promise<FeedPage> {
        if (id === 'home') {
          const blocks = await homeBlocks(ctx)
          return {
            sections: blocks.map((block) => ({
              id: `home-${block.id}`,
              title: block.title,
              style: 'grid',
              items: block.items.map((item): MediaItem => ({
                id: item.plid, title: item.title, subtitle: item.note, landscapeURL: item.image,
                target: item.mid ? { video: videoID(item.plid, item.mid) } : { show: item.plid },
              })),
              more: { title: '更多', route: KEYWORD + block.title },
            })),
            next: null,
          }
        }
        if (!id.startsWith(KEYWORD)) throw notFound('这个频道')
        const page = await keyword(id.slice(KEYWORD.length), cursor, ctx)
        return { sections: [{ id: `grid-${id}`, style: 'grid', items: page.items }], next: page.next }
      },
      async more(route, cursor, ctx) {
        if (!route.startsWith(KEYWORD)) throw notFound('这个列表')
        return keyword(route.slice(KEYWORD.length), cursor, ctx)
      },
      async subchannels(id, ctx) {
        return (await classifications(ctx)).find((c) => c.id === id)?.subchannels ?? []
      },
    },

    search: {
      prompt: '搜索网易公开课',
      async search(word, ctx) {
        const page = await keyword(word, undefined, ctx)
        return { shows: [], videos: page.items, moreVideos: page.next }
      },
      async videos(word, cursor, ctx) {
        return keyword(word, cursor, ctx)
      },
    },

    detail: {
      async detail(target, ctx): Promise<ShowDetail> {
        const ids = 'show' in target ? { plid: target.show, mid: undefined } : splitVideoID(target.video)
        if (!ids) throw notFound('这节课')
        const info = await course(ids.plid, ctx)
        const episodes = info.videoList.map(episode)
        const current = ids.mid ? episodes.find((e) => e.id === videoID(ids.plid, ids.mid!)) : undefined
        const related = await recommendations(info.videoList[0].mid, ids.plid, ctx).catch(() => [])
        const facts = [info.school, info.director, `${info.videoList.length} 集`].filter(Boolean).join(' · ')
        return {
          showID: info.plid,
          kind: info.videoList.length > 1 ? 'series' : 'standalone',
          title: info.title,
          tagline: info.subtitle || info.school || undefined,
          shortSummary: facts,
          summary: info.description,
          attributes: facts,
          category: [info.firstClassify, info.secondClassify].filter(Boolean).join(' · ') || info.type,
          landscapeURL: info.largeImgurl || info.imgPath,
          ratings: [],
          tags: (info.tags ?? '').split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          isPaid: false,
          credits: info.director ? [{ id: info.director, name: info.director, role: info.school ? `讲师 · ${info.school}` : '讲师' }] : [],
          defaultVideoID: current?.id ?? episodes[0]?.id,
          episodes: { episodes },
          series: [],
          recommendations: { tabs: [], items: related },
          stats: info.hits ? { views: info.hits } : undefined,
        }
      },
    },

    comments: {
      async first(video, sort, ctx) {
        const ids = splitVideoID(video)
        if (!ids) return { comments: [], next: null }
        return commentPage(ids.mid, sort === 'latest' ? 1 : 0, 1, ctx)
      },
      async page(cursor, ctx) {
        const [mid, sort, page] = cursor.split('|')
        return commentPage(mid, Number(sort), Number(page), ctx)
      },
    },

    links: {
      patterns: ['^https?://(open|m\\.open|c\\.open)\\.163\\.com/.*(pid=|plid=|newurl=|[A-Z0-9]{9}_[A-Z0-9]{9}\\.html)'],
      async resolve(url) {
        return linkTarget(url)
      },
    },

    playback: {
      async resolve(request, ctx): Promise<PlaybackMedia> {
        const ids = splitVideoID(request.video)
        if (!ids) throw notFound('这节课')
        const movie = (await course(ids.plid, ctx)).videoList.find((m) => m.mid === ids.mid)
        if (!movie) throw notFound('这节课')
        const streams = movieStreams(movie)
        if (!streams.length) throw new SourceError('unplayable', '这节课没有网页版的视频（可能只能在网易公开课 App 里看）')
        const subtitles = subtitleTracks(movie, request.video, ctx)
        const cap = request.preferences?.maxQualityRank ?? Number.POSITIVE_INFINITY
        const selected = streams.find((s) => s.quality.rank <= cap) ?? streams.at(-1)!
        return {
          title: movie.title,
          streams,
          selectedStream: selected.id,
          subtitles: subtitles.length ? subtitles : undefined,
          diagnostics: { path: 'open163-direct', subtitles: String(subtitles.length) },
        }
      },
      async cues(ref, key, ctx): Promise<Cue[]> {
        const ids = splitVideoID(ref)
        const movie = ids ? (await course(ids.plid, ctx)).videoList.find((m) => m.mid === ids.mid) : undefined
        const sub = movie?.subList?.[Number(key)]
        if (!sub?.subVttUrl) throw notFound('这条字幕')
        const response = await fetch(sub.subVttUrl, { headers: { 'user-agent': USER_AGENT }, signal: ctx.signal }).catch((error) => {
          if (ctx.signal.aborted) throw error
          throw new SourceError('unavailable', '连不上字幕地址', { retryable: true, cause: error })
        })
        if (!response.ok) throw new SourceError('unavailable', `字幕返回 ${response.status}`, { retryable: true })
        return parseWebVTT(await response.text())
      },
    },
  }

  /** 订阅号（学校、机构）的其他课程，作为相关推荐。 */
  async function recommendations(mid: string, plid: string, ctx: Ctx): Promise<MediaItem[]> {
    const answer = await get<{ data: { subscribeName?: string; subscribeList?: { contentTitle: string; plid?: string; image?: string; subscribeContentType: number; quantity?: string }[] } | null }>(
      '/open/mob/subscribe/detail/relate.do', { mid, rtypes: '2,6' }, ctx.signal,
    )
    const seen = new Set([plid])
    return (answer.data?.subscribeList ?? [])
      .filter((entry) => entry.plid && !seen.has(entry.plid) && seen.add(entry.plid))
      .map((entry) => ({
        id: entry.plid!, title: entry.contentTitle, subtitle: answer.data?.subscribeName, landscapeURL: entry.image,
        duration: quantitySeconds(entry.quantity), target: { show: entry.plid! },
      }))
  }

  async function commentPage(mid: string, sort: number, page: number, ctx: Ctx) {
    const answer = await get<{ data: { items: RawComment[]; totalNum: number } }>(
      '/open/pc/comment/list.do', { contentId: mid, sort, type: 2, page, pagesize: COMMENTS_PAGE }, ctx.signal,
    )
    const comments: Comment[] = answer.data.items.map((item) => ({
      id: String(item.id),
      author: { name: item.userName, avatarURL: item.userPhoto },
      text: item.content,
      pictures: item.imageList?.length ? item.imageList : undefined,
      date: new Date(item.dbCreateTime).toISOString(),
      likes: item.voteCount,
      replyCount: item.replyCount,
      previewReplies: (item.replyList ?? []).slice(0, 3).map((reply) => ({
        id: String(reply.id),
        author: { name: reply.userNameFrom, avatarURL: reply.userPhotoFrom },
        text: reply.content,
        date: new Date(reply.dbCreateTime).toISOString(),
        likes: reply.voteCount,
        repliesTo: reply.userNameTo && reply.userNameTo !== reply.userNameFrom ? reply.userNameTo : undefined,
      })),
    }))
    const more = page * COMMENTS_PAGE < answer.data.totalNum && answer.data.items.length > 0
    return { comments, next: more ? `${mid}|${sort}|${page + 1}` : null, total: page === 1 ? answer.data.totalNum : undefined }
  }
}

const TIERS: [string, number, string][] = [['Shd', 720, '超清'], ['Hd', 480, '高清'], ['Sd', 360, '标清']]

/** 各清晰度：HLS（字幕可加进主列表）优先，没有就用 MP4；`*Orign` 是另一份（老课程常只有它）。 */
export function movieStreams(movie: Movie): Stream[] {
  const streams: Stream[] = []
  const field = (name: string) => (typeof movie[name] === 'string' && movie[name] ? movie[name] as string : undefined)
  for (const [tier, rank, label] of TIERS) {
    const hls = field(`m3u8${tier}Url`) ?? field(`m3u8${tier}UrlOrign`)
    const mp4 = field(`mp4${tier}Url`) ?? field(`mp4${tier}UrlOrign`)
    if (hls) streams.push({ id: tier.toLowerCase(), url: hls, format: 'hls', quality: { rank, label }, description: `open163 hls ${tier.toLowerCase()}` })
    else if (mp4) streams.push({ id: tier.toLowerCase(), url: mp4, format: 'mp4', quality: { rank, label }, description: `open163 mp4 ${tier.toLowerCase()}`, keepable: true })
  }
  return streams
}

/** 课程的字幕（中文、英文…），按 `subList` 的位置做 key。 */
function subtitleTracks(movie: Movie, ref: string, ctx: Ctx): SubtitleTrack[] {
  return (movie.subList ?? []).flatMap((sub, index) => {
    if (!sub.subVttUrl) return []
    const language = /中/.test(sub.subName) ? 'zh' : /英/.test(sub.subName) ? 'en' : ''
    return [{
      key: String(index), name: sub.subName, language, generated: false, vtt: sub.subVttUrl,
      cues: `${BASE_PATH}/sources/${ctx.sourceId}/subtitles/${ref}/${index}`,
    }]
  })
}

function splitCursor(cursor: string): [string, string | undefined] {
  const at = cursor.lastIndexOf('|')
  return at < 0 ? [cursor, undefined] : [cursor.slice(0, at), cursor.slice(at + 1) || undefined]
}
