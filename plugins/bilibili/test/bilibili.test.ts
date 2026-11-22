import { describe, expect, it } from 'vitest'
import { episodePaywall, episodeTitle, paywallMessage, seasonGroups, viewPaywall, type BiliSeason, type BiliView } from '../src/catalog.ts'
import { day, pages, seasonEpisodes, seasonResume, videoEpisodes } from '../src/detail.ts'
import { channels, RANKINGS } from '../src/feed.ts'
import { av2bv, bv2av, episodeFromRedirect, isShortLink, LINK_PATTERNS, linkTarget, parseID } from '../src/ids.ts'
import { decodeCursor, encodeCursor } from '../src/interact.ts'
import {
  archiveItem, cuesToVTT, dynamicItem, historyItem, parseCount, parseDanmakuSegment, parseDuration, plainTitle, replyComment,
  searchSeason, searchVideo, seasonItem, subtitleCues,
} from '../src/models.ts'
import { clipMarkers, expiry, isPCDN, preferredTrack, subtitleList, trackURLs, type PlayTrack } from '../src/playback.ts'
import { apiError, credentialOf, image, navMembership } from '../src/session.ts'
import { appSigned, APP_SECRET, md5, mixinKey, query, wbiKey, wbiSigned } from '../src/sign.ts'

describe('签名', () => {
  it('WBI 和 bilibili-API-collect 的例子一致', () => {
    const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
    expect(key).toBe('ea1db124af3c7062474693fa704f4ff8')
    const signed = wbiSigned({ foo: '114', bar: '514', zab: '1919810' }, key, 1_702_204_169_000)
    expect(signed.wts).toBe('1702204169')
    expect(signed.w_rid).toBe('8f6f2b5b3d485fe1886cec6a0be8c5d4')
  })

  it('WBI 去掉值里的 !\'()*', () => {
    expect(wbiSigned({ q: "a!b'c(d)e*" }, 'k', 0).q).toBe('abcde')
  })

  it('wbi_img 的文件名就是 key', () => {
    expect(wbiKey('https://i0.hdslb.com/bfs/wbi/7cd0849413.png')).toBe('7cd0849413')
    expect(wbiKey(undefined)).toBeUndefined()
  })

  it('query 按键排序、像 encodeURIComponent 一样编码', () => {
    expect(query({ b: 'a b', a: '中' })).toBe('a=%E4%B8%AD&b=a%20b')
  })

  it('app 签名是排序后的 query 加 appsec 的 md5', () => {
    const signed = appSigned({ auth_code: 'x' }, 1_700_000_000_000)
    const { sign, ...unsigned } = signed
    expect(sign).toBe(md5(query(unsigned) + APP_SECRET))
    expect(signed).toMatchObject({ appkey: '5ae412b53418aac5', ts: '1700000000', auth_code: 'x' })
  })
})

describe('id 与链接', () => {
  it('解析 App 的 id', () => {
    expect(parseID('BV17x411w7KC')).toEqual({ kind: 'video', bvid: 'BV17x411w7KC', cid: undefined })
    expect(parseID('BV17x411w7KC#279786')).toEqual({ kind: 'video', bvid: 'BV17x411w7KC', cid: 279786 })
    expect(parseID('ep123')).toEqual({ kind: 'episode', epid: 123 })
    expect(parseID('ss456')).toEqual({ kind: 'season', sid: 456 })
    expect(parseID('av170001')).toBeUndefined()
    expect(parseID('BVshort')).toBeUndefined()
  })

  it('av 和 BV 互转', () => {
    expect(av2bv(170001)).toBe('BV17x411w7KC')
    expect(bv2av('BV17x411w7KC')).toBe(170001)
    expect(bv2av(av2bv(117644908825124))).toBe(117644908825124)
  })

  it('读 redirect_url 里的那一集', () => {
    expect(episodeFromRedirect('https://www.bilibili.com/bangumi/play/ep327107?from=1')).toBe(327107)
    expect(episodeFromRedirect('https://www.bilibili.com/video/BV1')).toBeUndefined()
    expect(episodeFromRedirect(undefined)).toBeUndefined()
  })

  it.each([
    ['https://www.bilibili.com/video/BV17x411w7KC/?spm_id_from=333.1007', { video: 'BV17x411w7KC' }],
    ['https://m.bilibili.com/video/BV17x411w7KC', { video: 'BV17x411w7KC' }],
    ['https://www.bilibili.com/video/av170001', { video: 'BV17x411w7KC' }],
    ['https://player.bilibili.com/player.html?bvid=BV17x411w7KC&page=1', { video: 'BV17x411w7KC' }],
    ['https://player.bilibili.com/player.html?aid=170001', { video: 'BV17x411w7KC' }],
    ['https://www.bilibili.com/bangumi/play/ep123', { video: 'ep123' }],
    ['https://www.bilibili.com/bangumi/play/ss26283?theme=movie', { show: 'ss26283' }],
  ])('认 %s', (url, target) => {
    expect(linkTarget(url)).toEqual({ target })
    expect(LINK_PATTERNS.some((pattern) => new RegExp(pattern).test(url))).toBe(true)
  })

  it('不认的链接', () => {
    expect(linkTarget('https://www.bilibili.com/')).toBeNull()
    expect(linkTarget('https://space.bilibili.com/546195')).toBeNull()
    expect(linkTarget('https://example.com/video/BV17x411w7KC')).toBeNull()
    expect(linkTarget('not a url')).toBeNull()
  })

  it('短链接', () => {
    expect(isShortLink(new URL('https://b23.tv/abc123'))).toBe(true)
    expect(isShortLink(new URL('https://bili2233.cn/abc'))).toBe(true)
    expect(isShortLink(new URL('https://www.bilibili.com/video/BV1'))).toBe(false)
    expect(LINK_PATTERNS.some((pattern) => new RegExp(pattern).test('https://b23.tv/abc123'))).toBe(true)
  })
})

describe('列表条目', () => {
  it('图片换 https、加尺寸', () => {
    expect(image('//i0.hdslb.com/bfs/a.jpg', 672, 378)).toBe('https://i0.hdslb.com/bfs/a.jpg@672w_378h_1c.jpg')
    expect(image('http://i0.hdslb.com/bfs/a.jpg')).toBe('https://i0.hdslb.com/bfs/a.jpg')
    expect(image('https://i0.hdslb.com/bfs/a.jpg@1w.jpg', 1, 1)).toBe('https://i0.hdslb.com/bfs/a.jpg@1w.jpg')
    expect(image('')).toBeUndefined()
  })

  it('数字和时长', () => {
    expect(parseCount('9876')).toBe(9876)
    expect(parseCount('1.2万')).toBe(12000)
    expect(parseCount('3.4亿')).toBe(340_000_000)
    expect(parseCount('--')).toBeUndefined()
    expect(parseDuration('03:07')).toBe(187)
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('x')).toBeUndefined()
  })

  it('投稿视频；广告不要；番剧的投稿版指向那一集', () => {
    const item = archiveItem({
      bvid: 'BV1xx411c7mD', title: '标题', pic: 'http://i1.hdslb.com/bfs/archive/a.jpg', duration: 200, pubdate: 1_700_000_000,
      owner: { mid: 1, name: 'UP', face: '//i0.hdslb.com/f.jpg' }, stat: { view: 10, danmaku: 2, like: 3 }, rcmd_reason: { content: '百万播放' },
    })
    expect(item).toEqual({
      id: 'BV1xx411c7mD', title: '标题', subtitle: '百万播放', landscapeURL: 'https://i1.hdslb.com/bfs/archive/a.jpg@672w_378h_1c.jpg',
      uploader: { id: '1', name: 'UP', avatarURL: 'https://i0.hdslb.com/f.jpg@96w_96h_1c.jpg' }, stats: { views: 10, danmaku: 2, likes: 3 },
      duration: 200, publishedAt: '2023-11-14T22:13:20.000Z', target: { video: 'BV1xx411c7mD' },
    })
    expect(archiveItem({ bvid: 'BV1', title: 'ad', goto: 'ad' })).toBeUndefined()
    expect(archiveItem({ bvid: 'BV1xx411c7mD', title: 't', redirect_url: 'https://www.bilibili.com/bangumi/play/ep9' })?.target).toEqual({ video: 'ep9' })
  })

  it('季', () => {
    expect(seasonItem({ season_id: 1, title: '番', cover: 'https://i0.hdslb.com/c.png', badge: '会员专享', index_show: '全12话', progress: '看到第3话' })).toEqual({
      id: 'ss1', title: '番', subtitle: '看到第3话', posterURL: 'https://i0.hdslb.com/c.png@360w_480h_1c.jpg',
      badge: { text: '会员专享', tone: 'red' }, caption: '全12话', target: { show: 'ss1' },
    })
  })

  it('动态里的视频', () => {
    const item = dynamicItem({
      modules: {
        module_author: { mid: 9, name: 'UP', pub_ts: '1700000000' },
        module_dynamic: { major: { archive: { bvid: 'BV1xx411c7mD', title: 't', duration_text: '01:02', stat: { play: '1.5万', danmaku: '12' } } } },
      },
    })
    expect(item).toMatchObject({ id: 'BV1xx411c7mD', duration: 62, stats: { views: 15000, danmaku: 12 }, uploader: { id: '9', name: 'UP' } })
    expect(dynamicItem({ modules: {} })).toBeUndefined()
  })

  it('搜索结果去掉高亮', () => {
    expect(plainTitle('<em class="keyword">原神</em> &amp; 你')).toBe('原神 & 你')
    expect(searchVideo({ bvid: 'BV1xx411c7mD', title: '<em>a</em>', play: '100', duration: '1:00', author: 'UP', mid: 3 }))
      .toMatchObject({ title: 'a', stats: { views: 100 }, duration: 60, uploader: { id: '3', name: 'UP' } })
    expect(searchSeason({ season_id: 5, title: 't', season_type_name: '番剧' })).toMatchObject({ id: 'ss5', subtitle: '番剧', target: { show: 'ss5' } })
  })

  it('观看历史', () => {
    expect(historyItem({ title: 't', history: { business: 'archive', bvid: 'BV1xx411c7mD', oid: 7, cid: 99, page: 2 }, progress: 30, duration: 60, view_at: 1_700_000_000 }))
      .toMatchObject({ id: 'BV1xx411c7mD#99', progress: 0.5, watchedPercent: 50, historyKey: 'archive_7' })
    expect(historyItem({ title: 't', history: { business: 'pgc', epid: 3 }, kid: 4, progress: -1, duration: 100 }))
      .toMatchObject({ id: 'ep3', showID: 'ss4', progress: 1, historyKey: 'pgc_4' })
    expect(historyItem({ title: 'live', history: { business: 'live' } })).toBeUndefined()
  })

  it('评论：回复对象挪出来，表情和图片', () => {
    const comment = replyComment({
      rpid: 1, oid: 2, ctime: 1_700_000_000, like: 5, rcount: 3,
      member: { uname: '甲', vip: { vipStatus: 1, nickname_color: '#FB7299' } },
      content: { message: '回复 @乙 :好的[doge]', emote: { '[doge]': { url: 'http://i0.hdslb.com/e.png' } }, pictures: [{ img_src: 'http://i0.hdslb.com/p.jpg' }] },
      reply_control: { location: 'IP属地：广东' },
    }, true, (r) => `r${r.rpid}`)
    expect(comment).toMatchObject({
      id: '1', text: '好的[doge]', repliesTo: '乙', author: { name: '甲', nameColor: '#FB7299' },
      emotes: { '[doge]': 'https://i0.hdslb.com/e.png' }, pictures: ['https://i0.hdslb.com/p.jpg'],
      location: '广东', likes: 5, replyCount: 3, replies: 'r1', isPinned: true,
    })
  })

  it('评论游标来回', () => {
    const cursor = { kind: 'main' as const, oid: 1, mode: 3, offset: '{"a":1}' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
    expect(() => decodeCursor('bad')).toThrow()
  })
})

describe('弹幕（protobuf）', () => {
  const varint = (value: number | bigint) => {
    const bytes: number[] = []
    let v = BigInt(value)
    do {
      let byte = Number(v & 0x7fn)
      v >>= 7n
      if (v > 0n) byte |= 0x80
      bytes.push(byte)
    } while (v > 0n)
    return bytes
  }
  const field = (number: number, value: number | string | number[]) => {
    if (typeof value === 'number') return [...varint((number << 3) | 0), ...varint(value)]
    const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : value
    return [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes]
  }
  const element = (progress: number, mode: number, color: number, text: string, id: string) =>
    field(1, [...field(1, 123), ...field(2, progress), ...field(3, mode), ...field(5, color), ...field(7, text), ...field(12, id)])

  it('读出滚动 / 顶部 / 底部，跳过高级弹幕', () => {
    const bytes = new Uint8Array([
      ...element(1500, 1, 0xffffff, '前方高能', 'a'),
      ...element(3000, 5, 0xfe0302, '顶部', 'b'),
      ...element(4000, 7, 0, '高级', 'c'),
      ...field(2, [1, 2, 3]),
    ])
    expect(parseDanmakuSegment(bytes)).toEqual([
      { id: 'a', time: 1.5, text: '前方高能', position: 'scroll', color: '#FFFFFF' },
      { id: 'b', time: 3, text: '顶部', position: 'top', color: '#FE0302' },
    ])
  })
})

const episode = (id: number, extra: Partial<BiliSeason['episodes'][number]> = {}) => ({ id, title: String(id), cid: id * 10, aid: id * 100, ...extra })

describe('详情', () => {
  const season: BiliSeason = {
    season_id: 9, title: '季', type: 1,
    episodes: [episode(1), episode(2, { section_type: 1, title: 'PV1' }), episode(3, { long_title: '名字', duration: 120_000 })],
    section: [{ title: '预告', episodes: [episode(4, { title: 'PV' })] }, { title: '花絮', episodes: [episode(5)] }],
    seasons: [{ season_id: 9, season_title: '第一季' }, { season_id: 10, season_title: '第二季' }],
    user_status: { progress: { last_ep_id: 3, last_time: 60 } },
  }

  it('分组：正片、预告（并进混在正片里的）、其他', () => {
    expect(seasonGroups(season).map((g) => [g.title, g.episodes.map((e) => e.id)])).toEqual([['正片', [1, 3]], ['预告', [4, 2]], ['花絮', [5]]])
    expect(episodeTitle(episode(3, { long_title: '名字' }))).toBe('第3话 名字')
    expect(episodeTitle(episode(1, { show_title: '第1话 自己的' }))).toBe('第1话 自己的')
  })

  it('季的分集和续播', () => {
    const list = seasonEpisodes(season, 0, 0, 5)
    expect(list.episodes.map((e) => e.id)).toEqual(['ep5'])
    expect(list.selectedRange?.title).toBe('花絮')
    expect(list.ranges?.length).toBe(3)
    expect(list.parts).toEqual([{ id: 'ss9', title: '第一季', isCurrent: true }, { id: 'ss10', title: '第二季', isCurrent: false }])
    expect(seasonResume(season)).toEqual({ videoID: 'ep3', progress: 0.5 })
  })

  it('长分组按 50 集一页', () => {
    expect(pages(120, '正片', (s) => `c${s}`).map((r) => r.title)).toEqual(['1-50', '51-100', '101-120'])
    expect(pages(3, undefined, (s) => `c${s}`)).toEqual([{ title: '全部', cursor: 'c0' }])
  })

  it('投稿视频的分P', () => {
    const view: BiliView = { aid: 1, bvid: 'BV1xx411c7mD', cid: 11, title: 't', pages: [{ cid: 11, page: 1, part: '上' }, { cid: 12, page: 2, part: '下' }] }
    const list = videoEpisodes(view, 0, 0, 'BV1xx411c7mD#12')
    expect(list.episodes.map((e) => [e.id, e.stage])).toEqual([['BV1xx411c7mD', 'P1'], ['BV1xx411c7mD#12', 'P2']])
    expect(list.summary).toBe('共2P')
    expect(videoEpisodes({ aid: 1, bvid: 'BV1', cid: 1, title: 't' }, 0, 0).episodes).toEqual([])
  })

  it('东八区的日期', () => {
    expect(day(1_700_000_000)).toBe('2023-11-15')
  })

  it('付费墙', () => {
    expect(viewPaywall({ aid: 1, bvid: 'b', cid: 1, title: 't', is_upower_exclusive: true })).toEqual({ kind: 'charge' })
    const paid = episodePaywall(episode(1, { status: 8 }), { ...season, payment: { price: '6.0', vip_price: '4.8' } })
    expect(paywallMessage(paid!, false)).toBe('付费内容，需在哔哩哔哩单独购买后观看（¥6，大会员 ¥4.8）')
    expect(paywallMessage(episodePaywall(episode(1, { badge: '会员专享' }), season)!, false)).toBe('大会员专享内容，开通哔哩哔哩大会员后才能观看')
  })
})

describe('播放', () => {
  const track = (codecs: string, bandwidth: number, url = 'https://upos-sz-mirrorcos.bilivideo.com/a.m4s?deadline=2000000000'): PlayTrack =>
    ({ id: 80, base_url: url, backup_url: ['https://x.mcdn.bilivideo.cn:4483/a.m4s'], bandwidth, codecs })

  it('H.264 优先，再 HEVC；AV1 不要', () => {
    expect(preferredTrack([track('av01.0.08M.08', 1), track('hev1.1.6.L120.90', 2), track('avc1.640032', 3)])?.codec).toBe('avc')
    expect(preferredTrack([track('av01.0.08M.08', 1), track('hev1.1.6.L120.90', 2), track('hvc1.1.6.L120.90', 1)])?.track.codecs).toBe('hvc1.1.6.L120.90')
    expect(preferredTrack([track('av01.0.08M.08', 1)])).toBeUndefined()
  })

  it('PCDN 排最后', () => {
    expect(isPCDN('https://x.mcdn.bilivideo.cn:4483/a.m4s')).toBe(true)
    expect(isPCDN('https://upos-sz-mirrorcos.bilivideo.com/a.m4s')).toBe(false)
    expect(trackURLs({ ...track('avc1', 1, 'https://x.szbdyd.com/a'), backup_url: ['https://cn-gd.bilivideo.com/b'] })).toEqual(['https://cn-gd.bilivideo.com/b', 'https://x.szbdyd.com/a'])
  })

  it('过期时间取最早的 deadline', () => {
    expect(expiry({ duration: 1, video: [track('avc1', 1)], audio: [track('mp4a', 1, 'https://a/b?deadline=1900000000')] }, 0)).toBe(1_900_000_000_000)
    expect(expiry({ duration: 1, video: [track('avc1', 1, 'https://a/b')] }, 0)).toBe(2 * 3600_000)
  })

  it('片头片尾', () => {
    expect(clipMarkers([{ start: 0, end: 90, clipType: 'CLIP_TYPE_OP' }, { start: 1300, end: 1400, clipType: 'CLIP_TYPE_ED' }])).toEqual({ introEnd: 90, outroStart: 1300 })
    expect(clipMarkers([])).toBeUndefined()
  })

  it('字幕：上传的在前，AI 的标成生成', () => {
    const list = subtitleList({ subtitle: { subtitles: [
      { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/a.json' },
      { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: '//i0.hdslb.com/b.json' },
      { lan: 'en', subtitle_url: '' },
    ] } })
    expect(list).toEqual([
      { key: 'zh-CN', name: '中文（中国）', language: 'zh-CN', generated: false, url: 'https://i0.hdslb.com/b.json' },
      { key: 'zh.asr', name: '中文（自动生成）', language: 'zh', generated: true, url: 'https://aisubtitle.hdslb.com/a.json' },
    ])
  })

  it('字幕 JSON → 句子 → WebVTT', () => {
    const cues = subtitleCues({ body: [{ from: 1.5, to: 3, content: '你好' }, { from: 3661.25, to: 3662, content: '再见' }] })
    expect(cues).toEqual([{ start: 1.5, end: 3, text: '你好' }, { start: 3661.25, end: 3662, text: '再见' }])
    expect(cuesToVTT(cues)).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\n你好\n\n01:01:01.250 --> 01:01:02.000\n再见\n')
  })
})

describe('账号', () => {
  it('扫码结果 → 凭证', () => {
    const credential = credentialOf({
      token_info: { mid: 42, access_token: 'a', refresh_token: 'r', expires_in: 100 },
      cookie_info: { cookies: [{ name: 'SESSDATA', value: 's', expires: 2 }, { name: 'bili_jct', value: 'j' }] },
    }, 1_000_000)
    expect(credential).toEqual({
      mid: '42', cookies: [{ name: 'SESSDATA', value: 's', expires: 2 }, { name: 'bili_jct', value: 'j', expires: undefined }],
      token: { accessToken: 'a', refreshToken: 'r', expiresAt: 1100 },
    })
  })

  it('大会员', () => {
    expect(navMembership({ vipType: 2, vipStatus: 1, vipDueDate: 1_800_000_000_000, vip_label: { text: '年度大会员' } }))
      .toEqual({ tier: '年度大会员', active: true, endsAt: '2027-01-15T08:00:00.000Z' })
    expect(navMembership({ vipType: 0, vipDueDate: 0 })).toBeUndefined()
  })

  it('错误码', () => {
    expect(apiError(-101, '账号未登录').code).toBe('login_required')
    expect(apiError(-352, '').code).toBe('throttled')
    expect(apiError(-404, '啥都木有').code).toBe('not_found')
    expect(apiError(-10403, '地区限制').code).toBe('restricted')
    expect(apiError(12345, '别的').message).toBe('别的（12345）')
  })
})

describe('频道', () => {
  it('首页是关注，置顶推荐、热门、排行榜、番剧、影视，「我的」四个书架', () => {
    const list = channels()
    expect(list.home).toEqual({ id: 'follow', title: '关注' })
    expect(list.pinned.map((c) => c.title)).toEqual(['推荐', '热门', '排行榜', '番剧', '影视'])
    expect(list.pinned[2].subchannels).toBe(RANKINGS)
    expect(list.pinned[3].filterCategories?.map((c) => c.title)).toEqual(['番剧', '国创'])
    expect(list.library.map((s) => [s.channel.id, s.content])).toEqual([['toview', 'feed'], ['favorites', 'subchannels'], ['seasons', 'subchannels'], ['followings', 'uploaders']])
  })
})
