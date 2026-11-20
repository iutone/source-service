import { describe, expect, it } from 'vitest'
import { isAllowedHost, isLocalAddress } from '../src/lan.ts'

describe('isLocalAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '::1', 'fe80::1%en0', 'fd12::3', '::ffff:192.168.1.2'])(
    'accepts %s', (address) => expect(isLocalAddress(address)).toBe(true))
  it.each(['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '::ffff:8.8.8.8', undefined, ''])(
    'rejects %s', (address) => expect(isLocalAddress(address)).toBe(false))
})

describe('isAllowedHost', () => {
  it('accepts addresses, localhost and .local', () => {
    for (const host of ['192.168.1.20:8090', '[fe80::1]:8090', 'localhost', 'nas.local:8090', 'NAS.LOCAL.']) {
      expect(isAllowedHost(host)).toBe(true)
    }
  })
  it('rejects other names unless listed', () => {
    expect(isAllowedHost('evil.example.com')).toBe(false)
    expect(isAllowedHost('nas.home.arpa:8090', ['nas.home.arpa'])).toBe(true)
    expect(isAllowedHost(undefined)).toBe(false)
  })
})
