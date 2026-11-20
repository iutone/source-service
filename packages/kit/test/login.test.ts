import { describe, expect, it } from 'vitest'
import type { LoginStep } from '@iyt-source/protocol'
import { LoginSessions } from '../src/login.ts'

const never = new AbortController().signal

describe('LoginSessions', () => {
  it('long-polls each step in order', async () => {
    const sessions = new LoginSessions()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const start = sessions.start('yt', async function* (): AsyncIterable<LoginStep> {
      yield { kind: 'showCode', content: 'https://example.com/device?code=AB', title: '扫码', message: '输入 AB' }
      await gate
      yield { kind: 'completed', profile: { name: 'Alice' } }
    })
    const first = await sessions.wait('yt', start.loginId, start.seq, 1, never)
    expect(first.step.kind).toBe('showCode')
    const pending = sessions.wait('yt', start.loginId, first.seq, 5, never)
    release()
    const done = await pending
    expect(done.step).toEqual({ kind: 'completed', profile: { name: 'Alice' } })
  })

  it('turns errors and cancellation into failed steps', async () => {
    const sessions = new LoginSessions()
    const failing = sessions.start('a', async function* (): AsyncIterable<LoginStep> {
      throw new Error('boom')
    })
    const failed = await sessions.wait('a', failing.loginId, failing.seq, 1, never)
    expect(failed.step.kind).toBe('failed')

    let aborted = false
    const slow = sessions.start('b', async function* (signal): AsyncIterable<LoginStep> {
      signal.addEventListener('abort', () => { aborted = true })
      yield { kind: 'waiting', message: '…' }
      await new Promise(() => {})
    })
    sessions.cancel(slow.loginId, 'b')
    const cancelled = await sessions.wait('b', slow.loginId, 0, 1, never)
    expect(cancelled.step).toMatchObject({ kind: 'failed', message: '已取消' })
    expect(aborted).toBe(true)
  })

  it('refuses another source’s login id', async () => {
    const sessions = new LoginSessions()
    const state = sessions.start('a', async function* (): AsyncIterable<LoginStep> { yield { kind: 'waiting', message: '' } })
    await expect(sessions.wait('b', state.loginId, 0, 0, never)).rejects.toMatchObject({ code: 'not_found' })
  })
})
