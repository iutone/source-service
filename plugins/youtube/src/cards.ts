// adapter 读出的卡片 → 协议的条目（App 的 YTBrowse.swift）。Shorts、频道、合辑（RD…）不打开，列表里去掉。
import type { Episode, FeedSection, MediaItem, UploaderProfile, VideoItem } from '@iyt-source/protocol'
import type { Card, Page, Shelf } from '../rules/adapter.ts'

/** "9,176,254,724次观看"、"3260万位订阅者"、"1.2M views" → 数字。 */
export function parseCount(text: string | undefined): number | undefined {
  if (!text) return undefined
  const match = /([0-9][0-9,.]*)\s*(亿|万|千|[KkMmBb])?/.exec(text)
  if (!match) return undefined
  const number = Number(match[1].replaceAll(',', ''))
  if (!Number.isFinite(number)) return undefined
  const scale = { 亿: 1e8, 万: 1e4, 千: 1e3, k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() as '亿'] ?? 1
  return Math.round(number * scale)
}

/** "2天前"、"3 weeks ago" → 大约那时（YouTube 只给相对时间）。 */
export function parseRelativeDate(text: string | undefined, now = Date.now()): string | undefined {
  if (!text) return undefined
  const match = /(\d+)\s*(秒|分钟|小时|天|周|个月|月|年|second|minute|hour|day|week|month|year)/.exec(text)
  if (!match) return undefined
  const unit: Record<string, number> = {
    秒: 1, second: 1, 分钟: 60, minute: 60, 小时: 3600, hour: 3600, 天: 86400, day: 86400,
    周: 604800, week: 604800, 个月: 2592000, 月: 2592000, month: 2592000, 年: 31536000, year: 31536000,
  }
  return new Date(now - Number(match[1]) * unit[match[2]] * 1000).toISOString()
}

const isViews = (text: string) => /观看|views?|watching|人正在/i.test(text)

/** 一张卡片在列表里的样子；不打开的（Shorts、频道、合辑）为 undefined。 */
export function mediaItem(card: Card): MediaItem | undefined {
  const uploader = card.channelName ? { id: card.channelID ?? '', name: card.channelName } : undefined
  if (card.kind === 'playlist') {
    if (card.id.startsWith('RD')) return undefined
    return {
      id: card.id,
      title: card.title,
      subtitle: card.details.filter((d) => d !== card.channelName).join(' · ') || undefined,
      landscapeURL: card.thumbnail,
      badge: { text: '播放列表', tone: 'neutral' },
      uploader,
      target: { show: card.id },
    }
  }
  if (card.kind !== 'video') return undefined
  const views = card.details.find(isViews)
  const rest = card.details.filter((d) => !isViews(d) && d !== card.channelName)
  return {
    id: card.id,
    title: card.title,
    subtitle: rest.join(' · ') || undefined,
    landscapeURL: card.thumbnail,
    badge: card.isLive ? { text: '直播', tone: 'red' } : undefined,
    progress: card.progress,
    uploader,
    stats: views ? { views: parseCount(views) } : undefined,
    duration: card.duration,
    publishedAt: card.details.map((d) => parseRelativeDate(d)).find(Boolean),
    target: { video: card.id },
  }
}

export function videoItem(card: Card): VideoItem | undefined {
  if (card.kind !== 'video') return undefined
  return {
    id: card.id,
    title: card.title,
    subtitle: card.channelName,
    coverURL: card.thumbnail,
    progress: card.progress,
    watchedPercent: card.progress === undefined ? undefined : Math.round(card.progress * 100),
    historyKey: card.id,
  }
}

export function episode(card: Card, index: number): Episode | undefined {
  if (card.kind !== 'video') return undefined
  return {
    id: card.id,
    title: card.title,
    stage: String(index + 1),
    isFeature: true,
    imageURL: card.thumbnail,
    isPaid: false,
    duration: card.duration,
    views: parseCount(card.details.find(isViews)),
    publishedAt: card.details.map((d) => parseRelativeDate(d)).find(Boolean),
  }
}

/** 订阅的频道里的一个频道：handle 作签名，订阅数单独一行。 */
export function uploaderProfile(card: Card): UploaderProfile {
  const subscribers = card.details.find((d) => parseCount(d) !== undefined && !d.startsWith('@'))
  return {
    uploader: { id: card.id, name: card.title, avatarURL: card.thumbnail, followers: parseCount(subscribers) },
    signature: card.details.filter((d) => d !== subscribers).join(' · ') || undefined,
    isFollowing: true,
    detail: subscribers,
  }
}

export const items = (cards: Card[]) => cards.map(mediaItem).filter((item): item is MediaItem => item !== undefined)

/** 每个视频只出现一次。 */
export function uniqueItems(page: Page): MediaItem[] {
  const seen = new Set<string>()
  return items(page.shelves.flatMap((shelf) => shelf.cards)).filter((item) => !seen.has(item.id) && seen.add(item.id))
}

const isShelf = (shelf: Shelf) => shelf.cards.some((card) => mediaItem(card) !== undefined)

/**
 * 页面的分区：一页只有一个无标题列表（播放列表、下一页）就是一个网格；否则每行一个网格分区，有续页就带「更多」
 * （route 是这一行的续页 token，App 原样回传）。
 */
export function sections(page: Page): FeedSection[] {
  const shelves = page.shelves.filter(isShelf)
  if (shelves.length === 1 && !shelves[0].title) return [{ id: 'grid', style: 'grid', items: items(shelves[0].cards) }]
  return shelves.map((shelf) => {
    const list = items(shelf.cards)
    // 不同页会出现同名的行：用第一个视频区分（同 id 的网格会被 App 合并）。
    const id = `shelf-${list[0].id}-${shelf.title ?? ''}`
    return {
      id,
      title: shelf.title,
      style: 'grid' as const,
      items: list,
      more: shelf.continuation ? { title: shelf.title ?? '更多', route: shelf.continuation } : undefined,
    }
  })
}

/** 订阅页的时间线：无标题的三列行合成一个网格；「最相关」和 Shorts 这些有标题的行不要。 */
export function timeline(page: Page): FeedSection[] {
  const list = items(page.shelves.filter((shelf) => !shelf.title).flatMap((shelf) => shelf.cards))
  return list.length ? [{ id: 'grid', style: 'grid', items: list }] : []
}
