import type { Cue } from '@iyt-source/protocol'

/** WebVTT 的时间：`hh:mm:ss.mmm` 或 `mm:ss.mmm`，秒。 */
export function vttTime(text: string): number {
  const parts = text.trim().replace(',', '.').split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return Number.NaN
  return parts.reduce((total, n) => total * 60 + n, 0)
}

/** 读出 WebVTT 的每一句（去掉标签和样式块）。 */
export function parseWebVTT(text: string): Cue[] {
  const cues: Cue[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const at = lines.findIndex((line) => line.includes('-->'))
    if (at < 0) continue
    const [from, rest] = lines[at].split('-->')
    const start = vttTime(from)
    const end = vttTime(rest.trim().split(/\s+/)[0])
    const body = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue
    cues.push({ start, end, text: body })
  }
  return cues
}
