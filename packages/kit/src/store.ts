import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一个源专属的持久化存储：`<dataDir>/sources/<id>/<key>.json`，原子写入，权限 600（存登录态）。 */
export class KeyValueStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  private path(key: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error(`invalid store key: ${key}`)
    return join(this.directory, `${key}.json`)
  }

  get<T>(key: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.path(key), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  set(key: string, value: unknown): void {
    const path = this.path(key)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  }

  delete(key: string): void {
    this.set(key, null)
  }
}
