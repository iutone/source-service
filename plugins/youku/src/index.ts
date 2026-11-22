// IUTone 自建源：优酷。照 App 的 Core/Youku（MTOP 签名、Columbus 首页 / 详情、soku 搜索、弹幕、历史、UPS）移植；
// 账号和 ckey 由服务端持有：扫码（Havana 的优酷 App 扫码）或 App 的网页登录交来 cookie，ckey 用 node:vm 跑阿里的 collina.js 生成
// （ckey.ts）。播放给明文 HLS（CDN 直连）；优酷私有加密的清晰度在服务端解密、转封装成 fMP4 再经网关给（private.ts）。
// 随镜像发布在 /app/plugins/youku，默认不启用：在 config.yaml 的 sources 里按路径加上。
import { fileURLToPath } from 'node:url'
import type { Channel, Channels, PlaybackMedia, Stream } from '@iyt-source/protocol'
import type { J } from './json.ts'
import { SourceError, badRequest, fairPlayEndpoints, type Ctx, type SourceFactory, type SourcePlugin } from '@iyt-source/kit'
import { YoukuDetail } from './detail.ts'
import { FALLBACK_CHANNELS, FILTER_CATEGORIES, HOME_CHANNEL, PINNED_CHANNELS, YoukuFeed, YoukuFilter, channelFilterCategories } from './feed.ts'
import { YoukuHistory, fetchDanmaku } from './history.ts'
import { LINK_PATTERNS, resolveLink } from './links.ts'
import { UPSError, callUPS, checkUPS, isVip, languages, mediaFrom, mergeStreams, pickStreams, reportProgress, upsParameters, type RawStream } from './playback.ts'
import { CERTIFICATE_REQUEST, FairPlayRefs, fairPlayPlaylist, postLicense } from './fairplay.ts'
import { PrivateKeySession, PrivatePipeline, privateEngineAvailable } from './private.ts'
import { YoukuSearch } from './search.ts'
import { LOGIN_COOKIES, WEB_LOGIN_URL, YoukuSession, publicProfile, sleep } from './session.ts'

export interface YoukuOptions {
  name?: string
  /** 优酷私有加密 / HEVC TS 的清晰度在服务端解密、转封装（默认开）。关掉就只给明文流。 */
  privateStreams?: boolean
  /** FairPlay（cbcs）档：设备上解密，服务端只转发许可（默认开）。 */
  fairPlay?: boolean
  /** 声明 H.265（私有流开着时）：有 4K、更省流量，但转封装更吃 CPU。默认开。 */
  hevc?: boolean
}

const CHANNELS_TTL = 3600_000
const SEARCH_TTL = 10 * 60_000

interface UPSAnswer {
  data: J
  keySession?: PrivateKeySession
  /** 这次请求声明了 FairPlay。 */
  declared: boolean
}

const factory: SourceFactory = (options, env) => createYoukuSource(options as YoukuOptions, env)
export default factory

export function createYoukuSource(options: YoukuOptions = {}, env?: { dataDir: string; log: Ctx['log'] }): SourcePlugin {
  const session = new YoukuSession()
  const utdid = () => session.ensureCna()
  const feed = new YoukuFeed(session.mtop, utdid)
  const filter = new YoukuFilter(session.mtop, utdid)
  const search = new YoukuSearch(session.mtop, utdid)
  const detail = new YoukuDetail(session.mtop, utdid)
  const history = new YoukuHistory(session.mtop, async (signal) => {
    if (!session.loggedIn) throw new SourceError('login_required', '登录优酷后才能看观看历史')
    const cna = await session.ensureCna(signal)
    return { uid: (session.profile ?? (await session.refreshProfile())).id, cna }
  })
  const useFairPlay = options.fairPlay !== false
  let certificate: { at: number; bytes: Buffer } | undefined
  const refs = new FairPlayRefs()
  const usePrivate = options.privateStreams !== false && privateEngineAvailable()
  const pipeline = usePrivate ? new PrivatePipeline(env?.log) : undefined
  let channelsCache: { at: number; channels: Channel[] } | undefined
  let channelsTask: Promise<Channel[]> | undefined
  const searchCache = new Map<string, { at: number; value: Promise<unknown> }>()

  /** 每个请求先挂上存储（第一次从 ctx.store 读回登录）。 */
  let warmed = false
  const use = (ctx: Ctx) => {
    session.attach(ctx)
    refs.attach(ctx.store)
    if (!warmed) {
      // 生成 ckey 要取两个脚本再跑一遍（几秒）：服务第一次被访问时就在后台做，不等到第一次播放。
      warmed = true
      void session.ckey(ctx).catch((error) => ctx.log.warn('youku ckey warm-up failed', { error: String(error) }))
    }
    return session
  }

  function cached<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
    const hit = searchCache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>
    const value = make()
    searchCache.set(key, { at: Date.now(), value })
    value.catch(() => { if (searchCache.get(key)?.value === value) searchCache.delete(key) })
    if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value!)
    return value
  }

  async function channelList(ctx: Ctx): Promise<Channel[]> {
    if (channelsCache && Date.now() - channelsCache.at < CHANNELS_TTL) return channelsCache.channels
    channelsTask ??= feed.channels(ctx.signal).then((list) => {
      const channels = list.length ? list : FALLBACK_CHANNELS
      channelsCache = { at: Date.now(), channels }
      return channels
    }).finally(() => { channelsTask = undefined })
    try {
      // manifest 每次都要频道（首页、置顶）：第一次取得慢就先给内置的列表，取到的留给下次。
      const timeout = new Promise<undefined>((resolve) => (setTimeout(resolve, 2500) as unknown as NodeJS.Timeout).unref())
      return (await Promise.race([channelsTask, timeout])) ?? channelsCache?.channels ?? FALLBACK_CHANNELS
    } catch (error) {
      if (ctx.signal.aborted) throw error
      ctx.log.warn('youku channels failed', { error: String(error) })
      return channelsCache?.channels ?? FALLBACK_CHANNELS
    }
  }

  // MARK: 播放

  /** 一次 UPS：私有流开着时带上这次的私有会话。 */
  async function ups(video: string, ckey: string, ctx: Ctx): Promise<UPSAnswer & { fairPlay?: UPSAnswer }> {
    const cna = await session.ensureCna(ctx.signal)
    const once = async (fairPlay: boolean): Promise<UPSAnswer> => {
      const keySession = pipeline ? new PrivateKeySession() : undefined
      const data = await callUPS(session.mtop, upsParameters({
        vid: video, ckey, utid: cna, privateClient: keySession?.client, hevc: options.hevc !== false, fairPlay,
      }), ctx.signal)
      checkUPS(data)
      return { data, keySession, declared: fairPlay }
    }
    // 声明了 FairPlay，UPS 只给 cbcs（和会员的私有流），明文档就没了：两种各问一次，合在一起按清晰度排（FAIRPLAY.md §6 的 A + B）。
    const [plain, fairPlay] = await Promise.allSettled([once(false), useFairPlay ? once(true) : Promise.reject(new Error('off'))])
    if (plain.status === 'fulfilled') {
      if (fairPlay.status === 'rejected' && useFairPlay && !ctx.signal.aborted) ctx.log.warn('youku fairplay ups failed', { error: String(fairPlay.reason) })
      return { ...plain.value, fairPlay: fairPlay.status === 'fulfilled' ? fairPlay.value : undefined }
    }
    // 只有 FairPlay 版本的片子（-4008）等：明文那次失败、FairPlay 那次成功就用它。ckey 的问题照样交给重试。
    const reason = plain.reason
    if (fairPlay.status === 'fulfilled' && !(reason instanceof UPSError && (reason.upsCode === -6004 || reason.upsCode === -6005))) return fairPlay.value
    throw reason
  }

  /**
   * App 的取流重试：ckey 被拒（-6004）换新的再试一次。「需要登录」（-6005）对热门片子也可能是 ckey 还没被认：刚生成的 ckey
   * 在新设备上大约 20 秒后才过，旧的先换成新的；还是不行才算真要登录。
   */
  async function upsWithRetry(video: string, ctx: Ctx) {
    let ckey = await session.ckey(ctx)
    try {
      return await ups(video, ckey, ctx)
    } catch (error) {
      if (!(error instanceof UPSError)) throw error
      if (error.upsCode === -6004) {
        session.dropCkey()
        ckey = await session.ckey(ctx, true)
        try {
          return await ups(video, ckey, ctx)
        } catch (again) {
          if (again instanceof UPSError && again.upsCode === -6004) {
            session.dropCkey()
            throw new SourceError('unavailable', '优酷不认服务端生成的播放密钥（ckey），请稍后再试', { retryable: true })
          }
          throw again
        }
      }
      if (error.upsCode !== -6005) throw error
    }
    // -6005：先确保 ckey 是新的，再等它被认。
    const fresh = (session.ckeyAge ?? Infinity) < 60_000
    if (!fresh) {
      ckey = await session.ckey(ctx, true)
      try {
        return await ups(video, ckey, ctx)
      } catch (error) {
        if (!(error instanceof UPSError) || error.upsCode !== -6005) throw error
      }
    }
    for (const delay of [3, 5, 7, 7, 8]) {
      await sleep(delay * 1000, ctx.signal)
      try {
        return await ups(video, ckey, ctx)
      } catch (error) {
        if (!(error instanceof UPSError) || error.upsCode !== -6005) throw error
      }
    }
    if (!session.loggedIn) throw new SourceError('login_required', '登录优酷后才能观看这个视频')
    throw new SourceError('restricted', '优酷说要登录才能看，但已经登录了：账号可能失效，或这个视频不让网页端播放')
  }

  function toStream(raw: RawStream, names: Map<string, string>, multi: boolean, ctx: Ctx): Stream {
    const language = multi ? { code: raw.languageCode, name: names.get(raw.languageCode) ?? raw.languageCode } : undefined
    let url = raw.url
    let description = `${raw.streamType} ${raw.drm} ${raw.height}p`
    if (raw.path === 'fairplay' && raw.licenseURL) {
      return {
        id: raw.id,
        // 补上 key 标签的播放列表经网关给；有效期跟 UPS 地址的（5 小时）。
        url: fairPlayPlaylist(ctx.media, raw.url, 5 * 3600),
        format: 'hls',
        quality: raw.quality,
        language,
        description: `${description} fairplay`,
        fairPlay: fairPlayEndpoints(ctx.sourceId, refs.register(raw.licenseURL)),
        // 加密的，缓存了也放不出来。
        keepable: false,
      }
    }
    if ((raw.path === 'private' || raw.path === 'remux') && pipeline) {
      url = pipeline.register(raw.url, raw.key, ctx)
      description += raw.path === 'private' ? ' decrypted' : ' remuxed'
    }
    return {
      id: raw.id,
      url,
      format: 'hls',
      quality: raw.quality,
      language,
      description,
      unavailableReason: raw.path === 'unsupported' ? raw.reason : undefined,
      // 私有流是服务端一片一片解出来的，缓存会把整集一口气拉一遍：只让明文的缓存。
      keepable: raw.path === 'direct',
    }
  }

  return {
    info: {
      name: options.name ?? '优酷',
      brand: { tint: '#0099FF', tabIconIsWordmark: false },
      assets: {
        logo: fileURLToPath(new URL('../assets/logo.png', import.meta.url)),
        // App 内置的优酷首页标签图标（@3x），按模板图渲染。
        tabIcon: fileURLToPath(new URL('../assets/tab.png', import.meta.url)),
      },
    },

    account: {
      // 电视上只能扫码；网页登录给 iPhone / iPad / Mac。
      methods: ['qr', 'webCookie'],
      requiredFor: 'browse',
      webLogin: { url: WEB_LOGIN_URL, doneWhen: { cookie: LOGIN_COOKIES[0], domain: '.youku.com' }, userAgent: 'mobile' },
      async state(ctx) {
        use(ctx)
        if (!session.loggedIn) return { loggedIn: false }
        try {
          return { loggedIn: true, profile: publicProfile(await session.refreshProfile()) }
        } catch (error) {
          if (error instanceof SourceError && error.code === 'login_required') return { loggedIn: false }
          // 读不到账号（网络）不算退出。
          return { loggedIn: true, profile: session.profile ? publicProfile(session.profile) : undefined }
        }
      },
      begin(method, ctx) {
        use(ctx)
        if (method !== 'qr') throw badRequest('优酷只支持扫码和网页登录')
        return session.qrLogin(ctx)
      },
      async acceptCookies(cookies, _userAgent, ctx) {
        use(ctx)
        return publicProfile(await session.acceptCookies(cookies, ctx))
      },
      async logout(ctx) {
        use(ctx).logout()
        searchCache.clear()
      },
    },

    feed: {
      homeShowsHistory: true,
      channelBrowser: true,
      async channels(ctx): Promise<Channels> {
        use(ctx)
        const channels = (await channelList(ctx)).map((channel) => {
          const categories = channelFilterCategories(channel)
          return categories ? { ...channel, filterCategories: categories } : channel
        })
        return { home: HOME_CHANNEL, pinned: PINNED_CHANNELS, channels, library: [] }
      },
      async channel(id, cursor, ctx) {
        use(ctx)
        return feed.channel(id, cursor, ctx.signal)
      },
      async more(route, cursor, ctx) {
        use(ctx)
        return feed.more(route, cursor, ctx.signal)
      },
    },

    filter: {
      async categories() {
        return FILTER_CATEGORIES
      },
      async dimensions(category, ctx) {
        use(ctx)
        return cached(`filter:${category}`, CHANNELS_TTL, () => filter.dimensions(category, ctx.signal))
      },
      async results(category, selection, cursor, ctx) {
        use(ctx)
        return filter.results(category, selection, cursor, ctx.signal)
      },
    },

    search: {
      prompt: '搜索优酷',
      async rankings(ctx) {
        use(ctx)
        return cached('rankings', SEARCH_TTL, () => search.rankings(ctx.signal))
      },
      async suggestions(text, ctx) {
        use(ctx)
        return cached(`sug:${text.trim()}`, SEARCH_TTL, () => search.suggestions(text, ctx.signal))
      },
      async search(keyword, ctx) {
        use(ctx)
        // 结果接口限流（一阵子连续搜就要验证码）：同一个词缓存一会儿。
        return cached(`q:${keyword.trim()}`, SEARCH_TTL, () => search.search(keyword, ctx.signal))
      },
    },

    detail: {
      async detail(target, ctx) {
        use(ctx)
        return detail.detail(target, ctx.signal)
      },
      async episodes(cursor, ctx) {
        use(ctx)
        return detail.episodes(cursor, ctx.signal)
      },
      async recommendations(cursor, ctx) {
        use(ctx)
        return detail.recommendations(cursor, ctx.signal)
      },
      /** 详情只说续播哪一集（登录时），不说看到哪：看历史第一页里这部剧（或这个 UP 主视频）的那条。 */
      async resume(show, video, ctx) {
        use(ctx)
        if (!session.loggedIn) return null
        try {
          const page = await history.page(1, ctx.signal)
          const entry = page.items.find((item) => (show ? item.showID === show : item.id === video))
          return entry ? { videoID: entry.id, progress: entry.progress } : null
        } catch (error) {
          if (ctx.signal.aborted) throw error
          return null
        }
      },
    },

    comments: {
      async first(video, sort, ctx) {
        use(ctx)
        return detail.comments(video, sort, ctx.signal)
      },
      async page(cursor, ctx) {
        use(ctx)
        return detail.commentsAt(cursor, ctx.signal)
      },
    },

    danmaku: {
      segmentDuration: 60,
      async segment(video, segment, ctx) {
        use(ctx)
        return fetchDanmaku(session.mtop, video, segment, await session.ensureCna(ctx.signal), ctx.signal)
      },
    },

    history: {
      async page(page, ctx) {
        use(ctx)
        return history.page(page, ctx.signal)
      },
      async delete(keys, ctx) {
        use(ctx)
        await history.delete(keys, ctx.signal)
      },
      async clear(ctx) {
        use(ctx)
        await history.clear(ctx.signal)
      },
    },

    links: {
      patterns: LINK_PATTERNS,
      async resolve(url, ctx) {
        return resolveLink(url, ctx.signal)
      },
    },

    playback: {
      async resolve(request, ctx): Promise<PlaybackMedia> {
        use(ctx)
        const { data, keySession, declared, fairPlay } = await upsWithRetry(request.video, ctx)
        const canProcess = Boolean(pipeline)
        const log = (m: string) => ctx.log.warn(m)
        const raw = mergeStreams([
          pickStreams(data, { privateClient: keySession, canProcess, fairPlay: declared, log }),
          fairPlay ? pickStreams(fairPlay.data, { privateClient: fairPlay.keySession, canProcess, fairPlay: true, log }) : [],
        ], canProcess)
        const { multi, names } = languages(data)
        const streams = raw.map((s) => toStream(s, names, multi, ctx))
        const counts = raw.reduce<Record<string, number>>((acc, s) => ((acc[s.path] = (acc[s.path] ?? 0) + 1), acc), {})
        return mediaFrom(data, request.video, streams, request.preferences, {
          paths: Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(','),
          ckeyAge: String(Math.round((session.ckeyAge ?? 0) / 1000)),
          loggedIn: String(session.loggedIn),
          // UPS 认出的会员身份：登录了却是 false 就是 cookie 没带对。
          vip: String(isVip(data)),
        }, raw.map((s) => s.url))
      },
      fairPlay: useFairPlay ? {
        async certificate(ref, ctx) {
          // 证书（Apple 签给优酷的那张）不随片子变：缓存半天。
          use(ctx)
          const url = refs.resolve(ref)
          if (!certificate || Date.now() - certificate.at > 12 * 3600_000) {
            certificate = { at: Date.now(), bytes: await postLicense(url, CERTIFICATE_REQUEST, ctx.signal) }
          }
          return certificate.bytes
        },
        async license(ref, spc, ctx) {
          use(ctx)
          return postLicense(refs.resolve(ref), Buffer.from(spc).toString('base64'), ctx.signal)
        },
      } : undefined,
      async progress(request, ctx) {
        use(ctx)
        // 没登录时优酷不记历史，也就不报。
        if (!session.loggedIn) return
        await reportProgress(session.mtop, request, await session.ensureCna(ctx.signal), ctx.signal)
      },
    },

    async close() {
      pipeline?.close()
    },
  }
}
