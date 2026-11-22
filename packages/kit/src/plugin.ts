import type {
  AccountState,
  ActionFeatures,
  Brand,
  Channel,
  Channels,
  CommentPage,
  CommentSort,
  CookieInput,
  Cue,
  Danmaku,
  EpisodeList,
  EpisodeRange,
  DrmEndpoints,
  DrmSystem,
  FairPlayEndpoints,
  FavoriteFolder,
  FeedPage,
  FilterCategory,
  FilterDimension,
  FilterSelection,
  HistoryPage,
  LinkResolution,
  LoginMethod,
  LoginStep,
  MediaItem,
  MediaItemPage,
  PlaybackMedia,
  Profile,
  ProgressRequest,
  ResolveRequest,
  ResumePoint,
  SearchRanking,
  SearchResults,
  SearchSuggestion,
  ShowDetail,
  SourceState,
  Target,
  UploaderPage,
  UploaderProfile,
  VideoActionState,
  WebLogin,
} from '@iyt-source/protocol'
import { BASE_PATH } from '@iyt-source/protocol'
import type { ExitPool } from './exits.ts'
import type { MediaGateway } from './media.ts'
import type { KeyValueStore } from './store.ts'
import type { YtDlp } from './ytdlp.ts'

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** 插件拿到的运行环境（SERVER.md §11.2）。 */
export interface Ctx {
  /** 全局唯一的源 id（配置里的 `id`）。 */
  sourceId: string
  /** 这个源专属的持久化存储：登录态、缓存。 */
  store: KeyValueStore
  /** 注册需要服务端提供的媒体（文件、代理、生成的播放列表），得到 App 能直接请求的地址。 */
  media: MediaGateway
  ytdlp: YtDlp
  /** 按用途的上游出口（SERVER.md §18）：平台按 IP 限流时换出口。没配时请求照旧走全局代理。 */
  exits: ExitPool
  log: Logger
  /** 请求被客户端取消时触发；插件发起的上游请求应带上它。 */
  signal: AbortSignal
}

export interface SourceInfo {
  name: string
  brand?: Brand
  /** 插件自己的资源文件（logo 等）：名字 → 本地路径，经 `/iyt/v1/sources/<id>/assets/<name>` 提供。 */
  assets?: Record<string, string>
  /** 当前状态；省略为 ready。 */
  status?(): { state: SourceState; message?: string }
}

export interface AccountModule {
  methods: LoginMethod[]
  requiredFor: 'nothing' | 'play' | 'browse'
  webLogin?: WebLogin
  /** 服务端当前持有的账号；未登录时 `{ loggedIn: false }`。 */
  state(ctx: Ctx): Promise<AccountState>
  /** `qr` / `deviceCode`：逐步产出登录步骤，`completed` 或 `failed` 结束。`ctx.signal` 在取消时触发。 */
  begin?(method: LoginMethod, ctx: Ctx): AsyncIterable<LoginStep>
  /** `webCookie`：用 App 网页登录得到的 cookie 登录。 */
  acceptCookies?(cookies: CookieInput[], userAgent: string | undefined, ctx: Ctx): Promise<Profile>
  logout(ctx: Ctx): Promise<void>
}

export interface FeedModule {
  homeShowsHistory?: boolean
  channelBrowser?: boolean
  channels(ctx: Ctx): Promise<Channels>
  channel(id: string, cursor: string | undefined, ctx: Ctx): Promise<FeedPage>
  more?(route: string, cursor: string | undefined, ctx: Ctx): Promise<MediaItemPage>
  subchannels?(id: string, ctx: Ctx): Promise<Channel[]>
  uploaders?(id: string, cursor: string | undefined, ctx: Ctx): Promise<UploaderPage>
}

export interface FilterModule {
  categories(ctx: Ctx): Promise<FilterCategory[]>
  dimensions(category: string, ctx: Ctx): Promise<FilterDimension[]>
  results(category: string, selection: FilterSelection, cursor: string | undefined, ctx: Ctx): Promise<MediaItemPage>
}

export interface SearchModule {
  prompt?: string
  rankings?(ctx: Ctx): Promise<SearchRanking[]>
  suggestions?(text: string, ctx: Ctx): Promise<SearchSuggestion[]>
  search(keyword: string, ctx: Ctx): Promise<SearchResults>
  videos?(keyword: string, cursor: string, ctx: Ctx): Promise<MediaItemPage>
}

export interface DetailModule {
  detail(target: Target, ctx: Ctx): Promise<ShowDetail>
  episodes?(cursor: string, ctx: Ctx): Promise<EpisodeList>
  recommendations?(cursor: string, ctx: Ctx): Promise<MediaItem[]>
  resume?(show: string | undefined, video: string | undefined, ctx: Ctx): Promise<ResumePoint | null>
  uploader?(id: string, ctx: Ctx): Promise<UploaderProfile | null>
  uploaderVideos?(id: string, ctx: Ctx): Promise<EpisodeList | null>
  uploaderCollections?(id: string, ctx: Ctx): Promise<EpisodeRange[]>
}

export interface ActionsModule {
  supports: ActionFeatures
  state(video: string, uploader: string | undefined, ctx: Ctx): Promise<VideoActionState>
  like?(video: string, value: boolean, ctx: Ctx): Promise<void>
  dislike?(video: string, value: boolean, ctx: Ctx): Promise<void>
  coins?(video: string, count: number, ctx: Ctx): Promise<void>
  favorites?(video: string, ctx: Ctx): Promise<FavoriteFolder[]>
  updateFavorites?(video: string, adding: string[], removing: string[], ctx: Ctx): Promise<void>
  follow?(uploader: string, value: boolean, ctx: Ctx): Promise<void>
}

export interface CommentsModule {
  first(video: string, sort: CommentSort, ctx: Ctx): Promise<CommentPage>
  page(cursor: string, ctx: Ctx): Promise<CommentPage>
}

export interface DanmakuModule {
  segmentDuration: number
  segment(video: string, segment: number, ctx: Ctx): Promise<Danmaku[]>
}

export interface HistoryModule {
  page(page: number, ctx: Ctx): Promise<HistoryPage>
  delete?(keys: string[], ctx: Ctx): Promise<void>
  clear?(ctx: Ctx): Promise<void>
}

/** 链接解析（SERVER.md §5.10）：`patterns` 写进 manifest，App 本地匹配后才调 `resolve`。 */
export interface LinksModule {
  patterns: string[]
  /** 认不出返回 null（App 当普通网页打开）。 */
  resolve(url: string, ctx: Ctx): Promise<LinkResolution | null>
}

/**
 * DRM 许可转发（SERVER.md §6.4）：解密在客户端做，服务端只按平台要求转发证书和许可请求，带上服务端持有的登录态。
 * `ref` 是插件在 `drmEndpoints` / `fairPlayEndpoints` 里给的不透明串（插件自己解释）；同一个 ref 可以用于几种 DRM。
 */
export interface DrmModule {
  /** 能转发的 DRM。 */
  systems: DrmSystem[]
  /** FairPlay 的证书原始字节（DER）。 */
  certificate?(system: DrmSystem, ref: string, ctx: Ctx): Promise<Uint8Array>
  /** 客户端发来的许可请求原始字节（FairPlay 的 SPC / Widevine 的 challenge）→ 平台给的许可原始字节（CKC / license）。 */
  license(system: DrmSystem, ref: string, request: Uint8Array, ctx: Ctx): Promise<Uint8Array>
}

/** 旧的 FairPlay 模块（只有 FairPlay 的插件仍可用它；新插件用 `drm`）。 */
export interface FairPlayModule {
  certificate(ref: string, ctx: Ctx): Promise<Uint8Array>
  license(ref: string, spc: Uint8Array, ctx: Ctx): Promise<Uint8Array>
}

export interface PlaybackModule {
  resolve(request: ResolveRequest, ctx: Ctx): Promise<PlaybackMedia>
  /** DRM 许可转发：manifest 的 `features.drm` 列出 `systems`；流用 `drmEndpoints` 带上 `drm` / `fairPlay`。 */
  drm?: DrmModule
  /** 旧的 FairPlay 模块，等于 `drm: { systems: ['fairplay'] }`。 */
  fairPlay?: FairPlayModule
  progress?(request: ProgressRequest, ctx: Ctx): Promise<void>
  /** `subtitles[].cues` 指向 `/iyt/v1/sources/<id>/subtitles/<ref>/<key>`，由这里给出原文。 */
  cues?(ref: string, key: string, ctx: Ctx): Promise<Cue[]>
}

/** 一个源（SERVER.md §11.2）。有哪些模块，就决定了 manifest 里的 `features`。 */
export interface SourcePlugin {
  info: SourceInfo
  account?: AccountModule
  feed?: FeedModule
  filter?: FilterModule
  search?: SearchModule
  detail: DetailModule
  actions?: ActionsModule
  comments?: CommentsModule
  danmaku?: DanmakuModule
  history?: HistoryModule
  playback: PlaybackModule
  links?: LinksModule
  /** 服务停止时调用。 */
  close?(): Promise<void>
}

/** 插件包的默认导出：按配置里的 `options` 创建一个源。 */
export type SourceFactory = (options: Record<string, unknown>, env: { dataDir: string; log: Logger }) => SourcePlugin | Promise<SourcePlugin>

/**
 * 流的 `fairPlay` 字段：这个源的证书和许可地址（服务端的路由，App 只当普通 URL 用）。`ref` 放在路径里，上限 2048 字符；
 * 平台的许可地址这类长串最好存进 `ctx.store`，`ref` 用短 id（优酷插件的做法）。
 */
export function fairPlayEndpoints(sourceId: string, ref: string): FairPlayEndpoints {
  const base = `${BASE_PATH}/sources/${sourceId}/fairplay/${encodeURIComponent(ref)}`
  return { certificate: `${base}/cert`, license: `${base}/license` }
}

/**
 * 一条加密流的 `drm`（和旧字段 `fairPlay`）：按 `systems` 给出各 DRM 的许可地址（服务端路由 `drm/<system>/<ref>/…`）。
 * 用法：`{ ...stream, ...drmEndpoints(ctx.sourceId, ref, ['fairplay', 'widevine']) }`。
 */
export function drmEndpoints(sourceId: string, ref: string, systems: DrmSystem[]): { drm: DrmEndpoints[]; fairPlay?: FairPlayEndpoints } {
  const base = (system: DrmSystem) => `${BASE_PATH}/sources/${sourceId}/drm/${system}/${encodeURIComponent(ref)}`
  const drm = systems.map((system): DrmEndpoints => system === 'fairplay'
    ? { system, certificate: `${base(system)}/cert`, license: `${base(system)}/license` }
    : { system, license: `${base(system)}/license` })
  const fairPlay = drm.find((d) => d.system === 'fairplay')
  return { drm, fairPlay: fairPlay ? { certificate: fairPlay.certificate!, license: fairPlay.license } : undefined }
}

/** 客户端能用的 DRM（`preferences.drm`）：缺省是旧 App，当 FairPlay。 */
export function clientDrm(request: { preferences?: { drm?: DrmSystem[] | null } }): DrmSystem[] {
  return request.preferences?.drm ?? ['fairplay']
}
