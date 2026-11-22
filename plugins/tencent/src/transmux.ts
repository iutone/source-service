// 会员 4K（uhd / suhd，HEVC 10-bit）只给 MPEG-TS 分片，AVPlayer 不放 TS 里的 HEVC（Apple 的 HLS 只认 fMP4 封装的 HEVC）。
// App 在设备上转封装（TencentTransmuxAsset + Foundation/TSTransmux）；这里在服务端做：每片 TS 经 KuPlayer 的转封装模块
// （vendor/KuTransmuxer.js，和优酷插件的同一份，App 从 KuPlayer 机械提取）在 node:vm 里转成自己的初始化段 + fMP4 分片，
// 不重新编码。播放列表改写成每片前一个 `EXT-X-MAP`；分片按需转，App 要第 N 片时顺带预取 N+1、N+2。
// HDR：模块不写 `colr`，动态范围从 SPS 的 VUI 读（`hevcTransfer`），写进 master 的 `VIDEO-RANGE`；AVPlayer 也按 SPS 认。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SourceError, type Logger, type MediaGateway } from '@iyt-source/kit'
import { REFERER, USER_AGENT } from './constants.ts'

const VENDOR = new URL('../vendor/', import.meta.url)
const PREFETCH_DEPTH = 2
const CACHE_LIMIT = 96 * 1024 * 1024

export interface RemuxOutput {
  initialization: Buffer
  media: Buffer
  codecs: string
  width: number
  height: number
  /** SPS 的传输特性（只读第一片）。 */
  transfer?: number
}

const GLUE = `(function () {
  "use strict";
  globalThis.tencentRemux = function (input) {
    var types = YoukuMediaTypes;
    var mux = new YoukuMediaEngine.b();
    try {
      mux.init(types.d.MIXED, types.a.M2TS, [types.a.MP4]);
      mux.initAligner({ type: "" });
      mux.setAligner({ type: types.d.MIXED, timestampOffset: input.start, discontinuity: true, sequential: false });
      mux.push(input.media);
      mux.flush();
      var result = mux.getOutput({ fmp4: true, separate: false, type: types.d.MIXED, forceAlign: true });
      if (!result || !result.data || !result.data[0] || result.data[0].length !== 2) throw new Error("Missing media output");
      var metadata = (result.streams[0] && result.streams[0].metadata) || {};
      return { initialization: result.data[0][0], media: result.data[0][1], width: metadata.width || 0, height: metadata.height || 0,
        codecs: result.streams.map(function (s) { return s.codecString; }).join(",") };
    } finally {
      mux.destroy();
    }
  };
})();`

function view(array: Uint8Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

/** 一个 node:vm 上下文，所有 4K 流共用。 */
export class TSEngine {
  private context?: vm.Context

  private load(): vm.Context {
    if (this.context) return this.context
    const noop = () => {}
    const context = vm.createContext({
      navigator: { userAgent: 'TencentJSCore' },
      console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    }, { name: 'tencent-media' })
    vm.runInContext('var window = globalThis; var self = globalThis;', context)
    vm.runInContext(readFileSync(new URL('KuTransmuxer.js', VENDOR), 'utf8'), context, { filename: 'KuTransmuxer.js', timeout: 10_000 })
    vm.runInContext(GLUE, context, { filename: 'tencent-glue.js' })
    this.context = context
    return context
  }

  /** - Parameter start: 这片在播放列表里的起点（秒），对齐时间戳用。 */
  remux(media: Buffer, start: number): RemuxOutput {
    if (media.length === 0) throw new SourceError('upstream_changed', '腾讯视频 4K 的分片是空的')
    const context = this.load()
    try {
      const Uint8 = vm.runInContext('Uint8Array', context) as Uint8ArrayConstructor
      const array = new Uint8(media.length)
      view(array).set(media)
      const call = vm.runInContext('tencentRemux', context) as (arg: unknown) => { initialization: Uint8Array; media: Uint8Array; codecs: string; width: number; height: number }
      const result = call({ media: array, start })
      return {
        initialization: Buffer.from(view(result.initialization)),
        media: Buffer.from(view(result.media)),
        codecs: String(result.codecs ?? ''),
        width: Number(result.width) || 0,
        height: Number(result.height) || 0,
      }
    } catch (error) {
      throw new SourceError('upstream_changed', '腾讯视频 4K 分片转封装失败', { cause: error })
    }
  }
}

export function transmuxAvailable(): boolean {
  try {
    readFileSync(new URL('KuTransmuxer.js', VENDOR))
    return true
  } catch {
    return false
  }
}

// MARK: HEVC SPS → 传输特性

/** 去掉防竞争字节（00 00 03）。 */
function unescapeRBSP(nal: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
    out.push(nal[i]!)
  }
  return Uint8Array.from(out)
}

class Bits {
  private position = 0
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  bit(): number {
    if (this.position >= this.bytes.length * 8) throw new Error('SPS ended early')
    const value = (this.bytes[this.position >> 3]! >> (7 - (this.position & 7))) & 1
    this.position++
    return value
  }
  bits(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.bit()
    return value
  }
  skip(n: number): void {
    for (let i = 0; i < n; i++) this.bit()
  }
  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      zeros++
      if (zeros > 31) throw new Error('bad Exp-Golomb')
    }
    return 2 ** zeros - 1 + this.bits(zeros)
  }
  se(): number {
    const k = this.ue()
    return k % 2 ? (k + 1) / 2 : -k / 2
  }
}

/** 第一个 HEVC SPS（NAL 类型 33）的 RBSP（不含两字节 NAL 头），在 Annex B 字节流（TS 的 PES 负载）里找。 */
export function findHEVCSPS(data: Uint8Array): Uint8Array | undefined {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue
    const type = (data[i + 3]! >> 1) & 0x3f
    if (type !== 33) continue
    let end = i + 3
    while (end + 2 < data.length && !(data[end] === 0 && data[end + 1] === 0 && (data[end + 2] === 1 || data[end + 2] === 0))) end++
    return unescapeRBSP(data.subarray(i + 5, end + 2 < data.length ? end : data.length))
  }
  return undefined
}

/** TS 包里拼出视频 PES 的负载（只取前面一段，够找到 SPS）。 */
export function videoElementaryBytes(ts: Uint8Array, limit = 512 * 1024): Uint8Array {
  const chunks: Buffer[] = []
  let total = 0
  for (let offset = 0; offset + 188 <= ts.length && total < limit; offset += 188) {
    if (ts[offset] !== 0x47) continue
    const adaptation = (ts[offset + 3]! >> 4) & 3
    let start = offset + 4
    if (adaptation === 2 || adaptation === 0) continue
    if (adaptation === 3) start += 1 + ts[offset + 4]!
    if (start >= offset + 188) continue
    const payload = Buffer.from(ts.subarray(start, offset + 188))
    chunks.push(payload)
    total += payload.length
  }
  return Buffer.concat(chunks)
}

function skipProfileTierLevel(bits: Bits, maxSubLayersMinus1: number): void {
  bits.skip(2 + 1 + 5 + 32 + 4 + 43 + 1 + 8)
  const profilePresent: number[] = []
  const levelPresent: number[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(bits.bit())
    levelPresent.push(bits.bit())
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) bits.skip(2)
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) bits.skip(88)
    if (levelPresent[i]) bits.skip(8)
  }
}

function skipScalingList(bits: Bits): void {
  for (let size = 0; size < 4; size++) {
    for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!bits.bit()) {
        bits.ue()
      } else {
        const count = Math.min(64, 1 << (4 + (size << 1)))
        if (size > 1) bits.se()
        for (let i = 0; i < count; i++) bits.se()
      }
    }
  }
}

/** 短期参考图像集（H.265 7.3.7），只为跳过它；返回这一集的图像数（后面的集预测要用）。 */
function skipShortTermRefPicSet(bits: Bits, index: number, counts: number[]): number {
  let predict = 0
  if (index !== 0) predict = bits.bit()
  if (predict) {
    // delta_idx_minus1 只在 slice 头里有；SPS 里是 delta_rps_sign 和 abs_delta_rps_minus1。
    bits.bit()
    bits.ue()
    const reference = counts[index - 1] ?? 0
    let pictures = 0
    for (let j = 0; j <= reference; j++) {
      const used = bits.bit()
      let useDelta = 1
      if (!used) useDelta = bits.bit()
      if (used || useDelta) pictures++
    }
    return pictures
  }
  const negative = bits.ue()
  const positive = bits.ue()
  for (let i = 0; i < negative + positive; i++) {
    bits.ue()
    bits.bit()
  }
  return negative + positive
}

/**
 * SPS 的 VUI 里的 `transfer_characteristics`（1 BT.709、16 PQ、18 HLG…）；没写颜色描述时 undefined。
 * 读到 VUI 之前的字段都只是跳过（H.265 7.3.2.2）。
 */
export function hevcTransfer(sps: Uint8Array): number | undefined {
  const bits = new Bits(sps)
  bits.skip(4)
  const maxSubLayersMinus1 = bits.bits(3)
  bits.skip(1)
  skipProfileTierLevel(bits, maxSubLayersMinus1)
  bits.ue()
  const chroma = bits.ue()
  if (chroma === 3) bits.skip(1)
  bits.ue()
  bits.ue()
  if (bits.bit()) {
    bits.ue(); bits.ue(); bits.ue(); bits.ue()
  }
  bits.ue()
  bits.ue()
  const log2MaxPOC = bits.ue() + 4
  const orderingAll = bits.bit()
  for (let i = orderingAll ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    bits.ue(); bits.ue(); bits.ue()
  }
  bits.ue(); bits.ue(); bits.ue(); bits.ue(); bits.ue(); bits.ue()
  if (bits.bit() && bits.bit()) skipScalingList(bits)
  bits.skip(2)
  if (bits.bit()) {
    bits.skip(8)
    bits.ue(); bits.ue()
    bits.skip(1)
  }
  const sets = bits.ue()
  const counts: number[] = []
  for (let i = 0; i < sets; i++) counts.push(skipShortTermRefPicSet(bits, i, counts))
  if (bits.bit()) {
    const longTerm = bits.ue()
    for (let i = 0; i < longTerm; i++) {
      bits.skip(log2MaxPOC)
      bits.skip(1)
    }
  }
  bits.skip(2)
  if (!bits.bit()) return undefined
  if (bits.bit()) {
    const idc = bits.bits(8)
    if (idc === 255) bits.skip(32)
  }
  if (bits.bit()) bits.skip(1)
  if (!bits.bit()) return undefined
  bits.skip(3 + 1)
  if (!bits.bit()) return undefined
  bits.skip(8)
  return bits.bits(8)
}

/** HLS 的 `VIDEO-RANGE`：16 PQ、18 HLG，其他 SDR。 */
export function videoRange(transfer: number | undefined): 'SDR' | 'PQ' | 'HLG' {
  return transfer === 16 ? 'PQ' : transfer === 18 ? 'HLG' : 'SDR'
}

/**
 * 转封装模块把 `hvcC` 的兼容标志和约束字节按位反着写了（SPS 里 `20000000` / `90…`，它写成 `04000000` / `09…`）：
 * 照 SPS 的 profile_tier_level 改回来（`hvcC` 第 1–12 字节和 SPS RBSP 第 1–12 字节一一对应）。
 */
export function patchHvcC(init: Buffer, sps: Uint8Array): void {
  const at = init.indexOf('hvcC')
  if (at < 0 || sps.length < 13 || at + 4 + 13 > init.length) return
  for (let i = 1; i < 13; i++) init[at + 4 + i] = sps[i]!
}

/**
 * 初始化段里 `hvcC` 的 RFC 6381 名字：`hvc1.<档次>.<兼容标志（位反序）>.<L|H><级别>.<约束字节>`（末尾的 0 字节省掉）。
 * 转封装模块自己给的是 `hev1…`（字节也是反的），这里按改正后的 `hvcC` 重算；样本项本来就是 `hvc1`。
 */
export function hevcCodecString(init: Uint8Array): string | undefined {
  for (let i = 4; i + 4 + 13 <= init.length; i++) {
    if (init[i] !== 0x68 || init[i + 1] !== 0x76 || init[i + 2] !== 0x63 || init[i + 3] !== 0x43) continue
    const c = init.subarray(i + 4)
    const space = (c[1]! >> 6) & 3
    const tier = (c[1]! >> 5) & 1
    const profile = c[1]! & 0x1f
    let compat = ((c[2]! << 24) | (c[3]! << 16) | (c[4]! << 8) | c[5]!) >>> 0
    let reversed = 0
    for (let b = 0; b < 32; b++) {
      reversed = ((reversed << 1) | (compat & 1)) >>> 0
      compat >>>= 1
    }
    const constraints = Array.from(c.subarray(6, 12))
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop()
    const level = c[12]!
    const parts = [`hvc1`, `${['', 'A', 'B', 'C'][space]}${profile}`, reversed.toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${level}`]
    if (constraints.length) parts.push(...constraints.map((b) => b.toString(16).toUpperCase()))
    return parts.join('.')
  }
  return undefined
}

// MARK: 流水线

interface Segment {
  url: string
  start: number
}

interface Stream {
  segments: string[]
  position: number
}

/**
 * 一条 4K 流：媒体播放列表改写成每片带 `EXT-X-MAP` 的 fMP4，分片在被请求时取、转（同一片共享一个任务），往后预取两片，
 * 输出只留播放位置附近的。转封装是 CPU 活，排队一片一片来；下载并行。
 */
export class TransmuxPipeline {
  private readonly engine = new TSEngine()
  private readonly segments = new Map<string, { segment: Segment; stream: Stream; index: number }>()
  private readonly jobs = new Map<string, Promise<RemuxOutput>>()
  private readonly done = new Map<string, RemuxOutput>()
  private queue: Promise<unknown> = Promise.resolve()
  private nextID = 0
  private readonly log?: Logger

  constructor(log?: Logger) {
    this.log = log
  }

  /**
   * TS 媒体播放列表 → fMP4 的，分片地址都指向网关。
   * - Parameter base: 播放列表的地址（相对的分片地址按它补全）。
   */
  rewrite(text: string, base: string, media: MediaGateway, ttl: number): { text: string; first?: string; segments: number; duration: number } {
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST')) throw new SourceError('upstream_changed', '腾讯视频 4K 的播放列表格式不支持')
    const stream: Stream = { segments: [], position: 0 }
    const output: string[] = []
    let start = 0
    let duration = 0
    for (const line of lines) {
      if (!line) continue
      if (line.startsWith('#EXT-X-VERSION:')) continue
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-BYTERANGE:')) {
        throw new SourceError('unplayable', '该片为版权加密内容，暂不支持播放')
      }
      if (line.startsWith('#EXTINF:')) {
        duration = Number(line.slice(8).split(',')[0])
        output.push(line)
        continue
      }
      if (line.startsWith('#')) {
        output.push(line)
        continue
      }
      const id = `t${this.nextID++}`
      this.segments.set(id, { segment: { url: new URL(line, base).toString(), start }, stream, index: stream.segments.length })
      stream.segments.push(id)
      // 二进制交给只认字符串的 `generated`：Fastify 照样当 Buffer 发出去（优酷插件同样的用法）。
      const initialization = media.generated(async () => (await this.demand(id)).initialization as unknown as string,
        { name: `${id}-init.mp4`, ttl, contentType: 'video/mp4' })
      const fragment = media.generated(async () => (await this.demand(id)).media as unknown as string,
        { name: `${id}.m4s`, ttl, contentType: 'video/mp4' })
      let at = output.length
      while (at > 0 && !output[at - 1]!.startsWith('#EXTINF:')) at--
      output.splice(at > 0 ? at - 1 : output.length, 0, `#EXT-X-MAP:URI="${initialization}"`)
      output.push(fragment)
      start += Number.isFinite(duration) ? duration : 0
      duration = 0
    }
    output.splice(1, 0, '#EXT-X-VERSION:7')
    return { text: output.join('\n') + '\n', first: stream.segments[0], segments: stream.segments.length, duration: start }
  }

  /** 某一片的输出（master 要第一片的 CODECS、分辨率、动态范围；顺带预取）。 */
  output(id: string): Promise<RemuxOutput> {
    return this.demand(id)
  }

  private demand(id: string): Promise<RemuxOutput> {
    const ref = this.segments.get(id)
    if (!ref) throw new SourceError('unplayable', '地址已过期，请重新解析', { retryable: true })
    ref.stream.position = ref.index
    for (let i = ref.index + 1; i <= ref.index + PREFETCH_DEPTH && i < ref.stream.segments.length; i++) {
      void this.job(ref.stream.segments[i]!).catch(() => undefined)
    }
    this.evict(ref.stream)
    return this.job(id)
  }

  private job(id: string): Promise<RemuxOutput> {
    const cached = this.done.get(id)
    if (cached) return Promise.resolve(cached)
    const running = this.jobs.get(id)
    if (running) return running
    const ref = this.segments.get(id)!
    const job = (async () => {
      const ts = await fetchBytes(ref.segment.url)
      const sps = findHEVCSPS(videoElementaryBytes(ts))
      let transfer: number | undefined
      try {
        transfer = sps ? hevcTransfer(sps) : undefined
      } catch {
        transfer = undefined
      }
      const run = this.queue.then(() => {
        const output = this.engine.remux(ts, ref.segment.start)
        if (sps) patchHvcC(output.initialization, sps)
        return { ...output, transfer }
      })
      this.queue = run.catch(() => undefined)
      const output = await run
      this.done.set(id, output)
      return output
    })()
    this.jobs.set(id, job)
    job.catch((error) => {
      if (!(error instanceof SourceError && error.code === 'unplayable')) this.log?.warn('tencent 4K segment failed', { error: String(error) })
    }).finally(() => this.jobs.delete(id))
    return job
  }

  /** 只留播放位置的上一片到预取的几片；超过总量从最早的丢。 */
  private evict(stream: Stream): void {
    stream.segments.forEach((id, i) => {
      const offset = i - stream.position
      if (offset < -1 || offset > PREFETCH_DEPTH + 1) this.done.delete(id)
    })
    let total = 0
    for (const output of this.done.values()) total += output.media.length + output.initialization.length
    for (const [id, output] of this.done) {
      if (total <= CACHE_LIMIT) break
      total -= output.media.length + output.initialization.length
      this.done.delete(id)
    }
  }
}

/** 取 CDN 上的分片：断线、超时、5xx 再试两次；403 / 410（签名过期）让 App 重新解析。 */
export async function fetchBytes(url: string): Promise<Buffer> {
  const delays = [300, 1000]
  for (let attempt = 0; ; attempt++) {
    let status = 0
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal: AbortSignal.timeout(120_000) })
      status = response.status
      if (response.ok) return Buffer.from(await response.arrayBuffer())
      if (status === 403 || status === 410) throw new SourceError('unplayable', '腾讯视频 CDN 拒绝了这个地址，请重新解析', { retryable: true })
      if (status !== 408 && status !== 429 && status < 500) throw new SourceError('unavailable', `腾讯视频 CDN 返回 ${status}`, { retryable: true })
    } catch (error) {
      if (error instanceof SourceError && error.code !== 'unavailable') throw error
      if (attempt >= delays.length) throw error instanceof SourceError ? error : new SourceError('unavailable', '连不上腾讯视频 CDN', { cause: error })
    }
    if (attempt >= delays.length) throw new SourceError('unavailable', `腾讯视频 CDN 返回 ${status}`, { retryable: true })
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
  }
}
