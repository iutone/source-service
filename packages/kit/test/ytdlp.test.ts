import { describe, expect, it } from 'vitest'
import { classify } from '../src/ytdlp.ts'

describe('classify yt-dlp errors', () => {
  it.each([
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'login_required'],
    ['ERROR: [youtube] abc: Join this channel to get access to members-only content like this video', 'login_required'],
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", 'login_required'],
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', 'login_required'],
    ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'unplayable'],
    ['ERROR: [youtube] abc: The uploader has not made this video available in your country', 'restricted'],
    ['ERROR: [youtube] abc: Unable to download webpage: HTTP Error 429: Too Many Requests', 'throttled'],
    ['ERROR: [youtube] abc: Unable to download webpage: <urlopen error timed out>', 'unavailable'],
    ['ERROR: [youtube] abc: Unable to extract nsig function', 'upstream_changed'],
  ])('%s → %s', (line, code) => {
    expect(classify(line).code).toBe(code)
  })
})

describe('yt-dlp version', () => {
  it('peekVersion does not wait, probes once in the background', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { YtDlp } = await import('../src/ytdlp.ts')
    const dir = mkdtempSync(join(tmpdir(), 'ytdlp-'))
    const bin = join(dir, 'yt-dlp')
    const counter = join(dir, 'count')
    // 假的 yt-dlp：启动慢 300 ms，记录被调用的次数。
    writeFileSync(bin, `#!/bin/sh\necho x >> ${counter}\nsleep 0.3\necho 2026.11.01\n`)
    chmodSync(bin, 0o755)
    const ytdlp = new YtDlp({ binary: bin })
    const started = Date.now()
    expect(ytdlp.peekVersion()).toBeUndefined()
    expect(ytdlp.peekVersion()).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(100)
    expect(await ytdlp.version()).toBe('2026.11.01')
    expect(ytdlp.peekVersion()).toBe('2026.11.01')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
