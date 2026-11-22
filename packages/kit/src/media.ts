import { createHmac, randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { BASE_PATH } from '@iyt-source/protocol'
import { SourceError } from './errors.ts'
import { byteRangePlaylist, dashMaster, readSegmentIndex, type DashAudioTrack, type DashVideoTrack, type SegmentIndex } from './dash.ts'
import { addSubtitleRenditions, isPlaylist, rewritePlaylist, type SubtitleRendition } from './hls.ts'
import type { KeyValueStore } from './store.ts'

/**
 * 媒体网关（SERVER.md §7、§12）：`/iyt/v1/media/<token>/<name>`。
 * - `file`：本地文件，支持 Range / HEAD。
 * - `text`：生成的播放列表、字幕。
 * - `proxy`：带请求头转发上游；HLS 播放列表被改写，其中的地址（子列表、分片、密钥）都指回网关。
 * - `dash`：单文件 DASH 轨道（音视频分开）做成按字节范围的 fMP4 HLS；文件本身直连 CDN 或经网关转发。
 * token 到期后返回 410，App 会重新解析。
 */
type Entry =
  | { kind: 'file'; path: string; contentType?: string; expires: number }
  | { kind: 'text'; body: string; contentType: string; expires: number }
  | { kind: 'generated'; produce: () => Promise<string>; contentType: string; expires: number }
  | {
      kind: 'proxy'
      url: string
      headers: Record<string, string>
      playlist: 'auto' | 'yes' | 'no'
      dispatcher?: unknown
      onRefused?: () => void
      expires: number
      children: string[]
      childIndex: Map<string, number>
    }
  | {
      kind: 'dash'
      videos: DashVideoTrack[]
      audios: DashAudioTrack[]
      subtitles: SubtitleRendition[]
      headers: Record<string, string>
      via: 'direct' | 'proxy'
      dispatcher?: unknown
      onRefused?: () => void
      expires: number
      children: string[]
      childIndex: Map<string, number>
      indexes: Map<string, Promise<SegmentIndex>>
      backups: Map<string, string[]>
      preferred: Map<string, number>
    }

type Children = {
  children: string[]
  childIndex: Map<string, number>
  dispatcher?: unknown
  onRefused?: () => void
  /** 主地址 → 备用地址（DASH 轨道的备用 CDN）。 */
  backups?: Map<string, string[]>
  /** 主地址 → 上次成功的是第几个地址（0 是主地址）：主地址坏了以后直接从好的开始。 */
  preferred?: Map<string, number>
}

export interface MediaOptions {
  /** 有效期，秒；默认 6 小时。 */
  ttl?: number
  /** URL 末段的文件名，便于播放器按扩展名识别；默认取原名。 */
  name?: string
  contentType?: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.m4s': 'video/iso.segment',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export function contentTypeOf(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

export class MediaGateway {
  private readonly entries = new Map<string, Entry>()
  private readonly secret: string
  private readonly persistent?: KeyValueStore
  private readonly sweeper: NodeJS.Timeout

  /**
   * - Parameter persistent: 稳定文件（`stable: true`）的登记存在这里，重启后海报等地址仍有效。
   */
  constructor(options: { secret?: string; persistent?: KeyValueStore } = {}) {
    this.secret = options.secret ?? randomBytes(16).toString('hex')
    this.persistent = options.persistent
    const saved = this.persistent?.get<Record<string, { path: string; contentType?: string }>>('stable-files') ?? {}
    for (const [token, file] of Object.entries(saved)) {
      this.entries.set(token, { kind: 'file', path: file.path, contentType: file.contentType, expires: Number.POSITIVE_INFINITY })
    }
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  close(): void {
    clearInterval(this.sweeper)
  }

  /**
   * 本地文件。`stable: true` 时 token 由路径决定且不过期（海报、logo 等反复出现在列表里的图片）。
   */
  file(path: string, options: MediaOptions & { stable?: boolean } = {}): string {
    const name = options.name ?? basename(path)
    if (options.stable) {
      const token = createHmac('sha256', this.secret).update(path).digest('base64url').slice(0, 22)
      if (!this.entries.has(token)) {
        this.entries.set(token, { kind: 'file', path, contentType: options.contentType, expires: Number.POSITIVE_INFINITY })
        this.saveStable()
      }
      return this.url(token, name)
    }
    return this.add({ kind: 'file', path, contentType: options.contentType, expires: this.expiry(options) }, name)
  }

  text(body: string, options: MediaOptions & { name: string }): string {
    return this.add({ kind: 'text', body, contentType: options.contentType ?? contentTypeOf(options.name), expires: this.expiry(options) }, options.name)
  }

  /**
   * 第一次被请求时才生成的文本（字幕：由源去取、缓存、限流，不让网关直接转发上游）。`produce` 抛的 `SourceError` 原样返回。
   */
  generated(produce: () => Promise<string>, options: MediaOptions & { name: string }): string {
    return this.add({ kind: 'generated', produce, contentType: options.contentType ?? contentTypeOf(options.name), expires: this.expiry(options) }, options.name)
  }

  /**
   * 代理上游地址。`playlist`：`auto` 按响应的 Content-Type 和内容判断是不是 HLS。
   */
  /**
   * - Parameter dispatcher: 上游请求走的出口（出口池的，SERVER.md §18）；省略走全局代理。地址绑了解析时出口 IP 的
   *   （YouTube 的 googlevideo）必须和解析时同一个出口。
   */
  /**
   * - Parameter onRefused: 上游拒了这个地址（403 / 410，签名过期或绑定的出口不对）时调用：源可以丢掉它缓存的解析结果，
   *   让 App 重试时拿到新地址，而不是缓存期内一直拿到同一个坏地址。
   */
  proxy(url: string, options: MediaOptions & { headers?: Record<string, string>; playlist?: 'auto' | 'yes' | 'no'; dispatcher?: unknown; onRefused?: () => void } = {}): string {
    const name = options.name ?? (basename(new URL(url).pathname) || 'media')
    return this.add(
      {
        kind: 'proxy',
        url,
        headers: options.headers ?? {},
        playlist: options.playlist ?? 'auto',
        dispatcher: options.dispatcher,
        onRefused: options.onRefused,
        expires: this.expiry(options),
        children: [],
        childIndex: new Map(),
      },
      name,
    )
  }

  /**
   * 音视频分开的单文件 DASH 轨道（YouTube 的 https 格式），返回 master 地址。分段索引在播放器第一次请求时读取。
   * 轨道的 `backupURLs`：`via: proxy` 时取主地址失败（连不上、403 / 404 / 410 / 429 / 5xx）就换下一个，读分段索引也一样；
   * `direct` 时播放列表里只有主地址。
   * - Parameter via: `direct` 分片地址直接给 CDN（App 和服务同一出口时可用，省 NAS 带宽）；`proxy` 经网关转发。
   */
  dash(tracks: { videos: DashVideoTrack[]; audios: DashAudioTrack[]; subtitles?: SubtitleRendition[] }, options: MediaOptions & { headers?: Record<string, string>; via?: 'direct' | 'proxy'; dispatcher?: unknown; onRefused?: () => void } = {}): string {
    if (tracks.videos.length === 0) throw new SourceError('unplayable', '没有可播放的视频轨')
    return this.add(
      {
        kind: 'dash',
        videos: tracks.videos,
        audios: tracks.audios,
        subtitles: tracks.subtitles ?? [],
        headers: options.headers ?? {},
        via: options.via ?? 'proxy',
        dispatcher: options.dispatcher,
        onRefused: options.onRefused,
        expires: this.expiry(options),
        children: [],
        childIndex: new Map(),
        indexes: new Map(),
        backups: new Map([...tracks.videos, ...tracks.audios].filter((t) => t.backupURLs?.length).map((t) => [t.url, t.backupURLs!])),
        preferred: new Map(),
      },
      options.name ?? 'master.m3u8',
    )
  }

  /** 处理 `GET|HEAD /iyt/v1/media/<token>/<rest>`。 */
  async handle(token: string, rest: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const entry = this.entries.get(token)
    if (!entry || entry.expires < Date.now()) {
      if (entry) this.entries.delete(token)
      throw new SourceError('unplayable', '地址已过期，请重新解析', { retryable: true })
    }
    switch (entry.kind) {
      case 'file':
        return serveFile(entry.path, entry.contentType ?? contentTypeOf(entry.path), request, reply)
      case 'text':
        reply.header('content-type', entry.contentType).header('cache-control', 'no-store')
        return void reply.send(request.method === 'HEAD' ? undefined : entry.body)
      case 'generated': {
        const body = await entry.produce()
        reply.header('content-type', entry.contentType).header('cache-control', 'no-store')
        return void reply.send(request.method === 'HEAD' ? undefined : body)
      }
      case 'proxy': {
        // 子地址：c/<index>/<name>
        const child = /^c\/(\d+)\//.exec(rest)
        const url = child ? entry.children[Number(child[1])] : entry.url
        if (url === undefined) throw new SourceError('not_found', '找不到这个分片')
        return this.serveProxy(token, entry, url, request, reply)
      }
      case 'dash':
        return this.serveDash(token, entry, rest, request, reply)
    }
  }

  private async serveDash(token: string, entry: Extract<Entry, { kind: 'dash' }>, rest: string,
                          request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const child = /^c\/(\d+)\//.exec(rest)
    if (child) {
      const url = entry.children[Number(child[1])]
      if (url === undefined) throw new SourceError('not_found', '找不到这个分片')
      return this.serveUpstream(url, entry.headers, 'no', token, entry, request, reply)
    }
    const track = /^(v|a)\/(\d+)\.m3u8$/.exec(rest)
    reply.header('content-type', 'application/vnd.apple.mpegurl').header('cache-control', 'no-store')
    if (!track) {
      const base = `${BASE_PATH}/media/${token}`
      const master = dashMaster(entry.videos, entry.audios, (kind, index) => `${base}/${kind === 'video' ? 'v' : 'a'}/${index}.m3u8`)
      return void reply.send(addSubtitleRenditions(master, entry.subtitles))
    }
    const list = track[1] === 'v' ? entry.videos : entry.audios
    const source = list[Number(track[2])]
    if (!source) throw new SourceError('not_found', '找不到这条轨道')
    let index = entry.indexes.get(source.url)
    if (!index) {
      const urls = [source.url, ...(source.backupURLs ?? [])]
      index = readSegmentIndex((start, end) => fetchRangeFirst(urls, entry.headers, start, end, entry.dispatcher, entry.preferred, source.url))
      entry.indexes.set(source.url, index)
      index.catch((error) => {
        entry.indexes.delete(source.url)
        if (error instanceof SourceError && error.code === 'unplayable') entry.onRefused?.()
      })
    }
    let segments: SegmentIndex
    try {
      segments = await index
    } catch (error) {
      if (error instanceof SourceError) throw error
      throw new SourceError('upstream_changed', '读不到分段索引', { cause: error })
    }
    const uri = entry.via === 'direct' ? source.url : this.childURL(token, entry, source.url, track[1] === 'v' ? 'video.mp4' : 'audio.m4a')
    return void reply.send(byteRangePlaylist(uri, segments))
  }

  private serveProxy(token: string, entry: Extract<Entry, { kind: 'proxy' }>, url: string,
                     request: FastifyRequest, reply: FastifyReply): Promise<void> {
    return this.serveUpstream(url, entry.headers, entry.playlist, token, entry, request, reply)
  }

  private async serveUpstream(url: string, baseHeaders: Record<string, string>, playlist: 'auto' | 'yes' | 'no', token: string,
                              entry: Children, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const headers: Record<string, string> = { ...baseHeaders }
    const range = request.headers.range
    if (typeof range === 'string') headers.range = range
    const controller = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort()
    })
    const candidates = [url, ...(entry.backups?.get(url) ?? [])]
    const first = Math.min(entry.preferred?.get(url) ?? 0, candidates.length - 1)
    let upstream: Response | undefined
    let failure: unknown
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const position = (first + attempt) % candidates.length
      const isLast = attempt === candidates.length - 1
      try {
        const response = await fetch(candidates[position], { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow', signal: controller.signal,
                                                            dispatcher: entry.dispatcher } as RequestInit)
        if (!isLast && shouldTryNext(response.status)) {
          await response.body?.cancel()
          failure = response.status
          continue
        }
        if (candidates.length > 1 && response.ok) entry.preferred?.set(url, position)
        upstream = response
        break
      } catch (error) {
        if (controller.signal.aborted) throw error
        failure = error
      }
    }
    if (!upstream) throw new SourceError('unavailable', '上游连不上', { cause: failure, retryable: true })
    if (upstream.status === 403 || upstream.status === 410) {
      entry.onRefused?.()
      throw new SourceError('unplayable', '上游拒绝了这个地址，请重新解析', { retryable: true })
    }
    if (!upstream.ok) {
      reply.code(upstream.status)
      return void reply.send()
    }
    const contentType = upstream.headers.get('content-type') ?? ''
    const looksLikePlaylist =
      playlist === 'yes' ||
      (playlist === 'auto' && (/mpegurl/i.test(contentType) || new URL(url).pathname.endsWith('.m3u8')))
    if (looksLikePlaylist && request.method !== 'HEAD') {
      const text = await upstream.text()
      if (playlist === 'yes' || isPlaylist(text)) {
        const rewritten = rewritePlaylist(text, upstream.url || url, (absolute) => this.childURL(token, entry, absolute))
        reply.header('content-type', 'application/vnd.apple.mpegurl').header('cache-control', 'no-store')
        return void reply.send(rewritten)
      }
      reply.header('content-type', contentType)
      return void reply.send(text)
    }
    reply.code(upstream.status)
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) reply.header(name, value)
    }
    if (request.method === 'HEAD' || !upstream.body) return void reply.send()
    return void reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream))
  }

  private childURL(token: string, entry: Children, absolute: string, fileName?: string): string {
    let index = entry.childIndex.get(absolute)
    if (index === undefined) {
      index = entry.children.length
      entry.children.push(absolute)
      entry.childIndex.set(absolute, index)
    }
    const name = fileName ?? (basename(new URL(absolute).pathname) || 'part')
    return `${BASE_PATH}/media/${token}/c/${index}/${encodeURIComponent(name)}`
  }

  private add(entry: Entry, name: string): string {
    const token = randomBytes(12).toString('base64url')
    this.entries.set(token, entry)
    return this.url(token, name)
  }

  private url(token: string, name: string): string {
    return `${BASE_PATH}/media/${token}/${encodeURIComponent(name)}`
  }

  private expiry(options: MediaOptions): number {
    return Date.now() + (options.ttl ?? 6 * 3600) * 1000
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, entry] of this.entries) if (entry.expires < now) this.entries.delete(token)
  }

  private saveStable(): void {
    if (!this.persistent) return
    const stable: Record<string, { path: string; contentType?: string }> = {}
    for (const [token, entry] of this.entries) {
      if (entry.kind === 'file' && entry.expires === Number.POSITIVE_INFINITY) stable[token] = { path: entry.path, contentType: entry.contentType }
    }
    this.persistent.set('stable-files', stable)
  }
}

/** 本地文件，单段 Range。 */
export function serveFile(path: string, contentType: string, request: FastifyRequest, reply: FastifyReply): void {
  let size: number
  let modified: Date
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
    modified = stat.mtime
  } catch {
    throw new SourceError('not_found', '文件不存在')
  }
  reply.header('accept-ranges', 'bytes').header('content-type', contentType).header('last-modified', modified.toUTCString())
  const range = parseRange(request.headers.range, size)
  if (range === 'invalid') {
    reply.code(416).header('content-range', `bytes */${size}`)
    return void reply.send()
  }
  const [start, end] = range ?? [0, size - 1]
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`)
  reply.header('content-length', String(size === 0 ? 0 : end - start + 1))
  if (request.method === 'HEAD' || size === 0) return void reply.send()
  reply.send(createReadStream(path, { start, end }))
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n`；无 Range 返回 undefined。 */
export function parseRange(header: string | string[] | undefined, size: number): [number, number] | undefined | 'invalid' {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return [start, end]
}

/** 换下一个地址的情况：地址失效、被拒、限流、上游出错。 */
function shouldTryNext(status: number): boolean {
  return status === 403 || status === 404 || status === 410 || status === 429 || status >= 500
}

/**
 * 依次试几个地址读同一段字节（主地址加备用 CDN），返回第一个成功的。`preferred` 记下成功的是第几个（按 `key`）。
 * 都失败时抛最后一个错误。
 */
export async function fetchRangeFirst(urls: string[], headers: Record<string, string>, start: number, end: number, dispatcher?: unknown,
                                      preferred?: Map<string, number>, key = urls[0]): Promise<Uint8Array> {
  const first = Math.min(preferred?.get(key) ?? 0, urls.length - 1)
  let failure: unknown
  for (let attempt = 0; attempt < urls.length; attempt++) {
    const position = (first + attempt) % urls.length
    try {
      const bytes = await fetchRange(urls[position], headers, start, end, dispatcher)
      if (urls.length > 1) preferred?.set(key, position)
      return bytes
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/** 读上游的一段字节（含两端）。 */
export async function fetchRange(url: string, headers: Record<string, string>, start: number, end: number,
                                 dispatcher?: unknown): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { ...headers, range: `bytes=${start}-${end}` }, dispatcher } as RequestInit)
  if (response.status === 416) return new Uint8Array()
  if (response.status === 403 || response.status === 410) throw new SourceError('unplayable', '上游拒绝了这个地址，请重新解析', { retryable: true })
  if (!response.ok) throw new SourceError('unavailable', `上游返回 ${response.status}`, { retryable: true })
  const body = new Uint8Array(await response.arrayBuffer())
  // 不认 Range 的上游会整个返回：只取要的部分。
  return response.status === 200 ? body.subarray(start, end + 1) : body
}
