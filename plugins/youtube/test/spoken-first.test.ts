import { describe, expect, it } from 'vitest'
import { spokenFirst } from '../src/playback.ts'

const track = (language: string) => ({ protocol: { language } })
const order = (tracks: { protocol: { language: string } }[]) => tracks.map((t) => t.protocol.language)

describe('spokenFirst', () => {
  it('puts the language the video was made in first, else English, keeping each order', () => {
    const tracks = ['ar', 'de', 'en', 'en-GB', 'ja'].map(track)
    expect(order(spokenFirst(tracks, 'ja'))).toEqual(['ja', 'ar', 'de', 'en', 'en-GB'])
    expect(order(spokenFirst(tracks, undefined))).toEqual(['en', 'en-GB', 'ar', 'de', 'ja'])
    expect(order(spokenFirst(tracks, 'en-US'))).toEqual(['en', 'en-GB', 'ar', 'de', 'ja'])
  })
})
