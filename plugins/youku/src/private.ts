// 优酷私有加密（copyrightDRM）和 MPEG-TS 封装的 H.265（mp5*）：App 在设备上解密、转封装（docs/youku-web/PRIVATE-PLAYBACK.md，
// YoukuPrivate*）；这里在服务端做同样的事，结果经媒体网关给 App 不要请求头的 fMP4 HLS。
// - 内容密钥：UPS 请求带 `encryptR_client`（16 字节随机串用固定密钥 AES-ECB 加密），回答的 `encryptR_server` 和
//   `copyright_key` 两层 AES-ECB 解开（YoukuPrivateKeySession）。
// - 媒体：KuPlayer 的转封装模块（vendor/KuTransmuxer.js，从 App 复制，App 从 KuPlayer 机械提取）在 node:vm 里跑，解密走
//   Node 的 AES（TS 包 AES-ECB、CMAF 样本 AES-CBC / cbcs），每片输出自己的初始化段和 fMP4 分片。
// - 播放列表重写成每片带 `EXT-X-MAP`（YoukuPrivatePlaylist），分片按需处理，AVPlayer 要第 N 片时顺带处理 N+1、N+2。
// 媒体网关的 `generated` 只认字符串：二进制分片照样交给它（Fastify 的 reply.send 收 Buffer），见报告。
import { createCipheriv, createDecipheriv, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SourceError, type Ctx, type Logger, type MediaGateway } from '@iyt-source/kit'
import { request, USER_AGENT, REFERER } from './mtop.ts'

const CLIENT_KEY = Buffer.from('f9387537ac27877b', 'ascii')
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz234567890'

function ecb(data: Buffer, key: Buffer, encrypt: boolean): Buffer {
  if (key.length !== 16 || data.length === 0 || data.length % 16 !== 0) throw new SourceError('upstream_changed', '优酷私有流的密钥材料不对')
  const cipher = encrypt ? createCipheriv('aes-128-ecb', key, null) : createDecipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 一次 UPS 的私有会话（App 的 YoukuPrivateKeySession）。 */
export class PrivateKeySession {
  private readonly random: Buffer
  readonly client: string

  constructor(random?: string) {
    const text = random ?? Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    this.random = Buffer.from(text, 'utf8')
    if (this.random.length !== 16) throw new Error('random must be 16 bytes')
    this.client = ecb(this.random, CLIENT_KEY, true).toString('base64')
  }

  recover(server: string, copyright: string): Buffer {
    const serverBytes = Buffer.from(server, 'base64')
    const wrapped = Buffer.from(copyright, 'base64')
    if (serverBytes.length !== 16 || wrapped.length < 32 || wrapped.length > 1024 || wrapped.length % 16 !== 0) {
      throw new SourceError('upstream_changed', '优酷私有流的密钥材料不对')
    }
    const serverKey = ecb(serverBytes, this.random, false)
    const plain = ecb(wrapped, serverKey, false)
    const key = Buffer.from(plain.subarray(0, 24).toString('ascii'), 'base64')
    if (key.length !== 16) throw new SourceError('upstream_changed', '优酷私有流的内容密钥不对')
    return key
  }
}

// MARK: 播放列表

export interface Segment {
  url: string
  initialization?: string
  start: number
  duration: number
  encrypted: boolean
  audio: boolean
}

export function attribute(name: string, line: string): string | undefined {
  const pattern = new RegExp(`(?:^|[:,])\\s*${name.replace(/[-]/g, '\\-')}=(?:"([^"]*)"|([^,]*))`)
  const match = pattern.exec(line)
  return match ? (match[1] ?? match[2]) : undefined
}

function absolute(value: string, base: string): string {
  const url = new URL(value, base)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SourceError('upstream_changed', '优酷私有流的播放列表格式不支持')
  // 相对地址拼出来的照原样；绝对地址保持原来的百分号编码（`new URL` 会改写 query）。
  return /^https?:\/\//i.test(value) ? value : url.toString()
}

/** 照 App 的 YoukuPrivatePlaylist.rewrite：去掉密钥标签，每片前面插自己的 `EXT-X-MAP`，地址换成 `playlist` / `segment` 给的。 */
export function rewritePrivatePlaylist(text: string, baseURL: string, audio: boolean,
                                       playlist: (url: string, audio: boolean) => string,
                                       segment: (segment: Segment) => { initialization: string; media: string }): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const unsupported = () => new SourceError('upstream_changed', '优酷私有流的播放列表格式不支持')
  if (lines[0] !== '#EXTM3U' || lines.some((l) => l.startsWith('#EXT-X-TARGETDURATION:-'))) throw unsupported()
  const master = text.includes('#EXT-X-STREAM-INF:')
  if (!master && !lines.includes('#EXT-X-ENDLIST')) throw unsupported()
  const output: string[] = []
  let initialization: string | undefined
  let start = 0
  let duration = 0
  let encrypted = true
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) continue
    if (line.startsWith('#EXT-X-BYTERANGE:')) throw unsupported()
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attribute('URI', line)
      if (attribute('BYTERANGE', line) !== undefined || !uri) throw unsupported()
      initialization = absolute(uri, baseURL)
      continue
    }
    if (line.startsWith('#EXT-X-PRIVINF:')) {
      const fields = line.slice('#EXT-X-PRIVINF:'.length).split(',').map((f) => f.trim())
      encrypted = !fields.some((f) => f === 'DRM_NOTENCRYPT' || f === 'DRM_NOTENCRYPT=1')
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const uri = attribute('URI', line)
      if (!uri) {
        output.push(line)
        continue
      }
      const mapped = playlist(absolute(uri, baseURL), attribute('TYPE', line) === 'AUDIO')
      output.push(line.replace(`URI="${uri}"`, `URI="${mapped}"`))
    } else if (line.startsWith('#EXT-X-VERSION:')) {
      output.push(`#EXT-X-VERSION:${Math.max(7, Number(line.slice('#EXT-X-VERSION:'.length)) || 0)}`)
    } else if (line.startsWith('#EXTINF:')) {
      const value = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(value) || value <= 0) throw unsupported()
      duration = value
      output.push(line)
    } else if (line.startsWith('#')) {
      output.push(line)
    } else if (master) {
      output.push(playlist(absolute(line, baseURL), false))
    } else {
      if (duration <= 0) throw unsupported()
      const mapped = segment({ url: absolute(line, baseURL), initialization, start, duration, encrypted, audio })
      let index = output.length
      for (let i = output.length - 1; i >= 0; i--) {
        if (output[i].startsWith('#EXTINF:')) {
          index = i
          break
        }
      }
      output.splice(index, 0, `#EXT-X-MAP:URI="${mapped.initialization}"`)
      output.push(mapped.media)
      start += duration
      duration = 0
      encrypted = true
    }
  }
  if (!output.some((l) => l.startsWith('#EXT-X-VERSION:'))) output.splice(1, 0, '#EXT-X-VERSION:7')
  return output.join('\n') + '\n'
}

// MARK: 媒体引擎

interface RemuxOutput {
  initialization: Buffer
  media: Buffer
  codecs: string
  width: number
  height: number
}

const VENDOR = new URL('../vendor/', import.meta.url)

/** vendor 里的转封装模块在不在（镜像里漏了就只给明文流）。 */
export function privateEngineAvailable(): boolean {
  try {
    readFileSync(new URL('KuTransmuxer.js', VENDOR))
    readFileSync(new URL('PrivateTransmuxer.js', VENDOR))
    return true
  } catch {
    return false
  }
}

/** 跨 realm 的 Uint8Array（vm 里的）在本进程里的视图。 */
function view(array: Uint8Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

/** 一个 node:vm 上下文，所有私有流共用：换集、换清晰度不重新加载。密钥只在调用期间放在宿主这边，不进 JS。 */
export class MediaEngine {
  private context?: vm.Context
  private key: Buffer = Buffer.alloc(16)

  private load(): vm.Context {
    if (this.context) return this.context
    const noop = () => {}
    const host = {
      youkuDecryptECB: (input: Uint8Array, output: Uint8Array): boolean => {
        const whole = input.byteLength & ~15
        const out = view(output)
        const src = view(input)
        if (whole > 0) {
          const decipher = createDecipheriv('aes-128-ecb', this.key, null)
          decipher.setAutoPadding(false)
          decipher.update(src.subarray(0, whole)).copy(out, 0)
          decipher.final()
        }
        // 不满一块的尾巴保持明文，同 KuPlayer。
        src.copy(out, whole, whole)
        return true
      },
      youkuDecryptCBC: (input: Uint8Array, output: Uint8Array, iv: Uint8Array, crypt: number, skip: number): boolean => {
        const src = view(input)
        const out = view(output)
        const whole = src.length & ~15
        const decipher = createDecipheriv('aes-128-cbc', this.key, Buffer.from(view(iv)))
        decipher.setAutoPadding(false)
        if (crypt <= 0 || skip <= 0) {
          if (whole > 0) decipher.update(src.subarray(0, whole)).copy(out, 0)
          src.copy(out, whole, whole)
          return true
        }
        // cbcs 的块模式：明文块原样，加密块连成一个 CBC 流。
        src.copy(out, 0)
        const cryptBytes = 16 * crypt
        const stride = 16 * (crypt + skip)
        for (let offset = 0; offset + cryptBytes <= whole; offset += stride) {
          decipher.update(src.subarray(offset, offset + cryptBytes)).copy(out, offset)
        }
        return true
      },
    }
    const context = vm.createContext({
      navigator: { userAgent: 'YoukuJSCore' },
      console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
      youkuDecryptECB: host.youkuDecryptECB,
      youkuDecryptCBC: host.youkuDecryptCBC,
    }, { name: 'youku-media' })
    vm.runInContext('var window = globalThis; var self = globalThis;', context)
    for (const name of ['KuTransmuxer.js', 'PrivateTransmuxer.js']) {
      vm.runInContext(readFileSync(new URL(name, VENDOR), 'utf8'), context, { filename: name, timeout: 10_000 })
    }
    this.context = context
    return context
  }

  remux(input: { media: Buffer; initialization?: Buffer; key?: Buffer; encrypted: boolean; audio: boolean; start: number }): RemuxOutput {
    if (input.media.length === 0) throw new SourceError('upstream_changed', '优酷私有流的分片是空的')
    if (input.encrypted && input.key?.length !== 16) throw new SourceError('upstream_changed', '优酷私有流缺内容密钥')
    const context = this.load()
    this.key = input.key ?? Buffer.alloc(16)
    try {
      const Uint8 = vm.runInContext('Uint8Array', context) as Uint8ArrayConstructor
      const copy = (bytes: Buffer) => {
        const array = new Uint8(bytes.length)
        view(array).set(bytes)
        return array
      }
      const call = vm.runInContext('youkuRemux', context) as (arg: unknown) => { initialization: Uint8Array; media: Uint8Array; codecs: string; width: number; height: number }
      const result = call({
        media: copy(input.media),
        initialization: input.initialization ? copy(input.initialization) : undefined,
        encrypted: input.encrypted,
        audio: input.audio,
        start: input.start,
      })
      if (!result?.initialization || !result?.media) throw new Error('missing output')
      return {
        initialization: Buffer.from(view(result.initialization)),
        media: Buffer.from(view(result.media)),
        codecs: String(result.codecs ?? ''),
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
      }
    } catch (error) {
      if (error instanceof SourceError) throw error
      throw new SourceError('upstream_changed', '优酷私有流解密 / 转封装失败', { cause: error })
    } finally {
      this.key = Buffer.alloc(16)
    }
  }
}

// MARK: 流水线

const PREFETCH_DEPTH = 2
const CACHE_LIMIT = 64 * 1024 * 1024
const TTL = 6 * 3600

interface SegmentRef {
  segment: Segment
  stream: StreamState
  index: number
}

interface StreamState {
  key?: Buffer
  /** 每个播放列表一组按顺序的片。 */
  playlists: Map<string, string[]>
  position: Map<string, number>
}

/**
 * 私有流的处理（App 的 YoukuPrivateProxy，不同的是经媒体网关给出）：播放列表第一次被请求时才去取、重写；每片的初始化段和
 * 分片在被请求时处理，共享一个任务；往后预取两片；输出只留播放位置附近的，总量有上限。
 */
export class PrivatePipeline {
  private readonly engine = new MediaEngine()
  private readonly segments = new Map<string, SegmentRef>()
  private readonly jobs = new Map<string, Promise<RemuxOutput>>()
  private readonly done = new Map<string, RemuxOutput>()
  private readonly inits = new Map<string, Promise<Buffer>>()
  private nextID = 0
  /** 转封装按顺序一片一片来（CPU 活，不并行）。 */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly log?: Logger

  constructor(log?: Logger) {
    this.log = log
  }

  /** 登记一条流（master 或媒体播放列表的地址），返回网关里的 master 地址。 */
  register(url: string, key: Buffer | undefined, ctx: Ctx): string {
    const stream: StreamState = { key, playlists: new Map(), position: new Map() }
    return this.playlistURL(ctx.media, url, false, stream, 'master.m3u8')
  }

  private playlistURL(media: MediaGateway, url: string, audio: boolean, stream: StreamState, name: string): string {
    const id = `p${this.nextID++}`
    let rendered: Promise<string> | undefined
    return media.generated(() => {
      rendered ??= this.render(media, id, url, audio, stream).catch((error) => {
        rendered = undefined
        throw error
      })
      return rendered
    }, { name, ttl: TTL, contentType: 'application/vnd.apple.mpegurl' })
  }

  private async render(media: MediaGateway, id: string, url: string, audio: boolean, stream: StreamState): Promise<string> {
    const body = (await fetchBytes(url)).toString('utf8')
    const order: string[] = []
    let child = 0
    const text = rewritePrivatePlaylist(body, url, audio,
      (playlist, isAudio) => this.playlistURL(media, playlist, isAudio, stream, `${isAudio ? 'audio' : 'video'}-${child++}.m3u8`),
      (segment) => {
        const segmentID = `s${this.nextID++}`
        this.segments.set(segmentID, { segment, stream, index: order.length })
        order.push(segmentID)
        // 二进制交给只认字符串的 `generated`：Fastify 照样当 Buffer 发出去。
        const initialization = media.generated(async () => (await this.demand(segmentID, id)).initialization as unknown as string,
          { name: `${segmentID}-init.mp4`, ttl: TTL, contentType: 'video/mp4' })
        const data = media.generated(async () => (await this.demand(segmentID, id)).media as unknown as string,
          { name: `${segmentID}.m4s`, ttl: TTL, contentType: 'video/mp4' })
        return { initialization, media: data }
      })
    if (order.length) stream.playlists.set(id, order)
    return text
  }

  /** AVPlayer 要的这一片；顺带开始后面两片，丢掉拖动后远离播放位置的输出。 */
  private demand(segmentID: string, playlist: string): Promise<RemuxOutput> {
    const ref = this.segments.get(segmentID)
    if (!ref) throw new SourceError('unplayable', '地址已过期，请重新解析', { retryable: true })
    ref.stream.position.set(playlist, ref.index)
    const order = ref.stream.playlists.get(playlist) ?? []
    for (let i = ref.index + 1; i <= ref.index + PREFETCH_DEPTH && i < order.length; i++) {
      void this.job(order[i]).catch(() => undefined)
    }
    this.evict(ref.stream, playlist)
    return this.job(segmentID)
  }

  private job(segmentID: string): Promise<RemuxOutput> {
    const cached = this.done.get(segmentID)
    if (cached) return Promise.resolve(cached)
    let job = this.jobs.get(segmentID)
    if (job) return job
    const ref = this.segments.get(segmentID)!
    job = (async () => {
      // 下载并行，转封装排队按顺序。
      const [initialization, media] = await Promise.all([
        ref.segment.initialization ? this.initialization(ref.segment.initialization) : Promise.resolve(undefined),
        fetchBytes(ref.segment.url),
      ])
      const run = this.queue.then(() => this.engine.remux({
        media, initialization, key: ref.stream.key, encrypted: Boolean(ref.stream.key) && ref.segment.encrypted,
        audio: ref.segment.audio, start: ref.segment.start,
      }))
      this.queue = run.catch(() => undefined)
      const output = await run
      this.done.set(segmentID, output)
      return output
    })()
    this.jobs.set(segmentID, job)
    job.catch((error) => {
      if (!(error instanceof SourceError && error.code === 'unplayable')) this.log?.warn('youku private segment failed', { error: String(error) })
    }).finally(() => this.jobs.delete(segmentID))
    return job
  }

  private initialization(url: string): Promise<Buffer> {
    let task = this.inits.get(url)
    if (!task) {
      task = fetchBytes(url)
      this.inits.set(url, task)
      task.catch(() => this.inits.delete(url))
      if (this.inits.size > 64) this.inits.delete(this.inits.keys().next().value!)
    }
    return task
  }

  /** 只留播放位置的上一片到预取的几片；超过总量从最远的丢。 */
  private evict(stream: StreamState, playlist: string): void {
    const order = stream.playlists.get(playlist) ?? []
    const current = stream.position.get(playlist) ?? 0
    for (let i = 0; i < order.length; i++) {
      const offset = i - current
      if (offset < -1 || offset > PREFETCH_DEPTH + 1) this.done.delete(order[i])
    }
    let total = 0
    for (const output of this.done.values()) total += output.media.length + output.initialization.length
    for (const id of this.done.keys()) {
      if (total <= CACHE_LIMIT) break
      const output = this.done.get(id)!
      total -= output.media.length + output.initialization.length
      this.done.delete(id)
    }
  }

  close(): void {
    this.segments.clear()
    this.done.clear()
    this.inits.clear()
  }
}

/** 取 CDN 上的播放列表 / 分片：连接断了、超时、5xx 再试两次；403 / 410（签名过期）让 App 重新解析。 */
async function fetchBytes(url: string): Promise<Buffer> {
  const delays = [300, 1000]
  for (let attempt = 0; ; attempt++) {
    let status = 0
    try {
      const response = await request(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER } }, '优酷 CDN')
      status = response.status
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length > 64 * 1024 * 1024) throw new SourceError('upstream_changed', '优酷的分片太大')
        return body
      }
      if (status === 403 || status === 410) throw new SourceError('unplayable', '优酷 CDN 拒绝了这个地址，请重新解析', { retryable: true })
      if (status !== 408 && status !== 429 && status < 500) throw new SourceError('unavailable', `优酷 CDN 返回 ${status}`, { retryable: true })
    } catch (error) {
      if (error instanceof SourceError && error.code !== 'unavailable') throw error
      if (attempt >= delays.length) throw error
    }
    if (attempt >= delays.length) throw new SourceError('unavailable', `优酷 CDN 返回 ${status}`, { retryable: true })
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
  }
}
