// FairPlay（drm 4：TS + SAMPLE-AES，skd://）：许可地址的读法、ref、表单、CKC、播放列表的密钥标签，以及解析出的流。
// `vinfo-fairplay-member` 是 SVIP 账号请求《阿凡达》原声版（y0040wzq199）的答复（App 的样例，凭证已换掉）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MediaGateway, type Ctx } from '@iyt-source/kit'
import { ckcOf, drmOf, ensureKeyTag, licenseBody, TencentPlayback } from '../src/playback.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

describe('FairPlay license', () => {
  it('reads the license, certificate and key id from `ckc`', () => {
    const drm = drmOf(fixture('vinfo-fairplay-member'))!
    expect(drm.assetID).toBe('f41005jf8z9')
    expect(new URL(drm.licenseURL).hostname).toBe('fairplay.l.qq.com')
    expect(drm.licenseURL).toMatch(/\/getckc\?/)
    expect(drm.certificateURL).toBe('https://fairplay.l.qq.com/static/fairplay.cer')
    expect(drmOf(fixture('vinfo-h264-720p'))).toBeUndefined()
    expect(drmOf({ vl: { vi: [{ ckc: 'https://a/getckc?x=1|https://a/c.cer', lnk: 'k1' }] } })?.assetID).toBe('k1')
  })

  it('posts the SPC as a form and takes the CKC from JSON', () => {
    expect(licenseBody(Uint8Array.from([0xfb, 0xff, 0x01]), 'f41005jf8z9')).toBe('spc=%2B%2F8B&assetId=f41005jf8z9')
    expect(Array.from(ckcOf({ code: 0, msg: 'success', ckc: 'AAEC' }))).toEqual([0, 1, 2])
    expect(() => ckcOf({ code: -1, msg: 'no right' })).toThrow(expect.objectContaining({ code: 'restricted' }))
  })

  it('keeps the skd key tag, adding one only when missing', () => {
    const keyed = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f41005jf8z9",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:10,\nhttps://cdn/a.ts\n'
    expect(ensureKeyTag(keyed, 'other')).toBe(keyed)
    const added = ensureKeyTag('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nhttps://cdn/a.ts\n', 'f41005jf8z9').split('\n')
    expect(added[2]).toBe('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f41005jf8z9",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"')
    expect(added[3]).toMatch(/^#EXTINF/)
  })
})

describe('FairPlay streams', () => {
  /** 一个只有 FairPlay 档的会员答复：每档都带 fairPlay、不能缓存，按清晰度排、选答复选中的那档。 */
  it('offers every tier with FairPlay endpoints', async () => {
    const session = {
      loggedIn: true, isVIP: true, membershipTier: 'SVIP', guid: '0123456789abcdef',
      ensureSession: async () => {}, ensureMembership: async () => {},
      qimei: { cached: '', h38: async () => '' },
    }
    const history = { record: async () => undefined }
    const playback = new TencentPlayback(session as any, {} as any, history as any)
    const info = fixture('vinfo-fairplay-member')
    ;(playback as any).vinfo = async () => ({ info, path: 'vinfo_proxy' })
    const media = new MediaGateway()
    const ctx = { sourceId: 'tencent', media, signal: new AbortController().signal } as unknown as Ctx
    try {
      const result = await playback.resolve({ video: 'vy0040wzq199', show: null }, ctx)
      expect(result.streams.map((s) => s.quality.rank)).toEqual([1080, 720, 480])
      expect(result.selectedStream).toBe('320262')
      for (const stream of result.streams) {
        expect(stream.unavailableReason).toBeUndefined()
        expect(stream.keepable).toBe(false)
        expect(stream.fairPlay?.certificate).toMatch(/^\/iyt\/v1\/sources\/tencent\/fairplay\/[^/]+\/cert$/)
        expect(stream.fairPlay?.license).toMatch(/\/license$/)
      }
      // 选中的那档：ref 登记着答复里的许可。
      const ref = decodeURIComponent(result.streams[0]!.fairPlay!.license.split('/').at(-2)!)
      expect(ref).toMatch(/^[0-9a-f]{12}~y0040wzq199~~fhd$/)
      expect((await (playback as any).fairPlayDRM(ref)).assetID).toBe('f41005jf8z9')
      await expect((playback as any).fairPlayDRM('bad')).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      media.close()
    }
  })
})
