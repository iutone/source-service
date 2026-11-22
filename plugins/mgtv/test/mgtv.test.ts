// 解析用的是网站上抓的响应（test/fixtures，来自 docs/mgtv-web/samples，凭证已替换），和 App 的 MgtvParsingTests 一一对应。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { avatar, image, isVIP, membership, pageIDs, parseID, query, signedQuery, timestamp } from '../src/api.ts'
import { linkTarget, selectStream } from '../src/index.ts'
import {
  comment, danmaku, episodeList, historyItem, libraryItem, lockedReason, markers, moduleSection, parseEpisodesCursor,
  pickRenditions, qualityLabel, qualityRank, restriction, searchResults, showDetail,
} from '../src/parse.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

describe('签名与编码', () => {
  it('搜索签名和网页端一致', () => {
    // Chrome 里抓的一个请求：签名是 MD5(盐 + 规范 query + 盐)。
    const signed = signedQuery({
      allowedRC: '1', _support: '10000000', src: 'mgtv', did: '5bd0b440-0d80-4289-ad93-5bec530ea6a6',
      timestamp: '2026-10-19T11:43:53Z', signVersion: '1', signNonce: '59d52ddcbdf24c2f8197eca3ab7c17d6',
      q: '大主宰', pn: '1', pc: '10', uid: '', corr: '1',
    })
    expect(signed.endsWith('&signature=09af603f98eb8bf55e2455d86885feff')).toBe(true)
    expect(signed.startsWith('_support=10000000&allowedRC=1&corr=1&did=')).toBe(true)
    expect(signed).toContain('q=%E5%A4%A7%E4%B8%BB%E5%AE%B0&signNonce=')
    expect(signed).not.toContain('uid=')
  })

  it('表单编码按 key 排序', () => {
    expect(query({ b: 'x y', a: "1!*'()" })).toBe('a=1%21%2A%27%28%29&b=x%20y')
  })

  it('时间戳到秒', () => {
    expect(timestamp(new Date('2026-10-19T11:43:53.123Z'))).toBe('2026-10-19T11:43:53Z')
  })
})

describe('id 与链接', () => {
  it('读 id', () => {
    expect(parseID('v24721841')).toEqual({ kind: 'video', id: '24721841' })
    expect(parseID('c899395')).toEqual({ kind: 'clip', id: '899395' })
    expect(parseID('x1')).toBeUndefined()
    expect(parseID('v')).toBeUndefined()
    expect(pageIDs('//www.mgtv.com/b/859271/24465089.html?fpa=se')).toEqual({ clip: '859271', video: '24465089' })
    expect(pageIDs('//www.mgtv.com/h/859271.html?fpa=se')).toEqual({ clip: '859271', video: undefined })
  })

  it('认得播放页链接', () => {
    expect(linkTarget('https://www.mgtv.com/b/859271/24465089.html?fpa=se')).toEqual({ target: { video: 'v24465089' } })
    expect(linkTarget('https://m.mgtv.com/b/859271/24465089.html')).toEqual({ target: { video: 'v24465089' } })
    expect(linkTarget('https://www.mgtv.com/h/859271.html')).toEqual({ target: { show: 'c859271' } })
    expect(linkTarget('https://www.mgtv.com/b/859271.html')).toEqual({ target: { show: 'c859271' } })
    expect(linkTarget('https://www.mgtv.com/')).toBeNull()
    expect(linkTarget('https://www.example.com/b/1/2.html')).toBeNull()
    expect(linkTarget('not a url')).toBeNull()
  })

  it('图片地址统一成 https', () => {
    expect(image('http://a.hitv.com/x.jpg')).toBe('https://a.hitv.com/x.jpg')
    expect(image('//a.hitv.com/x.jpg')).toBe('https://a.hitv.com/x.jpg')
    expect(image('')).toBeUndefined()
  })
})

describe('频道', () => {
  it('首页模块成为分区', () => {
    const modules: any[] = fixture('module-infos-home-1').data
    const sections = modules.map((m) => moduleSection(m, 't-listSinglePortrait', '5')).filter((s) => s !== undefined)
    expect(sections.length).toBeGreaterThanOrEqual(4)
    const shows = sections.find((s) => s.title === '王牌节目')!
    expect(shows.style).toBe('row')
    expect(shows.items[0].target).toEqual({ show: 'c893106' })
    expect(shows.items[0].posterURL?.startsWith('https://')).toBe(true)
    // 推荐信息流的单条卡片（DSL 686）没有 items，不成分区。
    expect(sections.some((s) => s.id === '5:12440')).toBe(false)
  })

  it('焦点图指向视频', () => {
    const focus = fixture('channel-index-home').data.find((m: any) => m.moduleEntityId === '1871' || m.moduleEntityId === 1871)
    const section = moduleSection(focus, 't-focus', '5')!
    expect(section.style).toBe('hero')
    expect(section.title).toBeUndefined()
    expect(section.items[0].target).toEqual({ video: 'v24697722' })
    expect(section.items[0].badge?.text).toBe('HOT')
  })

  it('片库条目', () => {
    const item = libraryItem({ clipId: 895854, title: '伦敦合伙人', img: 'http://x/y.jpg', zhihuScore: '8.25', rightCorner: { text: 'VIP' } })!
    expect(item).toMatchObject({ id: 'c895854', target: { show: 'c895854' }, posterURL: 'https://x/y.jpg', caption: '8.3分', badge: { tone: 'gold' } })
  })
})

describe('详情', () => {
  it('分季与正片', () => {
    const list = episodeList(fixture('vod-video-positives').data, '776903', 1, 1)
    expect(list.parts?.map((p) => p.title)).toEqual(['2026', '2025', '2024', '第二季', '第一季'])
    expect(list.parts?.find((p) => p.isCurrent)?.id).toBe('c776903')
    expect(list.episodes.length).toBe(53) // 只有正片，去掉 videoId 0 的运营条目
    expect(list.episodes[0]).toMatchObject({ id: 'v23298726', stage: '2025-08-02', isPaid: false })
    expect(list.episodes[1].badge?.text).toBe('VIP')
  })

  it('播放页模板', () => {
    const detail = showDetail(fixture('vod-info').data, '899395')
    expect(detail.title).toBe('我家那闺女2026')
    expect(detail.showID).toBe('c899395')
    expect(detail.category).toBe('综艺')
    expect(detail.summary).toBeTruthy()
    expect(detail.tags).toContain('家庭')
  })

  it('分集游标', () => {
    expect(parseEpisodesCursor('ep:776903:2:1')).toEqual({ clip: '776903', page: 2, type: 1 })
    expect(parseEpisodesCursor('ep:776903:2')).toEqual({ clip: '776903', page: 2, type: undefined })
    expect(parseEpisodesCursor('lib:1:c2')).toBeUndefined()
  })
})

describe('历史、弹幕、评论', () => {
  it('历史记录', () => {
    const item = historyItem(fixture('playhistory-v2-get-after').data.playList[0])!
    expect(item).toMatchObject({ id: 'v24721841', showID: 'c899395', title: '我家那闺女2026', subtitle: '2026-10-18', progress: 0, historyKey: '16908204414' })
  })

  it('弹幕', () => {
    const comments = danmaku(fixture('opbarrage').data.items)
    expect(comments.length).toBe(7)
    expect(comments[0]).toMatchObject({ text: 'iii', time: 0.954, color: '#FFFFFF', position: 'scroll' })
  })

  it('评论带前几条回复', () => {
    const list: any[] = fixture('comments-hot').data.list
    const comments = list.map((entry) => comment(entry, '24697722', false)).filter((c) => c !== undefined)
    expect(comments.length).toBe(3)
    const first = comments[0]
    expect(first).toMatchObject({ id: '646835507', author: { name: '芒果评论君' }, location: '湖南', likes: 100, replyCount: 27 })
    expect(first.previewReplies?.length).toBe(2)
    expect(first.pictures?.length).toBe(1)
    expect(JSON.parse(first.replies!)).toEqual({ kind: 'replies', subject: '24697722', hot: false, page: 1, comment: '646835507' })
    expect(first.previewReplies!.every((reply) => reply.replies === undefined)).toBe(true)
  })
})

describe('搜索', () => {
  it('只留芒果TV自己的节目', () => {
    const results = searchResults(fixture('search-v2-program').data.contents, '乘风破浪')
    const all = [...(results.topMatch ? [results.topMatch.show] : []), ...results.shows]
    expect(all.every((item) => 'show' in item.target && item.target.show.startsWith('c'))).toBe(true)
    // 同名的腾讯电影不要。
    expect(all.filter((item) => item.title === '乘风破浪').length).toBe(1)
    expect(results.topMatch?.show.title).toBe('乘风破浪')
  })
})

describe('播放', () => {
  it('付费集只给试看时是 restricted', () => {
    const list = fixture('streamList-24721841').data
    expect(restriction(list)).toBe('开通会员可免费观看本片')
    const locked = list.stream.find((s: any) => Number(s.definition) === 4)
    expect(lockedReason(locked)).toBe('VIP')
    expect(qualityLabel(locked)).toBe('1080P')
    expect(qualityRank(locked)).toBe(1080)
    expect(qualityRank({ definition: '2' })).toBe(576)
  })

  it('每档一个，H.265 有地址时优先', () => {
    const list = {
      stream: [{ definition: '3', url: '/a', videoFormat: 'H264' }, { definition: '4', url: '', needPay: 1 }],
      stream_h265: [{ definition: '3', url: '/h', videoFormat: 'H265' }, { definition: '5', url: '/x' }],
    }
    const picked = pickRenditions(list, true)
    expect(picked.get(3)?.url).toBe('/h')
    expect(picked.get(4)?.needPay).toBe(1)
    expect(picked.has(5)).toBe(false)
    expect(pickRenditions(list, false).get(3)?.url).toBe('/a')
  })

  it('按偏好选流', () => {
    const stream = (id: string, rank: number, locked = false) => ({
      id, url: '/', format: 'hls' as const, quality: { rank, label: id }, description: '', ...(locked ? { unavailableReason: 'VIP' } : {}),
    })
    const streams = [stream('1080', 1080, true), stream('720', 720), stream('480', 480)]
    expect(selectStream(streams)?.id).toBe('720')
    expect(selectStream(streams, 576)?.id).toBe('480')
    expect(selectStream(streams, 360)?.id).toBe('480')
  })

  it('片头片尾与看点', () => {
    expect(markers({ start: '106|片头', end: '2538|片尾', content: ['781|叶平君拔枪直指虞昶轩'] }))
      .toEqual({ introEnd: 106, outroStart: 2538, chapters: [{ start: 781, title: '叶平君拔枪直指虞昶轩' }] })
    expect(markers({ start: '', end: '', content: [] })).toBeUndefined()
  })
})

describe('账号', () => {
  it('会员以到期时间为准', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    const active = { vipinfo: { isvip: 1, vip_end_time: '2026-11-19 23:59:59' } }
    const lapsed = { isvip: 1, vipinfo: { isvip: 1, vip_end_time: '2023-10-03 23:59:59' } }
    expect(isVIP(active, now)).toBe(true)
    expect(isVIP(lapsed, now)).toBe(false)
    expect(membership(active, now)).toEqual({ tier: '会员', active: true, endsAt: '2026-11-19T15:59:59.000Z' })
    expect(membership({}, now)).toBeUndefined()
    expect(avatar('{"s":"http://a/s.png","l":"http://a/l.png"}')).toBe('https://a/l.png')
  })
})
