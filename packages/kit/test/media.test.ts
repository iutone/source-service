import { describe, expect, it } from 'vitest'
import { parseRange } from '../src/media.ts'

describe('parseRange', () => {
  it('reads the three forms', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('bytes=0-9', 100)).toEqual([0, 9])
    expect(parseRange('bytes=90-', 100)).toEqual([90, 99])
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99])
    expect(parseRange('bytes=50-500', 100)).toEqual([50, 99])
  })
  it('rejects what cannot be satisfied', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=5-1', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
  })
})
