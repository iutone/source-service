// 宽松读取网页接口 JSON 的小工具（对应 App 的 JSONValue）：字段形状只部分已知，取不到就是 undefined。
import type { Badge } from '@iyt-source/protocol'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = any

/** 非空字符串；数字转成字符串。 */
export function text(value: J): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 去掉首尾空白后的非空字符串（"第二季 "）。 */
export function trimmed(value: J): string | undefined {
  const t = text(value)?.trim()
  return t ? t : undefined
}

export function num(value: J): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function int(value: J): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.trunc(n)
}

export function bool(value: J): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.toLowerCase())
  return undefined
}

export function arr(value: J): J[] {
  return Array.isArray(value) ? value : []
}

export function isNull(value: J): boolean {
  return value === undefined || value === null
}

/** 树里第一个（深度优先）键为 `key` 的非 null 值。 */
export function first(value: J, key: string): J {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = first(item, key)
      if (found !== undefined) return found
    }
  } else if (value && typeof value === 'object') {
    if (key in value && value[key] !== null && value[key] !== undefined) return value[key]
    for (const item of Object.values(value)) {
      const found = first(item, key)
      if (found !== undefined) return found
    }
  }
  return undefined
}

export function firstText(value: J, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = text(first(value, key))
    if (found) return found
  }
  return undefined
}

/** 网页的图片字段可能是 `//…` 或 http：一律换成 https。 */
export function webImage(value: J): string | undefined {
  let s = text(value)
  if (!s) return undefined
  if (s.startsWith('//')) s = 'https:' + s
  if (s.startsWith('http://')) s = 'https://' + s.slice('http://'.length)
  return s
}

/** 键排序后的 JSON（App 用 `.sortedKeys` 序列化 `params` / `system_info` / 游标）。 */
export function sortedJSON(value: J): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: J): J {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, J> = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key])
    }
    return out
  }
  return value
}

/** 平台的角标颜色 → 协议的 tone。 */
export function tone(color: J): Badge['tone'] {
  switch (String(color ?? '').toUpperCase()) {
    case 'RED':
      return 'red'
    // 剧集写 GOLDEN，卡片写 YELLOW。
    case 'YELLOW':
    case 'GOLDEN':
      return 'gold'
    case 'BLUE':
      return 'blue'
    default:
      return 'neutral'
  }
}

/** 把对象里值为 undefined 的键去掉（输出更干净，测试好比对）。 */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key]
  return value
}
