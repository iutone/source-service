import { describe, expect, it } from 'vitest'
import { codecFamily, codecName, codecSupported } from '../src/codecs.ts'

describe('codecs', () => {
  it('normalizes ffprobe / yt-dlp / RFC 6381 spellings', () => {
    expect(codecFamily('hevc')).toBe('hvc1')
    expect(codecFamily('hev1.1.6.L93.B0')).toBe('hvc1')
    expect(codecFamily('avc1.64001e')).toBe('avc1')
    expect(codecFamily('h264')).toBe('avc1')
    expect(codecFamily('eac3')).toBe('ec-3')
    expect(codecFamily('mp4a.40.2')).toBe('mp4a')
  })

  it('treats a missing list as "everything works"', () => {
    expect(codecSupported(undefined, 'hevc')).toBe(true)
    expect(codecSupported(null, 'av1')).toBe(true)
  })

  it('checks the family against the client list', () => {
    const box = ['avc1', 'mp4a', 'ac-3']
    expect(codecSupported(box, 'h264')).toBe(true)
    expect(codecSupported(box, 'hevc')).toBe(false)
    expect(codecSupported(box, 'ac3')).toBe(true)
    expect(codecSupported(box, 'eac3')).toBe(false)
    expect(codecSupported(['hvc1'], 'hev1.2.4.L120')).toBe(true)
  })

  it('names codecs for users', () => {
    expect(codecName('hevc')).toBe('HEVC')
    expect(codecName('eac3')).toBe('E-AC-3')
  })
})
