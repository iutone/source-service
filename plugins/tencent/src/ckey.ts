// 播放请求 `proxyhttp` 的 cKey（App 的 TencentCKey / TencentCKey92）。
// - 8.5：官方 superplayer 的降级算法，服务端仍接受（API.md §4.2）。`--01` + AES-128-CBC/PKCS7 的大写十六进制，绑定 vid。
//   带登录态时它拿到的分片会被限流（每片 64 KB 就挂住），所以只在 vinfo_proxy 失败时兜底。
// - 9.2：网页 superplayer 1.80.0 自己的 wasm（`assets/ckey92.wasm`，SHA-256 d863d96e…），用 Node 的 WebAssembly 直接跑
//   （docs/tencent-web/CKEY-9.2.md）。`HRA(platform, appVer, vid, "", guid, 环境串, extension, options, h38, tm)` 给出
//   10 个候选，用 `|` 连起来，请求取下标 6（这一版观察到的）。
import { createCipheriv, createDecipheriv, createHash, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PLAYER_PLATFORM, PLAYER_VERSION, USER_AGENT } from './constants.ts'

const KEY85 = Buffer.from('2A5AA60178AA6C8DA662E443773A6C4E', 'hex')
const IV85 = Buffer.from('CFAC216FAA2D396013575D4055C63350', 'hex')
const NONCE_ALPHABET = 'ABCEFGHIJKLNOPQRSTVWXYZabcefgijklmnpqrsuvwxz0124679'

export const CKEY85_VERSION = '8.5'

/**
 * - Parameter timestamp: 秒；请求的 `tm` 必须相同。
 * - Parameter h38: 这台服务的 Qimei h38，没有时为空。
 */
export function cKey85(vid: string, guid: string, timestamp: number, h38 = '', nonce?: string): string {
  const n = nonce ?? Array.from({ length: 11 }, () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]).join('')
  const rand = createHash('md5').update(`${n}1234`).digest('hex').slice(0, 8)
  // 字段顺序照播放器写的。
  const fields: [string, string][] = [
    ['vid', vid], ['sdkVer', '1.0.1'], ['nonce', n], ['rand', rand], ['appVer', PLAYER_VERSION], ['guid', guid],
    ['platform', PLAYER_PLATFORM], ['ts', String(timestamp)], ['h38', h38], ['sj', ''], ['bj', ''], ['os', '{}'],
  ]
  const json = `{${fields.map(([k, v]) => `"${k}":${JSON.stringify(v)}`).join(',')}}`
  const cipher = createCipheriv('aes-128-cbc', KEY85, IV85)
  return `--01${Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]).toString('hex').toUpperCase()}`
}

/** 测试用：解开 8.5 的 cKey。 */
export function decryptCKey85(key: string): string {
  const decipher = createDecipheriv('aes-128-cbc', KEY85, IV85)
  return Buffer.concat([decipher.update(Buffer.from(key.slice(4), 'hex')), decipher.final()]).toString('utf8')
}

export const CKEY92_VERSION = '9.2'
/** wasm 来自的播放器版本；请求的 `appVer` 必须写它。 */
export const CKEY92_APP_VERSION = '1.80.0'
const CANDIDATE_INDEX = 6
const EXTENSION = '{"csal":["9x7k6uc7xw","m5h0zchrh5"]}'
const OPTIONS = '{"ea":3,"spa":1}'

let wasmModule: WebAssembly.Module | undefined

function module92(): WebAssembly.Module {
  wasmModule ??= new WebAssembly.Module(readFileSync(new URL('../assets/ckey92.wasm', import.meta.url)))
  return wasmModule
}

/** 播放页地址和浏览器 UA（小写）各取前 48 个字符。 */
export function ckey92Environment(page: string, userAgent = USER_AGENT): string {
  return `${page.slice(0, 48)}|${userAgent.toLowerCase().slice(0, 48)}|https://v.qq.com/|Mozilla|Netscape|MacIntel`
}

/** 十个候选（测试比对用）。每次新建一个实例（模块只解析一次）。 */
export function ckey92Candidates(input: { vid: string; guid: string; h38: string; environment: string; timestamp: number; nowMs?: number }): string[] {
  const nowMs = input.nowMs ?? Date.now()
  let memory: WebAssembly.Memory | undefined
  const instance = new WebAssembly.Instance(module92(), {
    UA6: {
      '0zS': () => {
        throw new Error('ckey92 wasm abort')
      },
      // 固定 16 MiB 内存：拒绝扩容。
      OFQ: () => 0,
      '2Hi': () => nowMs,
      n3z: (destination: number, source: number, size: number) => {
        new Uint8Array(memory!.buffer).copyWithin(destination, source, source + size)
      },
    },
  })
  const exports = instance.exports as Record<string, any>
  memory = exports.XiA as WebAssembly.Memory
  exports.Myf()
  const allocated: number[] = []
  let result = 0
  const put = (value: string) => {
    const bytes = Buffer.from(value, 'utf8')
    const pointer = exports.YCO(bytes.length + 1) as number
    if (!pointer) throw new Error('ckey92 wasm allocation failed')
    allocated.push(pointer)
    const view = new Uint8Array(memory!.buffer)
    view.set(bytes, pointer)
    view[pointer + bytes.length] = 0
    return pointer
  }
  try {
    const strings = [CKEY92_APP_VERSION, input.vid, '', input.guid, input.environment, EXTENSION, OPTIONS, input.h38]
    result = exports.HRA(Number(PLAYER_PLATFORM), ...strings.map(put), input.timestamp | 0) as number
    const view = new Uint8Array(memory.buffer)
    const end = view.indexOf(0, result)
    if (!result || end < 0) throw new Error('ckey92 wasm bad result')
    const candidates = Buffer.from(view.subarray(result, end)).toString('utf8').split('|')
    if (candidates.length !== 10) throw new Error('ckey92 wasm unexpected result')
    return candidates
  } finally {
    for (const pointer of allocated) exports.Cuk(pointer)
    if (result) exports.Cuk(result)
  }
}

export function cKey92(input: { vid: string; guid: string; h38: string; page: string; timestamp: number; nowMs?: number }): string {
  return ckey92Candidates({ ...input, environment: ckey92Environment(input.page) })[CANDIDATE_INDEX]!
}
