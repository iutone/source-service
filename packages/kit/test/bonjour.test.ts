import { describe, expect, it } from 'vitest'
import { localHostName } from '../src/bonjour.ts'

describe('bonjour host name', () => {
  it('always ends in .local', () => {
    expect(localHostName('mxc-nas')).toBe('mxc-nas.local')
    expect(localHostName('Mac.local')).toBe('Mac.local')
    expect(localHostName('Mac.local.')).toBe('Mac.local')
  })
})
