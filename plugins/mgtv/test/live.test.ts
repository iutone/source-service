// 联网测试：MGTV_LIVE=1 pnpm exec vitest run plugins/mgtv（直连芒果TV，要国内出口）。
// 有 MGTV_TICKET / MGTV_UUID 时先把凭证写进源的存储，再用 iyt-source check 按 App 的顺序走一遍，并读观看历史；
// 没有凭证时只测不需要登录的部分：登录二维码、频道、筛选、搜索、详情、评论、弹幕，以及免费片经网关的播放。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Channels, CommentPage, Danmaku, FeedPage, FilterDimension, HistoryPage, LoginState, Manifest, MediaItemPage, PlaybackMedia, SearchResults, ShowDetail } from '@iyt-source/protocol'
import { createServer, KeyValueStore, type SourceServer } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { createMgtvSource } from '../src/index.ts'

const live = process.env.MGTV_LIVE === '1'
const ticket = process.env.MGTV_TICKET
const uuid = process.env.MGTV_UUID

describe.skipIf(!live)('芒果TV live', () => {
  let data: string
  let server: SourceServer
  let base: string
  const prefix = '/iyt/v1/sources/mgtv'

  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-iutone-client': 'mgtv-live-test', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path} → ${response.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'iyt-mgtv-live-'))
    if (ticket && uuid) new KeyValueStore(join(data, 'sources', 'mgtv')).set('credential', { ticket, uuid })
    server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'mgtv', plugin: createMgtvSource() }] })
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await server?.close()
    rmSync(data, { recursive: true, force: true })
  })

  it('一致性检查', async () => {
    const lines: string[] = []
    const failures = await check(base, (line) => lines.push(line))
    console.log(lines.join('\n'))
    expect(failures, lines.join('\n')).toBe(0)
  }, 120_000)

  it('manifest 与频道', async () => {
    const manifest = await call<Manifest>('/iyt/v1/manifest')
    const source = manifest.sources.find((s) => s.id === 'mgtv')!
    expect(source.account).toMatchObject({ login: ['qr'], requiredFor: 'browse', loggedIn: Boolean(ticket && uuid) })
    expect(source.features.feed.home?.id).toBe('5')
    const channels = await call<Channels>(`${prefix}/feed/channels`)
    console.log('频道', channels.channels.map((c) => `${c.title}(${c.id})`).join(' '), '置顶', channels.pinned.map((c) => c.title).join(' '))
    expect(channels.channels.length).toBeGreaterThanOrEqual(4)
  }, 60_000)

  it.skipIf(Boolean(ticket && uuid))('登录二维码', async () => {
    const start = await call<LoginState>(`${prefix}/login/start`, { method: 'qr' })
    const state = start.step.kind === 'showCode' ? start : await call<LoginState>(`${prefix}/login/${start.loginId}?after=${start.seq}&wait=10`)
    expect(state.step.kind).toBe('showCode')
    if (state.step.kind === 'showCode') expect(state.step.content).toMatch(/^https:\/\/oauth\.mgtv\.com\//)
    await call(`${prefix}/login/${start.loginId}/cancel`, {})
  }, 30_000)

  it('首页、频道页与更多', async () => {
    const home = await call<FeedPage>(`${prefix}/feed/channel?id=5`)
    console.log('首页', home.sections.map((s) => `${s.title ?? s.style}:${s.items.length}`).join(' '))
    expect(home.sections.length).toBeGreaterThan(2)
    const series = await call<FeedPage>(`${prefix}/feed/channel?id=4`)
    const hot = series.sections.find((s) => s.more)!
    expect(hot).toBeTruthy()
    const more = await call<MediaItemPage>(`${prefix}/feed/more?route=${encodeURIComponent(hot.more!.route)}&cursor=2`)
    expect(more.items.length).toBeGreaterThan(10)
  }, 60_000)

  it('筛选、搜索', async () => {
    const dimensions = await call<FilterDimension[]>(`${prefix}/filter/dimensions?category=2`)
    console.log('筛选', dimensions.map((d) => `${d.title}(${d.id})${d.isSort ? '↕' : ''}`).join(' '))
    expect(dimensions.some((d) => d.isSort)).toBe(true)
    const results = await call<MediaItemPage>(`${prefix}/filter/results?category=2&selection=${encodeURIComponent(JSON.stringify({ chargeInfo: 'b1' }))}`)
    expect(results.items.length).toBeGreaterThan(0)
    const suggestions = await call<unknown[]>(`${prefix}/search/suggestions?q=${encodeURIComponent('乘风')}`)
    expect(suggestions.length).toBeGreaterThan(0)
    const search = await call<SearchResults>(`${prefix}/search?q=${encodeURIComponent('乘风破浪')}`)
    console.log('搜索', search.topMatch?.show.title, search.shows.length, search.videos.length)
    expect(search.topMatch || search.shows.length).toBeTruthy()
    const rankings = await call<unknown[]>(`${prefix}/search/rankings`)
    expect(rankings.length).toBeGreaterThan(0)
  }, 60_000)

  it('免费片：详情、评论、弹幕、经网关播放', async () => {
    const free = await call<MediaItemPage>(`${prefix}/filter/results?category=1&selection=${encodeURIComponent(JSON.stringify({ chargeInfo: 'b1', sort: 'c2' }))}`)
    const show = free.items[0]
    const detail = await call<ShowDetail>(`${prefix}/detail?target=${encodeURIComponent(`show:${'show' in show.target ? show.target.show : show.target.video}`)}`)
    console.log('详情', detail.title, detail.episodes?.episodes.length, '集', detail.episodes?.parts?.map((p) => p.title).join(' '), '推荐', detail.recommendations.items.length)
    const video = detail.defaultVideoID ?? detail.episodes!.episodes[0].id
    const comments = await call<CommentPage>(`${prefix}/comments?video=${video}&sort=hot`)
    console.log('评论', comments.total, comments.comments.length)
    const latest = await call<CommentPage>(`${prefix}/comments?video=${video}&sort=latest`)
    expect(Array.isArray(latest.comments)).toBe(true)
    const danmaku = await call<Danmaku[]>(`${prefix}/danmaku?video=${video}&segment=0`)
    console.log('弹幕', danmaku.length)
    const media = await call<PlaybackMedia>(`${prefix}/playback/resolve`, { video, show: detail.showID ?? null, preferences: { maxQualityRank: 720 } })
    console.log('解析', media.title, media.streams.map((s) => `${s.id}:${s.quality.label}${s.unavailableReason ? `(${s.unavailableReason})` : ''}`).join(' '), '选', media.selectedStream)
    const selected = media.streams.find((s) => s.id === media.selectedStream)!
    expect(selected.url.startsWith('/iyt/v1/media/')).toBe(true)
    const playlist = await (await fetch(`${base}${selected.url}`)).text()
    expect(playlist.startsWith('#EXTM3U')).toBe(true)
    const segment = playlist.split('\n').find((line) => line && !line.startsWith('#'))!
    expect(segment.startsWith('/iyt/v1/media/')).toBe(true)
    const part = await fetch(`${base}${segment}`, { headers: { range: 'bytes=0-1023' } })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(1024)
  }, 90_000)

  it.skipIf(!(ticket && uuid))('观看历史', async () => {
    const history = await call<HistoryPage>(`${prefix}/history?page=1`)
    console.log('历史', history.items.length, history.hasMore, history.items.slice(0, 3).map((i) => `${i.title} ${i.subtitle ?? ''}`).join(' / '))
    if (history.hasMore) {
      const second = await call<HistoryPage>(`${prefix}/history?page=2`)
      expect(second.items[0]?.historyKey).not.toBe(history.items[0]?.historyKey)
    }
  }, 30_000)
})
