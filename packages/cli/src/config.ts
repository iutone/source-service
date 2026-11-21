import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

export interface SourceConfig {
  id: string
  plugin: string
  options?: Record<string, unknown>
}

export interface Config {
  name: string
  port: number
  host: string
  allowedHosts: string[]
  bonjour: boolean
  debug: boolean
  ytdlp?: { path?: string; update?: string[]; args?: string[] }
  /**
   * 按用途的上游代理出口（SERVER.md §18）：`pools` 里每个用途一组代理地址，按顺序用，被平台限流的冷却
   * `cooldownMinutes` 分钟后再用。
   */
  exits?: { cooldownMinutes?: number; pools?: Record<string, string[]> }
  sources: SourceConfig[]
  /** 配置文件所在目录之外的数据目录（server.json、各源存储、插件）。 */
  dataDir: string
}

export const DEFAULT_PORT = 8090

/**
 * 读配置（SERVER.md §14）。路径：`--config`，否则 `$IYT_CONFIG`，否则 `<数据目录>/config.yaml`；
 * 数据目录：`$IYT_DATA`，否则配置文件所在目录。没有配置文件就写一份空的（只有调试页）。
 */
export function loadConfig(path?: string): { config: Config; path: string; created: boolean } {
  const dataDir = process.env.IYT_DATA ? resolve(process.env.IYT_DATA) : undefined
  const file = resolve(path ?? process.env.IYT_CONFIG ?? join(dataDir ?? 'data', 'config.yaml'))
  let created = false
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stringify({
      name: hostname().replace(/\.local$/, ''),
      port: DEFAULT_PORT,
      sources: [],
    }))
    created = true
  }
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Partial<Config> & { dataDir?: string }
  const base = dirname(file)
  const config: Config = {
    name: raw.name || hostname().replace(/\.local$/, ''),
    port: Number(process.env.IYT_PORT ?? raw.port ?? DEFAULT_PORT),
    host: raw.host ?? '0.0.0.0',
    allowedHosts: raw.allowedHosts ?? [],
    bonjour: raw.bonjour ?? true,
    debug: raw.debug ?? true,
    ytdlp: raw.ytdlp,
    exits: raw.exits,
    sources: (raw.sources ?? []).map((source) => {
      if (!source?.id || !source?.plugin) throw new Error(`${file}：每个源都要有 id 和 plugin`)
      // 以 ./ ../ 开头的 plugin 是本地目录（相对配置文件）。
      const plugin = source.plugin.startsWith('./') || source.plugin.startsWith('../') ? resolve(base, source.plugin) : source.plugin
      return { id: source.id, plugin, options: resolvePaths(source.options ?? {}, base) }
    }),
    dataDir: dataDir ?? (raw.dataDir ? resolve(base, raw.dataDir) : base),
  }
  return { config, path: file, created }
}

/** 选项里以 `./` 开头的相对路径按配置文件所在目录解析。 */
function resolvePaths(options: Record<string, unknown>, base: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    out[key] = typeof value === 'string' && (value.startsWith('./') || value.startsWith('../')) && !isAbsolute(value) ? resolve(base, value) : value
  }
  return out
}
