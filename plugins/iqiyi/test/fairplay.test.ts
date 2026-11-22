// FairPlay：播放列表改写、ref、许可回答，以及 resolve 用假的爱奇艺回答拼出带 fairPlay 的流。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyValueStore, MediaGateway, type Ctx } from '@iyt-source/kit'
import { CERTIFICATE, ckcFrom, fairPlayRef, isLicenseHost, parseFairPlayRef } from '../src/fairplay.ts'
import { createIQiyiSource } from '../src/index.ts'
import { capabilities, normalizeFairPlayMedia, parseDash, selectedRendition } from '../src/playback.ts'

const MASTER = 'https://drm.video.iqiyi.com/drm/x/dl/fp/481997300/master.m3u8?sig=1'
const MEDIA = [
  '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:6',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc123def",KEYFORMATVERSIONS="1",KEYFORMAT="com.apple.streamingkeydelivery"',
  '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'seg-1.m4s?k=1', '#EXT-X-ENDLIST',
].join('\n')

describe('FairPlay 播放列表', () => {
  it('分片、MAP 改成绝对地址，skd 原样，key 标签补齐', () => {
    const out = normalizeFairPlayMedia(MEDIA.replace(',KEYFORMATVERSIONS="1",KEYFORMAT="com.apple.streamingkeydelivery"', ''), 'https://cdn.iqiyi.com/v/1080/media.m3u8')
    expect(out).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc123def",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"')
    expect(out).toContain('#EXT-X-MAP:URI="https://cdn.iqiyi.com/v/1080/init.mp4"')
    expect(out).toContain('\nhttps://cdn.iqiyi.com/v/1080/seg-1.m4s?k=1\n')
  })

  it('已经齐全的 key 标签不重复，带 IV 的保留', () => {
    const line = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k1",IV=0x01,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"'
    const out = normalizeFairPlayMedia(`#EXTM3U\n${line}\n#EXTINF:6,\na.m4s`, 'https://c.iqiyi.com/m.m3u8')
    expect(out.split('\n')[1]).toBe('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k1",IV=0x01,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"')
  })

  it('ref、证书、许可地址、许可回答', () => {
    expect(fairPlayRef('481997300', 600)).toBe('481997300.600')
    expect(parseFairPlayRef('481997300.600')).toEqual({ tvid: '481997300', bid: 600 })
    expect(() => parseFairPlayRef('../x')).toThrow()
    expect(CERTIFICATE.length).toBe(1295)
    expect(isLicenseHost('http://drml.video.iqiyi.com/drm/fairplay/json?ve=1')).toBe(true)
    expect(isLicenseHost('http://example.com/iqiyi.com')).toBe(false)
    expect([...ckcFrom('{"status":0,"ckc":"AQID"}')]).toEqual([1, 2, 3])
    expect(() => ckcFrom('{"msg":"fairplay generateLicense verifyversion fail","status":-42580}')).toThrow(/verifyversion fail/)
  })

  it('请求声明 Safari 的 FairPlay 位；回答里的 FairPlay 档带主播放列表和许可地址', () => {
    expect(BigInt(Object.fromEntries(capabilities(true)).k_ft4) & (1n << 9n)).not.toBe(0n)
    const dash = parseDash({ code: 'A00000', data: { st: 101, program: { video: [
      { bid: 600, drmType: 9, _selected: true, url: MASTER, drm: { license_host: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=9' } },
      { bid: 500, drmType: 9 },
    ] } } })
    expect(selectedRendition(dash)).toMatchObject({ bid: 600, url: MASTER, licenseHost: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=9' })
  })
})

describe('FairPlay resolve（假的爱奇艺）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('加密档给 fairPlay 地址、不可缓存，主播放列表的变体经网关、补齐 key 标签', async () => {
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x800\n1080/media.m3u8?sig=1\n`
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      if (url.startsWith('https://cache.video.iqiyi.com/dash')) {
        const bid = Number(new URL(url).searchParams.get('bid'))
        return json({ code: 'A00000', data: { st: 101, aid: 1, program: { video: [
          { bid: 600, drmType: 9, _selected: bid === 600, url: MASTER, drm: { license_host: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=9' } },
          { bid: 500, drmType: 9, _selected: bid === 500, url: bid === 500 ? MASTER : undefined, drm: { license_host: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=5' } },
        ] } } })
      }
      if (url === MASTER) return new Response(master)
      if (url.startsWith('https://drm.video.iqiyi.com/drm/x/dl/fp/481997300/1080/media.m3u8')) return new Response(MEDIA.replace(',KEYFORMATVERSIONS="1",KEYFORMAT="com.apple.streamingkeydelivery"', ''))
      if (url.includes('/video/video/baseinfo/')) return json({ code: 'A00000', data: { name: '疯狂动物城' } })
      if (url.startsWith('http://drml.video.iqiyi.com/')) return json({ status: 0, ckc: Buffer.from('ckc').toString('base64') })
      return new Response('{}', { status: 404 })
    }))
    const store = new KeyValueStore(mkdtempSync(join(tmpdir(), 'iqfp-')))
    store.set('credential', { cookies: { P00001: 'auth', P00003: '1' } })
    const media = new MediaGateway()
    const ctx = { sourceId: 'iqiyi', store, media, log: console, signal: new AbortController().signal } as unknown as Ctx
    const plugin = createIQiyiSource()
    // 账号信息读不到也不影响（按普通账号）。
    const result = await plugin.playback.resolve({ video: 'v481997300', preferences: {} }, ctx)
    const read = async (url: string) => {
      const [, , , , token, ...rest] = url.split('/')
      let body = ''
      const reply: any = { header: () => reply, code: () => reply, send: (b: string) => ((body = b), reply), raw: { on() {} } }
      await media.handle(token, rest.join('/'), { method: 'GET', headers: {} } as any, reply)
      return body
    }
    const fp = result.streams.find((s) => s.id === '500')!
    expect(fp).toMatchObject({ keepable: false, fairPlay: { certificate: '/iyt/v1/sources/iqiyi/fairplay/481997300.500/cert', license: '/iyt/v1/sources/iqiyi/fairplay/481997300.500/license' } })
    expect(result.streams.find((s) => s.id === '600')?.unavailableReason).toBe('VIP')
    const masterText = await read(fp.url)
    const variant = masterText.split('\n').find((l) => l.startsWith('/iyt/v1/media/'))!
    const mediaText = await read(variant)
    expect(mediaText).toContain('KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"')
    expect(mediaText).toContain('https://drm.video.iqiyi.com/drm/x/dl/fp/481997300/1080/seg-1.m4s?k=1')
    expect([...(await plugin.playback.fairPlay!.license('481997300.500', new Uint8Array([1]), ctx))]).toEqual([...Buffer.from('ckc')])
    media.close()
  })
})
