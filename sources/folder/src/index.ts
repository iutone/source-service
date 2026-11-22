import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type {
  Channels,
  EpisodeList,
  FeedPage,
  FeedSection,
  MediaItem,
  MediaItemPage,
  PlaybackMedia,
  ShowDetail,
  SubtitleTrack,
  VideoItem,
} from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import { badRequest, codecName, codecSupported, notFound, SourceError, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { decodeID, encodeID, inside, type Library, type Show, ROOT_CHANNEL, scan, type VideoFile } from './library.ts'
import { parseSubtitles, toWebVTT } from './subtitles.ts'

/**
 * 示例源：本地视频目录（SERVER.md §13）。一级子目录是频道，频道下的子目录是节目，单独的文件是单个视频。
 * 无需登录；进度记在服务端，作为「继续观看」和观看历史。
 */
export interface FolderOptions {
  path: string
  name?: string
  /** 重新扫描的间隔，秒。 */
  rescan?: number
}

interface Progress {
  position: number
  duration?: number
  updatedAt: string
}

const PAGE = 60
const HISTORY_PAGE = 30
const FINISHED = 0.95

const factory: SourceFactory = (options) => {
  const config = options as unknown as FolderOptions
  if (!config.path) throw new Error('folder 源需要 options.path')
  return createFolderSource(config)
}
export default factory

export function createFolderSource(config: FolderOptions): SourcePlugin {
  const root = config.path
  const rescanMs = (config.rescan ?? 60) * 1000
  let library: Library | undefined
  let scanning: Promise<Library> | undefined
  const probes = new Map<string, Promise<Probe | undefined>>()

  async function lib(): Promise<Library> {
    if (library && Date.now() - library.scannedAt < rescanMs) return library
    scanning ??= scan(root).then((fresh) => {
      library = fresh
      scanning = undefined
      return fresh
    }, (error) => {
      scanning = undefined
      throw error
    })
    return library ?? scanning
  }

  const progressOf = (ctx: Ctx) => ctx.store.get<Record<string, Progress>>('progress') ?? {}
  const image = (ctx: Ctx, path: string | undefined) => (path ? ctx.media.file(path, { stable: true }) : undefined)
  const fraction = (progress: Progress | undefined) =>
    progress?.duration ? Math.min(1, progress.position / progress.duration) : undefined

  function video(library: Library, id: string): VideoFile {
    let rel: string
    try {
      rel = decodeID(id)
    } catch {
      throw badRequest('id 无效')
    }
    if (!inside(root, rel)) throw badRequest('id 无效')
    const found = library.videos.get(rel)
    if (!found) throw notFound('视频')
    return found
  }

  function show(library: Library, id: string): Show {
    const found = library.shows.get(decodeID(id))
    if (!found) throw notFound('节目')
    return found
  }

  function showItem(ctx: Ctx, show: Show, progress: Record<string, Progress>): MediaItem {
    const watched = show.episodes.filter((episode) => (fraction(progress[episode.rel]) ?? 0) >= FINISHED).length
    return {
      id: encodeID(show.rel),
      title: show.title,
      posterURL: image(ctx, show.poster),
      landscapeURL: image(ctx, show.fanart ?? show.episodes[0]?.poster),
      caption: show.episodes.length > 1 ? `${show.episodes.length} 集${watched ? ` · 看过 ${watched}` : ''}` : undefined,
      publishedAt: new Date(show.modified).toISOString(),
      target: { show: encodeID(show.rel) },
    }
  }

  function videoItem(ctx: Ctx, file: VideoFile, progress: Record<string, Progress>, owner?: Show): MediaItem {
    return {
      id: encodeID(file.rel),
      title: owner ? `${owner.title} ${file.title}` : file.title,
      landscapeURL: image(ctx, file.poster ?? owner?.fanart),
      posterURL: image(ctx, owner?.poster),
      badge: file.playable ? undefined : { text: '不支持', tone: 'neutral' },
      progress: fraction(progress[file.rel]),
      publishedAt: new Date(file.modified).toISOString(),
      target: { video: encodeID(file.rel) },
    }
  }

  function channelItems(ctx: Ctx, library: Library, channelID: string, progress: Record<string, Progress>): MediaItem[] {
    const channel = library.channels.find((c) => c.id === channelID)
    if (!channel) throw notFound('频道')
    return [...channel.shows.map((s) => showItem(ctx, s, progress)), ...channel.videos.map((v) => videoItem(ctx, v, progress))]
  }

  function page(items: MediaItem[], cursor: string | undefined): MediaItemPage {
    const offset = cursor ? Number(cursor) || 0 : 0
    const next = offset + PAGE < items.length ? String(offset + PAGE) : null
    return { items: items.slice(offset, offset + PAGE), next }
  }

  function episodeList(ctx: Ctx, show: Show): EpisodeList {
    return {
      episodes: show.episodes.map((episode) => ({
        id: encodeID(episode.rel),
        title: episode.title,
        stage: episode.stage,
        isFeature: true,
        imageURL: image(ctx, episode.poster),
        isPaid: false,
        badge: episode.playable ? undefined : { text: '不支持', tone: 'neutral' },
        publishedAt: new Date(episode.modified).toISOString(),
      })),
      summary: `${show.episodes.length} 集`,
    }
  }

  /** 节目里接着看哪一集：最近看过且没看完的，否则最近看完那集的下一集。 */
  function resumeIn(show: Show, progress: Record<string, Progress>): { videoID: string; progress?: number } | undefined {
    let latest: { index: number; at: string } | undefined
    show.episodes.forEach((episode, index) => {
      const p = progress[episode.rel]
      if (p && (!latest || p.updatedAt > latest.at)) latest = { index, at: p.updatedAt }
    })
    if (!latest) return undefined
    const episode = show.episodes[latest.index]
    const watched = fraction(progress[episode.rel]) ?? 0
    if (watched < FINISHED) return { videoID: encodeID(episode.rel), progress: watched }
    const next = show.episodes[latest.index + 1]
    return next ? { videoID: encodeID(next.rel), progress: 0 } : undefined
  }

  async function probe(path: string): Promise<Probe | undefined> {
    if (!probes.has(path)) probes.set(path, runProbe(path))
    return probes.get(path)
  }

  return {
    info: {
      name: config.name ?? '本地视频',
      brand: { tint: '#3478F6' },
    },

    feed: {
      homeShowsHistory: false,
      channelBrowser: true,
      async channels(): Promise<Channels> {
        const library = await lib()
        const channels = library.channels.map((channel) => ({ id: channel.id, title: channel.title }))
        return { home: { id: 'home', title: '首页' }, pinned: channels.slice(0, 4), channels, library: [] }
      },
      async channel(id, cursor, ctx): Promise<FeedPage> {
        const library = await lib()
        const progress = progressOf(ctx)
        if (id !== 'home') {
          const result = page(channelItems(ctx, library, id, progress), cursor)
          return { sections: [{ id: `grid-${id}`, style: 'grid', items: result.items }], next: result.next }
        }
        const sections: FeedSection[] = []
        const watching = Object.entries(progress)
          .filter(([rel, p]) => library.videos.has(rel) && (fraction(p) ?? 0) < FINISHED && p.position > 5)
          .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 12)
          .map(([rel]) => videoItem(ctx, library.videos.get(rel)!, progress, library.showOf.get(rel)))
        if (watching.length) sections.push({ id: 'continue', title: '继续观看', style: 'continueWatching', items: watching })
        const recent = [
          ...[...library.shows.values()].map((s) => ({ at: s.modified, item: showItem(ctx, s, progress) })),
          ...library.channels.flatMap((c) => c.videos).map((v) => ({ at: v.modified, item: videoItem(ctx, v, progress) })),
        ]
          .sort((a, b) => b.at - a.at)
          .slice(0, 20)
          .map((entry) => entry.item)
        if (recent.length) sections.push({ id: 'recent', title: '最近添加', style: 'row', items: recent })
        for (const channel of library.channels) {
          const items = channelItems(ctx, library, channel.id, progress)
          sections.push({
            id: `channel-${channel.id}`,
            title: channel.title,
            style: 'row',
            items: items.slice(0, 12),
            more: items.length > 12 ? { title: '全部', route: channel.id } : undefined,
          })
        }
        return { sections, next: null }
      },
      async more(route, cursor, ctx) {
        return page(channelItems(ctx, await lib(), route, progressOf(ctx)), cursor)
      },
    },

    search: {
      prompt: '搜索本地视频',
      async suggestions(text) {
        const library = await lib()
        const needle = text.trim().toLowerCase()
        return [...library.shows.values()]
          .filter((s) => s.title.toLowerCase().includes(needle))
          .slice(0, 8)
          .map((s) => ({ keyword: s.title, tag: '节目' }))
      },
      async search(keyword, ctx) {
        const library = await lib()
        const progress = progressOf(ctx)
        const needle = keyword.trim().toLowerCase()
        const shows = [...library.shows.values()].filter((s) => s.title.toLowerCase().includes(needle))
        const videos = [...library.videos.values()].filter((v) => v.title.toLowerCase().includes(needle) && !shows.includes(library.showOf.get(v.rel)!))
        return {
          shows: shows.map((s) => showItem(ctx, s, progress)),
          videos: videos.slice(0, 60).map((v) => videoItem(ctx, v, progress, library.showOf.get(v.rel))),
          moreVideos: null,
        }
      },
    },

    detail: {
      async detail(target, ctx): Promise<ShowDetail> {
        const library = await lib()
        const progress = progressOf(ctx)
        let owner: Show | undefined
        let file: VideoFile | undefined
        if ('show' in target) owner = show(library, target.show)
        else {
          file = video(library, target.video)
          owner = library.showOf.get(file.rel)
        }
        const channel = library.channels.find((c) => (owner ? c.shows.includes(owner) : c.videos.includes(file!)))
        const recommendations = channel
          ? channelItems(ctx, library, channel.id, progress)
              .filter((item) => item.id !== encodeID(owner?.rel ?? file!.rel))
              .slice(0, 12)
          : []
        if (owner) {
          const resume = resumeIn(owner, progress)
          return {
            showID: encodeID(owner.rel),
            kind: owner.episodes.length > 1 ? 'series' : 'standalone',
            title: owner.title,
            summary: owner.plot,
            attributes: [owner.year, ...owner.genres].filter(Boolean).join(' · ') || undefined,
            category: channel?.id === ROOT_CHANNEL ? undefined : channel?.title,
            posterURL: image(ctx, owner.poster),
            landscapeURL: image(ctx, owner.fanart ?? owner.episodes[0]?.poster),
            updateInfo: `${owner.episodes.length} 集`,
            ratings: [],
            tags: owner.genres,
            isPaid: false,
            credits: [],
            defaultVideoID: file ? encodeID(file.rel) : (resume?.videoID ?? encodeID(owner.episodes[0].rel)),
            episodes: episodeList(ctx, owner),
            series: [],
            recommendations: { tabs: [], items: recommendations },
            resume,
          }
        }
        const p = progress[file!.rel]
        return {
          kind: 'standalone',
          title: file!.title,
          category: channel?.id === ROOT_CHANNEL ? undefined : channel?.title,
          landscapeURL: image(ctx, file!.poster),
          ratings: [],
          tags: [],
          isPaid: false,
          credits: [],
          defaultVideoID: encodeID(file!.rel),
          series: [],
          recommendations: { tabs: [], items: recommendations },
          publishedAt: new Date(file!.modified).toISOString(),
          resume: p ? { videoID: encodeID(file!.rel), progress: fraction(p) } : undefined,
          duration: p?.duration,
        }
      },
      async resume(showID, videoID, ctx) {
        const library = await lib()
        const progress = progressOf(ctx)
        if (showID) return resumeIn(show(library, showID), progress) ?? null
        if (videoID) {
          const file = video(library, videoID)
          const p = progress[file.rel]
          return p ? { videoID, progress: fraction(p) } : null
        }
        return null
      },
    },

    history: {
      async page(number, ctx) {
        const library = await lib()
        const progress = progressOf(ctx)
        const all = Object.entries(progress)
          .filter(([rel]) => library.videos.has(rel))
          .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
        const slice = all.slice((number - 1) * HISTORY_PAGE, number * HISTORY_PAGE)
        const items: VideoItem[] = slice.map(([rel, p]) => {
          const file = library.videos.get(rel)!
          const owner = library.showOf.get(rel)
          const watched = fraction(p)
          return {
            id: encodeID(rel),
            showID: owner ? encodeID(owner.rel) : undefined,
            title: owner ? `${owner.title} ${file.title}` : file.title,
            coverURL: image(ctx, file.poster ?? owner?.fanart),
            posterURL: image(ctx, owner?.poster),
            progress: watched,
            watchedPercent: watched === undefined ? undefined : Math.round(watched * 100),
            lastWatched: p.updatedAt,
            isPlayable: file.playable,
            historyKey: rel,
          }
        })
        return { items, hasMore: number * HISTORY_PAGE < all.length }
      },
      async delete(keys, ctx) {
        const progress = progressOf(ctx)
        for (const key of keys) delete progress[key]
        ctx.store.set('progress', progress)
      },
      async clear(ctx) {
        ctx.store.set('progress', {})
      },
    },

    playback: {
      async resolve(request, ctx): Promise<PlaybackMedia> {
        const library = await lib()
        const file = video(library, request.video)
        const owner = library.showOf.get(file.rel)
        if (!file.playable) throw new SourceError('unplayable', '这个格式暂不支持播放（需要转封装）')
        const info = await probe(file.path)
        // 客户端说解不了这个视频编码（没有 HEVC 解码器的盒子）：流标为不可用，App 显示原因（ResolveRequest.preferences.codecs）。
        const codecs = request.preferences?.codecs
        const unsupported = info?.codec && !codecSupported(codecs, info.codec) ? `这台设备不能解码 ${codecName(info.codec)} 视频` : undefined
        const p = progressOf(ctx)[file.rel]
        const watched = fraction(p) ?? 0
        const height = info?.height ?? 0
        const subtitles: SubtitleTrack[] = []
        for (const sidecar of file.subtitles) {
          const text = await readFile(sidecar.path, 'utf8').catch(() => undefined)
          if (text === undefined) continue
          subtitles.push({
            key: sidecar.key,
            name: languageName(sidecar.language),
            language: sidecar.language === 'und' ? '' : sidecar.language,
            generated: false,
            vtt: ctx.media.text(toWebVTT(text), { name: `${sidecar.key}.vtt`, ttl: 6 * 3600 }),
            cues: `${BASE_PATH}/sources/${ctx.sourceId}/subtitles/${request.video}/${encodeURIComponent(sidecar.key)}`,
          })
        }
        return {
          title: owner ? `${owner.title} ${file.title}` : file.title,
          startPosition: p && watched < FINISHED && p.position > 5 ? p.position : undefined,
          streams: [
            {
              id: 'file',
              url: ctx.media.file(file.path, { ttl: 12 * 3600 }),
              format: 'mp4',
              quality: { rank: height, label: height ? `${height}P` : '原画' },
              description: [info?.codec, info?.audioCodec, height ? `${height}p` : undefined, 'local file'].filter(Boolean).join(' '),
              unavailableReason: unsupported,
            },
          ],
          selectedStream: 'file',
          subtitles: subtitles.length ? subtitles : undefined,
          diagnostics: { path: 'file' },
        }
      },
      async progress(request, ctx) {
        const library = await lib()
        const file = video(library, request.video)
        const progress = progressOf(ctx)
        const duration = request.duration ?? progress[file.rel]?.duration
        const position = request.event === 'end' && duration ? duration : request.position
        progress[file.rel] = { position, duration: duration ?? undefined, updatedAt: new Date().toISOString() }
        ctx.store.set('progress', progress)
      },
      async cues(ref, key) {
        const library = await lib()
        const file = video(library, ref)
        const sidecar = file.subtitles.find((s) => s.key === key)
        if (!sidecar) throw notFound('字幕')
        return parseSubtitles(await readFile(sidecar.path, 'utf8'))
      },
    },
  }
}

function languageName(code: string): string {
  if (code === 'und') return '字幕'
  try {
    return new Intl.DisplayNames(['zh-Hans'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

interface Probe {
  height?: number
  codec?: string
  audioCodec?: string
  duration?: number
}

/** ffprobe 读分辨率、视频 / 音频编码；没装 ffprobe 就算了。 */
function runProbe(path: string): Promise<Probe | undefined> {
  return new Promise((resolve) => {
    execFile(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,height,codec_name:format=duration', '-of', 'json', path],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(undefined)
        try {
          type ProbeStream = { codec_type?: string; height?: number; codec_name?: string }
          const data = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { duration?: string } }
          const video = data.streams?.find((s) => s.codec_type === 'video')
          const audio = data.streams?.find((s) => s.codec_type === 'audio')
          resolve({
            height: video?.height,
            codec: video?.codec_name,
            audioCodec: audio?.codec_name,
            duration: data.format?.duration ? Number(data.format.duration) : undefined,
          })
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}
