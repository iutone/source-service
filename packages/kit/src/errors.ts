import { ERROR_STATUS, type ErrorBody, type ErrorCode } from '@iyt-source/protocol'

/** 源插件抛出的、给用户看的错误（SERVER.md §2.2）。其他异常一律当作 `internal`。 */
export class SourceError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  /** 429 时的 Retry-After 秒数。 */
  readonly retryAfter?: number

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; retryAfter?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'SourceError'
    this.code = code
    this.retryable = options.retryable ?? (code === 'unavailable' || code === 'throttled' || code === 'upstream_changed')
    this.retryAfter = options.retryAfter
  }

  get status(): number {
    return ERROR_STATUS[this.code]
  }

  body(): ErrorBody {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } }
  }
}

export function toSourceError(error: unknown): SourceError {
  if (error instanceof SourceError) return error
  return new SourceError('internal', '服务内部错误', { cause: error, retryable: false })
}

export const notFound = (what = '内容') => new SourceError('not_found', `找不到这个${what}`)
export const badRequest = (message: string) => new SourceError('bad_request', message)
