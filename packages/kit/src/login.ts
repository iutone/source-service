import { randomBytes } from 'node:crypto'
import type { LoginState, LoginStep } from '@iyt-source/protocol'
import { SourceError } from './errors.ts'

interface Session {
  id: string
  sourceId: string
  seq: number
  step: LoginStep
  controller: AbortController
  waiters: Set<() => void>
  finished: boolean
  expires: number
}

const IDLE_LIFETIME = 15 * 60_000

/**
 * 登录会话（SERVER.md §5.1）：插件产出的步骤在后台推进，App 用 `after=<seq>` 长轮询下一个。
 * 插件拿到的 signal 在取消或会话过期时触发，不随某次 HTTP 请求结束。
 */
export class LoginSessions {
  private readonly sessions = new Map<string, Session>()

  start(sourceId: string, run: (signal: AbortSignal) => AsyncIterable<LoginStep>): LoginState {
    for (const session of this.sessions.values()) {
      // 同一个源同时只有一个登录。
      if (session.sourceId === sourceId && !session.finished) this.cancel(session.id)
    }
    this.sweep()
    const session: Session = {
      id: randomBytes(9).toString('base64url'),
      sourceId,
      seq: 0,
      step: { kind: 'waiting', message: '正在准备登录' },
      controller: new AbortController(),
      waiters: new Set(),
      finished: false,
      expires: Date.now() + IDLE_LIFETIME,
    }
    this.sessions.set(session.id, session)
    void this.pump(session, run(session.controller.signal))
    return this.state(session)
  }

  /** 等到 `seq > after` 或超时，返回当前状态。 */
  async wait(sourceId: string, loginId: string, after: number, waitSeconds: number, signal: AbortSignal): Promise<LoginState> {
    const session = this.session(sourceId, loginId)
    session.expires = Date.now() + IDLE_LIFETIME
    if (session.seq > after || session.finished || waitSeconds <= 0) return this.state(session)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        session.waiters.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(waitSeconds, 30) * 1000)
      session.waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
    return this.state(session)
  }

  cancel(loginId: string, sourceId?: string): void {
    const session = this.sessions.get(loginId)
    if (!session || (sourceId && session.sourceId !== sourceId)) return
    session.controller.abort()
    if (!session.finished) this.update(session, { kind: 'failed', message: '已取消', restartable: true }, true)
  }

  private session(sourceId: string, loginId: string): Session {
    const session = this.sessions.get(loginId)
    if (!session || session.sourceId !== sourceId) throw new SourceError('not_found', '登录已结束，请重新开始')
    return session
  }

  private async pump(session: Session, steps: AsyncIterable<LoginStep>): Promise<void> {
    try {
      for await (const step of steps) {
        if (session.finished) return
        const final = step.kind === 'completed' || step.kind === 'failed'
        this.update(session, step, final)
        if (final) return
      }
      if (!session.finished) this.update(session, { kind: 'failed', message: '登录没有完成', restartable: true }, true)
    } catch (error) {
      if (session.finished) return
      const message = error instanceof SourceError ? error.message : '登录失败'
      this.update(session, { kind: 'failed', message, restartable: true }, true)
    }
  }

  private update(session: Session, step: LoginStep, final: boolean): void {
    session.seq++
    session.step = step
    session.finished = final
    for (const waiter of [...session.waiters]) waiter()
  }

  private state(session: Session): LoginState {
    return { loginId: session.id, seq: session.seq, step: session.step }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.expires < now) {
        session.controller.abort()
        this.sessions.delete(id)
      }
    }
  }
}
