/**
 * 客户端声明能解的编码（`ResolveRequest.preferences.codecs`）。名字按 RFC 6381 的四字符前缀比较：
 * `avc1`、`hvc1`、`av01`、`vp09`、`mp4a`、`ac-3`、`ec-3` 等；ffprobe / yt-dlp 的写法（`hevc`、`h264`、`eac3`…）先归一。
 * 客户端没带 `codecs` 时什么都算支持（旧客户端的行为不变）。
 */

const ALIASES: Record<string, string> = {
  h264: 'avc1', avc: 'avc1', avc3: 'avc1',
  hevc: 'hvc1', h265: 'hvc1', hev1: 'hvc1',
  av1: 'av01',
  vp9: 'vp09', vp8: 'vp08',
  dvhe: 'dvh1', dvav: 'dvh1', dva1: 'dvh1',
  aac: 'mp4a',
  ac3: 'ac-3',
  eac3: 'ec-3',
  dts: 'dtsc',
}

/** `hev1.1.6.L93.B0` → `hvc1`，`eac3` → `ec-3`。 */
export function codecFamily(codec: string): string {
  const head = codec.trim().toLowerCase().split('.')[0]
  return ALIASES[head] ?? head
}

/** `codecs` 缺省（null / undefined）时一律 true；给了就按家族比较。 */
export function codecSupported(codecs: readonly string[] | null | undefined, codec: string | null | undefined): boolean {
  if (!codecs || !codec) return true
  const family = codecFamily(codec)
  return codecs.some((c) => codecFamily(c) === family)
}

const NAMES: Record<string, string> = { hvc1: 'HEVC', av01: 'AV1', vp09: 'VP9', dvh1: '杜比视界', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', dtsc: 'DTS' }

/** 给用户看的编码名：`hevc` → `HEVC`。 */
export function codecName(codec: string): string {
  const family = codecFamily(codec)
  return NAMES[family] ?? family.toUpperCase()
}
