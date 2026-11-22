// 腾讯视频的网页接口返回的 JSON 很松散：数字常常是字符串，反之亦然（App 的 TXJSON）。这里是读它的几个小工具。

/** 字符串值（数字转成字符串）。 */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return undefined
}

/** 非空字符串（去掉首尾空格）。 */
export function text(value: unknown): string | undefined {
  const s = str(value)?.trim()
  return s ? s : undefined
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function int(value: unknown): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.trunc(n)
}

/** id：数字或字符串；`0` 和空串都算没有。 */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') return value !== 0 && Number.isFinite(value) ? String(Math.trunc(value)) : undefined
  if (typeof value === 'string') return value !== '' && value !== '0' ? value : undefined
  return undefined
}

export function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字段里装的 JSON 字符串；读不懂返回 undefined。 */
export function parseJSON(value: unknown): any {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** 图片地址：常是 `http://` 或省略协议的 `//…`，一律换成 https。 */
export function imageURL(value: unknown): string | undefined {
  let s = text(value)
  if (!s) return undefined
  if (s.startsWith('//')) s = `https:${s}`
  if (s.startsWith('http://')) s = `https://${s.slice('http://'.length)}`
  return /^https:\/\//.test(s) ? s : undefined
}

/** 按 App 的 `PageServer/GetPageData` 结构取出全部条目。 */
export function pageItems(data: any): any[] {
  return arr(data?.module_list_datas).flatMap((m) => arr(m?.module_datas)).flatMap((d) => arr(d?.item_data_lists?.item_datas))
}
