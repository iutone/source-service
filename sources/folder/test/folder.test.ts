import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Channels, FeedPage, Manifest, MediaItemPage, PlaybackMedia, ShowDetail } from '@iyt-source/protocol'
import { createServer, type SourceServer } from '@iyt-source/kit'
import { createFolderSource } from '../src/index.ts'
import { stageOf } from '../src/library.ts'
import { parseSubtitles, toWebVTT } from '../src/subtitles.ts'

let root: string
let data: string
let server: SourceServer

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iyt-folder-'))
  data = mkdtempSync(join(tmpdir(), 'iyt-data-'))
  const show = join(root, '电视剧', '示例剧')
  mkdirSync(join(show, 'Season 1'), { recursive: true })
  writeFileSync(join(show, 'Season 1', 'S01E01.mp4'), Buffer.alloc(4096, 1))
  writeFileSync(join(show, 'Season 1', 'S01E02.mp4'), Buffer.alloc(4096, 2))
  writeFileSync(join(show, 'Season 1', 'S01E01.zh.srt'), '1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>世界</i>\n')
  writeFileSync(join(show, 'tvshow.nfo'), '<tvshow><title>示例剧集</title><plot>一个示例。</plot><year>2026</year><genre>剧情</genre></tvshow>')
  writeFileSync(join(show, 'poster.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  mkdirSync(join(root, '电影'))
  writeFileSync(join(root, '电影', '某电影.mov'), Buffer.alloc(2048, 3))
  writeFileSync(join(root, '电影', '不能播.mkv'), Buffer.alloc(16))
  writeFileSync(join(root, '.hidden.mp4'), Buffer.alloc(16))
  server = await createServer({ name: '测试', dataDir: data, sources: [{ id: 'videos', plugin: createFolderSource({ path: root }) }] })
})

afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

async function get<T>(url: string, init: { method?: 'GET' | 'POST' | 'HEAD'; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await server.app.inject({
    method: init.method ?? 'GET',
    url,
    payload: init.body as object | undefined,
    headers: { host: '192.168.1.20:8090', ...init.headers },
  })
  return { status: response.statusCode, headers: response.headers, body: (response.body && response.headers['content-type']?.toString().includes('json') ? JSON.parse(response.body) : response.body) as T }
}

const S = '/iyt/v1/sources/videos'

describe('folder source over the protocol', () => {
  it('describes itself in the manifest', async () => {
    const { body } = await get<Manifest>('/iyt/v1/manifest')
    expect(body.protocol).toBe(1)
    expect(body.server.id).toMatch(/[0-9a-f-]{36}/)
    const source = body.sources[0]
    expect(source.id).toBe('videos')
    expect(source.account).toEqual({ login: [], requiredFor: 'nothing', loggedIn: false })
    expect(source.features).toMatchObject({ filter: false, subtitles: true, progress: true, history: { read: true, delete: true }, danmaku: null })
  })

  it('lists channels and a home page', async () => {
    const channels = (await get<Channels>(`${S}/feed/channels`)).body
    expect(channels.channels.map((c) => c.title)).toEqual(['电视剧', '电影'])
    const home = (await get<FeedPage>(`${S}/feed/channel?id=home`)).body
    expect(home.sections.map((s) => s.title)).toEqual(['最近添加', '电视剧', '电影'])
    const show = home.sections[1].items[0]
    expect(show).toMatchObject({ title: '示例剧集', caption: '2 集', target: { show: expect.any(String) } })
    expect(show.posterURL).toMatch(/^\/iyt\/v1\/media\/.+\/poster\.jpg$/)
  })

  it('gives a show’s detail and plays an episode with range requests', async () => {
    const home = (await get<FeedPage>(`${S}/feed/channel?id=home`)).body
    const showID = (home.sections[1].items[0].target as { show: string }).show
    const detail = (await get<ShowDetail>(`${S}/detail?target=show:${showID}`)).body
    expect(detail).toMatchObject({ kind: 'series', title: '示例剧集', summary: '一个示例。', attributes: '2026 · 剧情' })
    expect(detail.episodes!.episodes.map((e) => e.stage)).toEqual(['1', '2'])

    const media = (await get<PlaybackMedia>(`${S}/playback/resolve`, { method: 'POST', body: { video: detail.defaultVideoID } })).body
    expect(media.streams[0]).toMatchObject({ id: 'file', format: 'mp4' })
    expect(media.subtitles?.[0]).toMatchObject({ key: 'zh', name: '中文', language: 'zh' })

    const ranged = await get<string>(media.streams[0].url, { headers: { range: 'bytes=0-99' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 0-99/4096')
    const head = await get<string>(media.streams[0].url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('4096')

    const vtt = await get<string>(media.subtitles![0].vtt!)
    expect(vtt.body.startsWith('WEBVTT')).toBe(true)
    const cues = (await get<{ cues: unknown[] }>(media.subtitles![0].cues!)).body.cues
    expect(cues).toEqual([{ start: 1, end: 2.5, text: '你好' }, { start: 3, end: 4, text: '世界' }])
  })

  it('records progress as continue watching and history', async () => {
    const home = (await get<FeedPage>(`${S}/feed/channel?id=home`)).body
    const showID = (home.sections[1].items[0].target as { show: string }).show
    const detail = (await get<ShowDetail>(`${S}/detail?target=show:${showID}`)).body
    const video = detail.episodes!.episodes[1].id
    const progress = await get(`${S}/playback/progress`, { method: 'POST', body: { event: 'progress', video, position: 30, duration: 100 } })
    expect(progress.status).toBe(204)

    const again = (await get<ShowDetail>(`${S}/detail?target=show:${showID}`)).body
    expect(again.resume).toEqual({ videoID: video, progress: 0.3 })
    expect(again.defaultVideoID).toBe(video)
    const resumed = (await get<PlaybackMedia>(`${S}/playback/resolve`, { method: 'POST', body: { video } })).body
    expect(resumed.startPosition).toBe(30)
    const newHome = (await get<FeedPage>(`${S}/feed/channel?id=home`)).body
    expect(newHome.sections[0]).toMatchObject({ id: 'continue', style: 'continueWatching' })

    const history = (await get<{ items: { historyKey: string }[] }>(`${S}/history?page=1`)).body
    expect(history.items).toHaveLength(1)
    await get(`${S}/history/delete`, { method: 'POST', body: { keys: [history.items[0].historyKey] } })
    expect((await get<{ items: unknown[] }>(`${S}/history?page=1`)).body.items).toHaveLength(0)
  })

  it('answers errors in the protocol’s shape', async () => {
    const unsupported = (await get<MediaItemPage>(`${S}/feed/more?route=${encodeURIComponent((await get<Channels>(`${S}/feed/channels`)).body.channels[1].id)}`)).body
    const mkv = unsupported.items.find((item) => item.title === '不能播')!
    const refused = await get<{ error: { code: string } }>(`${S}/playback/resolve`, { method: 'POST', body: { video: (mkv.target as { video: string }).video } })
    expect(refused.status).toBe(410)
    expect(refused.body.error.code).toBe('unplayable')

    const traversal = await get<{ error: { code: string } }>(`${S}/playback/resolve`, { method: 'POST', body: { video: Buffer.from('../etc/passwd').toString('base64url') } })
    expect(traversal.body.error.code).toBe('bad_request')
    expect((await get<{ error: { code: string } }>(`${S}/nothing`)).status).toBe(404)
    expect((await get<{ error: { code: string } }>('/iyt/v1/sources/missing/feed/channels')).body.error.code).toBe('not_found')
  })

  it('refuses a host name that could be DNS rebinding', async () => {
    const refused = await get('/iyt/v1/manifest', { headers: { host: 'attacker.example.com' } })
    expect(refused.status).toBe(403)
  })

  it('serves the debug page', async () => {
    const page = await get<string>('/debug')
    expect(page.status).toBe(200)
    expect(page.body).toContain('自建源')
    const qr = await get<string>('/debug/api/qr?text=hello')
    expect(qr.body).toContain('<svg')
  })
})

describe('helpers', () => {
  it('reads episode numbers from names', () => {
    expect(stageOf('Show.S02E07.1080p', 1)).toBe('7')
    expect(stageOf('第12集 标题', 1)).toBe('12')
    expect(stageOf('03 开场', 9)).toBe('3')
    expect(stageOf('花絮', 4)).toBe('4')
  })

  it('reads SRT and WebVTT', () => {
    expect(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\nhi')).toEqual([{ start: 1, end: 2, text: 'hi' }])
    expect(toWebVTT('1\n00:00:01,000 --> 00:00:02,000\nhi')).toContain('00:00:01.000 --> 00:00:02.000')
  })
})
