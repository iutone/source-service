// 弹幕（API.md §4.4，App 的 TencentDanmakuService）：`dm.video.qq.com/barrage/segment/<vid>/t/v1/<起毫秒>/<止毫秒>`，
// 每次 30 秒，不用登录。
import type { Danmaku } from '@iyt-source/protocol'
import { DANMAKU_HOST } from './constants.ts'
import { parseID } from './ids.ts'
import { arr, int, num, parseJSON, text } from './json.ts'
import type { TencentSession } from './session.ts'

export const DANMAKU_SEGMENT = 30

/** `time_offset` 毫秒；`content_style` 是 JSON 字符串：`color`（十六进制；渐变的在 `gradient_colors`）、`position`（2 顶、3 底，其余滚动）。 */
export function danmakuOf(list: unknown): Danmaku[] {
  return arr(list).flatMap((entry): Danmaku[] => {
    const content = text(entry?.content)
    const time = num(entry?.time_offset)
    if (!content || time === undefined) return []
    const style = parseJSON(entry.content_style)
    const position = int(style?.position) === 2 ? 'top' : int(style?.position) === 3 ? 'bottom' : 'scroll'
    // 带样式的弹幕 `color` 是白的，颜色在渐变里。
    const raw = text(arr(style?.gradient_colors)[0]) ?? text(style?.color)
    const color = raw && /^[0-9a-f]{1,6}$/i.test(raw) ? `#${raw.padStart(6, '0').toUpperCase()}` : '#FFFFFF'
    return [{ id: text(entry.id) ?? `${time}-${content}`, time: time / 1000, text: content, position, color }]
  })
}

export async function danmakuSegment(session: TencentSession, video: string, segment: number, signal?: AbortSignal): Promise<Danmaku[]> {
  const parsed = parseID(video)
  if (parsed?.kind !== 'video') return []
  const start = segment * DANMAKU_SEGMENT * 1000
  const response = await session.request(`${DANMAKU_HOST}/barrage/segment/${parsed.id}/t/v1/${start}/${start + DANMAKU_SEGMENT * 1000}`, { signal })
  return danmakuOf(response?.barrage_list)
}
