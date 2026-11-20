import { describe, expect, it } from 'vitest'
import { addSubtitleRenditions, masterFor, rewritePlaylist, webVTTPlaylist } from '../src/hls.ts'

describe('rewritePlaylist', () => {
  it('maps segment lines and URI attributes against the playlist address', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6,',
      'seg1.m4s',
      '#EXTINF:6,',
      'https://cdn.example.com/other/seg2.m4s?sig=1',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://abc"',
    ].join('\n')
    const seen: string[] = []
    const out = rewritePlaylist(playlist, 'https://cdn.example.com/v/index.m3u8', (url) => {
      seen.push(url)
      return `/p/${seen.length - 1}`
    })
    expect(seen).toEqual([
      'https://cdn.example.com/v/key.bin',
      'https://cdn.example.com/v/init.mp4',
      'https://cdn.example.com/v/seg1.m4s',
      'https://cdn.example.com/other/seg2.m4s?sig=1',
    ])
    expect(out).toContain('URI="/p/0"')
    expect(out).toContain('\n/p/2\n')
    expect(out).toContain('URI="skd://abc"')
  })
})

describe('subtitles', () => {
  it('adds a subtitle group to every variant', () => {
    const master = masterFor('/v.m3u8', 2_000_000, { resolution: '1920x1080' })
    const out = addSubtitleRenditions(master, [{ name: '中文', language: 'zh', uri: '/s.m3u8', isDefault: true }])
    expect(out).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="/s.m3u8"')
    expect(out).toContain('RESOLUTION=1920x1080,SUBTITLES="subs"')
    expect(out.indexOf('#EXT-X-MEDIA')).toBeLessThan(out.indexOf('#EXT-X-STREAM-INF'))
  })

  it('wraps a WebVTT file as one segment', () => {
    expect(webVTTPlaylist('/a.vtt', 61.2)).toContain('#EXT-X-TARGETDURATION:62')
  })
})
