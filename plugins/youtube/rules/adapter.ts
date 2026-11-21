/**
 * What the app reads out of YouTube's pages and InnerTube answers, in the shapes its Swift side takes
 * (`App/Core/YouTube`, docs/youtube/PLAN.md §12.2). Run in JavaScriptCore: plain ECMAScript only — no `URL`,
 * `URLSearchParams`, `fetch` or DOM there.
 *
 * Changing a shape the app reads is a new interface: the package then becomes `youtube<api + 1>` (`acache.mjs`),
 * so an app built for this one never receives it.
 */

/** The interface version; the offline package is named after it (`youtube1`). */
export const api = 1

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** A renderer's text: `simpleText`, else its `runs` joined. */
export function text(node: Json): string | undefined {
  if (!node) return undefined
  if (typeof node.simpleText === 'string' && node.simpleText) return node.simpleText
  if (Array.isArray(node.runs)) {
    const joined = node.runs.map((run: Json) => run?.text ?? '').join('')
    if (joined) return joined
  }
  return undefined
}

function int(value: Json): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

function nonEmpty(value: Json): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// MARK: - TV page and player JS

export interface TVPage {
  /** `/s/player/<id>/…/tv-player-ias.js`, as the page writes it (relative to `youtube.com`). */
  playerPath: string
  clientID?: string
  clientSecret?: string
  visitorData?: string
}

/** The YouTube TV app's page (`youtube.com/tv`): its player JS, its OAuth client (the first in its scripts), a visitor id. */
export function tvPage(html: string): TVPage | null {
  const player = /"jsUrl":"([^"]+)"/.exec(html)
  if (!player) return null
  const client = /clientId:"([-\w]+\.apps\.googleusercontent\.com)",\n?[$\w]+:"(\w+)"/.exec(html)
  return {
    playerPath: player[1].replace(/\\\//g, '/'),
    clientID: client?.[1],
    clientSecret: client?.[2],
    visitorData: /"visitorData":"([^"]+)"/.exec(html)?.[1],
  }
}

/** What `player` requests must send of the player JS. */
export function playerJS(code: string): { signatureTimestamp: number } | null {
  const match = /signatureTimestamp:(\d+)/.exec(code)
  return match ? { signatureTimestamp: Number(match[1]) } : null
}

// MARK: - Account

export interface Profile {
  id: string
  name: string
  avatar?: string
}

/** The account signed in, from `account/accounts_list`: the selected one. */
export function profile(answer: Json): Profile | null {
  const items: Json[] = []
  for (const section of answer?.contents ?? []) {
    for (const group of section?.accountSectionListRenderer?.contents ?? []) {
      for (const entry of group?.accountItemSectionRenderer?.contents ?? []) {
        if (entry?.accountItem) items.push(entry.accountItem)
      }
    }
  }
  const item = items.find((i) => i.isSelected === true) ?? items[0]
  const name = text(item?.accountName)
  if (!item || !name) return null
  const tokens: Json[] = item.serviceEndpoint?.selectActiveIdentityEndpoint?.supportedTokens ?? []
  const id = tokens.map((t) => t?.accountStateToken?.obfuscatedGaiaId).find(nonEmpty) ?? name
  const thumbnails: Json[] = item.accountPhoto?.thumbnails ?? []
  return { id, name, avatar: nonEmpty(thumbnails[thumbnails.length - 1]?.url) }
}

// MARK: - Player

/** The body of a `player` request (the client's `context` is the app's). */
export function playerRequest(args: { videoId: string; signatureTimestamp: number }): Json {
  return {
    videoId: args.videoId,
    playbackContext: {
      contentPlaybackContext: { signatureTimestamp: args.signatureTimestamp, html5Preference: 'HTML5_PREF_WANTS' },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  }
}

export interface Format {
  itag: number
  /** `video/mp4`, `audio/webm`. */
  mimeType: string
  /** `avc1.640028`, `mp4a.40.2`. */
  codecs: string
  width: number
  height: number
  fps: number
  bitrate: number
  averageBitrate?: number
  qualityLabel?: string
  /** `[start, end]` byte offsets, both included. */
  initRange?: [number, number]
  indexRange?: [number, number]
  durationMs?: number
  /** The address with its `n` still to transform. */
  url?: string
  /** The signature still to solve: `s`, its parameter name, the address. */
  cipher?: { s: string; sp: string; url: string }
  /** Not the default of a dubbed video's audio tracks. */
  isAlternateAudio: boolean
  /** A dubbed video's audio track's language (`audioTrack.id`'s "en" of "en.4"); with `isAlternateAudio` false, the
   * language the video was made in. Absent for a video with one audio track. */
  audioLanguage?: string
  /** Dynamic-range-compressed audio ("stable volume"). */
  isDRC: boolean
  /** What SABR names the format by, with `itag` (docs/youtube/SABR.md §3). */
  lastModified?: string
  xtags?: string
}

export interface Player {
  /** `OK`, `LOGIN_REQUIRED`, `UNPLAYABLE`, `ERROR`, … */
  status: string
  reason?: string
  /** YouTube asks to confirm this isn't a bot (this network or identity is challenged). */
  botCheck: boolean
  title?: string
  lengthSeconds?: number
  isLive: boolean
  hlsManifestUrl?: string
  expiresInSeconds?: number
  formats: Format[]
  /** SABR (docs/youtube/SABR.md): `serverAbrStreamingUrl` (its `n` still to transform) and
   *  `videoPlaybackUstreamerConfig` (base64url), when the answer offers it. */
  sabr?: { url: string; ustreamerConfig: string }
  /** Where watching is recorded in the account's history (`playbackTracking`), with this video's own parameters. */
  tracking?: { playback?: string; watchtime?: string }
  /** Its subtitles: uploaded ones, and YouTube's speech recognition (`isAuto`). */
  captions: Caption[]
}

export interface Caption {
  /** `timedtext` address; `fmt=json3` added for `captionVTT`. */
  url: string
  languageCode: string
  /** As YouTube names it in the account's language ("英语", "英语 (自动生成)"). */
  name: string
  isAuto: boolean
}

/** A `player` answer: whether it plays, and its adaptive formats. */
export function player(answer: Json): Player {
  const playability = answer?.playabilityStatus ?? {}
  const status: string = nonEmpty(playability.status) ?? '?'
  const reason = nonEmpty(playability.reason) ?? text(playability.errorScreen?.playerErrorMessageRenderer?.reason)
  const details = answer?.videoDetails ?? {}
  const streaming = answer?.streamingData ?? {}
  return {
    status,
    reason,
    botCheck: status === 'LOGIN_REQUIRED' && /bot/i.test(reason ?? ''),
    title: nonEmpty(details.title),
    lengthSeconds: int(details.lengthSeconds),
    isLive: details.isLive === true,
    hlsManifestUrl: nonEmpty(streaming.hlsManifestUrl),
    expiresInSeconds: int(streaming.expiresInSeconds),
    formats: (streaming.adaptiveFormats ?? []).map(format).filter((f: Format | null): f is Format => f !== null),
    sabr: sabr(answer),
    captions: captionTracks(answer),
    tracking: answer?.playbackTracking
      ? { playback: nonEmpty(answer.playbackTracking.videostatsPlaybackUrl?.baseUrl),
          watchtime: nonEmpty(answer.playbackTracking.videostatsWatchtimeUrl?.baseUrl) }
      : undefined,
  }
}

function format(json: Json): Format | null {
  const itag = int(json?.itag)
  const mime = nonEmpty(json?.mimeType)
  if (itag === undefined || !mime) return null
  const [type, parameters = ''] = mime.split(';', 2)
  const range = (r: Json): [number, number] | undefined => {
    const start = int(r?.start)
    const end = int(r?.end)
    return start !== undefined && end !== undefined && start <= end ? [start, end] : undefined
  }
  const cipherText = nonEmpty(json.signatureCipher) ?? nonEmpty(json.cipher)
  let cipher: Format['cipher']
  if (cipherText) {
    const query = parseQuery(cipherText)
    if (query.s && query.url) cipher = { s: query.s, sp: query.sp ?? 'signature', url: query.url }
  }
  return {
    itag,
    mimeType: type.trim(),
    codecs: /codecs="([^"]*)"/.exec(parameters)?.[1] ?? '',
    width: int(json.width) ?? 0,
    height: int(json.height) ?? 0,
    fps: int(json.fps) ?? 0,
    bitrate: int(json.bitrate) ?? 0,
    averageBitrate: int(json.averageBitrate),
    qualityLabel: nonEmpty(json.qualityLabel),
    initRange: range(json.initRange),
    indexRange: range(json.indexRange),
    durationMs: int(json.approxDurationMs),
    url: nonEmpty(json.url),
    cipher,
    isAlternateAudio: json.audioTrack != null && json.audioTrack.audioIsDefault === false,
    audioLanguage: nonEmpty(String(json.audioTrack?.id ?? '').split('.')[0]),
    isDRC: json.isDrc === true,
    lastModified: nonEmpty(json.lastModified),
    xtags: nonEmpty(json.xtags),
  }
}

function sabr(answer: Json): Player['sabr'] {
  const url = nonEmpty(answer?.streamingData?.serverAbrStreamingUrl)
  const config = nonEmpty(answer?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig)
  return url && config ? { url, ustreamerConfig: config } : undefined
}

/** `a=1&b=x%3Dy` → `{a: '1', b: 'x=y'}` (no `URLSearchParams` in JavaScriptCore). */
export function parseQuery(query: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    const key = index < 0 ? pair : pair.slice(0, index)
    const value = index < 0 ? '' : pair.slice(index + 1)
    try {
      result[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      // A malformed escape: left out.
    }
  }
  return result
}

// MARK: - Browsing (step three, docs/youtube/PLAN.md §5)

/**
 * A card of any list: a video, a playlist, a channel. Read alike from the TV's `tileRenderer`, the newer
 * `lockupViewModel` (search, recommendations) and the web's `videoRenderer`.
 */
export interface Card {
  kind: 'video' | 'short' | 'playlist' | 'channel'
  /** A video's 11-character id, a playlist's `PL…` / `VL…`, a channel's `UC…`. */
  id: string
  title: string
  thumbnail?: string
  /** Seconds. */
  duration?: number
  isLive: boolean
  /** Watched fraction, 0…1. */
  progress?: number
  channelID?: string
  channelName?: string
  /** The other metadata lines, as shown ("8万次观看", "3小时前"). */
  details: string[]
}

export interface Shelf {
  /** Stable within a page: its position. */
  id: string
  title?: string
  cards: Card[]
  /** The row's own next items (`browse` with it answers its further cards, about ten at a time). */
  continuation?: string
}

export interface Page {
  /** A playlist page's own title, and its owner / count lines ("Marques Brownlee", "12 个视频"). */
  title?: string
  byline: string[]
  shelves: Shelf[]
  /** The next page's token (`browse` / `search` with `continuation`). */
  continuation?: string
}

/** The body of a `browse` request: a page by id (`FEwhat_to_watch`, `UC…`, `VLWL`) or the next of one. */
export function browseRequest(args: { browseId?: string; params?: string; continuation?: string }): Json {
  if (args.continuation) return { continuation: args.continuation }
  return args.params ? { browseId: args.browseId, params: args.params } : { browseId: args.browseId }
}

export function searchRequest(args: { query?: string; continuation?: string }): Json {
  return args.continuation ? { continuation: args.continuation } : { query: args.query }
}

/**
 * Any list page — home, a topic, subscriptions, history, a playlist, a channel, search results, or a next page of
 * one — as shelves of cards. Cards outside any shelf form one untitled shelf. Duplicates (a video in two shelves)
 * stay: shelves are separate rows.
 */
export function page(answer: Json): Page {
  const shelves: Shelf[] = []
  const loose: Card[] = []
  walk(answer, (key, value) => {
    if (key === 'shelfRenderer' || key === 'richShelfRenderer' || key === 'reelShelfRenderer') {
      const cards = collectCards(value)
      if (cards.length) {
        shelves.push({ id: String(shelves.length), title: shelfTitle(value), cards, continuation: rowContinuation(value) })
      }
      return false
    }
    const card = cardOf(key, value)
    if (card) {
      loose.push(card)
      return false
    }
    // A channel page's or subscriptions' tabs: only the selected one's content is the page.
    if (key === 'tabRenderer') return value?.selected === true
    return true
  })
  if (loose.length) shelves.push({ id: String(shelves.length), cards: loose })
  let metadata: Json
  walk(answer, (key, value) => {
    if (!metadata && key === 'entityMetadataRenderer') metadata = value
    return !metadata
  })
  const byline: string[] = []
  for (const line of metadata?.bylines ?? []) {
    for (const item of line?.lineRenderer?.items ?? []) {
      const part = text(item?.lineItemRenderer?.text)
      if (meaningful(part)) byline.push(part)
    }
  }
  return { title: text(metadata?.title), byline, shelves, continuation: continuation(answer) }
}

/** A row's own next-items token. */
function rowContinuation(shelf: Json): string | undefined {
  let found: string | undefined
  walk(shelf, (key, value) => {
    if (found) return false
    if (key === 'nextContinuationData' && typeof value?.continuation === 'string') found = value.continuation
    else if (key === 'continuationCommand' && typeof value?.token === 'string') found = value.token
    return !found
  })
  return found
}

/** The page's own next-page token: the list's, not a shelf's (a row's further items). */
export function continuation(answer: Json): string | undefined {
  let found: string | undefined
  walk(answer, (key, value) => {
    if (found) return false
    if (key === 'shelfRenderer' || key === 'horizontalListRenderer') return false
    if (key === 'nextContinuationData' && typeof value?.continuation === 'string') found = value.continuation
    else if (key === 'continuationCommand' && typeof value?.token === 'string') found = value.token
    else if (key === 'reloadContinuationData') return false
    return !found
  })
  return found
}

/** The channels of a subscriptions page's side list (its tabs after 全部), each opening that channel's videos. */
export interface ChannelTab {
  title: string
  browseId: string
  params?: string
  thumbnail?: string
  /** The channel's own `UC…` id, read out of `params` (a protobuf holding it). */
  channelID?: string
}

export function channelTabs(answer: Json): ChannelTab[] {
  const tabs: ChannelTab[] = []
  walk(answer, (key, value) => {
    if (key !== 'tabRenderer') return true
    const browse = value?.endpoint?.browseEndpoint
    const title = typeof value?.title === 'string' ? nonEmpty(value.title) : text(value?.title)
    const thumbnails: Json[] = value?.thumbnail?.thumbnails ?? []
    // The channel ones have a picture; 全部 / 直播 have an icon.
    if (browse?.browseId && title && thumbnails.length) {
      const params = nonEmpty(browse.params)
      const channelID = /UC[\w-]{22}/.exec(base64Text(decodeURIComponentSafe(params ?? '')))?.[0]
      tabs.push({ title, browseId: browse.browseId, params, thumbnail: bestThumbnail(thumbnails), channelID })
    }
    return false
  })
  return tabs
}

// MARK: - Detail

export interface Detail {
  videoId: string
  title?: string
  description?: string
  /** "2017年1月12日发布". */
  published?: string
  /** "9,176,254,724次观看". */
  views?: string
  /** "5682万". */
  likes?: string
  /** Its channel; of a collaboration, the main one (the one its subscribe button is for). */
  channel?: { id: string; name: string; avatar?: string; subscribers?: string }
  /** A collaboration's other channels (its 联合创作者 panel), after `channel`. */
  collaborators: { id: string; name: string; avatar?: string }[]
  /** What plays next and other recommendations. */
  related: Card[]
}

export function nextRequest(args: { videoId: string }): Json {
  return { videoId: args.videoId }
}

/** A `next` answer: the video's facts and what YouTube recommends after it. */
export function detail(answer: Json): Detail | null {
  let metadata: Json
  let description: string | undefined
  let likes: string | undefined
  const related: Card[] = []
  const creators: { id: string; name: string; avatar?: string }[] = []
  walk(answer, (key, value) => {
    // A collaboration's creators: links opening each one's channel panel.
    if (key === 'compactLinkRenderer') {
      const tag = value?.navigationEndpoint?.showEngagementPanelEndpoint?.identifier?.tag
      const id = /channel-actions-panel-(UC[\w-]{22})/.exec(typeof tag === 'string' ? tag : '')?.[1]
      const name = text(value?.title)
      if (id && name && !creators.some((c) => c.id === id)) {
        creators.push({ id, name, avatar: bestThumbnail(value?.thumbnail?.thumbnails) })
      }
      return false
    }
    if (key === 'videoMetadataRenderer' && !metadata) metadata = value
    else if (key === 'expandableVideoDescriptionBodyRenderer' && !description) description = text(value?.descriptionBodyText)
    else if (key === 'factoidRenderer' && /赞|like/i.test(text(value?.label) ?? value?.accessibilityText ?? '')) likes ??= text(value?.value)
    const card = cardOf(key, value)
    if (card) {
      related.push(card)
      return false
    }
    return true
  })
  const videoId = nonEmpty(metadata?.videoId) ?? nonEmpty(answer?.currentVideoEndpoint?.watchEndpoint?.videoId)
  if (!videoId) return null
  const owner = metadata?.owner?.videoOwnerRenderer
  // A collaboration's owner links to no one channel: its subscribe button names the main one.
  const channelID = nonEmpty(owner?.navigationEndpoint?.browseEndpoint?.browseId)
    ?? nonEmpty(owner?.subscribeButton?.subscribeButtonRenderer?.channelId)
  const main = creators.find((c) => c.id === channelID)
  const channelName = main?.name ?? text(owner?.title)
  return {
    videoId,
    title: text(metadata?.title),
    description,
    published: text(metadata?.publishedTimeText) ?? text(metadata?.dateText),
    views: text(metadata?.viewCount?.videoViewCountRenderer?.viewCount),
    likes,
    channel: channelID && channelName
      ? { id: channelID, name: channelName, avatar: bestThumbnail(owner?.thumbnail?.thumbnails) ?? main?.avatar,
          subscribers: text(owner?.subscriberCountText) }
      : undefined,
    collaborators: creators.filter((c) => c.id !== channelID),
    related: related.filter((card) => card.id !== videoId),
  }
}

// MARK: - Search suggestions

/** `suggestqueries.google.com/complete/search?client=firefox&ds=yt`: `["q", ["s1", "s2", …]]`. */
export function suggestions(body: string): string[] {
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed?.[1]) ? parsed[1].filter((s: Json) => typeof s === 'string') : []
  } catch {
    return []
  }
}

// MARK: - Cards

/** Visits every object member, depth first; `visit` returning false skips that member's inside. */
function walk(node: Json, visit: (key: string, value: Json) => boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (value && typeof value === 'object' && visit(key, value)) walk(value, visit)
    }
  }
}

function collectCards(node: Json): Card[] {
  const cards: Card[] = []
  walk(node, (key, value) => {
    const card = cardOf(key, value)
    if (card) cards.push(card)
    return !card
  })
  return cards
}

function shelfTitle(shelf: Json): string | undefined {
  return text(shelf?.title)
    ?? text(shelf?.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title)
    ?? text(shelf?.headerRenderer?.shelfHeaderRenderer?.title)
}

function cardOf(key: string, value: Json): Card | null {
  switch (key) {
    case 'tileRenderer': return tileCard(value)
    case 'lockupViewModel': return lockupCard(value)
    case 'videoRenderer':
    case 'compactVideoRenderer':
    case 'gridVideoRenderer': return videoRendererCard(value)
    default: return null
  }
}

function tileCard(tile: Json): Card | null {
  const command = tile?.onSelectCommand ?? {}
  const header = tile?.header?.tileHeaderRenderer ?? {}
  const metadata = tile?.metadata?.tileMetadataRenderer ?? {}
  const title = text(metadata.title)
  const type: string = tile?.contentType ?? ''
  let kind: Card['kind'] | undefined
  let id: string | undefined
  if (command.reelWatchEndpoint?.videoId) {
    kind = 'short'
    id = command.reelWatchEndpoint.videoId
  } else if (command.watchEndpoint?.videoId && !type.includes('PLAYLIST')) {
    kind = 'video'
    id = command.watchEndpoint.videoId
  } else if (type.includes('PLAYLIST')) {
    kind = 'playlist'
    id = playlistID(nonEmpty(command.watchEndpoint?.playlistId) ?? nonEmpty(command.browseEndpoint?.browseId) ?? nonEmpty(tile.contentId))
  } else if (type.includes('CHANNEL') || command.browseEndpoint?.browseId?.startsWith?.('UC')) {
    kind = 'channel'
    id = nonEmpty(command.browseEndpoint?.browseId) ?? nonEmpty(tile.contentId)
  }
  if (!kind || !id || !title) return null
  let duration: number | undefined
  let isLive = false
  let progress: number | undefined
  for (const overlay of header.thumbnailOverlays ?? []) {
    const status = overlay?.thumbnailOverlayTimeStatusRenderer
    if (status) {
      if (status.style === 'LIVE') isLive = true
      if (status.style === 'SHORTS') kind = 'short'
      duration ??= seconds(text(status.text))
    }
    const resume = overlay?.thumbnailOverlayResumePlaybackRenderer
    if (typeof resume?.percentDurationWatched === 'number') progress = resume.percentDurationWatched / 100
  }
  const lines: string[][] = (metadata.lines ?? []).map((line: Json) =>
    (line?.lineRenderer?.items ?? []).map((item: Json) => text(item?.lineItemRenderer?.text)).filter(meaningful))
  let channelID: string | undefined
  walk(metadata.lines, (k, v) => {
    if (k === 'browseEndpoint' && typeof v?.browseId === 'string' && v.browseId.startsWith('UC')) channelID ??= v.browseId
    return !channelID
  })
  const channelName = kind === 'channel' ? undefined : lines[0]?.[0]
  return {
    kind, id, title,
    thumbnail: bestThumbnail(header.thumbnail?.thumbnails),
    duration, isLive, progress, channelID, channelName,
    details: (channelName ? lines.slice(1) : lines).flat(),
  }
}

function lockupCard(lockup: Json): Card | null {
  const type: string = lockup?.contentType ?? ''
  const id = nonEmpty(lockup?.contentId)
  const metadata = lockup?.metadata?.lockupMetadataViewModel ?? {}
  const title = nonEmpty(metadata.title?.content)
  const kind: Card['kind'] | undefined = type.includes('VIDEO') ? 'video' : type.includes('PLAYLIST') ? 'playlist'
    : type.includes('CHANNEL') ? 'channel' : type.includes('SHORT') ? 'short' : undefined
  if (!kind || !id || !title) return null
  return lockupCardWith(lockup, kind, kind === 'playlist' ? playlistID(id)! : id, title)
}

function lockupCardWith(lockup: Json, kind: Card['kind'], id: string, title: string): Card {
  const metadata = lockup?.metadata?.lockupMetadataViewModel ?? {}
  const image = lockup?.contentImage?.thumbnailViewModel
    ?? lockup?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel
  let duration: number | undefined
  let isLive = false
  let progress: number | undefined
  walk(image?.overlays, (k, v) => {
    if (k === 'thumbnailBadgeViewModel') {
      const badge = nonEmpty(v?.text)
      if (v?.badgeStyle?.includes?.('LIVE') || badge === 'LIVE' || badge === '直播') isLive = true
      duration ??= seconds(badge)
    }
    if (k === 'thumbnailOverlayProgressBarViewModel' && typeof v?.startPercent === 'number') progress = v.startPercent / 100
    return true
  })
  const rows: string[][] = (metadata.metadata?.contentMetadataViewModel?.metadataRows ?? []).map((row: Json) =>
    (row?.metadataParts ?? []).map((part: Json) => nonEmpty(part?.text?.content)).filter(meaningful))
  let channelID: string | undefined
  walk(metadata.metadata, (k, v) => {
    if (k === 'browseEndpoint' && typeof v?.browseId === 'string' && v.browseId.startsWith('UC')) channelID ??= v.browseId
    return !channelID
  })
  const channelName = kind === 'channel' ? undefined : rows[0]?.[0]
  const details = rows.flat()
  return {
    kind, id, title,
    thumbnail: bestThumbnail(image?.image?.sources),
    duration, isLive, progress, channelID, channelName,
    details: channelName ? details.slice(1) : details,
  }
}

function videoRendererCard(video: Json): Card | null {
  const id = nonEmpty(video?.videoId)
  const title = text(video?.title)
  if (!id || !title) return null
  const owner = video.ownerText ?? video.shortBylineText ?? video.longBylineText
  const resume = (video.thumbnailOverlays ?? []).find((o: Json) => o?.thumbnailOverlayResumePlaybackRenderer)
  return {
    kind: 'video', id, title,
    thumbnail: bestThumbnail(video.thumbnail?.thumbnails),
    duration: seconds(text(video.lengthText)),
    isLive: (video.badges ?? []).some((b: Json) => /LIVE/.test(b?.metadataBadgeRenderer?.style ?? '')),
    progress: resume ? resume.thumbnailOverlayResumePlaybackRenderer.percentDurationWatched / 100 : undefined,
    channelID: nonEmpty(owner?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId),
    channelName: text(owner),
    details: [text(video.viewCountText), text(video.publishedTimeText)].filter(meaningful),
  }
}

/** The widest of a thumbnail list (`thumbnails` or `sources`). */
function bestThumbnail(list: Json): string | undefined {
  if (!Array.isArray(list) || !list.length) return undefined
  const best = list.reduce((a: Json, b: Json) => ((b?.width ?? 0) > (a?.width ?? 0) ? b : a))
  let url = nonEmpty(best?.url)
  if (url?.startsWith('//')) url = `https:${url}`
  return url
}

/** "1:02:03" / "9:11" → seconds. */
export function seconds(value: string | undefined): number | undefined {
  if (!value || !/^\d+(:\d{1,2}){1,2}$/.test(value.trim())) return undefined
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

function meaningful(value: string | undefined): value is string {
  return !!value && value.trim() !== '•' && value.trim() !== ''
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Base64 (standard or URL-safe) to Latin-1 text: enough to find ASCII ids in a protobuf (no `atob` in JavaScriptCore). */
export function base64Text(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = value.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  let bits = 0
  let count = 0
  let out = ''
  for (const char of clean) {
    bits = (bits << 6) | alphabet.indexOf(char)
    count += 6
    if (count >= 8) {
      count -= 8
      out += String.fromCharCode((bits >> count) & 0xff)
    }
  }
  return out
}

// MARK: - Comments

/**
 * The comment panel's orders in a `next` answer, each a token `next` with `continuation` answers the first page of,
 * and how many comments there are as the panel's header says ("439万").
 */
export function commentSorts(answer: Json): { hot?: string; latest?: string; total?: string } {
  let panel: Json
  walk(answer, (key, value) => {
    if (panel) return false
    if (key === 'engagementPanelSectionListRenderer' && value?.panelIdentifier === 'comment-item-section') panel = value
    return !panel
  })
  if (!panel) return {}
  const items: Json[] = []
  walk(panel, (key, value) => {
    if (key === 'sortFilterSubMenuRenderer') items.push(...(value?.subMenuItems ?? []))
    return key !== 'sortFilterSubMenuRenderer'
  })
  const token = (item: Json) => nonEmpty(item?.continuation?.reloadContinuationData?.continuation)
    ?? nonEmpty(item?.serviceEndpoint?.continuationCommand?.token)
  // 最热门 first, 最新 second, as every client lists them.
  let fallback: string | undefined
  walk(panel.content, (key, value) => {
    if (!fallback && key === 'reloadContinuationData') fallback = nonEmpty(value?.continuation)
    if (!fallback && key === 'continuationCommand') fallback = nonEmpty(value?.token)
    return !fallback
  })
  let total: string | undefined
  walk(panel.header, (key, value) => {
    if (!total && key === 'engagementPanelTitleHeaderRenderer') total = text(value?.contextualInfo)
    return !total
  })
  return { hot: token(items[0]) ?? fallback, latest: token(items[1]), total }
}

export interface CommentItem {
  id: string
  author: string
  avatar?: string
  text: string
  /** "2天前". */
  published?: string
  /** "1345", "1.3万". */
  likes?: string
  replyCount: number
  /** The first page of its replies. */
  replies?: string
  isPinned: boolean
}

/** A page of comments or of a comment's replies (`next` with a comment token). */
export function comments(answer: Json): { comments: CommentItem[]; continuation?: string } {
  const list: CommentItem[] = []
  walk(answer, (key, value) => {
    if (key === 'commentThreadRenderer') {
      const item = comment(value?.comment?.commentRenderer)
      if (item) list.push(item)
      return false
    }
    if (key === 'commentRenderer') {
      const item = comment(value)
      if (item) list.push(item)
      return false
    }
    return true
  })
  return { comments: list, continuation: continuation(answer) }
}

function comment(renderer: Json): CommentItem | null {
  const id = nonEmpty(renderer?.commentId)
  const textValue = text(renderer?.contentText)
  if (!id || !textValue) return null
  let replies: string | undefined
  walk(renderer.detailViewEndpoint, (key, value) => {
    if (!replies && key === 'reloadContinuationData') replies = nonEmpty(value?.continuation)
    if (!replies && key === 'continuationCommand') replies = nonEmpty(value?.token)
    return !replies
  })
  return {
    id,
    author: text(renderer.authorText) ?? '',
    avatar: bestThumbnail(renderer.authorThumbnail?.thumbnails),
    text: textValue,
    published: text(renderer.publishedTimeText),
    likes: text(renderer.voteCount),
    replyCount: int(renderer.replyCount) ?? 0,
    replies: (int(renderer.replyCount) ?? 0) > 0 ? replies : undefined,
    isPinned: renderer.pinnedCommentBadge != null,
  }
}

/** A playlist's own id (`PL…`, `LL`, `WL`, a mix's `RD…`), without the `VL` its browse id adds. */
export function playlistID(id: string | undefined): string | undefined {
  return id?.startsWith('VL') ? id.slice(2) : id
}

// MARK: - The account's marks (点赞, 订阅)

/**
 * A `next` answer's like state and its channel's subscription, or a channel page's subscription: what the like and
 * subscribe buttons show.
 */
export function marks(answer: Json): { likeStatus?: string; channelId?: string; subscribed?: boolean } {
  let like: Json
  let subscribe: Json
  walk(answer, (key, value) => {
    if (!like && key === 'likeButtonRenderer') like = value
    if (!subscribe && key === 'subscribeButtonRenderer') subscribe = value
    return !(like && subscribe)
  })
  return {
    likeStatus: nonEmpty(like?.likeStatus),
    channelId: nonEmpty(subscribe?.channelId),
    subscribed: typeof subscribe?.subscribed === 'boolean' ? subscribe.subscribed : undefined,
  }
}

/** `like/like`, `like/dislike`, `like/removelike`'s body. */
export function likeRequest(args: { videoId: string }): Json {
  return { target: { videoId: args.videoId } }
}

/** `subscription/subscribe` / `unsubscribe`'s body. */
export function subscribeRequest(args: { channelId: string }): Json {
  return { channelIds: [args.channelId] }
}

// MARK: - Subtitles

function captionTracks(answer: Json): Caption[] {
  const tracks: Json[] = answer?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  return tracks.flatMap((track) => {
    const url = nonEmpty(track?.baseUrl)
    const languageCode = nonEmpty(track?.languageCode)
    if (!url || !languageCode) return []
    return [{ url, languageCode, name: text(track?.name) ?? languageCode, isAuto: track?.kind === 'asr' }]
  })
}

/**
 * A `timedtext` answer in `fmt=json3` as WebVTT: one cue per event with text. Speech recognition's events carry each
 * word with its own offset (`tOffsetMs`) and empty line breaks (`aAppend`); the words are joined into the line, which
 * players then show whole rather than word by word.
 */
export function captionVTT(answer: Json): string {
  const cues: string[] = []
  for (const event of answer?.events ?? []) {
    const start = int(event?.tStartMs)
    const length = int(event?.dDurationMs)
    if (start === undefined || !length || !Array.isArray(event?.segs)) continue
    const line = event.segs.map((seg: Json) => (typeof seg?.utf8 === 'string' ? seg.utf8 : '')).join('').trim()
    if (!line) continue
    cues.push(`${timestamp(start)} --> ${timestamp(start + length)}\n${line.replace(/\n{2,}/g, '\n')}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/**
 * A `timedtext` answer in `fmt=json3` as cues to translate (iyouteng docs/SUBTITLE-TRANSLATION-ARCHITECTURE.md): one per
 * event with text, times in seconds. With `auto` (speech recognition) each cue also has its words, each from its own
 * time (`tOffsetMs` after the event's start), which the app cuts into sentences at the pauses; its empty line-break
 * events (`aAppend`) are left out. Read by Swift as `SubtitleCue`. One argument, as the app calls every function.
 */
export function captionCues(input: { answer: Json; auto?: boolean }): CaptionCue[] {
  const answer = input?.answer
  const auto = input?.auto === true
  const cues: CaptionCue[] = []
  for (const event of answer?.events ?? []) {
    const start = int(event?.tStartMs)
    const length = int(event?.dDurationMs)
    if (start === undefined || !length || !Array.isArray(event?.segs) || event?.aAppend) continue
    const segs = event.segs.filter((seg: Json) => typeof seg?.utf8 === 'string')
    const text = segs.map((seg: Json) => seg.utf8).join('').replace(/\n{2,}/g, '\n').trim()
    if (!text) continue
    const cue: CaptionCue = { start: start / 1000, end: (start + length) / 1000, text }
    if (auto) {
      cue.words = segs.flatMap((seg: Json) => {
        const word = String(seg.utf8).trim()
        return word ? [{ start: (start + (int(seg.tOffsetMs) ?? 0)) / 1000, text: word }] : []
      })
    }
    cues.push(cue)
  }
  return cues
}

export type CaptionCue = { start: number; end: number; text: string; words?: { start: number; text: string }[] }

function timestamp(ms: number): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}
