/** HLS 播放列表的改写与拼装（SERVER.md §12.2）。纯函数，便于测试。 */

const URI_ATTRIBUTE = /URI="([^"]*)"/g

/**
 * 把播放列表里所有地址（分片行、`URI="…"` 属性：KEY / MAP / MEDIA / I-FRAME / SESSION-KEY / PRELOAD-HINT …）
 * 按 `base` 解析成绝对地址后交给 `map` 换掉。
 */
export function rewritePlaylist(text: string, base: string, map: (absolute: string) => string): string {
  const resolve = (value: string) => {
    if (value.startsWith('data:') || value.startsWith('skd:')) return value
    return map(new URL(value, base).toString())
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return line
      if (trimmed.startsWith('#')) return line.replace(URI_ATTRIBUTE, (_, uri: string) => `URI="${resolve(uri)}"`)
      return resolve(trimmed)
    })
    .join('\n')
}

export function isPlaylist(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U')
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF')
}

export interface SubtitleRendition {
  name: string
  language: string
  /** 字幕的 HLS 媒体播放列表地址（见 `webVTTPlaylist`）。 */
  uri: string
  isDefault?: boolean
  autoselect?: boolean
  /** 机器生成的字幕：`public.accessibility.describes-music-and-sound` 之外，App 识别的标记写在 CHARACTERISTICS。 */
  characteristics?: string
}

/** 往 master 里加字幕轨：`EXT-X-MEDIA:TYPE=SUBTITLES`，每个变体带上 `SUBTITLES="<group>"`。 */
export function addSubtitleRenditions(master: string, subtitles: SubtitleRendition[], group = 'subs'): string {
  if (subtitles.length === 0) return master
  const media = subtitles.map((sub) => {
    const attributes = [
      'TYPE=SUBTITLES',
      `GROUP-ID="${group}"`,
      `NAME="${sub.name.replaceAll('"', "'")}"`,
      `LANGUAGE="${sub.language}"`,
      `DEFAULT=${sub.isDefault ? 'YES' : 'NO'}`,
      `AUTOSELECT=${sub.autoselect === false ? 'NO' : 'YES'}`,
    ]
    if (sub.characteristics) attributes.push(`CHARACTERISTICS="${sub.characteristics}"`)
    attributes.push(`URI="${sub.uri}"`)
    return `#EXT-X-MEDIA:${attributes.join(',')}`
  })
  const lines = master.split(/\r?\n/)
  const out: string[] = []
  let inserted = false
  for (const line of lines) {
    if (!inserted && line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(...media)
      inserted = true
    }
    if (line.startsWith('#EXT-X-STREAM-INF') && !line.includes('SUBTITLES=')) {
      out.push(`${line},SUBTITLES="${group}"`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

/** 只有一个媒体播放列表时，合成一个只含它的 master（好往里加字幕）。 */
export function masterFor(mediaURI: string, bandwidth: number, extra: { resolution?: string; codecs?: string } = {}): string {
  const attributes = [`BANDWIDTH=${bandwidth}`]
  if (extra.resolution) attributes.push(`RESOLUTION=${extra.resolution}`)
  if (extra.codecs) attributes.push(`CODECS="${extra.codecs}"`)
  return ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-STREAM-INF:${attributes.join(',')}`, mediaURI, ''].join('\n')
}

/** 一个完整 WebVTT 文件当作单分片的字幕媒体播放列表。 */
export function webVTTPlaylist(vttURI: string, duration: number): string {
  const seconds = Math.max(1, Math.ceil(duration))
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${seconds}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${seconds.toFixed(3)},`,
    vttURI,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
}
