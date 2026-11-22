// DRM 许可转发（SERVER.md §6.4；照 App 的 IQiyiFairPlayLicense 和网页播放器 `pcweb.wonder.*.js`）：
// - FairPlay（Safari）：证书内嵌在网页播放器里；SPC 原始字节 POST 到这部片的 `drm.license_host`
//   （`drml.video.iqiyi.com/drm/fairplay/json?ve=…`），回 `{"status": 0, "ckc": "<base64>"}`。content id 是 `skd://` 的主机部分。
// - Widevine（Chrome）：challenge 原始字节 POST 到 `drm.license_host`（`drml.video.iqiyi.com/drm/widevine?ve=0`），回原始
//   license 字节；拒绝时回 204 空体（实测伪造的 challenge 如此）。网页播放器发这个请求不带 cookie，这里同样不带。
import type { DrmSystem } from '@iyt-source/protocol'
import { SourceError } from '@iyt-source/kit'
import type { IQiyiPlayback } from './playback.ts'
import { dashDrm, IQIYI_DRM_SYSTEMS, selectedRendition, unavailable } from './playback.ts'
import type { IQiyiSession } from './session.ts'
import { int, parseJSON, str, text, USER_AGENT } from './util.ts'

/** "FairPlay Streaming: Beijing Qiyi Century Science & Technology Co.,LTD."（DER，base64）。 */
const CERTIFICATE_BASE64 = `
MIIFCzCCA/OgAwIBAgIIJeaH6vCbPCkwDQYJKoZIhvcNAQEFBQAwfzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkFwcGxlIEluYy4x
JjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MTMwMQYDVQQDDCpBcHBsZSBLZXkgU2VydmljZXMgQ2VydGlm
aWNhdGlvbiBBdXRob3JpdHkwHhcNMTkwMTA2MTAwNzQ0WhcNMjEwMTA2MTAwNzQ0WjCBsDELMAkGA1UEBhMCVVMxOzA5BgNVBAoM
MkJlaWppbmcgUWl5aSBDZW50dXJ5IFNjaWVuY2UgJiBUZWNobm9sb2d5IENvLixMVEQuMRMwEQYDVQQLDAoyN0EyODJGNTROMU8w
TQYDVQQDDEZGYWlyUGxheSBTdHJlYW1pbmc6IEJlaWppbmcgUWl5aSBDZW50dXJ5IFNjaWVuY2UgJiBUZWNobm9sb2d5IENvLixM
VEQuMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5oS6rhjuv0DZla/HxEK+MeocdGkCsptb8yMI5ZJ9FZhcjqtmyS5ov5BEL
/rSBdqPAGA3+2HaHKmaQEukyVJxNBI+Ct7J7JbI4O67/j6HzLA1UMVy/TC8PTN52Bj4lcdnshqL+yIHLcjv1I+opmzXEqPD0+p23
3gkccXeJqZQw6QIDAQABo4IB2zCCAdcwDAYDVR0TAQH/BAIwADAfBgNVHSMEGDAWgBRj5EdUy4VxWUYsg6zMRDFkZwMsvjCB4gYD
VR0gBIHaMIHXMIHUBgkqhkiG92NkBQEwgcYwgcMGCCsGAQUFBwICMIG2DIGzUmVsaWFuY2Ugb24gdGhpcyBjZXJ0aWZpY2F0ZSBi
eSBhbnkgcGFydHkgYXNzdW1lcyBhY2NlcHRhbmNlIG9mIHRoZSB0aGVuIGFwcGxpY2FibGUgc3RhbmRhcmQgdGVybXMgYW5kIGNv
bmRpdGlvbnMgb2YgdXNlLCBjZXJ0aWZpY2F0ZSBwb2xpY3kgYW5kIGNlcnRpZmljYXRpb24gcHJhY3RpY2Ugc3RhdGVtZW50cy4w
NQYDVR0fBC4wLDAqoCigJoYkaHR0cDovL2NybC5hcHBsZS5jb20va2V5c2VydmljZXMuY3JsMB0GA1UdDgQWBBTsaWTs4Nx20b0J
yOUU6TFXLkGVrjAOBgNVHQ8BAf8EBAMCBSAwLgYLKoZIhvdjZAYNAQMBAf8EHAF0dGY2YmpndHhvemFxY2p0emI2OGw0b2xvam4w
KwYLKoZIhvdjZAYNAQQBAf8EGQE2cW5qZ2Z1Z2J4cTZnd2NhbmRuYnRmZnUwDQYJKoZIhvcNAQEFBQADggEBAJYwjOhIavYIr1oL
D2WibplO30tWKzQQNwvq9m9bv6MtKzxmHc+QqR5mRAyyvzdfN/Kz+HymSIXujOvLMZzbmcLbTlUK28+mR2lWZp2uQTSQhJDRnfYj
9mOOT2E5V/0AlBfu/EVKKWPql1BAfteFIs0Pzt5QTYX+QJEVI12SYYycIcjYGJErgWkrwrM1BinlysZckjUhytbPrtRclaeoth9A
cbtpWoD/b8qDLwcjqw8w+NUbw0hekha/xcb6CbL4jj3y/5/wPrTc5K2uyHi2JD8+3WvHTnsVj3vVLLbiXSkcIdK64H15Ygq1qxct
Z1wEKCnb06sW3JBuaPt2dC22auA=`

export const CERTIFICATE = new Uint8Array(Buffer.from(CERTIFICATE_BASE64.replace(/\s+/g, ''), 'base64'))

/** 许可转发的 ref：`<tvid>.<bid>`（两种 DRM 共用；许可地址按 DRM 和它记，丢了就再问 `dash`）。 */
export function drmRef(tvid: string, bid: number): string {
  return `${tvid}.${bid}`
}

export function parseDrmRef(ref: string): { tvid: string; bid: number } {
  const match = /^(\d+)\.(\d+)$/.exec(ref)
  if (!match) throw new SourceError('bad_request', 'DRM ref 不对')
  return { tvid: match[1], bid: Number(match[2]) }
}

/** 许可地址只认爱奇艺自己的主机（ref 之外的地址不转发）。 */
export function isLicenseHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'iqiyi.com' || host.endsWith('.iqiyi.com')
  } catch {
    return false
  }
}

/** FairPlay 许可服务的 JSON 回答 → CKC；拒绝时 `restricted`（客户端显示 message）。 */
export function ckcFrom(body: string): Uint8Array {
  let json: any
  try {
    json = parseJSON(body)
  } catch (error) {
    throw new SourceError('upstream_changed', '爱奇艺的许可回答读不懂', { cause: error })
  }
  const ckc = text(json?.ckc)
  if (int(json?.status) === 0 && ckc) return new Uint8Array(Buffer.from(ckc, 'base64'))
  const message = text(json?.msg) ?? '未知错误'
  throw new SourceError('restricted', `爱奇艺拒绝了这部加密片的播放许可：${message}（${str(json?.status) ?? '?'}）`)
}

/** Widevine 许可服务的回答：200 且有内容是 license；204 / 空体是拒绝。 */
export function widevineLicenseFrom(status: number, body: Uint8Array): Uint8Array {
  if (status === 200 && body.length > 0) {
    // 万一回的是 JSON 错误。
    if (body[0] === 0x7b) {
      try {
        const json = parseJSON(Buffer.from(body).toString('utf8'))
        throw new SourceError('restricted', `爱奇艺拒绝了这部加密片的播放许可：${text(json?.msg) ?? '未知错误'}（${str(json?.status ?? json?.code) ?? '?'}）`)
      } catch (error) {
        if (error instanceof SourceError) throw error
      }
    }
    return body
  }
  if (status === 204 || (status >= 200 && status < 300)) throw new SourceError('restricted', '爱奇艺拒绝了这部加密片的 Widevine 播放许可（会员、试看或设备安全级别不够）')
  throw new SourceError('unavailable', `爱奇艺许可服务返回 HTTP ${status}`, { retryable: true })
}

export class IQiyiDrm {
  /** 对外声明的 DRM（Widevine 暂未启用，见 playback.ts 的 IQIYI_DRM_SYSTEMS）。 */
  static get systems(): DrmSystem[] {
    return IQIYI_DRM_SYSTEMS
  }
  private readonly session: IQiyiSession
  private readonly playback: IQiyiPlayback

  constructor(session: IQiyiSession, playback: IQiyiPlayback) {
    this.session = session
    this.playback = playback
  }

  async certificate(system: DrmSystem, ref: string): Promise<Uint8Array> {
    parseDrmRef(ref)
    if (system !== 'fairplay') throw new SourceError('not_found', 'Widevine 没有证书接口')
    return CERTIFICATE
  }

  async license(system: DrmSystem, ref: string, request: Uint8Array, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const { tvid, bid } = parseDrmRef(ref)
    const key = `${system}:${ref}`
    let host = this.playback.licenseHosts.get(key)
    if (!host) {
      // 服务重启过或客户端拿旧地址来：按这种 DRM 再问一次这档的 `dash`。
      const answer = await this.playback.dash(tvid, bid, dashDrm([system]), signal)
      if (answer.status !== 101) throw unavailable(answer, this.session.isVIP)
      const want = system === 'fairplay' ? 9 : 7
      const rendition = answer.renditions.find((r) => r.bid === bid && r.drmType === want && r.licenseHost)
        ?? [selectedRendition(answer)].find((r) => r?.drmType === want && r.licenseHost)
      host = rendition?.licenseHost
      if (!host) throw new SourceError('unplayable', '这个清晰度拿不到播放许可地址，请重新打开')
      this.playback.licenseHosts.set(key, host)
    }
    if (!isLicenseHost(host)) throw new SourceError('upstream_changed', '许可地址不是爱奇艺的')
    if (system === 'fairplay') {
      // 和 Safari 的网页播放器一样：原始 SPC 作 body，带网页的头和登录 cookie。
      const response = await this.session.fetch(host, signal, { method: 'POST', body: new Uint8Array(request) })
      if (!response.ok) throw new SourceError('unavailable', `爱奇艺许可服务返回 HTTP ${response.status}`, { retryable: true })
      return ckcFrom(await response.text())
    }
    // Chrome 的网页播放器：XHR 直接 POST challenge，不带 cookie。
    let response: Response
    try {
      response = await fetch(host, {
        method: 'POST', body: new Uint8Array(request),
        headers: { 'user-agent': USER_AGENT, referer: 'https://www.iqiyi.com/', origin: 'https://www.iqiyi.com' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new SourceError('unavailable', '连不上爱奇艺的许可服务', { cause: error, retryable: true })
    }
    return widevineLicenseFrom(response.status, new Uint8Array(await response.arrayBuffer()))
  }
}
