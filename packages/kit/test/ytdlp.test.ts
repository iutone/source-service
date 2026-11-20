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
