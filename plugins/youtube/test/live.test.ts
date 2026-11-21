// 联网测试：YOUTUBE_LIVE=1 pnpm test（平台请求和 yt-dlp 走 HTTPS_PROXY；yt-dlp 位置用 YTDLP_PATH）。
// 起一个带这个源的服务，用 iyt-source check 按 App 的顺序走一遍：首页、详情、解析、读流。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { createYouTubeSource } from '../src/index.ts'

describe.skipIf(process.env.YOUTUBE_LIVE !== '1')('YouTube live', () => {
  it('passes the conformance check signed out', async () => {
    if (process.env.HTTPS_PROXY) {
      const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('../../../node_modules/.pnpm/node_modules/undici/index.js')
      setGlobalDispatcher(new EnvHttpProxyAgent({ maxHeaderSize: 65536 }))
    }
    const data = mkdtempSync(join(tmpdir(), 'iyt-yt-live-'))
    const server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'youtube', plugin: createYouTubeSource() }] })
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const lines: string[] = []
    try {
      const failures = await check(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, (line) => lines.push(line))
      expect(failures, lines.join('\n')).toBe(0)
    } finally {
      await server.close()
      rmSync(data, { recursive: true, force: true })
    }
  }, 120_000)
})
