// 联网测试：IQIYI_LIVE=1 pnpm exec vitest run plugins/iqiyi（国内直连爱奇艺）。
// 有 IQIYI_COOKIE='P00001=…; P00003=…' 时以这个账号起一个服务，用 iyt-source check 按 App 的顺序走一遍，再读观看历史；
// 没有时只测不需要登录的部分：拿二维码、匿名的频道 / 详情 / 搜索 / 弹幕 / 评论 / 播放 / 链接，以及 manifest 的形状。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Manifest } from '@iyt-source/protocol'
import { createServer, KeyValueStore, MediaGateway, type Ctx } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { createIQiyiSource } from '../src/index.ts'

const live = process.env.IQIYI_LIVE === '1'
const cookie = process.env.IQIYI_COOKIE

function cookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(';').map((pair) => pair.trim().split(/=(.*)/s).slice(0, 2)).filter(([name, value]) => name && value))
}

async function withServer(seed: ((store: KeyValueStore) => void) | undefined, run: (base: string) => Promise<void>) {
  const data = mkdtempSync(join(tmpdir(), 'iyt-iqiyi-live-'))
  seed?.(new KeyValueStore(join(data, 'sources', 'iqiyi')))
  const server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'iqiyi', plugin: createIQiyiSource(), visibility: 'auto' }] })
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  try {
    await run(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`)
  } finally {
    await server.close()
    rmSync(data, { recursive: true, force: true })
  }
}

describe.skipIf(!live)('爱奇艺 live（不登录）', () => {
  const media = new MediaGateway()
  const ctx = (signal: AbortSignal = AbortSignal.timeout(30_000)): Ctx =>
    ({ sourceId: 'iqiyi', store: new KeyValueStore(mkdtempSync(join(tmpdir(), 'iyt-iqiyi-'))), media, log: console, signal }) as unknown as Ctx
  const plugin = createIQiyiSource()

  it('拿到登录二维码', async () => {
    const steps = plugin.account!.begin!('qr', ctx(AbortSignal.timeout(10_000)))[Symbol.asyncIterator]()
    const first = (await steps.next()).value
    expect(first).toMatchObject({ kind: 'showCode', title: '爱奇艺扫码登录' })
    expect(first.content).toMatch(/^https:\/\/passport\.iqiyi\.com\/apis\/qrcode\/token_login\.action\?token=/)
    await steps.return?.()
  }, 20_000)

  it('频道、首页、频道页、更多', async () => {
    const c = ctx()
    const channels = await plugin.feed!.channels(c)
    expect(channels.home.id).toBe('recommend')
    expect(channels.channels.map((ch) => ch.id)).toContain('tv')
    const home = await plugin.feed!.channel('recommend', undefined, c)
    expect(home.sections.length).toBeGreaterThan(0)
    const tv = await plugin.feed!.channel('tv', undefined, c)
    const library = tv.sections.find((s) => s.more)
    expect(library?.items.length).toBeGreaterThan(0)
    const more = await plugin.feed!.more!(library!.more!.route, '2', c)
    expect(more.items.length).toBeGreaterThan(0)
  }, 60_000)

  it('详情、选集、播放、弹幕、评论', async () => {
    const c = ctx(AbortSignal.timeout(60_000))
    // 《狂飙》：免费、完结的剧。
    const detail = await plugin.detail.detail({ show: 'a5328486914190101' }, c)
    expect(detail.episodes?.episodes.length).toBeGreaterThan(10)
    const first = detail.episodes!.episodes[0].id
    const media = await plugin.playback.resolve({ video: first, preferences: { maxQualityRank: 720 } }, c)
    const selected = media.streams.find((s) => s.id === media.selectedStream)!
    expect(selected.unavailableReason).toBeUndefined()
    expect(selected.url).toMatch(/^\/iyt\/v1\/media\//)
    expect(media.streams.find((s) => s.id === '600')?.unavailableReason).toBe('VIP')
    const danmaku = await plugin.danmaku!.segment(first, 0, c)
    expect(danmaku.length).toBeGreaterThan(0)
    const comments = await plugin.comments!.first(first, 'hot', c)
    expect(Array.isArray(comments.comments)).toBe(true)
  }, 90_000)

  it('搜索、联想、热搜、链接', async () => {
    const c = ctx()
    const results = await plugin.search!.search('狂飙', c)
    expect(results.topMatch?.show.title).toBe('狂飙')
    expect((await plugin.search!.suggestions!('kb', c)).length).toBeGreaterThan(0)
    expect((await plugin.search!.rankings!(c)).length).toBeGreaterThan(0)
    expect(await plugin.links!.resolve('http://www.iqiyi.com/a_uu6qr7xu7d.html', c)).toEqual({ target: { show: 'a3190714930072901' } })
  }, 60_000)

  it('manifest：浏览要登录，未登录时 check 只看 manifest', async () => {
    await withServer(undefined, async (base) => {
      const manifest = (await (await fetch(`${base}/iyt/v1/manifest`)).json()) as Manifest
      const source = manifest.sources[0]
      expect(source.account).toMatchObject({ login: ['qr'], requiredFor: 'browse', loggedIn: false })
      expect(source.brand).toMatchObject({ tint: '#00C45A', tabIconIsWordmark: true })
      expect(source.features).toMatchObject({ filter: true, danmaku: { segmentDuration: 300 }, history: { read: true, delete: true }, fairPlay: false })
      expect(source.features.feed.home?.id).toBe('recommend')
      const lines: string[] = []
      expect(await check(base, (line) => lines.push(line)), lines.join('\n')).toBe(0)
    })
  }, 60_000)
})

describe.skipIf(!live || !cookie)('爱奇艺 live（登录）', () => {
  it('一致性检查和观看历史', async () => {
    await withServer((store) => store.set('credential', { cookies: cookies(cookie!) }), async (base) => {
      const manifest = (await (await fetch(`${base}/iyt/v1/manifest`)).json()) as Manifest
      expect(manifest.sources[0].account.loggedIn, '凭证无效或已过期').toBe(true)
      const lines: string[] = []
      const failures = await check(base, (line) => lines.push(line))
      console.log(lines.join('\n'))
      expect(failures, lines.join('\n')).toBe(0)
      const history = await fetch(`${base}/iyt/v1/sources/iqiyi/history?page=1`)
      expect(history.status).toBe(200)
      expect(Array.isArray(((await history.json()) as { items: unknown[] }).items)).toBe(true)
    })
  }, 120_000)
})
