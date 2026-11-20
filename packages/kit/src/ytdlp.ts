import { spawn } from 'node:child_process'
import { SourceError } from './errors.ts'

export interface YtDlpOptions {
  /** 可执行文件，默认 `yt-dlp`（环境变量 `YTDLP_PATH` 优先）。 */
  binary?: string
  concurrency?: number
  timeoutMs?: number
  /** 更新命令，如 `["/opt/venv/bin/pip", "install", "-U", "yt-dlp"]`（或环境变量 `YTDLP_UPDATE`，空格分隔）；不配就不更新。 */
  updateCommand?: string[]
}

interface Cached {
  value: unknown
  expires: number
}

/** yt-dlp 子进程包装（SERVER.md §12.4）：限并发、超时、按 URL + 参数缓存、失败后可触发更新。 */
export class YtDlp {
  private readonly binary: string
  private readonly concurrency: number
  private readonly timeoutMs: number
  private readonly updateCommand?: string[]
  private running = 0
  private readonly waiting: (() => void)[] = []
  private readonly cache = new Map<string, Cached>()
  private cachedVersion?: string
  private lastUpdate = 0

  constructor(options: YtDlpOptions = {}) {
    this.binary = process.env.YTDLP_PATH || options.binary || 'yt-dlp'
    this.concurrency = options.concurrency ?? 4
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.updateCommand = options.updateCommand ?? process.env.YTDLP_UPDATE?.split(' ').filter(Boolean)
  }

  /** 版本号；没装时 `undefined`。 */
  async version(): Promise<string | undefined> {
    if (this.cachedVersion) return this.cachedVersion
    try {
      const { stdout } = await this.run(['--version'], 5_000)
      this.cachedVersion = stdout.trim()
      return this.cachedVersion
    } catch {
      return undefined
    }
  }

  /**
   * `yt-dlp -J` 的结果。失败时抛 `upstream_changed`（解析失败，可能该更新了）或 `unavailable`（没装 / 超时）。
   * - Parameter cacheMs: 结果缓存多久；0 不缓存。
   */
  async extract<T = Record<string, unknown>>(url: string, args: string[] = [], options: { signal?: AbortSignal; cacheMs?: number } = {}): Promise<T> {
    const key = JSON.stringify([url, args])
    const hit = this.cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.value as T
    await this.acquire()
    try {
      const { stdout } = await this.run(['-J', '--no-warnings', '--no-playlist', ...args, url], this.timeoutMs, options.signal)
      const value = JSON.parse(stdout) as T
      if (options.cacheMs) this.cache.set(key, { value, expires: Date.now() + options.cacheMs })
      return value
    } finally {
      this.release()
    }
  }

  get canUpdate(): boolean {
    return Boolean(this.updateCommand?.length)
  }

  /** 跑一次更新命令（至少间隔 10 分钟）；返回是否真的跑了且成功。 */
  async update(): Promise<boolean> {
    if (!this.updateCommand || Date.now() - this.lastUpdate < 10 * 60_000) return false
    this.lastUpdate = Date.now()
    const [command, ...args] = this.updateCommand
    try {
      await this.run(args, 120_000, undefined, command)
      this.cachedVersion = undefined
      this.cache.clear()
      return true
    } catch {
      return false
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(() => { this.running++; resolve() }))
  }

  private release(): void {
    this.running--
    this.waiting.shift()?.()
  }

  private run(args: string[], timeoutMs: number, signal?: AbortSignal, command = this.binary): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      }
      const onAbort = () => {
        child.kill('SIGKILL')
        finish(new SourceError('unavailable', '已取消', { retryable: true }))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new SourceError('unavailable', '解析超时', { retryable: true }))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => finish(new SourceError('unavailable', `没有找到 ${command}`, { cause: error })))
      child.on('close', (code) => {
        if (code === 0) return finish()
        const message = Buffer.concat(stderr).toString('utf8').trim().split('\n').pop() ?? ''
        finish(classify(message))
      })
    })
  }
}

/** 把 yt-dlp 的错误行映射成协议错误码。 */
export function classify(message: string): SourceError {
  const text = message.replace(/^ERROR:\s*/, '')
  if (/sign in|login|members-only|age/i.test(text)) return new SourceError('login_required', '需要登录后观看', { cause: text })
  if (/private|removed|unavailable|not available|terminated|deleted/i.test(text)) return new SourceError('unplayable', '视频不可播放', { cause: text })
  if (/429|too many requests|rate/i.test(text)) return new SourceError('throttled', '请求太频繁，请稍后再试', { cause: text })
  if (/geo|country|region/i.test(text)) return new SourceError('restricted', '所在地区不可播放', { cause: text })
  return new SourceError('upstream_changed', '解析失败，可能需要更新', { cause: text })
}
