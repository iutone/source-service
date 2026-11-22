// 会员 4K 的转封装：HEVC TS → fMP4（KuPlayer 的模块），SPS 的传输特性，改正 `hvcC`，播放列表改写。
// `hdr10-hevc.m2ts` 是 ffmpeg 生成的 2 秒 HDR10（PQ）样片；SPS 向量取自腾讯视频 4K（322093）的第一片。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MediaGateway } from '@iyt-source/kit'
import { transmuxRank } from '../src/playback.ts'
import { findHEVCSPS, hevcCodecString, hevcTransfer, patchHvcC, TransmuxPipeline, TSEngine, videoElementaryBytes, videoRange } from '../src/transmux.ts'

const TENCENT_4K_SPS = '01022000000090000000000096a001e020021c4d9662846490846ac05a80808082000000020000003210'

describe('HEVC SPS', () => {
  it('reads the transfer characteristics of Tencent’s 4K (BT.709)', () => {
    expect(hevcTransfer(Buffer.from(TENCENT_4K_SPS, 'hex'))).toBe(1)
    expect(videoRange(1)).toBe('SDR')
  })

  it('reads PQ from an HDR10 stream', () => {
    const sps = findHEVCSPS(videoElementaryBytes(readFileSync(new URL('./fixtures/hdr10-hevc.m2ts', import.meta.url))))!
    expect(hevcTransfer(sps)).toBe(16)
    expect(videoRange(16)).toBe('PQ')
    expect(videoRange(18)).toBe('HLG')
  })
})

describe('TS → fMP4', () => {
  it('remuxes HEVC 10-bit with AAC, the hvcC fixed from the SPS', () => {
    const ts = readFileSync(new URL('./fixtures/hdr10-hevc.m2ts', import.meta.url))
    const output = new TSEngine().remux(ts, 0)
    expect(output.width).toBe(320)
    expect(output.height).toBeGreaterThanOrEqual(180) // 模块报的是编码高度（184），master 的分辨率取答复的 vw / vh
    expect(output.codecs).toContain('mp4a.40.2')
    expect(output.initialization.includes('hvc1')).toBe(true)
    expect(output.media.subarray(4, 8).toString()).toMatch(/moof|styp/)
    patchHvcC(output.initialization, findHEVCSPS(videoElementaryBytes(ts))!)
    // Main 10：兼容标志第 2 位，约束字节 progressive / frame-only。
    expect(hevcCodecString(output.initialization)).toMatch(/^hvc1\.2\.4\.L\d+\.90$/)
  })

  it('rewrites the playlist with a map before every segment', () => {
    const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:15\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:8.520,\n00_a.ts?index=0\n#EXTINF:14.480,\n01_a.ts?index=1\n#EXT-X-ENDLIST\n'
    const media = new MediaGateway()
    try {
      const rewritten = new TransmuxPipeline().rewrite(playlist, 'https://cdn.example.com/x/a.m3u8', media, 60)
      const lines = rewritten.text.trim().split('\n')
      expect(lines[1]).toBe('#EXT-X-VERSION:7')
      const maps = lines.flatMap((l, i) => (l.startsWith('#EXT-X-MAP:') ? [i] : []))
      expect(maps).toHaveLength(2)
      for (const at of maps) {
        expect(lines[at + 1]).toMatch(/^#EXTINF:/)
        expect(lines[at + 2]).toMatch(/^\/iyt\/v1\/media\/.+\.m4s$/)
      }
      expect(rewritten.segments).toBe(2)
      expect(rewritten.duration).toBeCloseTo(23)
      expect(() => new TransmuxPipeline().rewrite('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', 'https://x/', media, 60)).toThrow()
    } finally {
      media.close()
    }
  })

  it('offers uhd / suhd HEVC tiers only', () => {
    expect(transmuxRank({ name: 'uhd', video: 23, drm: 0 })).toBe(2160)
    expect(transmuxRank({ name: 'suhd', video: 8, drm: 0 })).toBe(2160)
    expect(transmuxRank({ name: 'uhd', video: 23, drm: 4 })).toBeUndefined()
    expect(transmuxRank({ name: 'fhd', video: 23 })).toBeUndefined()
    expect(transmuxRank({ name: 'uhd', video: 21 })).toBeUndefined()
  })
})
