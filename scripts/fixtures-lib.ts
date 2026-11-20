// 经真实路由跑样例源，得到每个接口的响应（packages/protocol/fixtures）。`type` 是 types.ts 里的类型名，
// 测试按 schema 校验；App 的 RemoteSource 测试按同一份 index.json 解码。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '@iyt-source/kit'
import { createSampleSource } from './sample-source.ts'

export interface FixtureCase {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  /** types.ts 里的类型名；数组写 `Type[]`；无响应体为 undefined。 */
  type?: string
  status: number
}

const S = '/iyt/v1/sources/sample'

export const CASES: Omit<FixtureCase, 'status'>[] = [
  { name: 'manifest', method: 'GET', path: '/iyt/v1/manifest', type: 'Manifest' },
  { name: 'account', method: 'GET', path: `${S}/account`, type: 'AccountState' },
  { name: 'login-start', method: 'POST', path: `${S}/login/start`, body: { method: 'deviceCode' }, type: 'LoginState' },
  { name: 'login-poll-code', method: 'GET', path: `${S}/login/{loginId}?after=0&wait=1`, type: 'LoginState' },
  { name: 'login-poll-waiting', method: 'GET', path: `${S}/login/{loginId}?after=1&wait=1`, type: 'LoginState' },
  { name: 'login-poll-completed', method: 'GET', path: `${S}/login/{loginId}?after=2&wait=2`, type: 'LoginState' },
  { name: 'manifest-logged-in', method: 'GET', path: '/iyt/v1/manifest', type: 'Manifest' },
  { name: 'login-cookie', method: 'POST', path: `${S}/login/cookie`, body: { cookies: [{ name: 'SESSION', value: 'x', domain: '.example.com' }], userAgent: 'Mozilla/5.0' }, type: 'CookieLoginResult' },
  { name: 'login-cookie-failed', method: 'POST', path: `${S}/login/cookie`, body: { cookies: [{ name: 'OTHER', value: 'x', domain: '.example.com' }] }, type: 'CookieLoginResult' },
  { name: 'feed-channels', method: 'GET', path: `${S}/feed/channels`, type: 'Channels' },
  { name: 'feed-channel', method: 'GET', path: `${S}/feed/channel?id=home`, type: 'FeedPage' },
  { name: 'feed-channel-page2', method: 'GET', path: `${S}/feed/channel?id=home&cursor=p2`, type: 'FeedPage' },
  { name: 'feed-more', method: 'GET', path: `${S}/feed/more?route=more%3Ahot`, type: 'MediaItemPage' },
  { name: 'feed-subchannels', method: 'GET', path: `${S}/feed/subchannels?id=favorites`, type: 'Channel[]' },
  { name: 'feed-uploaders', method: 'GET', path: `${S}/feed/uploaders?id=following`, type: 'UploaderPage' },
  { name: 'filter-categories', method: 'GET', path: `${S}/filter/categories`, type: 'FilterCategory[]' },
  { name: 'filter-dimensions', method: 'GET', path: `${S}/filter/dimensions?category=tv`, type: 'FilterDimension[]' },
  { name: 'filter-results', method: 'GET', path: `${S}/filter/results?category=tv&selection=${encodeURIComponent('{"area":"cn"}')}`, type: 'MediaItemPage' },
  { name: 'search-rankings', method: 'GET', path: `${S}/search/rankings`, type: 'SearchRanking[]' },
  { name: 'search-suggestions', method: 'GET', path: `${S}/search/suggestions?q=shi`, type: 'SearchSuggestion[]' },
  { name: 'search', method: 'GET', path: `${S}/search?q=${encodeURIComponent('示例')}`, type: 'SearchResults' },
  { name: 'search-videos', method: 'GET', path: `${S}/search/videos?q=x&cursor=v2`, type: 'MediaItemPage' },
  { name: 'detail-series', method: 'GET', path: `${S}/detail?target=show%3As1`, type: 'ShowDetail' },
  { name: 'detail-standalone', method: 'GET', path: `${S}/detail?target=video%3Av1`, type: 'ShowDetail' },
  { name: 'detail-episodes', method: 'GET', path: `${S}/detail/episodes?cursor=eps%3A31`, type: 'EpisodeList' },
  { name: 'detail-recommendations', method: 'GET', path: `${S}/detail/recommendations?cursor=rec%3Ac2`, type: 'MediaItem[]' },
  { name: 'detail-resume', method: 'GET', path: `${S}/detail/resume?show=s1`, type: 'ResumePoint' },
  { name: 'uploader', method: 'GET', path: `${S}/uploader?id=u1`, type: 'UploaderProfile' },
  { name: 'uploader-videos', method: 'GET', path: `${S}/uploader/videos?id=u1`, type: 'EpisodeList' },
  { name: 'uploader-collections', method: 'GET', path: `${S}/uploader/collections?id=u1`, type: 'EpisodeRange[]' },
  { name: 'actions-state', method: 'GET', path: `${S}/actions/state?video=v1&uploader=u1`, type: 'VideoActionState' },
  { name: 'actions-like', method: 'POST', path: `${S}/actions/like`, body: { video: 'v1', value: true } },
  { name: 'actions-favorites', method: 'GET', path: `${S}/actions/favorites?video=v1`, type: 'FavoriteFolder[]' },
  { name: 'comments', method: 'GET', path: `${S}/comments?video=e3&sort=hot`, type: 'CommentPage' },
  { name: 'comments-page', method: 'GET', path: `${S}/comments/page?cursor=comments%3A2`, type: 'CommentPage' },
  { name: 'danmaku', method: 'GET', path: `${S}/danmaku?video=e3&segment=2`, type: 'Danmaku[]' },
  { name: 'history', method: 'GET', path: `${S}/history?page=1`, type: 'HistoryPage' },
  { name: 'history-delete', method: 'POST', path: `${S}/history/delete`, body: { keys: ['h-e3'] } },
  { name: 'playback-resolve', method: 'POST', path: `${S}/playback/resolve`, body: { video: 'e3', show: 's1', preferences: { maxQualityRank: 1080, language: null, adaptive: false } }, type: 'PlaybackMedia' },
  { name: 'playback-progress', method: 'POST', path: `${S}/playback/progress`, body: { event: 'progress', video: 'e3', show: 's1', position: 330.2, duration: 1500, reportContext: { show: 's1', episode: 'e3', session: 42 } } },
  { name: 'subtitles-cues', method: 'GET', path: `${S}/subtitles/e3/en.asr`, type: 'CueList' },
  { name: 'links-resolve', method: 'POST', path: `${S}/links/resolve`, body: { url: 'https://example.com/watch/v1?t=42' }, type: 'LinkResolution' },
  { name: 'links-resolve-unknown', method: 'POST', path: `${S}/links/resolve`, body: { url: 'https://example.com/about' }, type: 'ErrorBody' },
  { name: 'account-logout', method: 'POST', path: `${S}/account/logout`, body: {} },
  { name: 'error-not-found', method: 'GET', path: `${S}/nothing`, type: 'ErrorBody' },
  { name: 'error-bad-request', method: 'GET', path: `${S}/detail?target=oops`, type: 'ErrorBody' },
  { name: 'error-missing-source', method: 'GET', path: '/iyt/v1/sources/missing/feed/channels', type: 'ErrorBody' },
]

const FIXED_SERVER_ID = '00000000-0000-4000-8000-000000000001'

export async function buildFixtures(): Promise<{ index: FixtureCase[]; bodies: Map<string, unknown> }> {
  const data = mkdtempSync(join(tmpdir(), 'iyt-fixtures-'))
  writeFileSync(join(data, 'server.json'), JSON.stringify({ id: FIXED_SERVER_ID }))
  const server = await createServer({
    name: '示例服务',
    dataDir: data,
    version: '0.0.0-fixture',
    sources: [{ id: 'sample', plugin: createSampleSource() }],
    ytdlp: { version: async () => '2026.11.10' } as never,
  })
  const index: FixtureCase[] = []
  const bodies = new Map<string, unknown>()
  let loginId = ''
  try {
    for (const entry of CASES) {
      const path = entry.path.replace('{loginId}', loginId)
      const response = await server.app.inject({
        method: entry.method,
        url: path,
        payload: entry.body as object | undefined,
        headers: { host: '192.168.1.20:8090', 'x-iutone-client': 'fixtures' },
      })
      let body: unknown = response.body ? JSON.parse(response.body) : undefined
      if (entry.name === 'login-start') loginId = (body as { loginId: string }).loginId
      body = normalize(body, loginId)
      index.push({ ...entry, path: entry.path, status: response.statusCode })
      if (body !== undefined) bodies.set(entry.name, body)
    }
  } finally {
    await server.close()
    rmSync(data, { recursive: true, force: true })
  }
  return { index, bodies }
}

/** 去掉每次不同的部分（登录 id）。 */
function normalize(body: unknown, loginId: string): unknown {
  if (body === undefined || !loginId) return body
  return JSON.parse(JSON.stringify(body).replaceAll(loginId, 'LOGIN_ID'))
}

export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export async function writeFixtures(directory: string): Promise<number> {
  const { index, bodies } = await buildFixtures()
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.json'), render(index))
  for (const [name, body] of bodies) writeFileSync(join(directory, `${name}.json`), render(body))
  return index.length
}
