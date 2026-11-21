import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KeyValueStore } from '@iyt-source/kit'
import { YouTubeSession } from '../src/session.ts'

describe('web login cookies', () => {
  const session = () => new YouTubeSession(new KeyValueStore(mkdtempSync(join(tmpdir(), 'yt-cookies-'))))

  it('writes YouTube / Google cookies as a Netscape file only yt-dlp reads', () => {
    const s = session()
    s.saveCookies([
      { name: 'SAPISID', value: 'abc', domain: '.youtube.com', expires: '2027-01-01T00:00:00Z' },
      { name: 'SID', value: 'def', domain: 'google.com', path: '/', secure: false },
      { name: 'other', value: 'x', domain: '.example.com' },
    ])
    const file = s.cookiesFile!
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('# Netscape HTTP Cookie File')
    expect(lines.slice(2)).toEqual([
      '.youtube.com\tTRUE\t/\tTRUE\t1798761600\tSAPISID\tabc',
      '.google.com\tTRUE\t/\tFALSE\t0\tSID\tdef',
    ])
  })

  it('refuses cookies without a login and forgets them on logout', () => {
    const s = session()
    expect(() => s.saveCookies([{ name: 'PREF', value: '1', domain: '.youtube.com' }])).toThrow(/登录 cookie/)
    s.saveCookies([{ name: '__Secure-3PSID', value: 'x', domain: '.youtube.com' }])
    expect(s.cookiesFile).toBeDefined()
    s.clear()
    expect(s.cookiesFile).toBeUndefined()
  })
})
