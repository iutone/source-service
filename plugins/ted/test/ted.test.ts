import { describe, expect, it } from 'vitest'
import { picture } from '../src/api.ts'
import { linkTarget, playlistItem, videoItem } from '../src/index.ts'
import { parseWebVTT } from '@iyt-source/kit'

describe('TED links', () => {
  it('reads talks and playlists', () => {
    expect(linkTarget('https://www.ted.com/talks/brene_brown_the_power_of_vulnerability')).toEqual({ target: { video: 'brene_brown_the_power_of_vulnerability' } })
    expect(linkTarget('https://www.ted.com/talks/brene_brown_the_power_of_vulnerability/transcript?language=zh-cn')).toEqual({ target: { video: 'brene_brown_the_power_of_vulnerability' } })
    expect(linkTarget('https://ted.com/playlists/927/ted_talks_on_critical_thinking_and_philosophy')).toEqual({ target: { show: 'ted_talks_on_critical_thinking_and_philosophy' } })
    expect(linkTarget('https://www.ted.com/speakers/brene_brown')).toBeNull()
    expect(linkTarget('https://example.com/talks/x')).toBeNull()
  })
})

describe('TED cards', () => {
  it('prefers a landscape picture, resized', () => {
    const images = [{ url: 'https://pi.tedcdn.com/r/a/4x3.jpg', aspectRatioName: '4x3' }, { url: 'https://pi.tedcdn.com/r/a/16x9.jpg', aspectRatioName: '16x9' }]
    expect(picture(images)).toBe('https://pi.tedcdn.com/r/a/16x9.jpg?w=640')
    expect(picture(undefined)).toBeUndefined()
  })

  it('maps talks and playlists', () => {
    const item = videoItem({ id: '1042', slug: 'brene', title: '脆弱的力量', presenterDisplayName: 'Brené Brown', duration: 1202, viewedCount: 5, videoContext: 'TEDxHouston' })
    expect(item).toMatchObject({ id: 'brene', title: '脆弱的力量', subtitle: 'Brené Brown', duration: 1202, caption: 'TEDxHouston', target: { video: 'brene' } })
    expect(playlistItem({ id: '1', slug: 'pl', title: 'List', videos: { totalCount: 11 } })).toMatchObject({ target: { show: 'pl' }, caption: '11 场演讲' })
  })
})

describe('WebVTT', () => {
  it('reads cues', () => {
    const cues = parseWebVTT('WEBVTT\n\n00:00:03.504 --> 00:00:05.504\n那我就这么开始吧：\n\n1\n00:01:05.000 --> 00:01:07.250 align:start\n<i>两行</i>\n字幕\n')
    expect(cues).toEqual([
      { start: 3.504, end: 5.504, text: '那我就这么开始吧：' },
      { start: 65, end: 67.25, text: '两行\n字幕' },
    ])
  })
})
