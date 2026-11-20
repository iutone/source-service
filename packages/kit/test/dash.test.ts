import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer as createHTTPServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { byteRangePlaylist, createServer, readSegmentIndex, type SourceServer } from '../src/index.ts'

// 用 ffmpeg 现做两条和 YouTube 一样的单文件轨道（init 段后一个全局 sidx），没有 ffmpeg 就跳过。
const hasFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const hasFFprobe = spawnSync('ffprobe', ['-version']).status === 0

let work: string
let upstream: Server
let origin: string
let server: SourceServer
let base: string
const requests: string[] = []

describe.skipIf(!hasFFmpeg)('DASH single-file tracks as HLS', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'iyt-dash-'))
    const src = join(work, 'src.mp4')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500',
      '-t', '12', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
    for (const [name, map] of [['v.mp4', '0:v'], ['a.mp4', '0:a']]) {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-i', src, '-map', map, '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '2000000', join(work, name)])
    }
    upstream = createHTTPServer((request, response) => {
      requests.push(`${request.url} ${request.headers.range ?? ''}`)
      const path = join(work, (request.url ?? '').slice(1))
      const size = statSync(path).size
      const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1)
        response.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' })
        createReadStream(path, { start, end }).pipe(response)
      } else {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(size) })
        createReadStream(path).pipe(response)
      }
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
            async resolve(request, ctx) {
              const url = ctx.media.dash(
                {
                  videos: [{ url: `${origin}/v.mp4`, codecs: 'avc1.64001e', bandwidth: 900_000, width: 640, height: 360, frameRate: 25 }],
                  audios: [{ url: `${origin}/a.mp4`, codecs: 'mp4a.40.2', bandwidth: 128_000, language: 'en', name: 'English' }],
                },
                { via: request.video === 'direct' ? 'direct' : 'proxy' },
              )
              return { title: 't', streams: [{ id: 'a', url, format: 'hls', quality: { rank: 360, label: '360P' }, description: 'dash' }], selectedStream: 'a' }
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

  const resolve = async (video: string) => {
    const response = await fetch(`${base}/iyt/v1/sources/d/playback/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ video }) })
    return (await response.json()) as { streams: { url: string }[] }
  }

  it('reads the segment index that covers the whole file', async () => {
    const file = readFileSync(join(work, 'v.mp4'))
    const index = await readSegmentIndex(async (start, end) => file.subarray(start, end + 1))
    expect(index.segments.length).toBe(6)
    const last = index.segments.at(-1)!
    // 文件尾可能还有 mfra，最后一段结束不超过文件。
    expect(last.offset + last.length).toBeLessThanOrEqual(file.byteLength)
    expect(file.subarray(index.segments[0].offset + 4, index.segments[0].offset + 8).toString()).toBe('moof')
    expect(index.segments.reduce((sum, s) => sum + s.duration, 0)).toBeCloseTo(12, 0)
    expect(byteRangePlaylist('/x.mp4', index)).toContain(`#EXT-X-MAP:URI="/x.mp4",BYTERANGE="${index.initLength}@0"`)
  })

  it('serves a master with audio apart and byte-range media playlists', async () => {
    const media = await resolve('proxy')
    const master = await (await fetch(`${base}${media.streams[0].url}`)).text()
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES')
    expect(master).toContain('CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=25.000,AUDIO="audio"')
    const videoPlaylist = master.split('\n').find((line) => line.endsWith('/v/0.m3u8'))!
    const playlist = await (await fetch(`${base}${videoPlaylist}`)).text()
    expect(playlist.match(/#EXT-X-BYTERANGE/g)).toHaveLength(6)
    expect(playlist).toMatch(/\/iyt\/v1\/media\/[^/]+\/c\/0\/video\.mp4/)
    const direct = await resolve('direct')
    const directMaster = await (await fetch(`${base}${direct.streams[0].url}`)).text()
    const directVideo = await (await fetch(`${base}${directMaster.split('\n').find((line) => line.endsWith('/v/0.m3u8'))}`)).text()
    expect(directVideo).toContain(`${origin}/v.mp4`)
  })

  it.skipIf(!hasFFprobe)('plays through the gateway (ffprobe reads both tracks)', async () => {
    const media = await resolve('proxy')
    // 异步跑：服务就在这个进程里，同步调用会把它堵死。
    const { stdout: output } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', `${base}${media.streams[0].url}`], { encoding: 'utf8', timeout: 20_000 })
    const probe = JSON.parse(output) as { streams: { codec_type: string }[]; format: { duration: string } }
    expect(probe.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video'])
    expect(Number(probe.format.duration)).toBeGreaterThan(11)
  }, 30_000)
})
