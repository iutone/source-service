// 单文件 DASH 轨道（YouTube 的 https 格式：一个 MP4 文件，init 段后跟 sidx）做成按字节范围的 fMP4 HLS
// （SERVER.md §12.3）。只生成播放列表，不碰媒体数据。

export interface SegmentIndex {
  /** init 段（ftyp + moov）的字节长度，从 0 开始。 */
  initLength: number
  segments: { offset: number; length: number; duration: number }[]
}

interface Box {
  type: string
  start: number
  size: number
  headerSize: number
}

/** 读顶层 box 的头；`buffer` 不够长时返回已读到的。 */
export function topLevelBoxes(buffer: Uint8Array): Box[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const boxes: Box[] = []
  let offset = 0
  while (offset + 8 <= buffer.byteLength) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7])
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > buffer.byteLength) break
      size = Number(view.getBigUint64(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      break
    }
    if (size < headerSize) throw new Error(`坏的 box：${type}`)
    boxes.push({ type, start: offset, size, headerSize })
    offset += size
  }
  return boxes
}

/** 解析 sidx box（`buffer` 从 box 开头起，完整）。`boxEnd` 是它在文件里的结束位置。 */
export function parseSidx(buffer: Uint8Array, boxEnd: number): SegmentIndex['segments'] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const size = view.getUint32(0)
  let headerSize = 8
  if (size === 1) headerSize = 16
  let p = headerSize
  const version = buffer[p]
  p += 4 // version + flags
  p += 4 // reference_ID
  const timescale = view.getUint32(p)
  p += 4
  let firstOffset: number
  if (version === 0) {
    p += 4 // earliest_presentation_time
    firstOffset = view.getUint32(p)
    p += 4
  } else {
    p += 8
    firstOffset = Number(view.getBigUint64(p))
    p += 8
  }
  p += 2 // reserved
  const count = view.getUint16(p)
  p += 2
  const segments: SegmentIndex['segments'] = []
  let offset = boxEnd + firstOffset
  for (let i = 0; i < count; i++) {
    const reference = view.getUint32(p)
    const duration = view.getUint32(p + 4)
    p += 12
    if (reference >>> 31) throw new Error('不支持分层的 sidx')
    const length = reference & 0x7fffffff
    segments.push({ offset, length, duration: duration / timescale })
    offset += length
  }
  return segments
}

/**
 * 取一个单文件轨道的分段索引：先读开头 64 KB，不够再按 box 头往后读，直到读完 sidx。
 * - Parameter read: 读 `[start, end]`（含）字节。
 */
export async function readSegmentIndex(read: (start: number, end: number) => Promise<Uint8Array>): Promise<SegmentIndex> {
  let buffer = await read(0, 65_535)
  for (let attempt = 0; attempt < 6; attempt++) {
    const boxes = topLevelBoxes(buffer)
    const moov = boxes.find((box) => box.type === 'moov')
    const sidx = boxes.find((box) => box.type === 'sidx')
    if (moov && sidx && sidx.start + sidx.size <= buffer.byteLength) {
      return {
        initLength: moov.start + moov.size,
        segments: parseSidx(buffer.subarray(sidx.start, sidx.start + sidx.size), sidx.start + sidx.size),
      }
    }
    if (boxes.some((box) => box.type === 'moof' || box.type === 'mdat') && !sidx) throw new Error('没有 sidx')
    // 最后一个 box 读不全：读到它结束为止。
    const last = boxes.at(-1)
    const want = last ? last.start + last.size + 64 * 1024 : buffer.byteLength * 2
    const more = await read(buffer.byteLength, want - 1)
    const joined = new Uint8Array(buffer.byteLength + more.byteLength)
    joined.set(buffer)
    joined.set(more, buffer.byteLength)
    buffer = joined
    if (more.byteLength === 0) break
  }
  throw new Error('读不到 sidx')
}

/** 一条轨道的 HLS 媒体播放列表：`EXT-X-MAP` 指 init 段，每段一个字节范围，地址都是同一个文件。 */
export function byteRangePlaylist(uri: string, index: SegmentIndex): string {
  const target = Math.max(1, Math.ceil(Math.max(...index.segments.map((segment) => segment.duration))))
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${uri}",BYTERANGE="${index.initLength}@0"`,
  ]
  for (const segment of index.segments) {
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${segment.length}@${segment.offset}`, uri)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

export interface DashVideoTrack {
  url: string
  codecs: string
  /** 峰值码率，bit/s。 */
  bandwidth: number
  width?: number
  height?: number
  frameRate?: number
}

export interface DashAudioTrack {
  url: string
  codecs: string
  bandwidth: number
  /** BCP 47。 */
  language?: string
  name: string
  isDefault?: boolean
}

/** master：视频变体（可多个清晰度）引用同一组音频。`uri(kind, index)` 给出各自媒体播放列表的地址。 */
export function dashMaster(videos: DashVideoTrack[], audios: DashAudioTrack[], uri: (kind: 'video' | 'audio', index: number) => string): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS']
  audios.forEach((audio, index) => {
    const attributes = [
      'TYPE=AUDIO',
      'GROUP-ID="audio"',
      `NAME="${audio.name.replaceAll('"', "'")}"`,
      audio.language ? `LANGUAGE="${audio.language}"` : undefined,
      `DEFAULT=${audio.isDefault || (index === 0 && !audios.some((a) => a.isDefault)) ? 'YES' : 'NO'}`,
      'AUTOSELECT=YES',
      `URI="${uri('audio', index)}"`,
    ].filter(Boolean)
    lines.push(`#EXT-X-MEDIA:${attributes.join(',')}`)
  })
  const audioBandwidth = Math.max(0, ...audios.map((audio) => audio.bandwidth))
  const audioCodecs = [...new Set(audios.map((audio) => audio.codecs))]
  videos.forEach((video, index) => {
    const attributes = [
      `BANDWIDTH=${Math.round(video.bandwidth + audioBandwidth)}`,
      `CODECS="${[video.codecs, ...audioCodecs].join(',')}"`,
      video.width && video.height ? `RESOLUTION=${video.width}x${video.height}` : undefined,
      video.frameRate ? `FRAME-RATE=${video.frameRate.toFixed(3)}` : undefined,
      audios.length ? 'AUDIO="audio"' : undefined,
    ].filter(Boolean)
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, uri('video', index))
  })
  lines.push('')
  return lines.join('\n')
}
