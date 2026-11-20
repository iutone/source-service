import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

/** 能直接交给 AVPlayer 的文件。 */
export const PLAYABLE = new Set(['.mp4', '.m4v', '.mov'])
/** 列出来但暂不能播（需要转封装，SERVER.md §13）。 */
export const LISTED = new Set(['.mkv', '.avi', '.webm', '.ts', '.flv', '.wmv', '.rmvb'])
const SUBTITLES = new Set(['.vtt', '.srt'])
const IMAGES = ['.jpg', '.jpeg', '.png', '.webp']
const SKIPPED = new Set(['@eaDir', '#recycle', '#snapshot', 'lost+found', '$RECYCLE.BIN', 'System Volume Information'])

export interface VideoFile {
  /** 相对根目录的路径（`/` 分隔），也是它的 id 来源。 */
  rel: string
  path: string
  title: string
  stage: string
  playable: boolean
  size: number
  modified: number
  poster?: string
  subtitles: SidecarSubtitle[]
}

export interface SidecarSubtitle {
  key: string
  language: string
  path: string
}

export interface Show {
  rel: string
  title: string
  plot?: string
  year?: string
  genres: string[]
  poster?: string
  fanart?: string
  episodes: VideoFile[]
  modified: number
}

export interface ChannelDir {
  id: string
  title: string
  shows: Show[]
  videos: VideoFile[]
}

export interface Library {
  channels: ChannelDir[]
  shows: Map<string, Show>
  videos: Map<string, VideoFile>
  /** 视频所在的节目。 */
  showOf: Map<string, Show>
  scannedAt: number
}

export const ROOT_CHANNEL = '__root'

/** id 是相对路径的 base64url。 */
export const encodeID = (rel: string) => Buffer.from(rel, 'utf8').toString('base64url')
export const decodeID = (id: string) => Buffer.from(id, 'base64url').toString('utf8')

/** `root` 之内的绝对路径；越界（`..`、绝对路径）返回 undefined。 */
export function inside(root: string, rel: string): string | undefined {
  const absolute = resolve(root, rel)
  const base = resolve(root)
  return absolute === base || absolute.startsWith(base + sep) ? absolute : undefined
}

const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' })

/** 扫描目录：一级子目录是频道，频道下的子目录是节目（其中的视频递归收集为分集），频道下的文件是单个视频。 */
export async function scan(root: string): Promise<Library> {
  const library: Library = { channels: [], shows: new Map(), videos: new Map(), showOf: new Map(), scannedAt: Date.now() }
  const top = await entries(root)
  const rootVideos = await videosIn(root, root, top.files)
  if (rootVideos.length) library.channels.push({ id: ROOT_CHANNEL, title: '未分类', shows: [], videos: rootVideos })
  for (const directory of top.directories) {
    const channelPath = join(root, directory)
    const inner = await entries(channelPath)
    const channel: ChannelDir = {
      id: encodeID(directory),
      title: directory,
      shows: [],
      videos: await videosIn(root, channelPath, inner.files),
    }
    for (const showDirectory of inner.directories) {
      const show = await readShow(root, join(channelPath, showDirectory))
      if (show.episodes.length) channel.shows.push(show)
    }
    channel.shows.sort((a, b) => collator.compare(a.title, b.title))
    if (channel.shows.length || channel.videos.length) library.channels.push(channel)
  }
  library.channels.sort((a, b) => (a.id === ROOT_CHANNEL ? 1 : b.id === ROOT_CHANNEL ? -1 : collator.compare(a.title, b.title)))
  for (const channel of library.channels) {
    for (const video of channel.videos) library.videos.set(video.rel, video)
    for (const show of channel.shows) {
      library.shows.set(show.rel, show)
      for (const episode of show.episodes) {
        library.videos.set(episode.rel, episode)
        library.showOf.set(episode.rel, show)
      }
    }
  }
  return library
}

async function entries(directory: string): Promise<{ directories: string[]; files: string[] }> {
  const directories: string[] = []
  const files: string[] = []
  let list
  try {
    list = await readdir(directory, { withFileTypes: true })
  } catch {
    return { directories, files }
  }
  for (const entry of list) {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue
    if (entry.isDirectory()) directories.push(entry.name)
    else if (entry.isFile()) files.push(entry.name)
  }
  directories.sort(collator.compare)
  files.sort(collator.compare)
  return { directories, files }
}

async function videosIn(root: string, directory: string, files: string[]): Promise<VideoFile[]> {
  const videos: VideoFile[] = []
  const names = new Set(files)
  for (const [index, name] of files.entries()) {
    const extension = extname(name).toLowerCase()
    if (!PLAYABLE.has(extension) && !LISTED.has(extension)) continue
    const path = join(directory, name)
    const info = await stat(path)
    const base = name.slice(0, -extension.length)
    videos.push({
      rel: relative(root, path).split(sep).join('/'),
      path,
      title: base,
      stage: stageOf(base, index + 1),
      playable: PLAYABLE.has(extension),
      size: info.size,
      modified: info.mtimeMs,
      poster: firstExisting(directory, names, [base, `${base}-poster`, `${base}-thumb`], IMAGES),
      subtitles: sidecars(directory, files, base),
    })
  }
  return videos
}

async function readShow(root: string, directory: string): Promise<Show> {
  const episodes: VideoFile[] = []
  const walk = async (current: string) => {
    const inner = await entries(current)
    episodes.push(...(await videosIn(root, current, inner.files)))
    for (const child of inner.directories) await walk(join(current, child))
  }
  await walk(directory)
  episodes.sort((a, b) => collator.compare(a.rel, b.rel))
  episodes.forEach((episode, index) => {
    episode.stage = stageOf(episode.title, index + 1)
  })
  const top = await entries(directory)
  const names = new Set(top.files)
  const nfo = names.has('tvshow.nfo') ? await readNFO(join(directory, 'tvshow.nfo')) : {}
  return {
    rel: relative(root, directory).split(sep).join('/'),
    title: nfo.title || basename(directory),
    plot: nfo.plot,
    year: nfo.year,
    genres: nfo.genres ?? [],
    poster: firstExisting(directory, names, ['poster', 'folder', 'cover'], IMAGES),
    fanart: firstExisting(directory, names, ['fanart', 'backdrop', 'landscape'], IMAGES),
    episodes,
    modified: Math.max(0, ...episodes.map((episode) => episode.modified)),
  }
}

function firstExisting(directory: string, names: Set<string>, bases: string[], extensions: string[]): string | undefined {
  for (const base of bases) {
    for (const extension of extensions) {
      if (names.has(`${base}${extension}`)) return join(directory, `${base}${extension}`)
    }
  }
  return undefined
}

/** `name.vtt`、`name.zh.srt`、`name.en.vtt`。 */
function sidecars(directory: string, files: string[], base: string): SidecarSubtitle[] {
  const found: SidecarSubtitle[] = []
  for (const file of files) {
    const extension = extname(file).toLowerCase()
    if (!SUBTITLES.has(extension) || !file.startsWith(base)) continue
    const middle = file.slice(base.length, -extension.length)
    if (middle !== '' && !/^\.[A-Za-z-]{2,10}$/.test(middle)) continue
    const language = middle.slice(1) || 'und'
    found.push({ key: language === 'und' ? `sub${found.length}` : language, language, path: join(directory, file) })
  }
  return found
}

/** 从文件名取集数：S01E03、E03、第3集、开头的数字；都没有就按顺序。 */
export function stageOf(name: string, fallback: number): string {
  const match = /[Ee][Pp]?(\d{1,4})(?!\d)/.exec(name) ?? /第\s*(\d{1,4})\s*[集话話期]/.exec(name) ?? /^(\d{1,4})(?!\d)/.exec(name)
  return String(match ? Number(match[1]) : fallback)
}

async function readNFO(path: string): Promise<{ title?: string; plot?: string; year?: string; genres?: string[] }> {
  try {
    const xml = await readFile(path, 'utf8')
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim()
    const genres = [...xml.matchAll(/<genre>([\s\S]*?)<\/genre>/g)].map((m) => m[1].trim()).filter(Boolean)
    return { title: tag('title'), plot: tag('plot'), year: tag('year') ?? tag('premiered')?.slice(0, 4), genres }
  } catch {
    return {}
  }
}
