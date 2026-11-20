import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  BASE_PATH,
  PROTOCOL_VERSION,
  type CommentSort,
  type CookieInput,
  type Features,
  type LoginMethod,
  type Manifest,
  type ProgressRequest,
  type LinkResolveRequest,
  type ResolveRequest,
  type SourceManifest,
  type Target,
} from '@iyt-source/protocol'
import { badRequest, notFound, SourceError, toSourceError } from './errors.ts'
import { isAllowedHost, isLocalAddress } from './lan.ts'
import { LoginSessions } from './login.ts'
import { MediaGateway, contentTypeOf, serveFile } from './media.ts'
import type { Ctx, Logger, SourcePlugin } from './plugin.ts'
import { RequestLog } from './requestLog.ts'
import { KeyValueStore } from './store.ts'
import { YtDlp } from './ytdlp.ts'
import { registerDebug } from './debug.ts'

export interface ServerOptions {
  name: string
  dataDir: string
  sources: { id: string; plugin: SourcePlugin }[]
  version?: string
  allowedHosts?: string[]
  ytdlp?: YtDlp
  /** 只接受局域网对端（SERVER.md §2.3）；测试里可关。 */
  localNetworkOnly?: boolean
  /** 调试页 `/debug`；默认开。 */
  debug?: boolean
  logger?: boolean
}

export interface SourceServer {
  app: FastifyInstance
  serverId: string
  media: MediaGateway
  requestLog: RequestLog
  /** 注册的全部路由（`GET /iyt/v1/...`），测试用。 */
  routes: string[]
  close(): Promise<void>
}

/** 读或生成持久化的 serverId（`<dataDir>/server.json`）。 */
export function loadServerId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, 'server.json')
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { id?: string }
    if (saved.id) return saved.id
  } catch {
    // 首次启动
  }
  const id = randomUUID()
  writeFileSync(path, JSON.stringify({ id }, null, 2))
  return id
}

const SOURCE_ID = /^[a-z0-9-]{1,24}$/

type TrackedRequest = FastifyRequest & { startedAt?: number; disconnect?: AbortController }

/** 客户端在响应写完之前断开时触发（`request.raw` 的 close 在请求体读完就会触发，不能用）。 */
function disconnectSignal(request: FastifyRequest): AbortSignal {
  return (request as TrackedRequest).disconnect?.signal ?? new AbortController().signal
}

export async function createServer(options: ServerOptions): Promise<SourceServer> {
  const serverId = loadServerId(options.dataDir)
  const ytdlp = options.ytdlp ?? new YtDlp()
  const media = new MediaGateway({ secret: serverId, persistent: new KeyValueStore(join(options.dataDir, 'media')) })
  const logins = new LoginSessions()
  const requestLog = new RequestLog()
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false, bodyLimit: 1 << 20, exposeHeadRoutes: false })

  const routes: string[] = []
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`)
  })

  const sources = new Map<string, { plugin: SourcePlugin; store: KeyValueStore; log: Logger }>()
  for (const { id, plugin } of options.sources) {
    if (!SOURCE_ID.test(id)) throw new Error(`源 id 只能是 [a-z0-9-]{1,24}：${id}`)
    if (sources.has(id)) throw new Error(`重复的源 id：${id}`)
    const child = app.log.child({ source: id })
    sources.set(id, {
      plugin,
      store: new KeyValueStore(join(options.dataDir, 'sources', id)),
      log: {
        info: (message, fields) => child.info(fields ?? {}, message),
        warn: (message, fields) => child.warn(fields ?? {}, message),
        error: (message, fields) => child.error(fields ?? {}, message),
      },
    })
  }

  // MARK: 局域网限制与日志

  app.addHook('onRequest', async (request, reply) => {
    const tracked = request as TrackedRequest
    tracked.startedAt = performance.now()
    const controller = new AbortController()
    tracked.disconnect = controller
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort()
    })
    if (options.localNetworkOnly !== false) {
      if (!isLocalAddress(request.socket.remoteAddress) || !isAllowedHost(request.headers.host, options.allowedHosts)) {
        reply.code(403).send({ error: { code: 'restricted', message: '只接受局域网内的请求', retryable: false } })
        return reply
      }
    }
  })

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/debug')) return
    const started = (request as TrackedRequest).startedAt ?? performance.now()
    const failure = (reply as FastifyReply & { sourceError?: SourceError }).sourceError
    requestLog.add({
      at: new Date().toISOString(),
      method: request.method,
      path: request.url.length > 300 ? `${request.url.slice(0, 300)}…` : request.url,
      status: reply.statusCode,
      ms: Math.round(performance.now() - started),
      errorCode: failure?.code,
      errorMessage: failure?.message,
      peer: request.socket.remoteAddress,
    })
  })

  app.setErrorHandler((error, request, reply) => {
    let failure: SourceError
    if (error instanceof SourceError) failure = error
    else if ((error as { validation?: unknown }).validation || (error as { statusCode?: number }).statusCode === 400) {
      failure = badRequest((error as Error).message)
    } else failure = toSourceError(error)
    if (failure.code === 'internal') request.log.error({ err: error }, 'internal error')
    ;(reply as FastifyReply & { sourceError?: SourceError }).sourceError = failure
    if (failure.retryAfter) reply.header('retry-after', String(failure.retryAfter))
    reply.code(failure.status).send(failure.body())
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(notFound('接口').body())
  })

  // MARK: 辅助

  function source(request: FastifyRequest) {
    const id = (request.params as { source: string }).source
    const entry = sources.get(id)
    if (!entry) throw notFound('源')
    return { id, ...entry }
  }

  function context(request: FastifyRequest, entry: ReturnType<typeof source>, signal?: AbortSignal): Ctx {
    return { sourceId: entry.id, store: entry.store, media, ytdlp, log: entry.log, signal: signal ?? disconnectSignal(request) }
  }

  const query = (request: FastifyRequest) => request.query as Record<string, string | undefined>
  const body = <T>(request: FastifyRequest) => (request.body ?? {}) as T

  function required(value: string | undefined, name: string): string {
    if (value === undefined || value === '') throw badRequest(`缺少参数 ${name}`)
    return value
  }

  function requiredModule<T>(module: T | undefined, what: string): T {
    if (!module) throw new SourceError('not_found', `这个源不提供${what}`)
    return module
  }

  function parseTarget(raw: string): Target {
    const colon = raw.indexOf(':')
    const kind = raw.slice(0, colon)
    const id = raw.slice(colon + 1)
    if (colon < 0 || id === '') throw badRequest('target 应为 show:<id> 或 video:<id>')
    if (kind === 'show') return { show: id }
    if (kind === 'video') return { video: id }
    throw badRequest('target 应为 show:<id> 或 video:<id>')
  }

  async function sourceManifest(id: string, entry: ReturnType<typeof source>, request: FastifyRequest): Promise<SourceManifest> {
    const { plugin } = entry
    const ctx = context(request, entry)
    let account: SourceManifest['account'] = { login: [], requiredFor: 'nothing', loggedIn: false }
    if (plugin.account) {
      let state: { loggedIn: boolean; profile?: SourceManifest['account']['profile'] } = { loggedIn: false }
      try {
        state = await plugin.account.state(ctx)
      } catch (error) {
        entry.log.warn('account state failed', { error: String(error) })
      }
      account = {
        login: plugin.account.methods,
        requiredFor: plugin.account.requiredFor,
        loggedIn: state.loggedIn,
        profile: state.profile,
        webLogin: plugin.account.webLogin,
      }
    }
    const brand = { ...plugin.info.brand }
    if (!brand.logo && plugin.info.assets?.logo) brand.logo = `${BASE_PATH}/sources/${id}/assets/logo`
    if (!brand.tabIcon && plugin.info.assets?.tabIcon) brand.tabIcon = `${BASE_PATH}/sources/${id}/assets/tabIcon`
    // 首页与置顶频道放进 manifest（§3.1）：App 打开这个源时就要，不能等 feed/channels。
    let layout: Pick<Features['feed'], 'home' | 'pinned'> = {}
    if (plugin.feed) {
      try {
        const channels = await plugin.feed.channels(ctx)
        layout = { home: channels.home, pinned: channels.pinned }
      } catch (error) {
        entry.log.warn('feed channels failed', { error: String(error) })
      }
    }
    const features: Features = {
      feed: { homeShowsHistory: plugin.feed?.homeShowsHistory ?? false, channelBrowser: plugin.feed?.channelBrowser ?? true, ...layout },
      filter: Boolean(plugin.filter),
      search: plugin.search
        ? {
            rankings: Boolean(plugin.search.rankings),
            suggestions: Boolean(plugin.search.suggestions),
            videos: Boolean(plugin.search.videos),
            prompt: plugin.search.prompt,
          }
        : null,
      detail: {
        comments: Boolean(plugin.comments),
        uploader: Boolean(plugin.detail.uploader),
        actions: plugin.actions?.supports ?? null,
      },
      history: plugin.history ? { read: true, delete: Boolean(plugin.history.delete) } : null,
      danmaku: plugin.danmaku ? { segmentDuration: plugin.danmaku.segmentDuration } : null,
      subtitles: Boolean(plugin.playback.cues),
      progress: Boolean(plugin.playback.progress),
      fairPlay: false,
    }
    return {
      id,
      name: plugin.info.name,
      brand,
      status: plugin.info.status?.() ?? { state: 'ready' },
      account,
      features,
      links: plugin.links && plugin.links.patterns.length > 0 ? { patterns: plugin.links.patterns } : undefined,
    }
  }

  async function manifest(request: FastifyRequest): Promise<Manifest> {
    const version = await ytdlp.version()
    return {
      protocol: PROTOCOL_VERSION,
      server: {
        id: serverId,
        name: options.name,
        version: options.version ?? '0.0.0',
        software: 'iyt-source-server',
        components: version ? { 'yt-dlp': version } : undefined,
      },
      sources: await Promise.all([...sources.keys()].map((id) => sourceManifest(id, { id, ...sources.get(id)! }, request))),
    }
  }

  // MARK: 路由

  const P = BASE_PATH
  const S = `${P}/sources/:source`

  app.get(`${P}/manifest`, async (request, reply) => {
    reply.header('cache-control', 'max-age=60')
    return manifest(request)
  })

  app.get(`${S}/assets/:name`, async (request, reply) => {
    const entry = source(request)
    const name = (request.params as { name: string }).name
    const path = entry.plugin.info.assets?.[name]
    if (!path) throw notFound('资源')
    reply.header('cache-control', 'max-age=86400')
    serveFile(path, contentTypeOf(path), request, reply)
    return reply
  })

  // 账号与登录（§5.1）
  app.get(`${S}/account`, async (request) => {
    const entry = source(request)
    if (!entry.plugin.account) return { loggedIn: false }
    return entry.plugin.account.state(context(request, entry))
  })

  app.post(`${S}/account/logout`, async (request, reply) => {
    const entry = source(request)
    await requiredModule(entry.plugin.account, '登录').logout(context(request, entry))
    reply.code(204)
  })

  app.post(`${S}/login/start`, async (request) => {
    const entry = source(request)
    const account = requiredModule(entry.plugin.account, '登录')
    const method = body<{ method?: LoginMethod }>(request).method ?? account.methods[0]
    if (!account.begin || !account.methods.includes(method) || method === 'webCookie') throw badRequest(`不支持的登录方式：${method}`)
    const begin = account.begin.bind(account)
    return logins.start(entry.id, (signal) => begin(method, context(request, entry, signal)))
  })

  app.get(`${S}/login/:loginId`, async (request) => {
    const entry = source(request)
    const { loginId } = request.params as { loginId: string }
    const q = query(request)
    return logins.wait(entry.id, loginId, Number(q.after ?? -1), Number(q.wait ?? 0), disconnectSignal(request))
  })

  app.post(`${S}/login/:loginId/cancel`, async (request, reply) => {
    const entry = source(request)
    logins.cancel((request.params as { loginId: string }).loginId, entry.id)
    reply.code(204)
  })

  app.post(`${S}/login/cookie`, async (request) => {
    const entry = source(request)
    const account = requiredModule(entry.plugin.account, '登录')
    if (!account.acceptCookies) throw badRequest('这个源不支持网页登录')
    const input = body<{ cookies?: CookieInput[]; userAgent?: string }>(request)
    if (!Array.isArray(input.cookies) || input.cookies.length === 0) throw badRequest('缺少 cookies')
    try {
      const profile = await account.acceptCookies(input.cookies, input.userAgent, context(request, entry))
      return { step: { kind: 'completed', profile } }
    } catch (error) {
      const failure = toSourceError(error)
      return { step: { kind: 'failed', message: failure.code === 'internal' ? '登录失败' : failure.message, restartable: true } }
    }
  })

  // 首页与频道（§5.2）
  app.get(`${S}/feed/channels`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.feed, '频道').channels(context(request, entry))
  })
  app.get(`${S}/feed/channel`, async (request) => {
    const entry = source(request)
    const q = query(request)
    return requiredModule(entry.plugin.feed, '频道').channel(required(q.id, 'id'), q.cursor, context(request, entry))
  })
  app.get(`${S}/feed/more`, async (request) => {
    const entry = source(request)
    const q = query(request)
    const feed = requiredModule(entry.plugin.feed, '频道')
    return requiredModule(feed.more?.bind(feed), '更多')(required(q.route, 'route'), q.cursor, context(request, entry))
  })
  app.get(`${S}/feed/subchannels`, async (request) => {
    const entry = source(request)
    const feed = requiredModule(entry.plugin.feed, '频道')
    return requiredModule(feed.subchannels?.bind(feed), '子频道')(required(query(request).id, 'id'), context(request, entry))
  })
  app.get(`${S}/feed/uploaders`, async (request) => {
    const entry = source(request)
    const q = query(request)
    const feed = requiredModule(entry.plugin.feed, '频道')
    return requiredModule(feed.uploaders?.bind(feed), '关注列表')(required(q.id, 'id'), q.cursor, context(request, entry))
  })

  // 筛选（§5.3）
  app.get(`${S}/filter/categories`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.filter, '筛选').categories(context(request, entry))
  })
  app.get(`${S}/filter/dimensions`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.filter, '筛选').dimensions(required(query(request).category, 'category'), context(request, entry))
  })
  app.get(`${S}/filter/results`, async (request) => {
    const entry = source(request)
    const q = query(request)
    let selection: Record<string, string> = {}
    if (q.selection) {
      try {
        selection = JSON.parse(q.selection) as Record<string, string>
      } catch {
        throw badRequest('selection 不是 JSON')
      }
    }
    return requiredModule(entry.plugin.filter, '筛选').results(required(q.category, 'category'), selection, q.cursor, context(request, entry))
  })

  // 搜索（§5.4）
  app.get(`${S}/search/rankings`, async (request) => {
    const entry = source(request)
    const search = requiredModule(entry.plugin.search, '搜索')
    return search.rankings ? search.rankings(context(request, entry)) : []
  })
  app.get(`${S}/search/suggestions`, async (request, reply) => {
    const entry = source(request)
    const search = requiredModule(entry.plugin.search, '搜索')
    reply.header('cache-control', 'max-age=300')
    const text = query(request).q ?? ''
    return search.suggestions && text.trim() ? search.suggestions(text, context(request, entry)) : []
  })
  app.get(`${S}/search`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.search, '搜索').search(required(query(request).q, 'q'), context(request, entry))
  })
  app.get(`${S}/search/videos`, async (request) => {
    const entry = source(request)
    const q = query(request)
    const search = requiredModule(entry.plugin.search, '搜索')
    if (!search.videos) return { items: [], next: null }
    return search.videos(required(q.q, 'q'), required(q.cursor, 'cursor'), context(request, entry))
  })

  // 详情（§5.5）
  app.get(`${S}/detail`, async (request) => {
    const entry = source(request)
    return entry.plugin.detail.detail(parseTarget(required(query(request).target, 'target')), context(request, entry))
  })
  app.get(`${S}/detail/episodes`, async (request) => {
    const entry = source(request)
    const detail = entry.plugin.detail
    return requiredModule(detail.episodes?.bind(detail), '分集')(required(query(request).cursor, 'cursor'), context(request, entry))
  })
  app.get(`${S}/detail/recommendations`, async (request) => {
    const entry = source(request)
    const detail = entry.plugin.detail
    return detail.recommendations ? detail.recommendations(required(query(request).cursor, 'cursor'), context(request, entry)) : []
  })
  app.get(`${S}/detail/resume`, async (request) => {
    const entry = source(request)
    const q = query(request)
    const detail = entry.plugin.detail
    return detail.resume ? detail.resume(q.show, q.video, context(request, entry)) : null
  })
  app.get(`${S}/uploader`, async (request) => {
    const entry = source(request)
    const detail = entry.plugin.detail
    const profile = detail.uploader ? await detail.uploader(required(query(request).id, 'id'), context(request, entry)) : null
    if (!profile) throw notFound('UP 主')
    return profile
  })
  app.get(`${S}/uploader/videos`, async (request) => {
    const entry = source(request)
    const detail = entry.plugin.detail
    return detail.uploaderVideos ? detail.uploaderVideos(required(query(request).id, 'id'), context(request, entry)) : null
  })
  app.get(`${S}/uploader/collections`, async (request) => {
    const entry = source(request)
    const detail = entry.plugin.detail
    return detail.uploaderCollections ? detail.uploaderCollections(required(query(request).id, 'id'), context(request, entry)) : []
  })

  // 互动（§5.6）
  app.get(`${S}/actions/state`, async (request) => {
    const entry = source(request)
    const q = query(request)
    return requiredModule(entry.plugin.actions, '互动').state(required(q.video, 'video'), q.uploader, context(request, entry))
  })
  for (const action of ['like', 'dislike'] as const) {
    app.post(`${S}/actions/${action}`, async (request, reply) => {
      const entry = source(request)
      const actions = requiredModule(entry.plugin.actions, '互动')
      const input = body<{ video?: string; value?: boolean }>(request)
      const run = requiredModule(actions[action]?.bind(actions), action)
      await run(required(input.video, 'video'), Boolean(input.value), context(request, entry))
      reply.code(204)
    })
  }
  app.post(`${S}/actions/coins`, async (request, reply) => {
    const entry = source(request)
    const actions = requiredModule(entry.plugin.actions, '互动')
    const input = body<{ video?: string; count?: number }>(request)
    await requiredModule(actions.coins?.bind(actions), '投币')(required(input.video, 'video'), Number(input.count ?? 1), context(request, entry))
    reply.code(204)
  })
  app.get(`${S}/actions/favorites`, async (request) => {
    const entry = source(request)
    const actions = requiredModule(entry.plugin.actions, '互动')
    return requiredModule(actions.favorites?.bind(actions), '收藏')(required(query(request).video, 'video'), context(request, entry))
  })
  app.post(`${S}/actions/favorites`, async (request, reply) => {
    const entry = source(request)
    const actions = requiredModule(entry.plugin.actions, '互动')
    const input = body<{ video?: string; adding?: string[]; removing?: string[] }>(request)
    await requiredModule(actions.updateFavorites?.bind(actions), '收藏')(required(input.video, 'video'), input.adding ?? [], input.removing ?? [], context(request, entry))
    reply.code(204)
  })
  app.post(`${S}/actions/follow`, async (request, reply) => {
    const entry = source(request)
    const actions = requiredModule(entry.plugin.actions, '互动')
    const input = body<{ uploader?: string; value?: boolean }>(request)
    await requiredModule(actions.follow?.bind(actions), '关注')(required(input.uploader, 'uploader'), Boolean(input.value), context(request, entry))
    reply.code(204)
  })

  // 评论（§5.7）
  app.get(`${S}/comments`, async (request) => {
    const entry = source(request)
    const q = query(request)
    const sort: CommentSort = q.sort === 'latest' ? 'latest' : 'hot'
    return requiredModule(entry.plugin.comments, '评论').first(required(q.video, 'video'), sort, context(request, entry))
  })
  app.get(`${S}/comments/page`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.comments, '评论').page(required(query(request).cursor, 'cursor'), context(request, entry))
  })

  // 弹幕（§5.8）
  app.get(`${S}/danmaku`, async (request) => {
    const entry = source(request)
    const q = query(request)
    return requiredModule(entry.plugin.danmaku, '弹幕').segment(required(q.video, 'video'), Number(required(q.segment, 'segment')), context(request, entry))
  })

  // 历史（§5.9）
  app.get(`${S}/history`, async (request) => {
    const entry = source(request)
    return requiredModule(entry.plugin.history, '观看历史').page(Math.max(1, Number(query(request).page ?? 1)), context(request, entry))
  })
  app.post(`${S}/history/delete`, async (request, reply) => {
    const entry = source(request)
    const history = requiredModule(entry.plugin.history, '观看历史')
    const keys = body<{ keys?: string[] }>(request).keys
    if (!Array.isArray(keys)) throw badRequest('缺少 keys')
    await requiredModule(history.delete?.bind(history), '删除历史')(keys, context(request, entry))
    reply.code(204)
  })
  app.post(`${S}/history/clear`, async (request, reply) => {
    const entry = source(request)
    const history = requiredModule(entry.plugin.history, '观看历史')
    await requiredModule(history.clear?.bind(history), '清空历史')(context(request, entry))
    reply.code(204)
  })

  // 播放（§6）
  app.post(`${S}/playback/resolve`, async (request, reply) => {
    const entry = source(request)
    const input = body<ResolveRequest>(request)
    required(input.video, 'video')
    reply.header('cache-control', 'no-store')
    const media = await entry.plugin.playback.resolve(input, context(request, entry))
    if (!media.streams.some((stream) => stream.id === media.selectedStream)) {
      throw new SourceError('internal', '解析结果里没有选中的流')
    }
    return media
  })
  app.post(`${S}/playback/progress`, async (request, reply) => {
    const entry = source(request)
    const input = body<ProgressRequest>(request)
    required(input.video, 'video')
    if (entry.plugin.playback.progress) await entry.plugin.playback.progress(input, context(request, entry))
    reply.code(204)
  })
  app.get(`${S}/subtitles/:ref/:key`, async (request) => {
    const entry = source(request)
    const { ref, key } = request.params as { ref: string; key: string }
    const playback = entry.plugin.playback
    return { cues: await requiredModule(playback.cues?.bind(playback), '字幕')(ref, key, context(request, entry)) }
  })

  // 链接解析（§5.10）
  app.post(`${S}/links/resolve`, async (request) => {
    const entry = source(request)
    const links = requiredModule(entry.plugin.links, '链接解析')
    const url = required(body<LinkResolveRequest>(request).url, 'url')
    const resolution = await links.resolve(url, context(request, entry))
    if (!resolution) throw notFound('链接')
    return resolution
  })

  // 媒体网关（§7）
  const mediaRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { token: string; '*': string }
    await media.handle(params.token, params['*'] ?? '', request, reply)
    return reply
  }
  app.get(`${P}/media/:token/*`, mediaRoute)
  app.head(`${P}/media/:token/*`, mediaRoute)

  if (options.debug !== false) registerDebug(app, { requestLog })

  return {
    app,
    serverId,
    media,
    requestLog,
    routes,
    async close() {
      media.close()
      await app.close()
      for (const { plugin } of sources.values()) await plugin.close?.()
    },
  }
}
