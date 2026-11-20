import type { Cue } from '@iyt-source/protocol'

/** SRT / WebVTT 读成逐句原文。 */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0) continue
    const [from, to] = lines[timing].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const start = seconds(from)
    const end = seconds(to)
    if (start === undefined || end === undefined) continue
    const body = lines
      .slice(timing + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

function seconds(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value)
  if (!match) return undefined
  const [, hours, minutes, secs, fraction] = match
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(secs) + Number(fraction.padEnd(3, '0')) / 1000
}

/** SRT 转 WebVTT（时间里的逗号换成点）。 */
export function toWebVTT(text: string): string {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (normalized.startsWith('WEBVTT')) return normalized
  const body = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body}`
}
