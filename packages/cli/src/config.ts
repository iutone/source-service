import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isMap, isSeq, parse, parseDocument, stringify } from 'yaml'
import type { SourceVisibility } from '@iyt-source/protocol'

const VISIBILITIES: SourceVisibility[] = ['auto', 'discoverable', 'hidden']

export interface SourceConfig {
  id: string
  plugin: string
  /** 在 App 里怎么出现：auto 直接列出 / discoverable 可添加（默认）/ hidden 不列出（SERVER.md §3.4）。 */
  visibility?: SourceVisibility
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
      if (source.visibility !== undefined && !VISIBILITIES.includes(source.visibility)) {
        throw new Error(`${file}：源 ${source.id} 的 visibility 只能是 ${VISIBILITIES.join(' / ')}`)
      }
      return { id: source.id, plugin, visibility: source.visibility, options: resolvePaths(source.options ?? {}, base) }
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

/**
 * 把一个源的展示策略写回配置文件（调试页改的，SERVER.md §3.2）。用 yaml 的文档模型改，注释和格式保留；
 * 默认值 `discoverable` 不写，删掉这一项。
 */
export function saveVisibility(file: string, id: string, visibility: SourceVisibility): void {
  const document = parseDocument(readFileSync(file, 'utf8'))
  const sources = document.get('sources')
  if (!isSeq(sources)) throw new Error(`${file} 里没有 sources`)
  const entry = sources.items.find((item) => isMap(item) && item.get('id') === id)
  if (!isMap(entry)) throw new Error(`${file} 里没有源 ${id}`)
  if (visibility === 'discoverable') entry.delete('visibility')
  else entry.set('visibility', visibility)
  writeFileSync(file, document.toString())
}
