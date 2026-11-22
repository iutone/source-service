// 联网测试：TED_LIVE=1 pnpm test（直连 ted.com，国内可用）。起一个带这个源的服务，用 iyt-source check 按 App 的顺序走一遍。
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from '@iyt-source/kit'
import { check } from '../../../packages/cli/src/check.ts'
import { createTEDSource } from '../src/index.ts'

describe.skipIf(process.env.TED_LIVE !== '1')('TED live', () => {
  it('passes the conformance check', async () => {
    const data = mkdtempSync(join(tmpdir(), 'iyt-ted-live-'))
    const server = await createServer({ name: 'live', dataDir: data, sources: [{ id: 'ted', plugin: createTEDSource() }] })
    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const lines: string[] = []
    try {
      const failures = await check(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, (line) => lines.push(line))
      console.log(lines.join('\n'))
      expect(failures, lines.join('\n')).toBe(0)
    } finally {
      await server.close()
      rmSync(data, { recursive: true, force: true })
    }
  }, 120_000)
})
