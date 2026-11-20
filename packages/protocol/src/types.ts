// IUTone 自建源接口规范 v1 的数据模型（docs/remote-source/SERVER.md §3–§6）。
// 字段名与 App 的 VideoSourceAPI 模型一一对应；可选字段可省略。时间是 ISO 8601 字符串，时长是秒，颜色是 #RRGGBB。
// URL 可以是绝对地址，或相对服务基础地址的路径（"/iyt/v1/..."）。游标（cursor / route）对 App 不透明。

export const PROTOCOL_VERSION = 1
export const BASE_PATH = '/iyt/v1'
export const BONJOUR_TYPE = 'iyt-source'

export type URLString = string
export type DateString = string
export type Cursor = string

// MARK: 错误（§2.2）

export type ErrorCode =
  | 'login_required'
  | 'restricted'
  | 'unplayable'
  | 'not_found'
  | 'throttled'
  | 'upstream_changed'
  | 'unavailable'
  | 'bad_request'
  | 'internal'

export const ERROR_STATUS: Record<ErrorCode, number> = {
  login_required: 401,
  restricted: 403,
  unplayable: 410,
  not_found: 404,
  throttled: 429,
  upstream_changed: 502,
  unavailable: 503,
  bad_request: 400,
  internal: 500,
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean }
}

// MARK: Manifest（§3）

export interface Manifest {
  protocol: number
  /** 低于这个版本的 App 应提示升级。 */
  minApp?: string
  server: ServerInfo
  sources: SourceManifest[]
}

export interface ServerInfo {
  id: string
  name: string
  version: string
  software: string
  /** 依赖组件的版本，如 { "yt-dlp": "2026.11.10" }。 */
  components?: Record<string, string>
}

export interface Brand {
  /** 彩色 logo，PNG，正方形，≥ 256 px。 */
  logo?: URLString
  /** 首页 tab 图标，透明底单色 PNG，按模板图渲染。 */
  tabIcon?: URLString
  tabIconIsWordmark?: boolean
  tint?: string
}

export type SourceState = 'ready' | 'starting' | 'degraded' | 'broken'

export type LoginMethod = 'qr' | 'deviceCode' | 'webCookie'

export interface Membership {
  tier: string
  active: boolean
  endsAt?: DateString
}

export interface Profile {
  name: string
  avatarURL?: URLString
  membership?: Membership
}

export interface WebLogin {
  url: URLString
  doneWhen: { cookie: string; domain: string }
  userAgent?: 'mobile' | 'desktop'
}

export interface AccountManifest {
  /** 按优先级排列；空数组表示这个源不需要登录。 */
  login: LoginMethod[]
  requiredFor: 'nothing' | 'play' | 'browse'
  loggedIn: boolean
  profile?: Profile
  webLogin?: WebLogin
}

export interface ActionFeatures {
  like: boolean
  dislike: boolean
  coins: boolean
  favorite: boolean
  follow: boolean
}

export interface Features {
  feed: FeedFeatures
  filter: boolean
  search: { rankings: boolean; suggestions: boolean; videos: boolean; prompt?: string } | null
  detail: { comments: boolean; uploader: boolean; actions: ActionFeatures | null }
  history: { read: boolean; delete: boolean } | null
  danmaku: { segmentDuration: number } | null
  subtitles: boolean
  progress: boolean
  fairPlay: boolean
}

/**
 * 首页与置顶频道（§3.1）：App 打开这个源时就要用，所以放在 manifest 里，而不是等 `feed/channels`。
 * 有 feed 模块的源一定给出 `home`；它们可能随登录状态变（YouTube 登录后首页是订阅）。
 */
export interface FeedFeatures {
  homeShowsHistory: boolean
  channelBrowser: boolean
  /** 首页频道：`feed/channel?id=` 用它的 id。 */
  home?: Channel
  /** 默认置顶为标签的频道（TV），用户没改过置顶时用。 */
  pinned?: Channel[]
}

export interface SourceManifest {
  id: string
  name: string
  brand: Brand
  status: { state: SourceState; message?: string }
  account: AccountManifest
  features: Features
  /** 这个源认得的链接（§5.10）；没有就不接粘贴的链接。 */
  links?: LinkPatterns
}

// MARK: 链接解析（§5.10）

export interface LinkPatterns {
  /** 正则（ICU / JavaScript 共有的子集），匹配整个链接（含 scheme）；任一个匹配，App 才把链接交给这个源。 */
  patterns: string[]
}

export interface LinkResolveRequest {
  url: string
}

/** `links/resolve` 的响应：链接指向的节目或视频。认不出返回 404 `not_found`。 */
export interface LinkResolution {
  target: Target
  /** 给「打开了什么」的提示用。 */
  title?: string
}

// MARK: 共享模型（§4）

export interface Badge {
  text: string
  tone: 'red' | 'gold' | 'blue' | 'neutral'
}

export type Target = { show: string } | { video: string }

export interface Reservation {
  id: string
  onlineText?: string
  count?: number
  isReserved: boolean
}

export interface Uploader {
  id: string
  name: string
  avatarURL?: URLString
  followers?: number
}

export interface UploaderProfile {
  uploader: Uploader
  signature?: string
  followingCount?: number
  videoCount?: number
  isFollowing?: boolean
  detail?: string
}

export interface Stats {
  views?: number
  danmaku?: number
  likes?: number
  coins?: number
  favorites?: number
  replies?: number
}

export interface MediaItem {
  id: string
  title: string
  subtitle?: string
  posterURL?: URLString
  landscapeURL?: URLString
  badge?: Badge
  caption?: string
  progress?: number
  rank?: number
  reservation?: Reservation
  uploader?: Uploader
  stats?: Stats
  duration?: number
  publishedAt?: DateString
  target: Target
}

export interface MediaItemPage {
  items: MediaItem[]
  next?: Cursor | null
}

// MARK: 首页与频道（§5.2）

export interface FilterCategory {
  id: string
  title: string
}

export interface Channel {
  id: string
  title: string
  subchannels?: Channel[]
  filterCategories?: FilterCategory[]
}

export interface Shelf {
  channel: Channel
  systemImage: string
  content: 'feed' | 'subchannels' | 'uploaders'
}

export interface Channels {
  home: Channel
  pinned: Channel[]
  channels: Channel[]
  library: Shelf[]
}

export interface FeedMore {
  title: string
  route: Cursor
}

export type SectionStyle = 'hero' | 'row' | 'ranking' | 'continueWatching' | 'upcoming' | 'shortVideo' | 'grid'

export interface FeedSection {
  id: string
  title?: string
  style: SectionStyle
  items: MediaItem[]
  more?: FeedMore
}

export interface FeedPage {
  sections: FeedSection[]
  next?: Cursor | null
}

export interface UploaderPage {
  uploaders: UploaderProfile[]
  next?: Cursor | null
}

// MARK: 筛选（§5.3）

export interface FilterOption {
  id: string
  title: string
}

export interface FilterDimension {
  id: string
  title: string
  options: FilterOption[]
  defaultOptionID: string
  isSort?: boolean
}

export type FilterSelection = Record<string, string>

// MARK: 搜索（§5.4）

export interface SearchRanking {
  id: string
  title: string
  items: MediaItem[]
}

export interface SearchSuggestion {
  keyword: string
  tag?: string
  detail?: string
}

export interface SearchTopMatch {
  show: MediaItem
  facts?: string
  summary?: string
  cast?: string
  episodes: VideoItem[]
}

export interface SearchResults {
  topMatch?: SearchTopMatch
  shows: MediaItem[]
  videos: MediaItem[]
  moreVideos?: Cursor | null
}

// MARK: 详情（§5.5）

export interface Rating {
  source: 'platform' | 'douban' | 'unknown'
  score: string
}

export interface Credit {
  id: string
  name: string
  role?: string
  avatarURL?: URLString
}

export interface Episode {
  id: string
  title: string
  stage: string
  isFeature: boolean
  kind?: string
  imageURL?: URLString
  isPaid: boolean
  badge?: Badge
  duration?: number
  views?: number
  publishedAt?: DateString
}

export interface EpisodeRange {
  title: string
  section?: string
  cursor: Cursor
}

export interface ShowPart {
  id: string
  title: string
  isCurrent: boolean
}

export interface EpisodeList {
  episodes: Episode[]
  ranges?: EpisodeRange[]
  selectedRange?: EpisodeRange
  summary?: string
  parts?: ShowPart[]
  collection?: string
}

export interface RecommendationTab {
  title: string
  imageURL?: URLString
  cursor?: Cursor
}

export interface Recommendations {
  tabs: RecommendationTab[]
  items: MediaItem[]
}

export interface ResumePoint {
  videoID: string
  progress?: number
}

export interface ShowDetail {
  showID?: string
  kind?: 'standalone' | 'series'
  title: string
  tagline?: string
  shortSummary?: string
  summary?: string
  attributes?: string
  category?: string
  posterURL?: URLString
  landscapeURL?: URLString
  badge?: Badge
  updateInfo?: string
  heat?: number
  ratings: Rating[]
  tags: string[]
  isPaid: boolean
  credits: Credit[]
  defaultVideoID?: string
  episodes?: EpisodeList
  series: MediaItem[]
  uploads?: EpisodeList
  recommendations: Recommendations
  uploader?: Uploader
  coUploaders?: Uploader[]
  stats?: Stats
  publishedAt?: DateString
  resume?: ResumePoint
  duration?: number
}

// MARK: 互动（§5.6）

export interface VideoActionState {
  isLiked: boolean
  coins: number
  maxCoins: number
  coinsToday?: number
  coinsPerDay: number
  isFavorited?: boolean
  isFollowingUploader?: boolean
  isDisliked?: boolean
}

export interface FavoriteFolder {
  id: string
  title: string
  containsVideo: boolean
}

// MARK: 评论（§5.7）

export interface CommentAuthor {
  name: string
  avatarURL?: URLString
  nameColor?: string
  role?: string
}

export interface Comment {
  id: string
  author: CommentAuthor
  text: string
  emotes?: Record<string, URLString>
  pictures?: URLString[]
  date?: DateString
  location?: string
  likes: number
  replyCount?: number
  previewReplies?: Comment[]
  replies?: Cursor
  isPinned?: boolean
  repliesTo?: string
}

export interface CommentPage {
  comments: Comment[]
  next?: Cursor | null
  total?: number
}

export type CommentSort = 'hot' | 'latest'

// MARK: 弹幕（§5.8）

export interface Danmaku {
  id: string
  time: number
  text: string
  position: 'scroll' | 'top' | 'bottom'
  color: string
}

// MARK: 历史（§5.9）

export interface WatchDevice {
  kind: 'tv' | 'computer' | 'phone' | 'tablet' | 'other'
  name: string
}

export interface VideoItem {
  id: string
  showID?: string
  title: string
  subtitle?: string
  coverURL?: URLString
  posterURL?: URLString
  progress?: number
  watchedPercent?: number
  badge?: Badge
  caption?: string
  lastWatched?: DateString
  device?: WatchDevice
  isPlayable?: boolean
  unplayableReason?: string
  historyKey?: string
}

export interface HistoryPage {
  items: VideoItem[]
  hasMore: boolean
}

// MARK: 登录（§5.1）

export type LoginStep =
  | { kind: 'showCode'; content: string; title: string; message: string; openURL?: URLString; expiresAt?: DateString }
  | { kind: 'waiting'; message: string }
  | { kind: 'completed'; profile: Profile }
  | { kind: 'failed'; message: string; restartable: boolean }

/** `login/start` 与 `login/{id}` 的响应：`seq` 随每个新步骤递增，长轮询带 `after=<seq>` 等下一个。 */
export interface LoginState {
  loginId: string
  seq: number
  step: LoginStep
}

/** `login/cookie` 的响应。 */
export interface CookieLoginResult {
  step: LoginStep
}

export interface AccountState {
  loggedIn: boolean
  profile?: Profile
}

export interface CookieInput {
  name: string
  value: string
  domain: string
  path?: string
  expires?: DateString
  secure?: boolean
  httpOnly?: boolean
}

// MARK: 播放（§6）

export interface Quality {
  /** 像素高度：720、1080、2160。 */
  rank: number
  label: string
}

export interface AudioLanguage {
  code: string
  name: string
}

export interface Variant {
  peakBandwidths: number[]
  label: string
}

export interface FairPlayEndpoints {
  certificate: URLString
  license: URLString
}

export interface Stream {
  id: string
  url: URLString
  format: 'hls' | 'mp4'
  quality: Quality
  language?: AudioLanguage
  description: string
  unavailableReason?: string
  fallback?: Variant
  lowerVariants?: Variant[]
  fairPlay?: FairPlayEndpoints
  /** App 能否缓存到本地，默认 true（§6.1）。要缓存的 HLS 必须是完整的点播 playlist（有 `EXT-X-ENDLIST`）。 */
  keepable?: boolean
}

export interface Chapter {
  start: number
  end?: number
  title: string
  imageURL?: URLString
}

export interface Markers {
  introEnd?: number
  outroStart?: number
  chapters?: Chapter[]
}

export interface SubtitleTrack {
  /** 语言，语音识别加 `.asr`（"en"、"en.asr"）。 */
  key: string
  name: string
  language: string
  generated: boolean
  vtt?: URLString
  /** 逐句原文（`{ cues }`），用于 App 本地翻译。 */
  cues?: URLString
}

export interface PlaybackMedia {
  title: string
  startPosition?: number
  expiresAt?: DateString
  live?: boolean
  markers?: Markers
  streams: Stream[]
  selectedStream: string
  subtitles?: SubtitleTrack[]
  reportContext?: unknown
  diagnostics?: Record<string, string>
}

export interface ResolveRequest {
  video: string
  show?: string | null
  preferences?: { maxQualityRank?: number | null; language?: string | null; adaptive?: boolean }
}

export type ProgressEvent = 'start' | 'progress' | 'seek' | 'leave' | 'end'

export interface ProgressRequest {
  event: ProgressEvent
  video: string
  show?: string | null
  position: number
  duration?: number | null
  reportContext?: unknown
}

/** `subtitles/{ref}/{key}` 的响应。 */
export interface CueList {
  cues: Cue[]
}

export interface Cue {
  start: number
  end: number
  text: string
  words?: { start: number; text: string }[]
}
