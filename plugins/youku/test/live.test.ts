// 联网测试：YOUKU_LIVE=1 pnpm exec vitest run plugins/youku（国内直连）。
// - 不登录：首页、联想、扫码登录拿到二维码、匿名解析一集（服务端生成 ckey）并读到播放列表。
// - YOUKU_COOKIE='<浏览器里 youku.com 的 Cookie 头>'：用网页登录交 cookie，再用 iyt-source check 按 App 的顺序走一遍，并读观看历史。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '@iyt-source/kit'
import type { FeedPage, LoginState, PlaybackMedia, ShowDetail } from '@iyt-source/protocol'
import { check } from '../../../packages/cli/src/check.ts'
import { createYoukuSource } from '../src/index.ts'

const live = process.env.YOUKU_LIVE === '1'

describe.skipIf(!live)('Youku live', () => {
  let data: string
  let server: Awaited<ReturnType<typeof createServer>>
  let origin: string

  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}/iyt/v1/sources/youku/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-iutone-client': 'youku-live-test', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'iyt-youku-live-'))
    server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'youku', plugin: createYoukuSource() }] })
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    origin = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await server?.close()
    rmSync(data, { recursive: true, force: true })
  })

  it('browses, suggests and plays without a login', async () => {
    const home = await call<FeedPage>('feed/channel?id=WEBHOME')
    expect(home.sections.length).toBeGreaterThan(2)
    const suggestions = await call<{ keyword: string }[]>(`search/suggestions?q=${encodeURIComponent('谷')}`)
    expect(suggestions.length).toBeGreaterThan(0)
    // 首页轮播里第一部节目的第一集：匿名有明文流（限免、免费的）。
    const shows = home.sections.flatMap((s) => s.items).filter((i) => 'show' in i.target).slice(0, 6)
    let played = false
    for (const show of shows) {
      const detail = await call<ShowDetail>(`detail?target=${encodeURIComponent(`show:${(show.target as { show: string }).show}`)}`)
      const video = detail.defaultVideoID ?? detail.episodes?.episodes[0]?.id
      if (!video) continue
      let media: PlaybackMedia
      try {
        media = await call<PlaybackMedia>('playback/resolve', { video, show: detail.showID, preferences: {} })
      } catch {
        continue
      }
      const selected = media.streams.find((s) => s.id === media.selectedStream)!
      const url = selected.url.startsWith('/') ? origin + selected.url : selected.url
      expect((await (await fetch(url)).text()).startsWith('#EXTM3U')).toBe(true)
      played = true
      break
    }
    expect(played).toBe(true)
  }, 180_000)

  it('shows a Youku app QR code to scan', async () => {
    const start = await call<LoginState>('login/start', { method: 'qr' })
    const next = await call<LoginState>(`login/${start.loginId}?after=${start.seq}&wait=20`)
    expect(next.step.kind).toBe('showCode')
    if (next.step.kind === 'showCode') expect(next.step.content).toMatch(/^https:\/\/qr\.youku\.com\//)
    await call(`login/${start.loginId}/cancel`, {})
  }, 60_000)

  it.skipIf(Boolean(process.env.YOUKU_COOKIE))('passes the conformance check signed out (login gate lifted for the test)', async () => {
    // 匿名的首页、详情、解析都能用：把「浏览要登录」放开，让 check 走完全程。
    const plugin = createYoukuSource()
    const open = { ...plugin, account: { ...plugin.account!, requiredFor: 'nothing' as const } }
    const dir = mkdtempSync(join(tmpdir(), 'iyt-youku-check-'))
    const anonymous = await createServer({ name: 'check', dataDir: dir, sources: [{ id: 'youku', plugin: open }] })
    await anonymous.app.listen({ port: 0, host: '127.0.0.1' })
    const lines: string[] = []
    try {
      const failures = await check(`http://127.0.0.1:${(anonymous.app.server.address() as AddressInfo).port}`, (line) => lines.push(line))
      console.log(lines.join('\n'))
      expect(failures, lines.join('\n')).toBe(0)
    } finally {
      await anonymous.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it.skipIf(!process.env.YOUKU_COOKIE)('logs in with web cookies and passes the conformance check', async () => {
    const cookies = process.env.YOUKU_COOKIE!.split(/;\s*/).filter(Boolean).map((pair) => {
      const eq = pair.indexOf('=')
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '.youku.com', path: '/' }
    })
    const result = await call<{ step: { kind: string; message?: string } }>('login/cookie', { cookies, userAgent: 'test' })
    expect(result.step.kind, result.step.message).toBe('completed')
    const history = await call<{ items: unknown[] }>('history?page=1')
    expect(Array.isArray(history.items)).toBe(true)
    const lines: string[] = []
    const failures = await check(origin, (line) => lines.push(line))
    console.log(lines.join('\n'))
    expect(failures, lines.join('\n')).toBe(0)
  }, 240_000)
})
