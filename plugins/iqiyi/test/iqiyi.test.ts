// 单元测试：签名（向量取自网站自己的请求，同 App 的 IQiyiSignerTests）、id、链接、解析。
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { comment } from '../src/comments.ts'
import { danmakuFromZlib } from '../src/danmaku.ts'
import { clock, detailOf, episode, recommendation, resumePoint } from '../src/detail.ts'
import { cardItem, dimension, editorialSections, filterParam, libraryItem } from '../src/feed.ts'
import { historyItem } from '../src/history.ts'
import { matchLink, inspectPage, slugID } from '../src/links.ts'
import { bidFor, capabilities, dashURL, normalizePlaylist, parseDash, selectedRendition, unavailable } from '../src/playback.ts'
import { credentialFrom, membership } from '../src/session.ts'
import { show, video } from '../src/search.ts'
import { authKey, image, parseID, parseJSON, qipsValue, tvgSign, vf, VF_SALT } from '../src/util.ts'

describe('签名', () => {
  it('vf 的盐和网页播放器的一致', () => {
    expect(VF_SALT).toBe('ulc2h7tka0mdrf2lkb1n6m6mulc2htbn')
  })

  it('authKey、vf、tvg sign 与浏览器的请求一致', () => {
    expect(authKey('', '1792235433653', '6411410812043600')).toBe('a9f200e6ec2b6bbffcd7ec65588f4bb7')
    const path = '/dash?tvid=6411410812043600&bid=600&src=01080031010000000000&vt=0&rs=1&uid=&ori=pcw&ps=0&k_uid=29092973679b92682553eb2854a8d927&pt=0&d=0&s=&lid=undefined&cf=0&ct=0&authKey=a9f200e6ec2b6bbffcd7ec65588f4bb7&k_tag=1&dfp=a1fff959c1ec4a407e998358a4d15666669135a498ad8b934b43613149e1a6df7e&locale=zh_cn&up=&qd_v=a1&tm=1792235433653&ppt=0&k_ft1=704237197590532&k_ft4=1170017878024196&k_ft5=17592337039361&k_ft7=26422940794880&k_ftx=CA&k_ftx2=g&fr_300=120_120_120_120_120_120&fr_500=120_120_120_120_120_120&fr_600=120_120_120_120_120_120&fr_800=120_120_120_120_120_120&bop=%7B%22version%22%3A%2210.0%22%2C%22dfp%22%3A%22a1fff959c1ec4a407e998358a4d15666669135a498ad8b934b43613149e1a6df7e%22%2C%22b_ft1%22%3A60%7D&cpt=3&sr=1&ost=0&apdl=1&ut=0'
    expect(vf(path)).toBe('e318bd390e32e4b0d4db937aa5dea60b')
    expect(tvgSign({
      app_version: '17.102.26596', device_id: '29092973679b92682553eb2854a8d927', only_long: '0',
      page_num: '1', page_size: '50', src: 'pcw', timestamp: '1792235509114',
    })).toBe('E76C99399158DFFB3BA6594D74C2457E')
  })

  it('能力位：FairPlay 照 Safari，Widevine 照 Chrome，都不要时两种都不声明', () => {
    const bits = (value: string | undefined) => {
      const n = BigInt(value ?? '0')
      return Array.from({ length: 64 }, (_, i) => i + 1).filter((b) => (n >> BigInt(b - 1)) & 1n)
    }
    const withFP = Object.fromEntries(capabilities('fairplay'))
    const without = Object.fromEntries(capabilities('none'))
    expect(bits(withFP.k_ft1)).toEqual([3, 40, 48, 50])
    expect(bits(withFP.k_ft4)).toEqual(expect.arrayContaining([10, 11, 12, 29]))
    expect(bits(without.k_ft4).filter((b) => [10, 11, 12, 29, 20, 21].includes(b))).toEqual([])
    const wv = Object.fromEntries(capabilities('widevine'))
    expect(bits(wv.k_ft1)).toEqual([3, 40, 42, 48, 50])
    expect(bits(wv.k_ft4)).toEqual([3, 14, 20, 21, 27, 38, 44, 46, 51])
    expect(bits(wv.k_ft7)).toEqual([3, 26, 29, 36, 44, 45])
  })

  it('dash 地址的 vf 对路径和参数原文算', () => {
    const url = new URL(dashURL({ tvid: '123', bid: 500, deviceID: 'd', vipType: '0', time: 1 }))
    const pathAndQuery = `${url.pathname}${url.search}`.replace(/&vf=[0-9a-f]+$/, '')
    expect(url.searchParams.get('vf')).toBe(vf(pathAndQuery))
    expect(url.searchParams.get('authKey')).toBe(authKey('', '1', '123'))
    expect(pathAndQuery.endsWith('&ut=0')).toBe(true)
  })
})

describe('id 与图片', () => {
  it('认 v / a 前缀和裸 qipu id', () => {
    expect(parseID('v3544470072202400')).toEqual({ kind: 'video', id: '3544470072202400' })
    expect(parseID('a6582272134154501')).toEqual({ kind: 'album', id: '6582272134154501' })
    expect(parseID('6582272134154501')).toEqual({ kind: 'album', id: '6582272134154501' })
    expect(parseID('3544470072202400')).toEqual({ kind: 'video', id: '3544470072202400' })
    expect(parseID('x1')).toBeNull()
    expect(qipsValue('tvid', 'qips://tvid=5459239950713400;vid=bfc8;albumid=4262408502598901;')).toBe('5459239950713400')
  })

  it('超过 2^53 的 id 保留原数字', () => {
    expect(parseJSON('{"id": 9007199254740993, "n": 1.5}')).toEqual({ id: '9007199254740993', n: 1.5 })
  })

  it('图片换尺寸、换 https、AVIF 换 JPEG', () => {
    expect(image('http://pic6.iqiyipic.com/image/20260929/fd/8f/a_100801066_m_601_m5.jpg', 260, 360))
      .toBe('https://pic6.iqiyipic.com/image/20260929/fd/8f/a_100801066_m_601_m5_260_360.jpg')
    expect(image('https://pic6.iqiyipic.com/image/20260929/fd/8f/a_100801066_m_601_m5_592_333.avif', 260, 360))
      .toBe('https://pic6.iqiyipic.com/image/20260929/fd/8f/a_100801066_m_601_m5_260_360.jpg')
    expect(image('')).toBeUndefined()
  })
})

describe('链接', () => {
  it('v_ 页的 slug 解出 tvid', () => {
    expect(slugID('/v_1ewmjgivkm4.html')).toBe('5114308636498800')
    expect(matchLink('http://www.iqiyi.com/v_1ewmjgivkm4.html')).toEqual({ target: { video: 'v5114308636498800' } })
    // a_ 页的 slug 不是 id：取页面再认（见下）。
    expect(matchLink('http://www.iqiyi.com/a_uu6qr7xu7d.html')).toBeNull()
  })

  it('参数里的 tvid、curid、shareId', () => {
    expect(matchLink('https://www.iqiyi.com/v_x.html?tvid=123456')).toEqual({ target: { video: 'v123456' } })
    expect(matchLink('https://m.iqiyi.com/play.html?curid=987654_abc')).toEqual({ target: { video: 'v987654' } })
    const share = Buffer.from('5114308636498800').toString('base64')
    expect(matchLink(`https://m.iqiyi.com/m/playShare?shareId=${share}`)).toEqual({ target: { video: 'v5114308636498800' } })
    expect(matchLink('https://example.com/v_1ewmjgivkm4.html')).toBeNull()
  })

  it('页面里嵌的 id', () => {
    expect(inspectPage(new URL('https://www.iqiyi.com/v_zzzz.html'), 'x "tvId":12345678, "albumId":87654301')).toEqual({ target: { video: 'v12345678' } })
    expect(inspectPage(new URL('https://www.iqiyi.com/a_zzzz.html'), '"albumId":"87654301"')).toEqual({ target: { show: 'a87654301' } })
    expect(inspectPage(new URL('https://www.iqiyi.com/other'), '"tvId":1')).toBeNull()
  })
})

describe('频道与片库', () => {
  it('编辑页：焦点图 hero，榜单带名次，广告丢掉', () => {
    const page = {
      code: 0,
      items: [
        { temp: { id: 62 }, video: [{ data: [{ tv_id: 11100, album_id: 22201, title: '剧', image_url: 'https://pic.iqiyipic.com/image/x.jpg', content_type: 'FEATURE_FILM', pay_mark: 'VIP_MARK' }] }] },
        { temp: { id: 85, feedRowAd: 'ad' }, video: [{ data: [{ tv_id: 1, title: '广告' }] }] },
        { temp: { id: 90 }, title: '风云榜', video: [{ data: [{ tv_id: 33300, title: '片', isAd: false }, { tv_id: 1, isAd: true, title: 'ad' }] }] },
        { temp: { id: 91 }, title: '外链', video: [{ data: [{ tv_id: 44400, title: '游戏', page_url: 'https://game.iqiyi.com/x' }] }] },
      ],
    }
    const sections = editorialSections(page, 'tv')
    expect(sections.map((s) => [s.style, s.title, s.items.length])).toEqual([['hero', undefined, 1], ['ranking', '风云榜', 1]])
    expect(sections[0].items[0]).toMatchObject({ id: 'a22201', target: { show: 'a22201' }, badge: { text: 'VIP', tone: 'gold' } })
    expect(sections[1].items[0]).toMatchObject({ id: 'v33300', rank: 1, target: { video: 'v33300' } })
  })

  it('花絮卡片打开视频，不打开剧', () => {
    expect(cardItem({ tv_id: 5, album_id: 601, title: 't', content_type: 'PREVIEW' })?.target).toEqual({ video: 'v5' })
  })

  it('旧片库：剧、综艺（sourceId）、单片', () => {
    expect(libraryItem({ albumId: 301, name: '剧', videoCount: 40, latestOrder: 12 })).toMatchObject({ target: { show: 'a301' }, caption: '更新至12集' })
    expect(libraryItem({ albumId: 401, sourceId: 401, name: '综艺', videoCount: 0 })).toMatchObject({ target: { show: 'a401' } })
    expect(libraryItem({ albumId: 501, tvId: 500, name: '电影', videoCount: 1, score: 8.46 })).toMatchObject({ target: { video: 'v500' }, caption: '8.5分' })
  })

  it('筛选的维度与参数合并', () => {
    const sort = dimension({ group: '排序', tags: [{ text: '最热', tag_param: 'mode=11', selected: true }, { text: '最新', tag_param: 'mode=4' }] })
    expect(sort).toMatchObject({ isSort: true, defaultOptionID: 'mode=11' })
    expect(dimension({ group: '空', tags: [{ text: '全部' }] })).toBeUndefined()
    expect(filterParam({ 排序: 'mode=11', 类型: 'three_category_id_v2=1', 地区: 'k=a;should,b;should', 年份: '' }))
      .toBe('{"k":"a;should,b;should","mode":"11","three_category_id_v2":"1"}')
    expect(filterParam({ a: 'x=1', b: 'x=2' })).toBe('{"x":"1,2"}')
  })
})

describe('详情', () => {
  it('专辑 baseinfo → 详情', () => {
    const detail = detailOf({
      albumName: '狂飙', name: '狂飙第1集', focus: '一句话', description: '简介', publishTime: 1673654400000,
      areas: ['内地'], categories: [{ name: '悬疑' }], channelId: 2, videoCount: 39, latestOrder: 39, score: 9.2, payMark: 1,
      imageUrl: 'http://pic.iqiyipic.com/image/a.jpg',
      people: { director: [{ id: 1, name: '徐纪周' }], main_charactor: [{ id: 2, name: '张译', character: ['安欣'] }, { id: 1, name: '徐纪周' }] },
    }, 'a5328486914190101', 'v1', undefined, [])
    expect(detail).toMatchObject({ title: '狂飙', attributes: '内地·2023·悬疑', category: '电视剧', isPaid: true, ratings: [{ source: 'platform', score: '9.2' }], updateInfo: '39集全' })
    expect(detail.credits.map((c) => [c.name, c.role])).toEqual([['徐纪周', '导演'], ['张译', '饰安欣']])
  })

  it('分集、时长、推荐、继续播放', () => {
    expect(episode({ tvId: 9, order: 3, name: '狂飙第3集', subtitle: '标题', duration: '45:33', payMark: 1 }, true))
      .toMatchObject({ id: 'v9', title: '标题', stage: '3', isPaid: true, duration: 2733 })
    expect(clock('1:02:03')).toBe(3723)
    const items = [
      { isCollection: true, entity_id: 3574952371144702 },
      { isAd: true, entity_id: null },
      { entity_id: '8146495537170101', display_name: '警字一号', play_url: 'qips://tvid=2519302118753800;albumid=8146495537170101;' },
    ].map(recommendation).filter(Boolean)
    expect(items.map((i) => i!.id)).toEqual(['a8146495537170101'])
    expect(resumePoint({ episodeId: 7, play_time: 30, duration: 120 })).toEqual({ videoID: 'v7', progress: 0.25 })
  })
})

describe('历史、搜索、评论', () => {
  it('历史记录', () => {
    const item = historyItem({ episodeId: 700, albumId: 801, title: '第2集', album_order: '第2集', play_time: 60, duration: 600, add_time: 1700000000, terminal_id: 11 })
    expect(item).toMatchObject({ id: 'v700', showID: 'a801', progress: 0.1, historyKey: '700', device: { kind: 'computer' }, lastWatched: '2023-11-14T22:13:20.000Z' })
    expect(historyItem({ episodeId: 700, albumId: 700, title: '电影' })?.showID).toBeUndefined()
  })

  it('搜索结果：剧和短视频，别站的不要', () => {
    expect(show({ qipuId: 101, title: '剧', channel: '电视剧,2', actors: { value: [{ title: 'A' }] }, year: { value: '2026' } }))
      .toMatchObject({ item: { target: { show: 'a101' } }, facts: '电视剧 · 2026', cast: '主演：A' })
    expect(show({ qipuId: 101, title: '剧', siteId: 'youku' })).toBeUndefined()
    expect(video({ qipuId: 900, title: ' 短视频 ', duration: 61000, playCount: 5 })).toMatchObject({ id: 'v900', title: '短视频', duration: 61, stats: { views: 5 } })
  })

  it('评论：表情、回复的对象', () => {
    const c = comment({
      id: 1, content: '好看[微笑]', userInfo: { uname: 'u' }, likes: 3, replyCount: 2, addTime: 1700000000,
      replies: [{ id: 2, content: 'r', replySource: { id: 3, userInfo: { uname: '别人' } } }],
    }, undefined, { '[微笑]': 'https://e/smile.png' })
    expect(c).toMatchObject({ id: '1', emotes: { '[微笑]': 'https://e/smile.png' }, replyCount: 2 })
    expect(c.replies).toBeTruthy()
    expect(c.previewReplies?.[0].repliesTo).toBe('别人')
  })
})

describe('弹幕', () => {
  it('zlib 的 XML', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><danmu><data><entry><list><bulletInfo><contentId>1</contentId><content>洛龙区 &amp; 你</content><showTime>2</showTime><color>7850e5</color><position>0</position><userInfo><uid>9</uid><name>用户</name></userInfo></bulletInfo></list></entry></data></danmu>'
    expect(danmakuFromZlib(deflateSync(Buffer.from(xml)))).toEqual([{ id: '1', time: 2, text: '洛龙区 & 你', position: 'scroll', color: '#7850E5' }])
    expect(danmakuFromZlib(new Uint8Array([1, 2, 3]))).toEqual([])
  })
})

describe('播放', () => {
  const answer = (video: unknown[], st = 101) => ({ code: 'A00000', data: { st, p: { bt: 85, et: 0 }, aid: 301, program: { video } } })

  it('每个清晰度一条，选中的带播放列表；同清晰度优先选中的 / 明文的', () => {
    const dash = parseDash(answer([
      { bid: 600, drmType: 1, code: 5, ff: 'dash' },
      { bid: 500, drmType: 1, _selected: true, m3u8: '#EXTM3U\n#EXTINF:5,\nhttps://a/1.ts\n#EXT-X-ENDLIST', duration: 2329, scrsz: '1280x720' },
      { bid: 800, drmType: 9 },
      { bid: 800, drmType: 1 },
    ]))
    expect(dash.renditions.map((r) => [r.bid, r.drmType, r.selected])).toEqual([[600, 1, false], [500, 1, true], [800, 1, false]])
    expect(selectedRendition(dash)?.bid).toBe(500)
    expect(dash).toMatchObject({ status: 101, introEnd: 85, outroStart: undefined, albumID: '301' })
  })

  it('不能播的回答', () => {
    expect(unavailable(parseDash(answer([], 110)), false).code).toBe('restricted')
    expect(unavailable(parseDash(answer([], 502)), false).message).toContain('VIP')
    expect(unavailable(parseDash(answer([], 300)), true).code).toBe('unplayable')
    expect(unavailable(parseDash(answer([], 702)), true).message).toContain('加密')
    expect(() => parseDash({ code: 'A00111' })).toThrow(/中国大陆/)
  })

  it('播放列表：分片改 HTTP，声明点播', () => {
    expect(normalizePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:3,\nhttps://pcw-data.video.iqiyi.com/a.ts?start=0\n#EXT-X-ENDLIST'))
      .toBe('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:5\n#EXTINF:3,\nhttp://pcw-data.video.iqiyi.com/a.ts?start=0\n#EXT-X-ENDLIST')
  })

  it('最高清晰度 → bid', () => {
    expect([undefined, 2160, 1080, 720, 480, 360, 240].map((r) => bidFor(r))).toEqual([600, 600, 600, 500, 300, 200, 100])
  })
})

describe('登录', () => {
  it('凭证先取 Set-Cookie，再取响应体', () => {
    expect(credentialFrom(['P00001=abc; Path=/; Domain=.iqiyi.com', 'P00003=42; Path=/', 'QC005=x'], {}).cookies).toEqual({ P00001: 'abc', P00003: '42' })
    expect(credentialFrom([], { data: { authcookie: 'tok', userinfo: { uid: 7 } } }).cookies).toEqual({ P00001: 'tok', P00003: '7' })
    expect(() => credentialFrom([], { data: {} })).toThrow()
  })

  it('会员：有效、过期、非会员', () => {
    expect(membership({ status: '1', name: '黄金VIP会员', deadline: { date: '2099-01-01' } })).toMatchObject({ tier: '黄金VIP会员', active: true, endsAt: '2099-01-01T15:59:59.000Z' })
    expect(membership({ status: '0', deadline: { t: 1600000000000 } })).toMatchObject({ active: false })
    expect(membership({})).toBeUndefined()
  })
})
