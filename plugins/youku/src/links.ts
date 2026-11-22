// 链接解析（SERVER.md §5.10），规则同 App 的 link-resolver（web/packages/link-resolver/src/sources/youku.ts）：
// - `v.youku.com/v_show/id_XNj….html`、`m.youku.com/…/id_XNj….html`：视频（编码的 vid）；
// - `player.youku.com/embed/XNj…`：网页嵌的播放器，视频；
// - `?vid=XNj…`：视频；`v.youku.com/video?s=<节目>` / `?showid=<节目>`：节目；
// 其他 youku.com / youku.tv / tudou.com 的链接（分享短链等）跟着跳转再认一次。
import type { LinkResolution, Target } from '@iyt-source/protocol'
import { request } from './mtop.ts'

export const LINK_PATTERNS = ['^https?://([A-Za-z0-9-]+\\.)*(youku\\.com|youku\\.tv|tudou\\.com)(/|$|\\?)']

function isHost(host: string, ...domains: string[]): boolean {
  const h = host.toLowerCase()
  return domains.some((d) => h === d || h.endsWith('.' + d))
}

export function matchLink(raw: string): Target | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (!isHost(url.hostname, 'youku.com')) return undefined
  const vid = /(?:id_|\/embed\/)(X[0-9A-Za-z]+={0,2})/.exec(url.pathname) ?? /^(X[0-9A-Za-z]+={0,2})$/.exec(url.searchParams.get('vid') ?? '')
  if (vid) return { video: vid[1] }
  const show = /^([0-9a-z]{16,})$/.exec(url.searchParams.get('showid') ?? url.searchParams.get('s') ?? '')
  if (show) return { show: show[1] }
  return undefined
}

export async function resolveLink(raw: string, signal?: AbortSignal): Promise<LinkResolution | null> {
  const direct = matchLink(raw)
  if (direct) return { target: direct }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!isHost(url.hostname, 'youku.com', 'youku.tv', 'tudou.com')) return null
  // 跟着跳转（分享短链、旧地址），每一跳都认一次。
  let current = url.toString()
  for (let hop = 0; hop < 6; hop++) {
    let response: Response
    try {
      response = await request(current, { redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } })
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
    const location = response.headers.get('location')
    if (!location || response.status < 300 || response.status >= 400) {
      // 落地页：页面里写着的视频 id。
      const html = response.ok ? await response.text().catch(() => '') : ''
      const vid = /["']?(?:videoId|vid|videoEncodeId)["']?\s*[:=]\s*["'](X[0-9A-Za-z]+={0,2})["']/.exec(html)
      return vid ? { target: { video: vid[1] } } : null
    }
    await response.arrayBuffer().catch(() => undefined)
    current = new URL(location, current).toString()
    const found = matchLink(current)
    if (found) return { target: found }
  }
  return null
}
