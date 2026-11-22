// DRM：FairPlay 播放列表改写、Widevine 的 JSON 描述做成 HLS、ref、许可回答，以及 resolve 用假的爱奇艺回答按客户端的 DRM 拼出流。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyValueStore, MediaGateway, type Ctx } from '@iyt-source/kit'
import { CERTIFICATE, ckcFrom, drmRef, isLicenseHost, parseDrmRef, widevineLicenseFrom } from '../src/drm.ts'
import { createIQiyiSource } from '../src/index.ts'
import { capabilities, dashDrm, normalizeFairPlayMedia, parseDash, selectedRendition } from '../src/playback.ts'
import { keySystems, psshBox, widevineMaster, widevineMediaPlaylist, widevineTracks, WIDEVINE_KEYFORMAT } from '../src/widevine.ts'

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
    expect(drmRef('481997300', 600)).toBe('481997300.600')
    expect(parseDrmRef('481997300.600')).toEqual({ tvid: '481997300', bid: 600 })
    expect(() => parseDrmRef('../x')).toThrow()
    expect(CERTIFICATE.length).toBe(1295)
    expect(isLicenseHost('http://drml.video.iqiyi.com/drm/fairplay/json?ve=1')).toBe(true)
    expect(isLicenseHost('http://example.com/iqiyi.com')).toBe(false)
    expect([...ckcFrom('{"status":0,"ckc":"AQID"}')]).toEqual([1, 2, 3])
    expect(() => ckcFrom('{"msg":"fairplay generateLicense verifyversion fail","status":-42580}')).toThrow(/verifyversion fail/)
  })

  it('请求声明 Safari 的 FairPlay 位；回答里的 FairPlay 档带主播放列表和许可地址', () => {
    expect(BigInt(Object.fromEntries(capabilities('fairplay')).k_ft4) & (1n << 9n)).not.toBe(0n)
    const dash = parseDash({ code: 'A00000', data: { st: 101, program: { video: [
      { bid: 600, drmType: 9, _selected: true, url: MASTER, drm: { license_host: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=9' } },
      { bid: 500, drmType: 9 },
    ] } } })
    expect(selectedRendition(dash)).toMatchObject({ bid: 600, url: MASTER, licenseHost: 'http://drml.video.iqiyi.com/drm/fairplay/json?ve=9' })
  })
})

// MARK: Widevine

/** 一个盒子。 */
const box = (type: string, body: Uint8Array) => {
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(Buffer.from(type, 'latin1'), 4)
  out.set(body, 8)
  return out
}
const pssh = (systemHex: string) => box('pssh', new Uint8Array([0, 0, 0, 0, ...Buffer.from(systemHex, 'hex'), 0, 0, 0, 2, 9, 9]))
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
const INIT = concat(box('ftyp', new Uint8Array(8)), box('moov', concat(box('mvhd', new Uint8Array(4)), pssh('9a04f07998404286ab92e65be0885f95'), pssh('edef8ba979d64acea3c827dcd51d21ed'))))
const FILE = 'https://pcw-data.video.iqiyi.com/videos/v0/a.m4s?qd=1'
const AUDIO_FILE = 'https://pcw-data.video.iqiyi.com/videos/v0/b.m4s?qd=1'
const PAYLOAD = JSON.stringify({ version: 1, payload: { wm_a: {
  video_track1: { codec: 'avc1.640028', codec_init: Buffer.from(INIT).toString('base64'), encryption_scheme: 'cenc', duration_second: 6250, files: [
    { file_name: FILE, size: 100, seekable: { pos_start: 0, pos_end: 100, time_start: 0, time_end: 6 } },
    { file_name: FILE, size: 50, seekable: { pos_start: 100, pos_end: 150, time_start: 6, time_end: 15 } },
  ] },
  audio_track1: { codec: 'mp4a.40.2', codec_init: Buffer.from(INIT).toString('base64'), encryption_scheme: 'cenc', duration_second: 6250, files: [
    { file_name: AUDIO_FILE, size: 9000, duration_second: 6250.031, seekable: { pos: [0, 30, 70, 120], time: [0, 5.991, 14.977, 23.986] } },
  ] },
} } })

describe('Widevine', () => {
  it('init 里找 Widevine 的 pssh 盒', () => {
    const found = psshBox(INIT)!
    expect(Buffer.from(found.subarray(12, 28)).toString('hex')).toBe('edef8ba979d64acea3c827dcd51d21ed')
    expect(psshBox(INIT, 'ff'.repeat(16))).toBeUndefined()
  })

  it('JSON 描述 → 字节区间的 fMP4 HLS；音频截到视频的长度（试看）', () => {
    const tracks = widevineTracks(PAYLOAD)
    expect(tracks.video.segments).toEqual([{ url: FILE, offset: 0, length: 100, duration: 6 }, { url: FILE, offset: 100, length: 50, duration: 9 }])
    expect(tracks.audio!.segments.map((s) => [s.offset, s.length])).toEqual([[0, 30], [30, 40], [70, 50]])
    const playlist = widevineMediaPlaylist(tracks.video, '/iyt/v1/media/t/init.mp4')
    expect(playlist).toContain(`#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,${Buffer.from(psshBox(INIT)!).toString('base64')}",KEYFORMAT="${WIDEVINE_KEYFORMAT}",KEYFORMATVERSIONS="1"`)
    expect(playlist).toContain('#EXT-X-MAP:URI="/iyt/v1/media/t/init.mp4"\n#EXTINF:6.000,\n#EXT-X-BYTERANGE:100@0\n' + FILE)
    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true)
    expect(keySystems(playlist)).toEqual(['widevine'])
    const master = widevineMaster(tracks, { video: '/v.m3u8', audio: '/a.m3u8' }, '1280x536')
    expect(master).toContain('CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x536,AUDIO="audio"')
  })

  it('key 标签认格式；许可回答', () => {
    expect(keySystems(MEDIA)).toEqual(['fairplay'])
    expect(keySystems('#EXTM3U\n#EXTINF:1,\na.ts')).toEqual([])
    expect([...widevineLicenseFrom(200, new Uint8Array([8, 1]))]).toEqual([8, 1])
    expect(() => widevineLicenseFrom(204, new Uint8Array())).toThrow(/Widevine/)
    expect(() => widevineLicenseFrom(500, new Uint8Array())).toThrow(/HTTP 500/)
  })

  it('客户端的 DRM → 向 dash 声明哪种', () => {
    expect([dashDrm(['fairplay']), dashDrm(['widevine']), dashDrm(['widevine', 'fairplay']), dashDrm([])]).toEqual(['fairplay', 'widevine', 'fairplay', 'none'])
  })
})

// MARK: resolve（假的爱奇艺：按能力位给 FairPlay / Widevine / 别的加密）

const FP_MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x800\n1080/media.m3u8?sig=1\n`

function fakeIQiyi() {
  const bitSet = (value: string | null, bit: number) => ((BigInt(value ?? '0') >> BigInt(bit - 1)) & 1n) === 1n
  return vi.fn(async (input: string | URL) => {
    const url = String(input)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://cache.video.iqiyi.com/dash')) {
      const q = new URL(url).searchParams
      const bid = Number(q.get('bid'))
      const widevine = bitSet(q.get('k_ft1'), 42)
      const fairPlay = bitSet(q.get('k_ft4'), 10)
      const video = [600, 500, 300].map((b) => {
        const selected = b === Math.min(bid, 500)
        if (widevine) return { bid: b, drmType: 7, ff: 'm4s', _selected: selected, m3u8: selected ? PAYLOAD : undefined, scrsz: '1280x536', drm: selected ? { license_host: 'https://drml.video.iqiyi.com/drm/widevine?ve=0' } : undefined }
        if (fairPlay) return { bid: b, drmType: 9, ff: 'fmp4', _selected: selected, url: selected ? MASTER : undefined, drm: selected ? { license_host: `http://drml.video.iqiyi.com/drm/fairplay/json?ve=${b}`, videoM3u8Content: MEDIA } : undefined }
        return { bid: b, drmType: 5, ff: 'm4s', _selected: selected }
      })
      return json({ code: 'A00000', data: { st: 101, aid: 1, program: { video } } })
    }
    if (url === MASTER) return new Response(FP_MASTER)
    if (url.startsWith('https://drm.video.iqiyi.com/drm/x/dl/fp/481997300/1080/media.m3u8')) return new Response(MEDIA.replace(',KEYFORMATVERSIONS="1",KEYFORMAT="com.apple.streamingkeydelivery"', ''))
    if (url.includes('/video/video/baseinfo/')) return json({ code: 'A00000', data: { name: '疯狂动物城' } })
    if (url.startsWith('http://drml.video.iqiyi.com/drm/fairplay')) return json({ status: 0, ckc: Buffer.from('ckc').toString('base64') })
    if (url.startsWith('https://drml.video.iqiyi.com/drm/widevine')) return new Response(new Uint8Array([0x08, 0x02]))
    return new Response('{}', { status: 404 })
  })
}

describe('resolve 按客户端的 DRM（假的爱奇艺）', () => {
  afterEach(() => vi.unstubAllGlobals())

  const setup = () => {
    vi.stubGlobal('fetch', fakeIQiyi())
    const store = new KeyValueStore(mkdtempSync(join(tmpdir(), 'iqdrm-')))
    store.set('credential', { cookies: { P00001: 'auth', P00003: '1' } })
    const media = new MediaGateway()
    const ctx = { sourceId: 'iqiyi', store, media, log: console, signal: new AbortController().signal } as unknown as Ctx
    const read = async (url: string) => {
      const [, , , , token, ...rest] = url.split('/')
      let body: unknown = ''
      const reply: any = { header: () => reply, code: () => reply, send: (b: unknown) => ((body = b), reply), raw: { on() {} } }
      await media.handle(token, rest.join('/'), { method: 'GET', headers: {} } as any, reply)
      return typeof body === 'string' ? body : ''
    }
    return { plugin: createIQiyiSource(), media, ctx, read }
  }

  it('缺省（旧 App）= FairPlay：drm 一项、fairPlay 旧字段，变体经网关、补齐 key 标签；许可转发', async () => {
    const { plugin, media, ctx, read } = setup()
    const result = await plugin.playback.resolve({ video: 'v481997300', preferences: {} }, ctx)
    const fp = result.streams.find((s) => s.id === '500')!
    const base = '/iyt/v1/sources/iqiyi/drm/fairplay/481997300.500'
    expect(fp).toMatchObject({ keepable: false, drm: [{ system: 'fairplay', certificate: `${base}/cert`, license: `${base}/license` }], fairPlay: { certificate: `${base}/cert`, license: `${base}/license` } })
    expect(result.selectedStream).toBe('500')
    expect(result.streams.find((s) => s.id === '600')?.unavailableReason).toBe('VIP')
    // 300 档还没取：按 drmType 当 FairPlay。
    expect(result.streams.find((s) => s.id === '300')?.drm?.map((d) => d.system)).toEqual(['fairplay'])
    const variant = (await read(fp.url)).split('\n').find((l) => l.startsWith('/iyt/v1/media/'))!
    const mediaText = await read(variant)
    expect(mediaText).toContain('KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"')
    expect(mediaText).toContain('https://drm.video.iqiyi.com/drm/x/dl/fp/481997300/1080/seg-1.m4s?k=1')
    expect([...(await plugin.playback.drm!.license('fairplay', '481997300.500', new Uint8Array([1]), ctx))]).toEqual([...Buffer.from('ckc')])
    expect((await plugin.playback.drm!.certificate!('fairplay', '481997300.500', ctx)).length).toBe(1295)
    media.close()
  })

  // Widevine 暂未启用（IQIYI_DRM_SYSTEMS 只有 fairplay，SERVER.md §21 待办），代码保留，启用时把 skip 去掉。
  it.skip('只支持 Widevine：按 Chrome 声明，流带 widevine、没有 fairPlay；播放列表有 Widevine 的 key 标签；许可原样转发', async () => {
    const { plugin, media, ctx, read } = setup()
    const result = await plugin.playback.resolve({ video: 'v481997300', preferences: { drm: ['widevine'] } }, ctx)
    const wv = result.streams.find((s) => s.id === '500')!
    expect(wv).toMatchObject({ keepable: false, drm: [{ system: 'widevine', license: '/iyt/v1/sources/iqiyi/drm/widevine/481997300.500/license' }] })
    expect(wv.fairPlay).toBeUndefined()
    const master = await read(wv.url)
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO')
    const video = master.split('\n').find((l) => l.startsWith('/iyt/v1/media/'))!
    const videoText = await read(video)
    expect(keySystems(videoText)).toEqual(['widevine'])
    expect(videoText).toContain('#EXT-X-BYTERANGE:100@0')
    expect([...(await plugin.playback.drm!.license('widevine', '481997300.500', new Uint8Array([1]), ctx))]).toEqual([8, 2])
    media.close()
  })

  it('什么 DRM 都不能用：加密档不可用，整部都是加密的就 unplayable', async () => {
    const { plugin, media, ctx } = setup()
    await expect(plugin.playback.resolve({ video: 'v481997300', preferences: { drm: [] } }, ctx)).rejects.toMatchObject({ code: 'unplayable' })
    media.close()
  })
})
