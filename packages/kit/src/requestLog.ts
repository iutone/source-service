/** 最近的请求，供调试页查看（不属于协议）。 */
export interface RequestRecord {
  at: string
  method: string
  path: string
  status: number
  ms: number
  errorCode?: string
  errorMessage?: string
  peer?: string
}

export class RequestLog {
  private readonly records: RequestRecord[] = []
  private readonly limit: number

  constructor(limit = 300) {
    this.limit = limit
  }

  add(record: RequestRecord): void {
    this.records.push(record)
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit)
  }

  recent(): RequestRecord[] {
    return [...this.records].reverse()
  }
}
