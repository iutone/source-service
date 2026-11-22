// FairPlay（drm 4：TS + SAMPLE-AES，skd://）：许可地址的读法、ref、表单、CKC、播放列表的密钥标签，以及解析出的流。
// `vinfo-fairplay-member` 是 SVIP 账号请求《阿凡达》原声版（y0040wzq199）的答复（App 的样例，凭证已换掉）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MediaGateway, type Ctx } from '@iyt-source/kit'
import { ckcOf, drmOf, ensureKeyTag, licenseBody, playlistSystems, TencentPlayback } from '../src/playback.ts'

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

const FAIRPLAY_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f41005jf8z9",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:10,\n00_a.ts?index=0\n#EXT-X-ENDLIST\n'
const WIDEVINE_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI="00_a.1.mp4?index=0"\n#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAANnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAABYaB3RlbmNlbnQiC2Y0MTAwNWpmOHo5",KEYID=0xD6CF4BB581D8D2C998455DA2405E87D1,KEYFORMATVERSIONS="1",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:11.929,\n01_a.1.mp4?index=1\n#EXT-X-ENDLIST\n'

/** 照 2026-11-22 SVIP 账号用 Chrome 能力位（drm 32）要《阿凡达》的答复写的（地址、密钥换掉了）。 */
function widevineAnswer() {
  return {
    em: 0,
    fl: { fi: [
      { id: 321212, name: 'hd', cname: '标清;(480P)', video: 1, drm: 5, sl: 0, lmt: 0 },
      { id: 320277, name: 'shd', cname: '准高清;(720P)', video: 1, drm: 5, sl: 0, lmt: 0 },
      { id: 320281, name: 'fhd', cname: '高清SDR;(1080P)', video: 1, drm: 5, sl: 1, lmt: 1 },
    ] },
    vl: { vi: [{ vid: 'y0040wzq199', st: 2, drm: 1, td: '9000', ti: '阿凡达', lnk: 'f41005jf8z9',
      ckc: 'https://fairplay.l.qq.com/vod/widevine/v1/getlicense?key=x&vid=y0040wzq199&fmt=320281&afmt=326002&link_vid=f41005jf8z9&version=1|',
      ul: { ui: [{ url: 'https://0243cdfd2f1f26ffcdbac47ad5b2104f.v.smtcdns.com/a/gzc_1000102_x.f320281.mp4.m3u8?ver=5' }] } }] },
    play: { master: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4710135,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="default-audio-group"\nhttps://omexts.tc.qq.com/a/gzc_1000102_x.f320281.mp4.m3u8?ver=5\n#EXT-X-MEDIA:TYPE=AUDIO,URI="https://omexts.tc.qq.com/b/gzc_1000102_x.f326002.mp4.m3u8?ver=5",GROUP-ID="default-audio-group",NAME="stream_0",AUTOSELECT=YES,CHANNELS="2"\n#EXT-X-ENDLIST\n' },
  }
}

describe('Widevine and key tags', () => {
  it('tells the DRM by the playlist’s key format', () => {
    expect(playlistSystems(FAIRPLAY_PLAYLIST)).toEqual(['fairplay'])
    expect(playlistSystems(WIDEVINE_PLAYLIST)).toEqual(['widevine'])
    expect(playlistSystems('#EXTM3U\n#EXTINF:1,\na.ts\n')).toEqual([])
  })

  it('reads a Widevine license address (no certificate)', () => {
    const drm = drmOf(widevineAnswer())!
    expect(drm).toMatchObject({ system: 'widevine', assetID: 'f41005jf8z9', certificateURL: undefined })
    expect(drm.licenseURL).toMatch(/\/vod\/widevine\/v1\/getlicense\?/)
    expect(drmOf(fixture('vinfo-fairplay-member'))?.system).toBe('fairplay')
  })

  it('refuses a sealed license', () => {
    expect(() => ckcOf({ code: 0, msg: '', ckc: '', anc: 'eyJyYyI6IngifQ==' })).toThrow(expect.objectContaining({ code: 'upstream_changed' }))
    expect(() => ckcOf({ code: -1005, msg: '', ckc: '', anc: '' })).toThrow(expect.objectContaining({ code: 'restricted' }))
  })
})

function harness(info: any, playlist: string) {
  const session = {
    loggedIn: true, isVIP: true, membershipTier: 'SVIP', guid: '0123456789abcdef',
    ensureSession: async () => {}, ensureMembership: async () => {},
    qimei: { cached: '', h38: async () => '' },
  }
  const playback = new TencentPlayback(session as any, {} as any, { record: async () => undefined } as any)
  const asked: number[] = []
  ;(playback as any).vinfo = async (_vid: string, _cid: string, _defn: string, _signal: unknown, bits: number) => {
    asked.push(bits)
    return { info, path: 'vinfo_proxy' }
  }
  ;(playback as any).fetchPlaylist = async (urls: string[]) => ({ body: urls[0]!.includes('f326002') ? playlist.replace('00_a', '00_audio') : playlist, base: urls[0]! })
  const media = new MediaGateway()
  const ctx = { sourceId: 'tencent', media, signal: new AbortController().signal } as unknown as Ctx
  return { playback, media, ctx, asked }
}

describe('FairPlay streams', () => {
  /** 只有 FairPlay 档的会员答复：每档都带 drm / fairPlay、不能缓存，按清晰度排、选答复选中的那档。 */
  it('offers every tier with FairPlay endpoints (and by default)', async () => {
    const { playback, media, ctx, asked } = harness(fixture('vinfo-fairplay-member'), FAIRPLAY_PLAYLIST)
    try {
      for (const preferences of [undefined, { drm: ['fairplay' as const] }]) {
        const result = await playback.resolve({ video: 'vy0040wzq199', show: null, preferences }, ctx)
        expect(result.streams.map((s) => s.quality.rank)).toEqual([1080, 720, 480])
        expect(result.selectedStream).toBe('320262')
        for (const stream of result.streams) {
          expect(stream.unavailableReason).toBeUndefined()
          expect(stream.keepable).toBe(false)
          expect(stream.drm?.map((d) => d.system)).toEqual(['fairplay'])
          expect(stream.fairPlay?.certificate).toMatch(/\/drm\/fairplay\/[^/]+\/cert$/)
          expect(stream.fairPlay?.license).toMatch(/\/drm\/fairplay\/[^/]+\/license$/)
        }
        const ref = decodeURIComponent(result.streams[0]!.fairPlay!.license.split('/').at(-2)!)
        expect(ref).toMatch(/^[0-9a-f]{12}~y0040wzq199~~fhd~16$/)
        expect((await (playback as any).drmFor('fairplay', ref)).assetID).toBe('f41005jf8z9')
        await expect((playback as any).drmFor('widevine', ref)).rejects.toMatchObject({ code: 'bad_request' })
        await expect((playback as any).drmFor('fairplay', 'bad')).rejects.toMatchObject({ code: 'bad_request' })
      }
      expect(asked.every((bits) => bits === 16)).toBe(true)
    } finally {
      media.close()
    }
  })

  it('marks encrypted tiers unavailable when the client has no DRM', async () => {
    const { playback, media, ctx } = harness(fixture('vinfo-fairplay-member'), FAIRPLAY_PLAYLIST)
    try {
      await expect(playback.resolve({ video: 'vy0040wzq199', show: null, preferences: { drm: [] } }, ctx))
        .rejects.toMatchObject({ code: 'unplayable', message: '这台设备不能播放加密内容' })
    } finally {
      media.close()
    }
  })

  // Widevine 暂未启用（TENCENT_DRM_SYSTEMS 只有 fairplay，SERVER.md §21 待办），代码保留，启用时把 skip 去掉。
  it.skip('asks as Chrome for a Widevine client and builds the CMAF master', async () => {
    const { playback, media, ctx, asked } = harness(widevineAnswer(), WIDEVINE_PLAYLIST)
    try {
      const result = await playback.resolve({ video: 'vy0040wzq199', show: null, preferences: { drm: ['widevine'] } }, ctx)
      expect(asked[0]).toBe(32)
      expect(result.selectedStream).toBe('320281')
      const selected = result.streams.find((s) => s.id === '320281')!
      expect(selected.drm).toEqual([{ system: 'widevine', license: expect.stringMatching(/\/drm\/widevine\/[^/]+\/license$/) }])
      expect(selected.fairPlay).toBeUndefined()
      expect(selected.keepable).toBe(false)
      const master = await (media as any).entries.get(selected.url.split('/')[4]).produce()
      expect(master).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"[^\n]*URI="\/iyt\/v1\/media\//)
      expect(master).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=4710135,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="audio"/)
      const videoURL = master.trim().split('\n').at(-1)
      const video = (media as any).entries.get(videoURL.split('/')[4]).body as string
      expect(video).toContain('URI="data:text/plain;base64,AAAANnBzc2g')
      expect(video).toContain('#EXT-X-MAP:URI="https://0243cdfd2f1f26ffcdbac47ad5b2104f.v.smtcdns.com/a/00_a.1.mp4?index=0"')
      // 只会 FairPlay 的客户端拿到 Widevine 档时不能播。
      const fairPlayOnly = await playback.resolve({ video: 'vy0040wzq199', show: null, preferences: { drm: ['fairplay'] } }, ctx).catch((e) => e)
      expect(fairPlayOnly).toMatchObject({ code: 'unplayable', message: '这台设备不支持 Widevine 加密' })
    } finally {
      media.close()
    }
  })
})
