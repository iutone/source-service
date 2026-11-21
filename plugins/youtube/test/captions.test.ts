import { describe, expect, it } from 'vitest'
import { CaptionFetcher } from '../src/captions.ts'

function server(statuses: number[]) {
  const calls: string[] = []
  const fetch = (async (url: URL) => {
    calls.push(String(url))
    const status = statuses.shift() ?? 200
    return new Response(status === 200 ? JSON.stringify({ events: [] }) : 'Sorry', { status })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe('CaptionFetcher', () => {
  it('fetches a track once, as json3, and shares concurrent asks', async () => {
    const { calls, fetch } = server([200])
    const captions = new CaptionFetcher({ fetch })
    const [a, b] = await Promise.all([captions.get('v|en', 'https://www.youtube.com/api/timedtext?v=v&fmt=vtt'),
      captions.get('v|en', 'https://www.youtube.com/api/timedtext?v=v&fmt=vtt')])
    expect(a).toEqual({ events: [] })
    expect(b).toBe(a)
    await captions.get('v|en', 'https://www.youtube.com/api/timedtext?v=v')
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]).searchParams.get('fmt')).toBe('json3')
  })

  it('stops asking for a while once refused with 429', async () => {
    let now = 0
    const { calls, fetch } = server([429, 200])
    const captions = new CaptionFetcher({ fetch, cooldown: 60_000, now: () => now })
    await expect(captions.get('v|en', 'https://x/t')).rejects.toMatchObject({ code: 'throttled' })
    await expect(captions.get('w|en', 'https://x/t')).rejects.toMatchObject({ code: 'throttled', retryAfter: 60 })
    expect(calls).toHaveLength(1)
    now = 61_000
    await expect(captions.get('w|en', 'https://x/t')).resolves.toEqual({ events: [] })
  })
})
