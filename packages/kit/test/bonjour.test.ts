import { describe, expect, it } from 'vitest'
import { lanAddresses, localHostName } from '../src/bonjour.ts'

describe('bonjour host name', () => {
  it('always ends in .local', () => {
    expect(localHostName('mxc-nas')).toBe('mxc-nas.local')
    expect(localHostName('Mac.local')).toBe('Mac.local')
    expect(localHostName('Mac.local.')).toBe('Mac.local')
  })

  it('advertises LAN interfaces only', () => {
    const v4 = (address: string) => ({ address, family: 'IPv4' as const, internal: false, mac: '00:11:22:33:44:55', netmask: '255.255.255.0', cidr: null })
    expect(lanAddresses({
      lo: [{ ...v4('127.0.0.1'), internal: true }],
      qvs0: [v4('192.168.31.207')],
      'br-e12c640ad691': [v4('172.29.0.1')],
      docker0: [v4('10.0.5.1')],
      lxdbr0: [v4('10.0.7.1')],
      en0: [v4('169.254.38.219'), v4('192.168.31.151')],
    })).toEqual(['192.168.31.207', '192.168.31.151'])
  })
})
