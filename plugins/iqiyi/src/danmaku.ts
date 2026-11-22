// 弹幕（照 App 的 IQiyiDanmakuService）：`cmts.iqiyi.com/bullet/<tvid 倒数第4-3位>/<倒数第2-1位>/<tvid>_300_<n>.z`，
// 每段 5 分钟，zlib 压缩的 XML，不用登录（docs/iqiyi-web/API.md §8）。
import { inflateSync, inflateRawSync } from 'node:zlib'
import type { Danmaku } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import type { IQiyiSession } from './session.ts'
import { parseID } from './util.ts'

export const DANMAKU_SEGMENT = 300

export async function danmakuSegment(session: IQiyiSession, video: string, segment: number, signal: AbortSignal | undefined): Promise<Danmaku[]> {
  const id = parseID(video)
  if (id?.kind !== 'video' || id.id.length < 4) return []
  const tvid = id.id
  const url = `https://cmts.iqiyi.com/bullet/${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_${segment + 1}.z`
  const response = await session.fetch(url, signal)
  // 过了最后一段 CDN 回 404。
  if (response.status === 404 || response.status === 403) return []
  if (!response.ok) throw new SourceError('unavailable', `弹幕加载失败（HTTP ${response.status}）`, { retryable: true })
  return danmakuFromZlib(new Uint8Array(await response.arrayBuffer()))
}

export function danmakuFromZlib(data: Uint8Array): Danmaku[] {
  let xml: string
  try {
    xml = inflateSync(data).toString('utf8')
  } catch {
    try {
      xml = inflateRawSync(data).toString('utf8')
    } catch {
      return []
    }
  }
  return parseBullets(xml)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      return ENTITIES[entity.toLowerCase()] ?? match
    })
    .trim()
}

/** `<bulletInfo>`：`contentId`、`content`、`showTime`（秒）、`color`（hex）。嵌套的用户信息里有同名字段，取弹幕自己的（第一个）。 */
export function parseBullets(xml: string): Danmaku[] {
  const comments: Danmaku[] = []
  for (const match of xml.matchAll(/<bulletInfo>([\s\S]*?)<\/bulletInfo>/g)) {
    const body = match[1]
    const field = (name: string) => {
      const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
      return found ? decode(found[1]) : undefined
    }
    const content = field('content')
    const time = Number(field('showTime'))
    if (!content || !Number.isFinite(time)) continue
    const color = field('color')
    const hex = color && /^[0-9a-f]{1,6}$/i.test(color) ? color.padStart(6, '0').toUpperCase() : 'FFFFFF'
    // `position` 在见过的文件里都是 0（滚动）。
    comments.push({ id: field('contentId') ?? `${time}-${content}`, time, text: content, position: 'scroll', color: `#${hex}` })
  }
  return comments
}
