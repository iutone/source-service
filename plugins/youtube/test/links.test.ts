import { describe, expect, it } from 'vitest'
import { linkTarget } from '../src/index.ts'

describe('linkTarget', () => {
  it('reads videos from every kind of link', () => {
    expect(linkTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toEqual({ target: { video: 'dQw4w9WgXcQ' } })
    expect(linkTarget('https://youtu.be/dQw4w9WgXcQ?si=abc')).toEqual({ target: { video: 'dQw4w9WgXcQ' } })
    expect(linkTarget('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({ target: { video: 'dQw4w9WgXcQ' } })
    expect(linkTarget('https://www.youtube.com/live/dQw4w9WgXcQ')).toEqual({ target: { video: 'dQw4w9WgXcQ' } })
  })

  it('reads playlists, not mixes', () => {
    expect(linkTarget('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'))
      .toEqual({ target: { show: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' } })
    expect(linkTarget('https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ')).toBeNull()
  })

  it('leaves other pages', () => {
    expect(linkTarget('https://www.youtube.com/@channel')).toBeNull()
    expect(linkTarget('not a url')).toBeNull()
  })
})
