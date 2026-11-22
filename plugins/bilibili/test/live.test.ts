// 联网测试：BILI_LIVE=1 pnpm exec vitest run plugins/bilibili（国内直连）。
// - 不登录：manifest、扫码登录拿到二维码，匿名能调的接口（热门、搜索、详情、评论、弹幕），以及匿名能播的清晰度经媒体网关做成的 HLS。
// - 带 BILI_COOKIE（浏览器里 bilibili.com 的 cookie 串，至少 SESSDATA、bili_jct、DedeUserID）：存进源的存储后用 iyt-source check 走一遍。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LoginState, Manifest } from '@iyt-source/protocol'
import { createServer, KeyValueStore, type Ctx } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { Catalog } from '../src/catalog.ts'
import { Detail } from '../src/detail.ts'
import * as feed from '../src/feed.ts'
import { createBilibiliSource, expandShortLink } from '../src/index.ts'
import { Interactions } from '../src/interact.ts'
import { parseDanmakuSegment } from '../src/models.ts'
import { Playback } from '../src/playback.ts'
import { search, suggestions } from '../src/search.ts'
import { BiliSession, type Credential } from '../src/session.ts'

const live = process.env.BILI_LIVE === '1'
const log = { info() {}, warn() {}, error() {} }

async function withServer(seed: Credential | undefined, run: (base: string, server: Awaited<ReturnType<typeof createServer>>) => Promise<void>) {
  const data = mkdtempSync(join(tmpdir(), 'iyt-bili-live-'))
  if (seed) {
    mkdirSync(join(data, 'sources', 'bilibili'), { recursive: true })
    writeFileSync(join(data, 'sources', 'bilibili', 'credential.json'), JSON.stringify(seed))
  }
  const server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'bilibili', plugin: createBilibiliSource() }] })
  await server.app.listen({ port: 0, host: '127.0.0.1' })
  try {
    await run(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, server)
  } finally {
    await server.close()
    rmSync(data, { recursive: true, force: true })
  }
}

/** `SESSDATA=…; bili_jct=…; DedeUserID=…` → 登录凭证（没有 app token：续期和「不喜欢」用不了）。 */
function credentialFromCookie(text: string): Credential {
  const cookies = text.split(';').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const at = pair.indexOf('=')
    return { name: pair.slice(0, at), value: pair.slice(at + 1) }
  })
  return { mid: cookies.find((c) => c.name === 'DedeUserID')?.value ?? '0', cookies }
}

describe.skipIf(!live)('Bilibili live（不登录）', () => {
  it('manifest 要登录，扫码登录给出二维码', async () => {
    await withServer(undefined, async (base) => {
      const manifest = await (await fetch(`${base}/iyt/v1/manifest`)).json() as Manifest
      const source = manifest.sources[0]
      expect(source).toMatchObject({ name: '哔哩哔哩', account: { login: ['qr'], requiredFor: 'browse', loggedIn: false } })
      expect(source.features.feed.home).toEqual({ id: 'follow', title: '关注' })
      expect(source.features.danmaku).toEqual({ segmentDuration: 360 })
      const lines: string[] = []
      expect(await check(base, (line) => lines.push(line)), lines.join('\n')).toBe(0)

      const login = await (await fetch(`${base}/iyt/v1/sources/bilibili/login/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'qr' }),
      })).json() as LoginState
      const next = login.step.kind === 'showCode' ? login
        : await (await fetch(`${base}/iyt/v1/sources/bilibili/login/${login.loginId}?after=${login.seq}&wait=10`)).json() as LoginState
      expect(next.step.kind).toBe('showCode')
      if (next.step.kind === 'showCode') expect(next.step.content).toMatch(/^https:\/\/passport\.bilibili\.com\//)
      await fetch(`${base}/iyt/v1/sources/bilibili/login/${login.loginId}/cancel`, { method: 'POST' })
      // 没登录时浏览接口回 401。
      const channel = await fetch(`${base}/iyt/v1/sources/bilibili/feed/channel?id=popular`)
      expect(channel.status).toBe(401)
    })
  }, 60_000)

  it('匿名能调的接口和匿名清晰度的 HLS', async () => {
    await withServer(undefined, async (base, server) => {
      const signal = AbortSignal.timeout(60_000)
      const session = new BiliSession(new KeyValueStore(mkdtempSync(join(tmpdir(), 'iyt-bili-store-'))), log)
      const catalog = new Catalog(session)
      const popular = await feed.channel(session, 'popular', undefined, signal)
      const first = popular.sections[0].items[0]
      expect(first.id).toMatch(/^BV/)
      expect((await suggestions(session, '原神', signal)).length).toBeGreaterThan(0)
      expect((await search(session, '原神', signal)).videos.length).toBeGreaterThan(0)
      const detail = await new Detail(catalog).detail({ video: first.id }, signal)
      expect(detail.title).toBeTruthy()
      expect((await new Interactions(catalog).comments(first.id, 'hot', signal)).comments.length).toBeGreaterThan(0)
      const view = await catalog.view(first.id, signal)
      const danmaku = parseDanmakuSegment(await session.bytes('https://api.bilibili.com/x/v2/dm/wbi/web/seg.so',
        { type: '1', oid: String(view.cid), segment_index: '1' }, { signal }))
      expect(danmaku.length).toBeGreaterThan(0)
      expect(await expandShortLink(`https://b23.tv/${first.id}`, signal)).toContain(first.id)

      const ctx = { sourceId: 'bilibili', store: new KeyValueStore(mkdtempSync(join(tmpdir(), 'iyt-bili-ctx-'))), media: server.media, log, signal } as unknown as Ctx
      const media = await new Playback(catalog).resolve({ video: first.id, preferences: {} }, ctx)
      const stream = media.streams.find((s) => s.id === media.selectedStream)!
      expect(stream.format).toBe('hls')
      const master = await (await fetch(base + stream.url)).text()
      expect(master).toContain('#EXT-X-STREAM-INF')
      const videoList = master.split('\n').find((line) => line.startsWith('/iyt/v1/media/'))!
      const playlist = await (await fetch(base + videoList)).text()
      expect(playlist).toContain('#EXT-X-BYTERANGE')
      expect(playlist).toContain('#EXT-X-ENDLIST')
      // 第一段：经网关带 Referer 转发，CDN 放行。
      const [length, offset] = /#EXT-X-BYTERANGE:(\d+)@(\d+)/.exec(playlist)!.slice(1).map(Number)
      const segmentURL = playlist.split('\n').find((line) => line.startsWith('/iyt/v1/media/'))!
      const segment = await fetch(base + segmentURL, { headers: { range: `bytes=${offset}-${offset + Math.min(length, 4096) - 1}` } })
      expect(segment.status).toBe(206)
      expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0)
    })
  }, 120_000)
})

describe.skipIf(!live || !process.env.BILI_COOKIE)('Bilibili live（登录）', () => {
  it('passes the conformance check', async () => {
    await withServer(credentialFromCookie(process.env.BILI_COOKIE!), async (base) => {
      const lines: string[] = []
      const failures = await check(base, (line) => lines.push(line))
      console.log(lines.join('\n'))
      expect(failures, lines.join('\n')).toBe(0)
    })
  }, 180_000)
})
