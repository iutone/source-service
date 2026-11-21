import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExitPool, SourceError } from '../src/index.ts'

const logs: string[] = []
const log = { info: (m: string) => logs.push('info ' + m), warn: (m: string) => logs.push('warn ' + m), error: (m: string) => logs.push('error ' + m) }

afterEach(() => {
  vi.unstubAllGlobals()
  logs.length = 0
})

function pool(now: () => number) {
  return new ExitPool({ pools: { subtitles: [{ url: 'http://a:1', dispatcher: 'A' }, { url: 'http://b:2', dispatcher: 'B' }] }, cooldownMs: 60_000, log, now })
}

describe('ExitPool', () => {
  it('moves on from an exit that is limited, and keeps using the one that works', async () => {
    const seen: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { dispatcher?: unknown }) => {
      seen.push(init.dispatcher)
      return new Response('', { status: init.dispatcher === 'A' ? 429 : 200 })
    })
    const exits = pool(() => 0)
    const response = await exits.fetch('subtitles', 'https://x/t', {}, (r) => r.status === 429, '等 {minutes} 分钟')
    expect(response.status).toBe(200)
    await exits.fetch('subtitles', 'https://x/t', {}, (r) => r.status === 429, '等 {minutes} 分钟')
    expect(seen).toEqual(['A', 'B', 'B'])
    expect(exits.status().subtitles[0]).toMatchObject({ url: 'http://a:1', limited: 1, lastFailure: 'HTTP 429' })
    expect(logs).toContain('warn 出口被限，冷却')
  })

  it('says how long to wait once every exit is cooling, then tries them again', async () => {
    let now = 0
    vi.stubGlobal('fetch', async () => new Response('', { status: now < 60_000 ? 429 : 200 }))
    const exits = pool(() => now)
    const failure = await exits.fetch('subtitles', 'https://x/t', {}, (r) => r.status === 429, '等 {minutes} 分钟').catch((e) => e)
    expect(failure).toBeInstanceOf(SourceError)
    expect(failure).toMatchObject({ code: 'throttled', message: '等 1 分钟', retryAfter: 60 })
    expect(logs).toContain('error 这个用途的出口都在冷却')
    now = 60_000
    expect((await exits.fetch('subtitles', 'https://x/t', {}, (r) => r.status === 429, '')).status).toBe(200)
    expect(logs).toContain('info 出口恢复')
  })

  it('runs work through each exit, and goes direct for a purpose without exits', async () => {
    const exits = pool(() => 0)
    const used: (string | undefined)[] = []
    const result = await exits.run('subtitles', async (exit) => {
      used.push(exit?.url)
      if (exit?.url === 'http://a:1') throw new Error('bot')
      return 'ok'
    }, (error) => (String(error).includes('bot') ? 'bot check' : undefined), '')
    expect(result).toBe('ok')
    expect(used).toEqual(['http://a:1', 'http://b:2'])
    expect(await exits.run('ytdlp', async (exit) => exit?.url ?? 'direct', () => undefined, '')).toBe('direct')
  })
})
