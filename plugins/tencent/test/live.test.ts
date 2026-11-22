// 联网测试：TENCENT_LIVE=1 pnpm exec vitest run plugins/tencent（国内直连）。
// - 没有凭证：浏览、搜索、详情、评论、弹幕、未登录的播放解析（分片不带请求头也能取）、登录二维码；再把 `requiredFor` 临时
//   改成 `nothing` 起一个服务跑 iyt-source check（这个源真正的配置要登录才浏览，check 会跳过）。
// - `TENCENT_CREDENTIAL='<App 的 TencentCredential JSON>'`：存进源的存储，续期、会员、观看历史、我的追剧，原样跑 check。
//   续期后的凭证打印出来（vurefresh 不变，可以接着用）。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, KeyValueStore, MediaGateway, type Ctx, type SourcePlugin } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { createTencentSource } from '../src/index.ts'
import { TencentSession } from '../src/session.ts'
import { normalizeCredential } from '../src/session.ts'

const live = process.env.TENCENT_LIVE === '1'
const credentialJSON = process.env.TENCENT_CREDENTIAL

function context(store: KeyValueStore): Ctx {
  return {
    sourceId: 'tencent', store, media: new MediaGateway(), ytdlp: undefined as never, exits: undefined as never,
    log: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal,
  }
}

/**
 * - Parameter allowRestricted: 不登录时首页第一部的第一集常是 VIP 的，解析答 `restricted`（这是对的），不算失败。
 */
async function runCheck(plugin: SourcePlugin, data: string, prepare?: (dataDir: string) => void, allowRestricted = false): Promise<void> {
  prepare?.(data)
  const server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'tencent', plugin }] })
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  const lines: string[] = []
  try {
    const failures = await check(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, (line) => lines.push(line))
    console.log(lines.join('\n'))
    const restricted = allowRestricted ? lines.filter((line) => line.includes('✗') && line.includes('"code":"restricted"')).length : 0
    expect(failures - restricted, lines.join('\n')).toBe(0)
  } finally {
    await server.close()
  }
}

describe.skipIf(!live)('腾讯视频 live（不登录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iyt-tencent-live-'))
  const ctx = context(new KeyValueStore(dir))
  const plugin = createTencentSource()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('browses channels, the library and filters', async () => {
    const channels = await plugin.feed!.channels(ctx)
    expect(channels.channels.length).toBeGreaterThanOrEqual(4)
    const home = await plugin.feed!.channel(channels.home.id, undefined, ctx)
    console.log('[home]', home.sections.map((s) => `${s.title ?? 'hero'}(${s.items.length})`).join(' '))
    expect(home.sections.length).toBeGreaterThan(0)
    const tv = await plugin.feed!.channel('100113', undefined, ctx)
    const library = tv.sections.find((s) => s.more)!
    const more = await plugin.feed!.more!(library.more!.route, '2', ctx)
    expect(more.items.length).toBeGreaterThan(10)
    const dimensions = await plugin.filter!.dimensions('100113', ctx)
    const kind = dimensions.find((d) => d.id === 'itype')!
    const results = await plugin.filter!.results('100113', { itype: kind.options[1]!.id }, undefined, ctx)
    expect(results.items.length).toBeGreaterThan(0)
  }, 60_000)

  it('searches', async () => {
    const suggestions = await plugin.search!.suggestions!('庆余年', ctx)
    expect(suggestions.length).toBeGreaterThan(0)
    const results = await plugin.search!.search('庆余年第二季', ctx)
    expect(results.topMatch?.show.id).toBe('cmzc002002kqssyu')
    const rankings = await plugin.search!.rankings!(ctx)
    expect(rankings.length).toBeGreaterThan(0)
  }, 60_000)

  it('reads a show, its episodes, comments and 弹幕', async () => {
    const detail = await plugin.detail.detail({ show: 'cmzc00200803dr6b' }, ctx)
    expect(detail.episodes?.ranges).toHaveLength(2)
    const later = await plugin.detail.episodes!(detail.episodes!.ranges![1]!.cursor, ctx)
    expect(later.episodes.some((e) => e.stage === '31')).toBe(true)
    expect(detail.recommendations.items.length).toBeGreaterThan(0)
    const byVideo = await plugin.detail.detail({ video: 'vc4102g9a01t' }, ctx)
    expect(byVideo.showID).toBe('cmzc00200803dr6b')
    const comments = await plugin.comments!.first('vc4102g9a01t', 'hot', ctx)
    expect(comments.comments.length).toBeGreaterThan(0)
    const next = await plugin.comments!.page(comments.next!, ctx)
    expect(next.comments[0]?.id).not.toBe(comments.comments[0]?.id)
    const withReplies = comments.comments.find((c) => c.replies)
    if (withReplies) expect((await plugin.comments!.page(withReplies.replies!, ctx)).comments.length).toBeGreaterThan(0)
    expect((await plugin.danmaku!.segment('vc4102g9a01t', 5, ctx)).length).toBeGreaterThan(0)
  }, 60_000)

  it('resolves a free episode signed out; the CDN takes no headers', async () => {
    const media = await plugin.playback.resolve({ video: 'vc4102g9a01t', show: 'cmzc00200803dr6b' }, ctx)
    console.log('[resolve]', media.diagnostics, media.streams.map((s) => `${s.id} ${s.quality.label} ${s.unavailableReason ?? ''}`))
    const selected = media.streams.find((s) => s.id === media.selectedStream)!
    expect(selected.unavailableReason).toBeUndefined()
    // VIP 剧集要拒绝。
    await expect(plugin.playback.resolve({ video: 'vz4102dk8msl', show: 'cmzc00200803dr6b' }, ctx)).rejects.toMatchObject({ code: 'restricted' })
  }, 60_000)

  it('issues a login QR code', async () => {
    const controller = new AbortController()
    const steps = plugin.account!.begin!('qr', { ...ctx, signal: controller.signal })[Symbol.asyncIterator]()
    const first = await steps.next()
    controller.abort()
    expect(first.value).toMatchObject({ kind: 'showCode', title: '扫码登录腾讯视频' })
    expect(first.value.content).toMatch(/^https:\/\/m\.v\.qq\.com\/z\/app\/auth-page\/index\.html\?qr_code_id=/)
  }, 30_000)

  it('passes the conformance check (browsing allowed signed out)', async () => {
    const data = mkdtempSync(join(tmpdir(), 'iyt-tencent-check-'))
    const source = createTencentSource()
    try {
      await runCheck({ ...source, account: { ...source.account!, requiredFor: 'nothing' } }, data, undefined, true)
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(!live || !credentialJSON)('腾讯视频 live（登录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iyt-tencent-login-'))
  const store = new KeyValueStore(dir)
  const credential = normalizeCredential(JSON.parse(credentialJSON ?? '{}'))
  if (credential) store.set('credential', credential)
  const ctx = context(store)
  const plugin = createTencentSource()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('renews and reads the account', async () => {
    const state = await plugin.account!.state(ctx)
    console.log('[account]', state)
    expect(state.loggedIn).toBe(true)
    console.log('[credential]', JSON.stringify(new TencentSession(store).credential))
  }, 30_000)

  it('reads the history and the shows followed', async () => {
    const history = await plugin.history!.page(1, ctx)
    console.log('[history]', history.items.slice(0, 3).map((i) => `${i.title} ${i.watchedPercent ?? '-'}%`), history.hasMore)
    const chasing = await plugin.feed!.channel('chasing', undefined, ctx)
    console.log('[chasing]', chasing.sections[0]?.items.slice(0, 3).map((i) => i.title))
    const first = history.items.find((i) => i.showID)
    if (first) {
      const resume = await plugin.detail.resume!(first.showID, undefined, ctx)
      expect(resume?.videoID).toBe(first.id)
    }
  }, 60_000)

  it('resolves with the login', async () => {
    const media = await plugin.playback.resolve({ video: 'vc4102g9a01t', show: 'cmzc00200803dr6b' }, ctx)
    console.log('[resolve]', media.diagnostics, media.startPosition, media.streams.map((s) => `${s.id} ${s.quality.label} ${s.unavailableReason ?? ''}`))
    expect(media.streams.some((s) => !s.unavailableReason)).toBe(true)
  }, 60_000)

  it('passes the conformance check', async () => {
    const data = mkdtempSync(join(tmpdir(), 'iyt-tencent-check-'))
    try {
      await runCheck(createTencentSource(), data, (dataDir) => {
        if (credential) new KeyValueStore(join(dataDir, 'sources', 'tencent')).set('credential', new TencentSession(store).credential)
      })
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  }, 120_000)
})
