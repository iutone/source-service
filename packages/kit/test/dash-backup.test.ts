import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHTTPServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, fetchRangeFirst, type SourceServer } from '../src/index.ts'

// 备用 CDN：主地址坏了（503 / 403 / 连不上）时，网关读分段索引和转发分片都换下一个地址。
const hasFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0

let work: string
let upstream: Server
let origin: string
let server: SourceServer
let base: string
const hits: string[] = []

describe.skipIf(!hasFFmpeg)('DASH backup URLs', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'iyt-dash-backup-'))
    const src = join(work, 'src.mp4')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500',
      '-t', '6', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
    for (const [name, map] of [['v.mp4', '0:v'], ['a.mp4', '0:a']]) {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-i', src, '-map', map, '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '2000000', join(work, name)])
    }
    upstream = createHTTPServer((request, response) => {
      const [, folder, name] = (request.url ?? '').split('/')
      hits.push(`${folder}/${name}`)
      if (folder === 'down') return void response.writeHead(503).end()
      if (folder === 'denied') return void response.writeHead(403).end()
      const file = readFileSync(join(work, name))
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const end = Math.min(range?.[2] ? Number(range[2]) : file.byteLength - 1, file.byteLength - 1)
      response.writeHead(range ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${file.byteLength}` })
      response.end(file.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    server = await createServer({
      name: 't',
      dataDir: join(work, 'data'),
      sources: [{
        id: 'd',
        plugin: {
          info: { name: 'dash' },
          detail: { detail: async () => { throw new Error('unused') } },
          playback: {
            async resolve(_request, ctx) {
              const url = ctx.media.dash({
                videos: [{ url: `${origin}/down/v.mp4`, backupURLs: [`${origin}/denied/v.mp4`, `${origin}/ok/v.mp4`], codecs: 'avc1.64000d', bandwidth: 300_000 }],
                audios: [{ url: `${origin}/down/a.mp4`, backupURLs: [`${origin}/ok/a.mp4`], codecs: 'mp4a.40.2', bandwidth: 128_000, name: 'a' }],
              })
              return { title: 't', streams: [{ id: 'a', url, format: 'hls', quality: { rank: 180, label: '180P' }, description: 'dash' }], selectedStream: 'a' }
            },
          },
        },
      }],
    })
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    upstream?.close()
    rmSync(work, { recursive: true, force: true })
  })

  it('fetchRangeFirst 换到第一个能用的地址并记住它', async () => {
    const preferred = new Map<string, number>()
    const urls = [`${origin}/down/v.mp4`, `${origin}/ok/v.mp4`]
    const bytes = await fetchRangeFirst(urls, {}, 0, 7, undefined, preferred)
    expect(Buffer.from(bytes.subarray(4, 8)).toString()).toBe('ftyp')
    expect(preferred.get(urls[0])).toBe(1)
    await expect(fetchRangeFirst([`${origin}/down/v.mp4`], {}, 0, 7)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('读索引和取分片都换到备用地址', async () => {
    const resolved = await (await fetch(`${base}/iyt/v1/sources/d/playback/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ video: 'x' }) })).json() as { streams: { url: string }[] }
    const master = await (await fetch(base + resolved.streams[0].url)).text()
    const videoList = master.split('\n').find((line) => line.endsWith('/v/0.m3u8'))!
    const playlist = await (await fetch(base + videoList)).text()
    expect(playlist).toContain('#EXT-X-BYTERANGE')
    const [length, offset] = /#EXT-X-BYTERANGE:(\d+)@(\d+)/.exec(playlist)!.slice(1).map(Number)
    const segmentURL = playlist.split('\n').find((line) => line.startsWith('/iyt/v1/media/'))!
    hits.length = 0
    const segment = await fetch(base + segmentURL, { headers: { range: `bytes=${offset}-${offset + length - 1}` } })
    expect(segment.status).toBe(206)
    const body = Buffer.from(await segment.arrayBuffer())
    expect(body.subarray(4, 8).toString()).toBe('moof')
    // 读索引时已经知道主地址坏了：分片直接从好的地址取。
    expect(hits).toEqual(['ok/v.mp4'])
  })
})
