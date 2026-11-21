import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHTTPServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaybackMedia } from '@iyt-source/protocol'
import { createServer, type SourceServer } from '../src/index.ts'

let upstream: Server
let origin: string
let server: SourceServer
let data: string
let resolved: PlaybackMedia
let refused = 0

beforeAll(async () => {
  upstream = createHTTPServer((request, response) => {
    if (request.headers['x-token'] !== 'secret') {
      response.writeHead(403).end()
      return
    }
    if (request.url === '/v/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow/index.m3u8\n')
    } else if (request.url === '/v/low/index.m3u8') {
      response.writeHead(200, { 'content-type': 'application/x-mpegURL' })
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n')
    } else if (request.url === '/v/low/seg0.ts') {
      const body = Buffer.alloc(1000, 7)
      const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '')
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])]
        response.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': `bytes ${start}-${end}/1000`, 'content-length': String(end - start + 1) })
        response.end(body.subarray(start, end + 1))
      } else {
        response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': '1000' })
        response.end(body)
      }
    } else if (request.url === '/v/key') {
      response.writeHead(200).end(Buffer.alloc(16, 1))
    } else response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  data = mkdtempSync(join(tmpdir(), 'iyt-proxy-'))
  server = await createServer({
    name: 't',
    dataDir: data,
    sources: [{
      id: 'p',
      plugin: {
        info: { name: 'proxy' },
        detail: { detail: async () => { throw new Error('unused') } },
        playback: {
          async resolve(_request, ctx) {
            const url = ctx.media.proxy(`${origin}/v/master.m3u8`, { headers: { 'x-token': 'secret' } })
            // Without the header the upstream refuses (403): the source is told.
            const bad = ctx.media.proxy(`${origin}/v/master.m3u8`, { onRefused: () => { refused += 1 } })
            return { title: 't', streams: [{ id: 'a', url, format: 'hls', quality: { rank: 720, label: '720P' }, description: 'proxy' },
              { id: 'b', url: bad, format: 'hls', quality: { rank: 360, label: '360P' }, description: 'refused' }], selectedStream: 'a' }
          },
        },
      },
    }],
  })
  const response = await server.app.inject({ method: 'POST', url: '/iyt/v1/sources/p/playback/resolve', payload: { video: 'x' }, headers: { host: 'localhost' } })
  resolved = response.json()
})

afterAll(async () => {
  await server.close()
  upstream.close()
  rmSync(data, { recursive: true, force: true })
})

const fetchLocal = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } })

describe('media gateway proxy', () => {
  it('rewrites playlists so every address comes back through the gateway with the headers', async () => {
    const master = await fetchLocal(resolved.streams[0].url)
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl')
    const variant = master.body.split('\n').find((line) => line.startsWith('/iyt/v1/media/'))!
    expect(variant).toMatch(/\/c\/0\/index\.m3u8$/)

    const media = await fetchLocal(variant)
    expect(media.body).toMatch(/URI="\/iyt\/v1\/media\/[^"]+\/c\/1\/key"/)
    const segment = media.body.split('\n').find((line) => line.endsWith('seg0.ts'))!

    const ranged = await fetchLocal(segment, { range: 'bytes=10-19' })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 10-19/1000')
    expect(ranged.rawPayload.length).toBe(10)
  })

  it('tells the source when the upstream refuses an address', async () => {
    const answer = await fetchLocal(resolved.streams[1].url)
    expect(answer.json().error.code).toBe('unplayable')
    expect(refused).toBe(1)
  })

  it('answers 410 for an unknown token', async () => {
    const gone = await fetchLocal('/iyt/v1/media/nope/x.m3u8')
    expect(gone.statusCode).toBe(410)
    expect(gone.json().error.code).toBe('unplayable')
  })
})
