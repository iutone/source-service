#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { advertise, createServer, YtDlp, type Logger } from '@iyt-source/kit'
import { check } from './check.ts'
import { loadConfig } from './config.ts'
import { loadPlugin, pluginsDir } from './plugins.ts'

const here = dirname(fileURLToPath(import.meta.url))
const version = (JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8')) as { version: string }).version

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function serve(args: string[]) {
  // 平台请求走环境里的代理（HTTPS_PROXY / NO_PROXY）；局域网与媒体网关的上游也一样遵守 NO_PROXY。
  // 响应头上限放到 64 KB：youtube.com/tv 的 Set-Cookie 超过 Node 默认的 16 KB。
  const maxHeaderSize = 64 * 1024
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  setGlobalDispatcher(proxied ? new EnvHttpProxyAgent({ maxHeaderSize }) : new Agent({ maxHeaderSize }))
  const { config, path, created } = loadConfig(option(args, '--config'))
  const log: Logger = {
    info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
    warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
    error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
  }
  if (created) log.info(`写了一份空配置：${path}，在 sources 里加源后重启`)
  const sources = []
  for (const source of config.sources) {
    try {
      sources.push({ id: source.id, plugin: await loadPlugin(source.plugin, source.options ?? {}, { dataDir: config.dataDir, log }) })
    } catch (error) {
      log.error(`源 ${source.id}（${source.plugin}）加载失败`, { error: String(error) })
    }
  }
  const ytdlp = new YtDlp({ binary: config.ytdlp?.path, updateCommand: config.ytdlp?.update, args: config.ytdlp?.args })
  const server = await createServer({
    name: config.name,
    dataDir: config.dataDir,
    sources,
    version,
    allowedHosts: config.allowedHosts,
    ytdlp,
    debug: config.debug,
    localNetworkOnly: process.env.IYT_ALLOW_ANY_PEER !== '1',
    logger: process.env.IYT_LOG_REQUESTS === '1',
  })
  await server.app.listen({ port: config.port, host: config.host })
  const bonjour = config.bonjour
    ? advertise({
        name: config.name,
        port: config.port,
        serverId: server.serverId,
        onError: (error) => log.warn('Bonjour 广播出错，10 秒后重新广播', { error: String(error) }),
      })
    : undefined
  log.info(`「${config.name}」已启动`, {
    port: config.port,
    serverId: server.serverId,
    sources: sources.map((s) => s.id),
    debug: config.debug ? `http://<本机局域网地址>:${config.port}/debug` : undefined,
    ytdlp: await ytdlp.version() ?? '未安装',
  })
  // yt-dlp 失效很快：每天更新一次（SERVER.md §12.4）。
  const updater = ytdlp.canUpdate ? setInterval(() => {
    void ytdlp.update().then(async (updated) => {
      if (updated) log.info('yt-dlp 已更新', { version: await ytdlp.version() })
    })
  }, 24 * 3600_000) : undefined
  updater?.unref()
  const stop = async () => {
    if (updater) clearInterval(updater)
    await bonjour?.stop()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function plugins(args: string[]) {
  const [action, spec] = args
  const { config } = loadConfig(option(args, '--config'))
  const directory = pluginsDir(config.dataDir)
  if (action !== 'add' || !spec) {
    console.log('用法：iyt-source plugins add <npm 包名或 git 地址> [--config <路径>]')
    process.exit(1)
  }
  mkdirSync(directory, { recursive: true })
  if (!existsSync(join(directory, 'package.json'))) writeFileSync(join(directory, 'package.json'), '{ "private": true }\n')
  execFileSync('npm', ['install', '--prefix', directory, spec], { stdio: 'inherit' })
  console.log(`已装到 ${directory}。在配置的 sources 里用它的包名作为 plugin，然后重启。`)
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'serve':
    await serve(rest)
    break
  case 'check': {
    const url = rest[0]
    if (!url) {
      console.log('用法：iyt-source check http://<地址>:<端口>')
      process.exit(1)
    }
    process.exit((await check(url)) ? 1 : 0)
    break
  }
  case 'plugins':
    await plugins(rest)
    break
  case '--version':
  case 'version':
    console.log(version)
    break
  default:
    console.log(`iyt-source ${version}

  serve [--config <路径>]       启动服务（默认 ./data/config.yaml，或 $IYT_CONFIG）
  check <地址>                  按 App 的方式走一遍接口，检查一致性
  plugins add <包> [--config]   把第三方源装进数据目录`)
}
