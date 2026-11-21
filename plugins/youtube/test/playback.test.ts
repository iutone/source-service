import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { audioTracks, languageName, videoLadder, type YtDlpInfo } from '../src/playback.ts'
import { mediaItem, parseCount, parseRelativeDate, sections } from '../src/cards.ts'

const info = JSON.parse(readFileSync(new URL('./fixtures/ytdlp-dQw4w9WgXcQ.json', import.meta.url), 'utf8')) as YtDlpInfo

describe('format choice', () => {
  it('keeps one H.264 https track per height, best first', () => {
    const ladder = videoLadder(info.formats)
    expect(ladder.map((f) => f.height)).toEqual([1080, 720, 480, 360, 240, 144])
    expect(ladder.every((f) => f.vcodec?.startsWith('avc1') && f.protocol === 'https')).toBe(true)
    expect(ladder[0].format_id).toBe('137')
  })

  it('keeps the best AAC per language', () => {
    expect(audioTracks(info.formats).map((f) => f.format_id)).toEqual(['140'])
  })

  it('names languages in Chinese', () => {
    expect(languageName('en')).toBe('英语')
    expect(languageName(undefined)).toBe('默认')
  })
})

describe('cards', () => {
  it('reads counts and relative dates as YouTube words them', () => {
    expect(parseCount('9,176,254,724次观看')).toBe(9176254724)
    expect(parseCount('3260万位订阅者')).toBe(32_600_000)
    expect(parseCount('1.2M views')).toBe(1_200_000)
    expect(parseCount(undefined)).toBeUndefined()
    const now = Date.parse('2026-11-20T00:00:00Z')
    expect(parseRelativeDate('2天前', now)).toBe('2026-11-18T00:00:00.000Z')
    expect(parseRelativeDate('3 weeks ago', now)).toBe('2026-10-30T00:00:00.000Z')
  })

  it('opens videos and playlists, leaves out Shorts, channels and mixes', () => {
    const base = { title: 't', isLive: false, details: [] as string[] }
    expect(mediaItem({ ...base, kind: 'video', id: 'abc', details: ['8万次观看', '3小时前'], channelName: 'C', channelID: 'UC1' })).toMatchObject({
      target: { video: 'abc' }, subtitle: '3小时前', stats: { views: 80000 }, uploader: { id: 'UC1', name: 'C' },
    })
    expect(mediaItem({ ...base, kind: 'playlist', id: 'PL1' })).toMatchObject({ target: { show: 'PL1' }, badge: { text: '播放列表' } })
    expect(mediaItem({ ...base, kind: 'playlist', id: 'RDabc' })).toBeUndefined()
    expect(mediaItem({ ...base, kind: 'short', id: 's' })).toBeUndefined()
    expect(mediaItem({ ...base, kind: 'channel', id: 'UC1' })).toBeUndefined()
  })

  it('makes one grid of an untitled list, a grid with 更多 per titled shelf', () => {
    const card = (id: string) => ({ kind: 'video' as const, id, title: id, isLive: false, details: [] })
    expect(sections({ byline: [], shelves: [{ id: '0', cards: [card('a')] }] })).toEqual([{ id: 'grid', style: 'grid', items: [expect.objectContaining({ id: 'a' })] }])
    const titled = sections({ byline: [], shelves: [{ id: '0', title: '热门', cards: [card('a')], continuation: 'tok' }] })
    expect(titled[0]).toMatchObject({ id: 'shelf-a-热门', title: '热门', more: { title: '热门', route: 'tok' } })
  })
})
