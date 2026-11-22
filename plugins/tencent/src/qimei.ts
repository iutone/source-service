// 这台服务的 Qimei `h38`（docs/tencent-web/QIMEI.md，App 的 TencentQimei / TencentQimeiCodec）：腾讯的设备号，由
// `snowflake.qq.com/ola/v2` 按网页 SDK 上报的设备信息（cmd 12）签发；播放签名要它（网页的 cKey 9.2、8.5 的 h38 字段；
// vinfo_proxy 的 cookie 里也带）。上报装成播放请求所用的 Safari：一份简短的指纹，用随机的 UUID42 和 canvas id
// 变成这台服务自己的（服务端按两者派生 h38）。一天问一次（SDK 的 idFrequency），失败时沿用上次的；从来没有时给 ""。
import { randomBytes, randomInt } from 'node:crypto'
import type { KeyValueStore } from '@iyt-source/kit'
import { USER_AGENT, REFERER, ORIGIN } from './constants.ts'
import { text } from './json.ts'

export const QIMEI_APP_KEY = '15d45fa36b498329'
export const QIMEI_SDK_VERSION = '0.9.6-alpha.1'
const ENDPOINT = 'https://snowflake.qq.com/ola/v2'
const REFRESH_INTERVAL = 86_400_000
const INNER_KEY = 'f3553bea6fcf365c6f8e4f3f9554e716'
const OUTER_KEY = '35b4cfe6f7eae7acbd7bace522d0db54'
const PREFIX = Uint8Array.from([1, 0, 0, 0, 200])

// MARK: 编码（SDK 0.9.6 的客户端部分）

export function rc4(bytes: Uint8Array, key: string): Uint8Array {
  const k = Buffer.from(key, 'utf8')
  const state = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + k[i % k.length]!) & 255
    ;[state[i], state[j]] = [state[j]!, state[i]!]
  }
  const out = new Uint8Array(bytes.length)
  let i = 0
  j = 0
  for (let n = 0; n < bytes.length; n++) {
    i = (i + 1) & 255
    j = (j + state[i]!) & 255
    ;[state[i], state[j]] = [state[j]!, state[i]!]
    out[n] = bytes[n]! ^ state[(state[i]! + state[j]!) & 255]!
  }
  return out
}

/** 请求的 `pms`：`hex(RC4(prefix + RC4(json, inner), outer))`。 */
export function encodeRequest(json: string | Uint8Array): string {
  const bytes = typeof json === 'string' ? Buffer.from(json, 'utf8') : json
  const inner = rc4(bytes, INNER_KEY)
  const joined = new Uint8Array(PREFIX.length + inner.length)
  joined.set(PREFIX)
  joined.set(inner, PREFIX.length)
  return Buffer.from(rc4(joined, OUTER_KEY)).toString('hex')
}

export function decodeRequest(hex: string): string | undefined {
  const bytes = fromHex(hex)
  if (!bytes) return undefined
  const outer = rc4(bytes, OUTER_KEY)
  if (outer.length < PREFIX.length || PREFIX.some((b, i) => outer[i] !== b)) return undefined
  return Buffer.from(rc4(outer.subarray(PREFIX.length), INNER_KEY)).toString('utf8')
}

/** 响应的 `data`：`RC4(bytes, outer)`，JSON。 */
export function decodeResponse(hex: string): string | undefined {
  const bytes = fromHex(hex)
  return bytes ? Buffer.from(rc4(bytes, OUTER_KEY)).toString('utf8') : undefined
}

function fromHex(hex: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) return undefined
  return Buffer.from(hex, 'hex')
}

export function crc32Hex(input: string): string {
  let crc = 0xffffffff
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

/** 日历字段（年、月、日、时、分、秒），按北京时间（网页 SDK 读的是浏览器本地时间，假装是国内的 Safari）。 */
export interface CalendarFields {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function shanghaiFields(date: Date): CalendarFields {
  const d = new Date(date.getTime() + 8 * 3600_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }
}

/**
 * `time + flags + crc[0..<4] + random20 + crc[4..<8]`：时间取本地日历字段（每个两位十六进制，月份一位），flags 在开着
 * cookie 时是 `"100"`。
 */
export function uuid42(fields: CalendarFields = shanghaiFields(new Date()), cookieEnabled = true, random: () => number = Math.random): string {
  const hex2 = (n: number) => n.toString(16).padStart(2, '0')
  const time = hex2(fields.year % 100) + fields.month.toString(16) + [fields.day, fields.hour, fields.minute, fields.second].map(hex2).join('')
  const flags = `${cookieEnabled ? '1' : '0'}00`
  let random20 = ''
  for (let i = 0; i < 20; i++) random20 += Math.floor(random() * 16).toString(16)
  const crc = crc32Hex(`${time}${flags}----${random20}----`)
  return (time + flags + crc.slice(0, 4) + random20 + crc.slice(4)).toLowerCase()
}

const MASK = (1n << 64n) - 1n

/**
 * SDK 的 `x64hash128(text, 31)`：MurmurHash3 x64-128，只是尾部第一个字节落在 `k1` 的高 32 位（SDK 写的是
 * `[charCode]`，参考实现是 `[0, charCode]`）。每个 UTF-16 单元截成一个字节。
 */
export function x64hash128(input: string, seed = 31): string {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) bytes.push(input.charCodeAt(i) & 255)
  const c1 = 0x87c37b91114253d5n
  const c2 = 0x4cf5ad432745937fn
  const rot = (n: bigint, r: bigint) => ((n << r) | (n >> (64n - r))) & MASK
  const mul = (a: bigint, b: bigint) => (a * b) & MASK
  const add = (a: bigint, b: bigint) => (a + b) & MASK
  const fmix = (value: bigint) => {
    let n = value
    n ^= n >> 33n
    n = mul(n, 0xff51afd7ed558ccdn)
    n ^= n >> 33n
    n = mul(n, 0xc4ceb9fe1a85ec53n)
    return n ^ (n >> 33n)
  }
  const word = (offset: number) => {
    let w = 0n
    for (let i = 0; i < 8; i++) w |= BigInt(bytes[offset + i]!) << BigInt(i * 8)
    return w
  }
  let h1 = BigInt(seed)
  let h2 = BigInt(seed)
  const blocks = Math.floor(bytes.length / 16)
  for (let b = 0; b < blocks; b++) {
    let k1 = word(b * 16)
    let k2 = word(b * 16 + 8)
    k1 = mul(rot(mul(k1, c1), 31n), c2)
    h1 ^= k1
    h1 = add(mul(add(rot(h1, 27n), h2), 5n), 0x52dce729n)
    k2 = mul(rot(mul(k2, c2), 33n), c1)
    h2 ^= k2
    h2 = add(mul(add(rot(h2, 31n), h1), 5n), 0x38495ab5n)
  }
  const tail = bytes.slice(blocks * 16)
  let k1 = 0n
  let k2 = 0n
  if (tail.length > 0) k1 = BigInt(tail[0]!) << 32n
  for (let i = 1; i < Math.min(tail.length, 8); i++) k1 ^= BigInt(tail[i]!) << BigInt(i * 8)
  for (let i = 8; i < tail.length; i++) k2 |= BigInt(tail[i]!) << BigInt((i - 8) * 8)
  if (tail.length > 8) h2 ^= mul(rot(mul(k2, c2), 33n), c1)
  if (tail.length > 0) h1 ^= mul(rot(mul(k1 & MASK, c1), 31n), c2)
  h1 ^= BigInt(bytes.length)
  h2 ^= BigInt(bytes.length)
  h1 = add(h1, h2)
  h2 = add(h2, h1)
  h1 = fmix(h1)
  h2 = fmix(h2)
  h1 = add(h1, h2)
  h2 = add(h2, h1)
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0')
}

/** 键排好序的紧凑 JSON（照 App 的 `JSONSerialization` `.sortedKeys`）。 */
export function sortedJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    }
    return v
  })
}

// MARK: 上报

export interface QimeiRecord {
  uuid: string
  canvas: string
  h38: string
  fetchedAt?: number
}

/** `cmd` 12 的上报：SDK 发的字段类型，加 Safari 的指纹和它的 `hid`。 */
export function qimeiReport(record: QimeiRecord): Record<string, unknown> {
  const resolution = '1920x1080'
  const timezoneOffset = -480
  const fingerprint = {
    canvas: { id: record.canvas, winding: true },
    screen: { resolution, availResolution: '1920x1055', dpr: 2, colorDepth: 24 },
    navigator: {
      hardwareConcurrency: 8, platform: 'MacIntel', productSub: '20030107', userAgent: USER_AGENT, vendor: 'Apple Computer, Inc.',
      cookieEnabled: true, language: 'zh-CN', languages: ['zh-CN'],
    },
    indexedDB: true, localStorage: true, sessionStorage: true, timezoneOffset, timezone: 'Asia/Shanghai', webgl: 'Apple Inc.~Apple GPU', localIP: '',
  }
  const hid = x64hash128([
    resolution, '1920x1055', '', 'true', 'true', '20030107', '8', record.canvas, String(timezoneOffset), 'Mac', x64hash128(''),
  ].join('###'))
  return {
    runTime: 80, isDebug: false, version: QIMEI_SDK_VERSION, appKey: QIMEI_APP_KEY, q36: '', q32: '', appQ36: '',
    h38: record.h38, oldHid: hid, userId: '{}', uuid: record.uuid, hid, q64: '', localIp: '',
    platform: 'MacIntel', resolution, fingerprint: sortedJSON(fingerprint), upgrade: 1, rt: '', ft: '',
  }
}

export function qimeiRequestBody(cmd: number, data: Record<string, unknown>, ssid: string, now = Date.now()): string {
  const header = { cmd, ssid, app_key: QIMEI_APP_KEY, sdk_ver: QIMEI_SDK_VERSION, platform: 4, q36: '', q16: '', type: 'web' }
  const envelope = sortedJSON({ header, data: sortedJSON(data) })
  return JSON.stringify({ cpt: 3, tm: String(Math.floor(now / 1000)), pms: encodeRequest(envelope) })
}

/** 这台服务的 h38：没有或满一天时去问；问不到给上次的（或 ""）。并发的调用共用一次请求。 */
export class Qimei {
  private record: QimeiRecord
  private pending?: Promise<string>
  private readonly store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.store = store
    this.record = store.get<QimeiRecord>('qimei') ?? { uuid: uuid42(), canvas: randomBytes(16).toString('hex'), h38: '' }
  }

  get cached(): string {
    return this.record.h38
  }

  async h38(now = Date.now()): Promise<string> {
    if (this.record.h38 && this.record.fetchedAt && now - this.record.fetchedAt < REFRESH_INTERVAL) return this.record.h38
    this.pending ??= this.refresh(now).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async refresh(now: number): Promise<string> {
    const current = { ...this.record }
    try {
      await this.send(4, { appKey: QIMEI_APP_KEY, version: QIMEI_SDK_VERSION }).catch(() => undefined)
      const answer = await this.send(12, qimeiReport(current))
      const h38 = text(answer?.h38)
      if (!h38 || h38.length !== 38) throw new Error('qimei h38')
      this.record = { ...current, h38, fetchedAt: now }
      this.store.set('qimei', this.record)
      return h38
    } catch {
      return current.h38
    }
  }

  private async send(cmd: number, data: Record<string, unknown>): Promise<any> {
    const ssid = uuid42(shanghaiFields(new Date()), true, () => randomInt(16) / 16)
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      body: qimeiRequestBody(cmd, data, ssid),
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, referer: REFERER, origin: ORIGIN },
      signal: AbortSignal.timeout(10_000),
    })
    const outer = (await response.json()) as { code?: unknown; data?: unknown }
    const hex = text(outer.data)
    const plain = Number(outer.code) === 0 && hex ? decodeResponse(hex) : undefined
    if (!plain) throw new Error(`qimei cmd ${cmd}: ${String(outer.code)}`)
    return JSON.parse(plain)
  }
}
