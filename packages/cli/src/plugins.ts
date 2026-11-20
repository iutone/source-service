import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Logger, SourceFactory, SourcePlugin } from '@iyt-source/kit'

/** 插件目录：`<数据目录>/plugins`，用 `iyt-source plugins add <包>` 装进去。 */
export const pluginsDir = (dataDir: string) => join(dataDir, 'plugins')

/** 先找数据目录里装的插件，再找随服务端带的（示例源 `@iyt-source/folder`）。 */
export async function loadPlugin(spec: string, options: Record<string, unknown>, env: { dataDir: string; log: Logger }): Promise<SourcePlugin> {
  let module: { default?: SourceFactory }
  if (isAbsolute(spec)) {
    // 本地目录：按它 package.json 的 exports["."] / main 找入口。
    let entry = spec
    if (statSync(spec).isDirectory()) {
      const manifest = join(spec, 'package.json')
      const pkg = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: { '.'?: string } | string; main?: string }) : {}
      const exported = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']
      entry = join(spec, exported ?? pkg.main ?? 'src/index.ts')
    }
    module = await import(pathToFileURL(entry).href)
  } else try {
    const require = createRequire(join(pluginsDir(env.dataDir), 'package.json'))
    module = await import(pathToFileURL(require.resolve(spec)).href)
  } catch {
    module = await import(spec)
  }
  if (typeof module.default !== 'function') throw new Error(`插件 ${spec} 没有默认导出的工厂函数`)
  return module.default(options, env)
}
