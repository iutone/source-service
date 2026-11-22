import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyValueStore } from '@iyt-source/kit'
import { DrmRefs, decodeLicense, defaultKeyID, fairPlayKeyTag, hasFairPlayKey, initSegmentURL, keySystems, licenseBody, rewriteMaster, rewriteMedia, variantURLs, widevinePSSH } from '../src/drm.ts'
import { NO_DRM, mergeStreams, pickStreams, upsParameters } from '../src/playback.ts'

const LICENSE = 'https://drm-license.youku.com/ups/drm.json?drmType=cbcs&token=a%2Bb%3D&vid=XNj%3D%3D&psid=p&encVer=0'

describe('DRM ref', () => {
  it('is short enough for a route parameter and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iyt-youku-fp-'))
    try {
      const refs = new DrmRefs()
      refs.attach(new KeyValueStore(dir))
      const ref = refs.register(LICENSE)
      // Fastify 的 maxParamLength 默认 100。
      expect(encodeURIComponent(ref).length).toBeLessThanOrEqual(100)
      expect(refs.resolve(ref)).toBe(LICENSE)
      const again = new DrmRefs()
      again.attach(new KeyValueStore(dir))
      expect(again.resolve(ref)).toBe(LICENSE)
      expect(() => again.resolve('unknown')).toThrow(/重新解析/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never forwards anywhere but Youku over https', () => {
    const refs = new DrmRefs()
    expect(() => refs.resolve(refs.register('https://evil.example/x'))).toThrow()
    expect(() => refs.resolve(refs.register('http://drm-license.youku.com/x'))).toThrow()
  })
})

describe('FairPlay license', () => {
  it('posts the URL’s own query with drmType=fairplay and the encoded request', () => {
    const { endpoint, body } = licenseBody(LICENSE, 'CAQ=')
    expect(endpoint).toBe('https://drm-license.youku.com/ups/drm.json')
    expect(body).toBe('token=a%2Bb%3D&vid=XNj%3D%3D&psid=p&encVer=0&drmType=fairplay&licenseRequest=CAQ%3D')
  })

  it('decodes plain answers and turns refusals into restricted', () => {
    expect(decodeLicense({ data: Buffer.from('ckc').toString('base64'), enc: 0 }).toString()).toBe('ckc')
    expect(decodeLicense({ msg: 'fairplay certificate succ', enc: 0, data: Buffer.from('cert').toString('base64') }).toString()).toBe('cert')
    expect(() => decodeLicense({ msg: 'gen fairplay license error', states: 209 })).toThrow(/gen fairplay license error/)
    // 实测：拒绝时也带一串 data（追踪号），不能当 CKC 交出去。
    expect(() => decodeLicense({ data: 'af5f2bb431e464d572220aeab0a5fdd541346', enc: 0, msg: 'gen fairplay license error', states: 209 })).toThrow(/209/)
    try { decodeLicense({ msg: 'x', states: 209 }) } catch (error) { expect((error as { code: string }).code).toBe('restricted') }
    expect(() => decodeLicense({ data: 'AAAA', enc: 1 })).toThrow(/enc=1/)
  })
})

describe('FairPlay playlists', () => {
  const base = 'http://pl-ali.youku.com/playlist/m3u8?vid=XNj%3D%3D&type=cmfv4hd3&ups_key=a%2Bb'

  it('reads the default KID from tenc', () => {
    const kid = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const tenc = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('tenc'), Buffer.from([0, 0, 0, 0, 0, 0x19, 1, 0]), kid])
    const init = Buffer.concat([Buffer.from('....moov....'), tenc])
    expect(defaultKeyID(init)).toBe('00112233445566778899aabbccddeeff')
    expect(defaultKeyID(Buffer.from('no box here'))).toBeUndefined()
  })

  it('puts the key tag before the map and keeps signed URLs as they are', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI="init.mp4?k=a%2Bb"\n#EXTINF:6,\nhttp://cdn.example/s1.m4s?k=x%2By\n#EXTINF:6,\ns2.m4s\n#EXT-X-ENDLIST'
    const out = rewriteMedia(text, base, fairPlayKeyTag('ab'))
    expect(out).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://ab",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXT-X-MAP:URI="http://pl-ali.youku.com/playlist/init.mp4?k=a%2Bb"')
    expect(out).toContain('\nhttp://cdn.example/s1.m4s?k=x%2By\n')
    expect(out).toContain('\nhttp://pl-ali.youku.com/playlist/s2.m4s\n')
    expect(initSegmentURL(text, base)).toBe('http://pl-ali.youku.com/playlist/init.mp4?k=a%2Bb')
    // 平台自己写了 FairPlay 的 key 就不再加（现在的列表在 MAP 之后有 Widevine 的 data: 和 skd:// 两行）；只有 Widevine 的照样补。
    const keyed = '#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AA==",KEYID=0xAB\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://ab",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\ns.m4s'
    expect(hasFairPlayKey(keyed)).toBe(true)
    expect(rewriteMedia(keyed, base, fairPlayKeyTag('ab')).match(/skd:\/\//g)).toHaveLength(1)
    const widevineOnly = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AA=="\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6,\ns.m4s'
    expect(rewriteMedia(widevineOnly, base, fairPlayKeyTag('ab'))).toContain('URI="skd://ab"')
  })

  it('routes video variants through the gateway and leaves audio direct', () => {
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8?k=a%2Bb"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nhttp://pl-ali.youku.com/v.m3u8?k=x%2By'
    const seen: string[] = []
    const out = rewriteMaster(master, base, (url: string) => {
      seen.push(url)
      return '/iyt/v1/media/t/video-0.m3u8'
    })
    expect(seen).toEqual(['http://pl-ali.youku.com/v.m3u8?k=x%2By'])
    expect(out).toContain('URI="http://pl-ali.youku.com/playlist/audio.m3u8?k=a%2Bb"')
    expect(out.endsWith('/iyt/v1/media/t/video-0.m3u8')).toBe(true)
  })
})

describe('cbcs streams', () => {
  it('declares cbcs to UPS like KuPlayer (Safari with drmLevel, Chrome Widevine without)', () => {
    expect(JSON.parse(upsParameters({ vid: 'v', ckey: 'k', utid: 'u', cbcs: 'fairplay' }).biz_params)).toMatchObject({ drm_type: 19, drm_level: 1, key_index: 'web01' })
    const widevine = JSON.parse(upsParameters({ vid: 'v', ckey: 'k', utid: 'u', cbcs: 'widevine' }).biz_params)
    expect(widevine).toMatchObject({ drm_type: 19, key_index: 'web01' })
    expect(widevine.drm_level).toBeUndefined()
    expect(JSON.parse(upsParameters({ vid: 'v', ckey: 'k', utid: 'u', cbcs: 'fairplay', privateClient: 'c' }).biz_params)).toMatchObject({ drm_type: 19, encryptR_client: 'c' })
  })

  it('makes cbcs tiers playable and merges them with the clear ones by clarity', () => {
    const s = (type: string, height: number, drm: string, uri?: string) => ({ stream_type: type, height, drm_type: drm, m3u8_url: `http://cdn/${type}`, stream_ext: uri ? { uri } : undefined })
    const clear = pickStreams({ stream: [s('mp4hd2', 534, 'default'), s('mp4hd', 360, 'default')] }, { canProcess: true })
    const cbcs = pickStreams({ stream: [s('cmfv4hd3', 800, 'cbcs', LICENSE), s('cmfv4hd2', 534, 'cbcs', LICENSE), s('cmfv4sd', 266, 'cbcs')] }, { canProcess: true, cbcs: ['widevine'] })
    expect(cbcs.find((x) => x.id === 'cmfv4sd-default')?.path).toBe('unsupported')
    const merged = mergeStreams([clear, cbcs], true)
    expect(merged.map((x) => [x.id, x.path])).toEqual([
      ['cmfv4hd3-default', 'cbcs'], ['mp4hd2-default', 'direct'], ['mp4hd-default', 'direct'], ['cmfv4sd-default', 'unsupported'],
    ])
    expect(merged[0].licenseURL).toBe(LICENSE)
    // 没声明 cbcs 的回答里的 cbcs 仍然给不了；客户端什么 DRM 都不能用时标成这台设备放不了。
    expect(pickStreams({ stream: [s('cmfv4hd3', 800, 'cbcs', LICENSE)] }, { canProcess: true })[0].path).toBe('unsupported')
    const none = pickStreams({ stream: [s('cmfv4hd3', 800, 'cbcs', LICENSE)] }, { canProcess: true, cbcs: [] })[0]
    expect([none.path, none.reason]).toEqual(['unsupported', NO_DRM])
  })
})

describe('Widevine', () => {
  // 《谷雨》媒体列表里实际的那行（PSSH：Widevine 系统 id，KID f74b…）。
  const pssh = 'AAAASnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAACoSEPdLmLpckX2ukFCuxMhXSIISEPdLmLpckX2ukFCuxMhXSIJI88aJmwY='
  const youkuLine = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,${pssh}",KEYID=0xF74B98BA5C917DAE9050AEC4C8574882,IV=0x00`

  it('recognizes the Widevine PSSH by its system id', () => {
    expect(widevinePSSH(youkuLine)).toBe(pssh)
    expect(widevinePSSH('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f74b"')).toBeUndefined()
    expect(widevinePSSH('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="com.microsoft.playready"')).toBeUndefined()
  })

  it('lists the DRM a playlist actually carries', () => {
    expect(keySystems(`#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n${youkuLine}\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f74b"\n#EXTINF:6,\ns.m4s`)).toEqual(['fairplay', 'widevine'])
    expect(keySystems('#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6,\ns.m4s')).toEqual(['fairplay'])
  })

  it('writes the Widevine key in the standard form', () => {
    const out = rewriteMedia(`#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n${youkuLine}\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://f74b"\n#EXTINF:6,\ns.m4s`, 'https://cdn/p/x.m3u8', fairPlayKeyTag('f74b'))
    expect(out).toContain(`#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,${pssh}",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"`)
    expect(out.match(/skd:\/\//g)).toHaveLength(1)
  })

  it('posts like KuPlayer’s Chrome path: drmType=widevine and the device id', () => {
    const { body } = licenseBody(LICENSE, 'CAQ=', 'widevine', { utdid: 'a+b/c' })
    expect(body).toBe('token=a%2Bb%3D&vid=XNj%3D%3D&psid=p&encVer=0&utdid=a%2Bb%2Fc&drmType=widevine&licenseRequest=CAQ%3D')
  })

  it('finds the video variants of a master', () => {
    expect(variantURLs('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8?k=a%2Bb', 'http://h/p/m.m3u8')).toEqual(['http://h/p/v.m3u8?k=a%2Bb'])
  })
})
