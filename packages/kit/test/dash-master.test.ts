import { describe, expect, it } from 'vitest'
import { audioGroups, dashMaster, type DashAudioTrack, type DashVideoTrack } from '../src/index.ts'

const uri = (kind: 'video' | 'audio', index: number) => `${kind === 'video' ? 'v' : 'a'}/${index}.m3u8`
const aac: DashAudioTrack = { url: 'a', codecs: 'mp4a.40.2', bandwidth: 200_000, language: 'zh', name: '192 kbps', isDefault: true }
const eac3: DashAudioTrack = { url: 'e', codecs: 'ec-3', bandwidth: 700_000, language: 'zh', name: '杜比全景声' }
const flac: DashAudioTrack = { url: 'f', codecs: 'fLaC', bandwidth: 2_000_000, language: 'zh', name: '无损音质' }

describe('dashMaster', () => {
  it('只有一种音频编码时和以前一样：一组 audio，一个画面一个变体', () => {
    const master = dashMaster([{ url: 'v', codecs: 'avc1.640028', bandwidth: 3_000_000, width: 1920, height: 1080, frameRate: 25 }],
      [aac, { ...aac, url: 'a2', name: '64 kbps', isDefault: false, bandwidth: 100_000 }], uri)
    expect(master).toBe([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="192 kbps",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="a/0.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="64 kbps",LANGUAGE="zh",DEFAULT=NO,AUTOSELECT=YES,URI="a/1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3200000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=25.000,AUDIO="audio"',
      'v/0.m3u8', '',
    ].join('\n'))
  })

  it('音频按编码分组，每个画面按组各出一个变体', () => {
    expect(audioGroups([aac, eac3, flac]).map((g) => [g.id, g.members])).toEqual([['audio', [0]], ['audio-ec-3', [1]], ['audio-flac', [2]]])
    const master = dashMaster([{ url: 'v', codecs: 'avc1.640028', bandwidth: 3_000_000 }], [aac, eac3, flac], uri)
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-ec-3",NAME="杜比全景声",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="a/1.m3u8"')
    const variants = master.split('\n').filter((line) => line.startsWith('#EXT-X-STREAM-INF'))
    expect(variants).toEqual([
      '#EXT-X-STREAM-INF:BANDWIDTH=3200000,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3700000,CODECS="avc1.640028,ec-3",AUDIO="audio-ec-3"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,fLaC",AUDIO="audio-flac"',
    ])
    expect(master.split('\n').filter((line) => line === 'v/0.m3u8')).toHaveLength(3)
  })

  it('写 VIDEO-RANGE 和 SUPPLEMENTAL-CODECS', () => {
    const videos: DashVideoTrack[] = [
      { url: 'dv', codecs: 'hvc1.2.4.L153.b0', supplementalCodecs: 'dvh1.08.07/db4h', videoRange: 'HLG', bandwidth: 20_000_000, width: 3840, height: 2160, frameRate: 25 },
      { url: 'p5', codecs: 'dvh1.05.06', videoRange: 'PQ', bandwidth: 18_000_000 },
      { url: 'sdr', codecs: 'avc1.640033', bandwidth: 8_000_000 },
    ]
    const variants = dashMaster(videos, [aac], uri).split('\n').filter((line) => line.startsWith('#EXT-X-STREAM-INF'))
    expect(variants).toEqual([
      '#EXT-X-STREAM-INF:BANDWIDTH=20200000,CODECS="hvc1.2.4.L153.b0,mp4a.40.2",SUPPLEMENTAL-CODECS="dvh1.08.07/db4h",RESOLUTION=3840x2160,FRAME-RATE=25.000,VIDEO-RANGE=HLG,AUDIO="audio"',
      '#EXT-X-STREAM-INF:BANDWIDTH=18200000,CODECS="dvh1.05.06,mp4a.40.2",VIDEO-RANGE=PQ,AUDIO="audio"',
      '#EXT-X-STREAM-INF:BANDWIDTH=8200000,CODECS="avc1.640033,mp4a.40.2",AUDIO="audio"',
    ])
  })

  it('没有音频时变体不带 AUDIO', () => {
    expect(dashMaster([{ url: 'v', codecs: 'avc1', bandwidth: 1 }], [], uri)).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1"\nv/0.m3u8')
  })
})
