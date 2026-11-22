// Widevine（网页播放器在 Chrome 上的路子，`pcweb.wonder.*.js` 的 `drmType 7` 分支）：`dash` 声明 Widevine 能力位后，
// 加密片的选中档 `m3u8` 字段不是 HLS，而是一段 JSON 描述（`{"payload":{"wm_a":{"video_track1":…,"audio_track1":…}}}`）：
// 每条轨道的 init 段（`codec_init`，base64，内含 Widevine 的 pssh）、cenc 加密方案、key id，以及分片——视频是一个大文件的
// 若干字节区间（`seekable.pos_start / pos_end / time_start / time_end`），音频是一个大文件加 `seekable.pos[] / time[]`；
// 每段都是 `styp + moof + mdat`。这里把它做成 fMP4 的 HLS（`EXT-X-MAP` + `EXT-X-BYTERANGE`，音频作 `EXT-X-MEDIA`），
// key 标签写 Widevine 的 pssh。cenc 是 AES-CTR，所以 METHOD 是 `SAMPLE-AES-CTR`（ExoPlayer 的 HLS 认它；协议示例里的
// `SAMPLE-AES` 是 cbcs 的写法）。许可：原始 challenge POST 到 `drm.license_host`，回原始 license（网页播放器就这么做）。
import { arr, num, str, text } from './util.ts'

export const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed'
export const WIDEVINE_KEYFORMAT = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'

/** init 段里某个 DRM 系统的 pssh 盒（整盒字节）；moov 顶层和 moov 里都找。 */
export function psshBox(init: Uint8Array, systemID = WIDEVINE_SYSTEM_ID): Uint8Array | undefined {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength)
  const scan = (start: number, end: number): Uint8Array | undefined => {
    let offset = start
    while (offset + 8 <= end) {
      let size = view.getUint32(offset)
      const type = String.fromCharCode(...init.subarray(offset + 4, offset + 8))
      if (size === 0) size = end - offset
      if (size < 8 || offset + size > end) return undefined
      if (type === 'pssh' && size >= 32 && Buffer.from(init.subarray(offset + 12, offset + 28)).toString('hex') === systemID) {
        return init.subarray(offset, offset + size)
      }
      if (type === 'moov') {
        const found = scan(offset + 8, offset + size)
        if (found) return found
      }
      offset += size
    }
    return undefined
  }
  return scan(0, init.length)
}

export interface WidevineSegment {
  url: string
  offset: number
  length: number
  duration: number
}

export interface WidevineTrack {
  kind: 'video' | 'audio'
  codec: string
  init: Uint8Array
  pssh: Uint8Array
  scheme: string
  segments: WidevineSegment[]
}

/** `m3u8` 字段的 JSON 描述 → 视频、音频轨道。视频决定时长（试看时只有前几分钟），音频截到同样长。 */
export function widevineTracks(raw: string): { video: WidevineTrack; audio?: WidevineTrack } {
  const json = JSON.parse(raw)
  const group = Object.values(json?.payload ?? {})[0] as Record<string, any> | undefined
  if (!group) throw new Error('payload 里没有轨道')
  const track = (kind: 'video' | 'audio', limit?: number): WidevineTrack | undefined => {
    const entry = Object.entries(group).find(([key]) => key.startsWith(`${kind}_track`))?.[1]
    if (!entry) return undefined
    const init = new Uint8Array(Buffer.from(String(entry.codec_init ?? ''), 'base64'))
    const pssh = psshBox(init)
    if (!pssh) throw new Error(`${kind} 的 init 里没有 Widevine pssh`)
    const segments: WidevineSegment[] = []
    for (const file of arr(entry.files)) {
      const url = text(file?.file_name)
      const seekable = file?.seekable ?? {}
      if (!url) continue
      if (Array.isArray(seekable.pos) && Array.isArray(seekable.time)) {
        // 一个大文件，按 pos / time 切段；最后一段到文件尾。
        const pos = seekable.pos as number[]
        const time = seekable.time as number[]
        const size = num(file.size) ?? 0
        const total = num(file.duration_second) ?? num(entry.duration_second) ?? 0
        for (let i = 0; i < pos.length; i++) {
          if (limit !== undefined && time[i] >= limit - 0.01) break
          const end = i + 1 < pos.length ? pos[i + 1] : size
          const duration = (i + 1 < time.length ? time[i + 1] : total) - time[i]
          if (end > pos[i] && duration > 0) segments.push({ url, offset: pos[i], length: end - pos[i], duration })
        }
      } else {
        const start = num(seekable.pos_start) ?? 0
        const end = num(seekable.pos_end) ?? (start + (num(file.size) ?? 0))
        const duration = (num(seekable.time_end) ?? 0) - (num(seekable.time_start) ?? 0) || (num(file.duration_second) ?? 0)
        if (end > start && duration > 0) segments.push({ url, offset: start, length: end - start, duration })
      }
    }
    if (segments.length === 0) throw new Error(`${kind} 没有分片`)
    return { kind, codec: str(entry.codec) ?? '', init, pssh, scheme: str(entry.encryption_scheme) ?? 'cenc', segments }
  }
  const video = track('video')
  if (!video) throw new Error('没有视频轨')
  const length = video.segments.reduce((sum, s) => sum + s.duration, 0)
  return { video, audio: track('audio', length) }
}

/** 一条轨道的媒体播放列表：`initURL` 是 init 段的地址（网关提供）。 */
export function widevineMediaPlaylist(track: WidevineTrack, initURL: string): string {
  const target = Math.ceil(Math.max(...track.segments.map((s) => s.duration)))
  // cenc（AES-CTR）写 SAMPLE-AES-CTR；cbcs 写 SAMPLE-AES。
  const method = track.scheme === 'cbcs' ? 'SAMPLE-AES' : 'SAMPLE-AES-CTR'
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-KEY:METHOD=${method},URI="data:text/plain;base64,${Buffer.from(track.pssh).toString('base64')}",KEYFORMAT="${WIDEVINE_KEYFORMAT}",KEYFORMATVERSIONS="1"`,
    `#EXT-X-MAP:URI="${initURL}"`,
  ]
  for (const segment of track.segments) {
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${segment.length}@${segment.offset}`, segment.url)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

/** 主播放列表：一个视频变体，音频作 `EXT-X-MEDIA`。 */
export function widevineMaster(tracks: { video: WidevineTrack; audio?: WidevineTrack }, uris: { video: string; audio?: string }, resolution?: string): string {
  const peak = (track: WidevineTrack) => Math.max(...track.segments.map((s) => (s.length * 8) / s.duration))
  const bandwidth = Math.ceil(peak(tracks.video) + (tracks.audio ? peak(tracks.audio) : 0))
  const codecs = [tracks.video.codec, tracks.audio?.codec].filter(Boolean).join(',')
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS']
  if (tracks.audio && uris.audio) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="默认",DEFAULT=YES,AUTOSELECT=YES,URI="${uris.audio}"`)
  const attributes = [`BANDWIDTH=${bandwidth}`, `CODECS="${codecs}"`]
  if (resolution && /^\d+x\d+$/.test(resolution)) attributes.push(`RESOLUTION=${resolution}`)
  if (tracks.audio && uris.audio) attributes.push('AUDIO="audio"')
  lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, uris.video, '')
  return lines.join('\n')
}

/** 播放列表里实际写了哪几种 DRM 的 key 标签（流的 `drm` 按它给，不按平台写死）。 */
export function keySystems(playlist: string): ('fairplay' | 'widevine')[] {
  const systems = new Set<'fairplay' | 'widevine'>()
  for (const line of playlist.split(/\r?\n/)) {
    if (!/^#EXT-X-(SESSION-)?KEY:/.test(line)) continue
    if (/KEYFORMAT="com\.apple\.streamingkeydelivery"/i.test(line) || /URI="skd:\/\//.test(line)) systems.add('fairplay')
    if (line.toLowerCase().includes(WIDEVINE_KEYFORMAT)) systems.add('widevine')
  }
  return [...systems]
}
