// FairPlay（cbcs）档（docs/youku-web/FAIRPLAY.md；SERVER.md §6.4）：UPS 声明 `drm_type=19` 后给 cbcs 加密的 CMAF 流和许可地址
// （`stream_ext.uri`，token 绑本次取流）。解密在 Apple 设备上；服务端做两件事，照 App 的 FairPlayKit / YoukuFairPlayLicense：
// - 播放列表：优酷的视频媒体列表没有 `EXT-X-KEY`，插件补上 `skd://<默认 KID>`（初始化段 `tenc` 里的，KSM 认它作
//   content identifier），经网关给出；分片和初始化段仍直连 CDN，地址原样（带签名，不能重新编码）。
// - 许可：证书和 SPC 都 POST 到许可地址（它自己的 query 原样，`drmType=fairplay`，`licenseRequest=<base64>`），应答
//   `{data, enc}`，`enc=0` 时 `data` 是 base64 明文。不要 cookie（实测）。
import { randomBytes } from 'node:crypto'
import { SourceError, type KeyValueStore, type MediaGateway } from '@iyt-source/kit'
import { request } from './mtop.ts'
import { percentEncode } from './mtop.ts'

/** KuPlayer 要证书时发的固定请求。 */
export const CERTIFICATE_REQUEST = 'CAQ='

// MARK: ref

/** 只转发到优酷的许可服务，不当开放代理。 */
export function isLicenseURL(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && /(^|\.)youku\.com$/.test(parsed.hostname)
  } catch {
    return false
  }
}

const REF_TTL = 6 * 3600_000
const REF_LIMIT = 500

/**
 * `ref`：一个短 id，对应许可地址（带本次取流的 token，约 500 字符）。地址不能直接放进 ref：kit 的路由参数有长度上限
 * （Fastify 默认 `maxParamLength` 100），超了回 414。登记存进 ctx.store，服务重启后 token 有效期内仍能用。
 */
export class FairPlayRefs {
  private entries: Record<string, { u: string; at: number }> | undefined
  private store?: KeyValueStore

  attach(store: KeyValueStore): void {
    if (this.store) return
    this.store = store
    this.entries = store.get<Record<string, { u: string; at: number }>>('fairplay-refs') ?? {}
  }

  register(licenseURL: string): string {
    const entries = (this.entries ??= {})
    const now = Date.now()
    for (const [id, entry] of Object.entries(entries)) if (now - entry.at > REF_TTL) delete entries[id]
    const ids = Object.keys(entries)
    for (const id of ids.slice(0, Math.max(0, ids.length - REF_LIMIT + 1))) delete entries[id]
    const id = randomBytes(12).toString('base64url')
    entries[id] = { u: licenseURL, at: now }
    this.store?.set('fairplay-refs', entries)
    return id
  }

  resolve(ref: string): string {
    const entry = this.entries?.[ref]
    if (!entry || Date.now() - entry.at > REF_TTL) throw new SourceError('unplayable', 'FairPlay 许可已过期，请重新解析', { retryable: true })
    if (!isLicenseURL(entry.u)) throw new SourceError('bad_request', 'FairPlay 的参数不对')
    return entry.u
  }
}

// MARK: 许可

/** 许可请求体：地址自己的 query 原样（去掉 drmType），加 `drmType=fairplay` 和 `licenseRequest`。 */
export function licenseBody(licenseURL: string, licenseRequest: string): { endpoint: string; body: string } {
  const at = licenseURL.indexOf('?')
  const endpoint = at < 0 ? licenseURL : licenseURL.slice(0, at)
  const query = at < 0 ? '' : licenseURL.slice(at + 1)
  const fields = query.split('&').filter((f) => f && !f.startsWith('drmType='))
  fields.push('drmType=fairplay', `licenseRequest=${percentEncode(licenseRequest)}`)
  return { endpoint, body: fields.join('&') }
}

/** `{"data": <base64>, "enc": 0, "msg": "...", "states": n}`；`enc != 0` 要 KuPlayer 的 wasm，不支持。 */
export function decodeLicense(json: unknown): Buffer {
  const value = (json ?? {}) as { data?: unknown; enc?: unknown; msg?: unknown; states?: unknown }
  const message = typeof value.msg === 'string' ? value.msg : ''
  // 失败的应答也带 `data`（一串十六进制的追踪号）：按 `msg` / `states` 认（假 SPC：「gen fairplay license error」，states 209）。
  const states = value.states === undefined || value.states === null ? undefined : Number(value.states)
  const failed = /error|fail/i.test(message) || (states !== undefined && states !== 0 && states !== 200)
  if (failed || typeof value.data !== 'string' || !value.data) {
    throw new SourceError('restricted', `优酷的许可服务拒绝了：${message || '没有数据'}（${String(value.states ?? '?')}）`)
  }
  if (Number(value.enc ?? 0) !== 0) throw new SourceError('upstream_changed', `优酷的许可应答加密了（enc=${String(value.enc)}），暂不支持`)
  return Buffer.from(value.data, 'base64')
}

export async function postLicense(licenseURL: string, licenseRequest: string, signal?: AbortSignal): Promise<Buffer> {
  const { endpoint, body } = licenseBody(licenseURL, licenseRequest)
  const response = await request(endpoint, {
    method: 'POST', body, signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }, '优酷许可服务')
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new SourceError('upstream_changed', `优酷许可服务返回的不是 JSON（HTTP ${response.status}）`)
  }
  return decodeLicense(json)
}

// MARK: 播放列表

/** fMP4 初始化段 `tenc` 里的默认 KID（ISO/IEC 23001-7），十六进制。 */
export function defaultKeyID(init: Uint8Array): string | undefined {
  const bytes = Buffer.from(init.buffer, init.byteOffset, init.byteLength)
  const at = bytes.indexOf('tenc', 4, 'latin1')
  if (at < 0) return undefined
  // type(4) version(1) flags(3) reserved(1) pattern(1) isProtected(1) perSampleIVSize(1) KID(16)
  const start = at + 4 + 8
  if (start + 16 > bytes.length) return undefined
  return bytes.subarray(start, start + 16).toString('hex')
}

export function fairPlayKeyTag(kid: string): string {
  return `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://${kid}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`
}

/** 相对地址按 base 拼；绝对地址原样（`new URL` 会改写签名过的 query）。 */
function absolute(value: string, base: string): string {
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : new URL(trimmed, base).toString()
}

function uriAttribute(line: string): string | undefined {
  return /URI="([^"]*)"/.exec(line)?.[1]
}

/** master：视频变体交给 `mapVariant`（要补 key 标签），其余地址（音轨等）拼成绝对的直连。 */
export function rewriteMaster(text: string, base: string, mapVariant: (url: string) => string): string {
  let variantNext = false
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      variantNext = true
      return line
    }
    if (line.startsWith('#')) {
      const uri = uriAttribute(line)
      return uri && !uri.startsWith('data:') && !uri.startsWith('skd:') ? line.replace(`URI="${uri}"`, `URI="${absolute(uri, base)}"`) : line
    }
    if (!line.trim()) return line
    const url = absolute(line, base)
    if (variantNext) {
      variantNext = false
      return mapVariant(url)
    }
    return url
  }).join('\n')
}

/** 平台自己写了 FairPlay 的 key（现在的优酷列表有：`skd://<KID>`，在 Widevine 的 `data:` 那行后面）。 */
export function hasFairPlayKey(text: string): boolean {
  return text.split(/\r?\n/).some((l) => l.startsWith('#EXT-X-KEY') && /URI="skd:\/\//.test(l))
}

/** 媒体列表：地址拼成绝对的直连，在第一个 `EXT-X-MAP`（或第一片）前插 FairPlay 的 key 标签；已有 FairPlay 的就不动。 */
export function rewriteMedia(text: string, base: string, keyTag: string | undefined): string {
  let pending = hasFairPlayKey(text) ? undefined : keyTag
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (pending && (line.startsWith('#EXT-X-MAP') || line.startsWith('#EXTINF'))) {
      out.push(pending)
      pending = undefined
    }
    if (line.startsWith('#')) {
      const uri = uriAttribute(line)
      out.push(uri && line.startsWith('#EXT-X-MAP') ? line.replace(`URI="${uri}"`, `URI="${absolute(uri, base)}"`) : line)
    } else {
      out.push(line.trim() ? absolute(line, base) : line)
    }
  }
  return out.join('\n')
}

export function initSegmentURL(text: string, base: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('#EXT-X-MAP'))
  const uri = line ? uriAttribute(line) : undefined
  return uri ? absolute(uri, base) : undefined
}

async function fetchCDN(url: string): Promise<Response> {
  const response = await request(url, {}, '优酷 CDN')
  if (response.status === 403 || response.status === 410) throw new SourceError('unplayable', '优酷 CDN 拒绝了这个地址，请重新解析', { retryable: true })
  if (!response.ok) throw new SourceError('unavailable', `优酷 CDN 返回 ${response.status}`, { retryable: true })
  return response
}

/** 一条 cbcs 流经网关给出的 master：第一次被请求时才去取、改写。 */
export function fairPlayPlaylist(media: MediaGateway, masterURL: string, ttl: number): string {
  const generated = (produce: () => Promise<string>, name: string) => {
    let text: Promise<string> | undefined
    return media.generated(() => {
      text ??= produce().catch((error) => {
        text = undefined
        throw error
      })
      return text
    }, { name, ttl, contentType: 'application/vnd.apple.mpegurl' })
  }
  const mediaPlaylist = (url: string, name: string) => generated(async () => {
    const body = await (await fetchCDN(url)).text()
    if (hasFairPlayKey(body)) return rewriteMedia(body, url, undefined)
    const init = initSegmentURL(body, url)
    const kid = init ? defaultKeyID(new Uint8Array(await (await fetchCDN(init)).arrayBuffer())) : undefined
    if (!kid) throw new SourceError('upstream_changed', '优酷 FairPlay 流的初始化段里读不到 KID')
    return rewriteMedia(body, url, fairPlayKeyTag(kid))
  }, name)
  let variants = 0
  return generated(async () => {
    const body = await (await fetchCDN(masterURL)).text()
    if (!body.includes('#EXT-X-STREAM-INF')) {
      if (hasFairPlayKey(body)) return rewriteMedia(body, masterURL, undefined)
      // 只有一个媒体列表：当作视频列表直接改写。
      const init = initSegmentURL(body, masterURL)
      const kid = init ? defaultKeyID(new Uint8Array(await (await fetchCDN(init)).arrayBuffer())) : undefined
      if (!kid) throw new SourceError('upstream_changed', '优酷 FairPlay 流的初始化段里读不到 KID')
      return rewriteMedia(body, masterURL, fairPlayKeyTag(kid))
    }
    return rewriteMaster(body, masterURL, (url) => mediaPlaylist(url, `video-${variants++}.m3u8`))
  }, 'master.m3u8')
}
