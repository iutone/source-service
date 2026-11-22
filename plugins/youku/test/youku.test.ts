import { createCipheriv, createHash } from 'node:crypto'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { uabPath } from '../src/ckey.ts'
import { countOf, beijingTime, componentCursor, decodeComponentCursor, episodeList, parseDetail } from '../src/detail.ts'
import { emotesIn } from '../src/emotes.ts'
import { mediaTarget, more, parseChannels, parseDimension, parseFeedPage, sectionStyle, shortVideoTarget, channelFilterCategories } from '../src/feed.ts'
import { danmakuParameters, historyItem, parseDanmaku } from '../src/history.ts'
import { sortedJSON, webImage } from '../src/json.ts'
import { matchLink, LINK_PATTERNS } from '../src/links.ts'
import { CookieJar, mtopSign, mtopURL, parseSetCookie, percentEncode, tokenFromCookie } from '../src/mtop.ts'
import { checkUPS, expiry, markers, pickStreams, private4KURL, progressParameters, quality, startPosition, trialRestriction, upsParameters, UPSError } from '../src/playback.ts'
import { MediaEngine, PrivateKeySession, attribute, rewritePrivatePlaylist, type Segment } from '../src/private.ts'
import { parseResults, parseSuggestions, plainText, routeTarget, titleMatches } from '../src/search.ts'
import { loginFormData, parseMembership } from '../src/session.ts'

describe('MTOP', () => {
  it('signs md5(token&t&appKey&data)', () => {
    const data = '{"a":1}'
    expect(mtopSign('tok', '1700000000000', '24679788', data)).toBe(createHash('md5').update(`tok&1700000000000&24679788&${data}`).digest('hex'))
  })

  it('takes the token before the first underscore', () => {
    expect(tokenFromCookie('abc123_1700000000000')).toBe('abc123')
    expect(tokenFromCookie(undefined)).toBe('')
  })

  it('encodes strictly (the gateway reads + as a space; ckey has +)', () => {
    expect(percentEncode('a+b/c=d e!*()\'')).toBe('a%2Bb%2Fc%3Dd%20e%21%2A%28%29%27')
    const url = mtopURL('mtop.x', '1.0', '{"ckey":"140#a+b"}', 'tok', '1', 'acs.youku.com', '24679788')
    expect(url).toContain('data=%7B%22ckey%22%3A%22140%23a%2Bb%22%7D')
    expect(url.startsWith('https://acs.youku.com/h5/mtop.x/1.0/?jsv=2.6.1&appKey=24679788&t=1&sign=')).toBe(true)
  })

  it('keeps cookies by domain and sends the matching ones', () => {
    const jar = new CookieJar()
    jar.set(parseSetCookie('_m_h5_tk=abc_123; Path=/; Domain=youku.com', 'acs.youku.com')!)
    jar.set(parseSetCookie('hl_sk=x; Path=/', 'cnpassport.youku.com')!)
    jar.set(parseSetCookie('gone=1; Max-Age=0; Domain=.youku.com', 'acs.youku.com')!)
    expect(jar.get('_m_h5_tk')).toBe('abc_123')
    expect(jar.header('https://acs.youku.com/h5/x')).toBe('_m_h5_tk=abc_123')
    expect(jar.header('https://cnpassport.youku.com/a')).toContain('hl_sk=x')
    expect(jar.get('gone')).toBeUndefined()
  })
})

describe('JSON helpers', () => {
  it('sorts keys like the App (.sortedKeys)', () => {
    expect(sortedJSON({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}')
  })

  it('makes web images https', () => {
    expect(webImage('//m.ykimg.com/x')).toBe('https://m.ykimg.com/x')
    expect(webImage('http://m.ykimg.com/x')).toBe('https://m.ykimg.com/x')
    expect(webImage('')).toBeUndefined()
  })
})

describe('feed', () => {
  it('reads targets, short dramas included', () => {
    expect(mediaTarget({ action: { type: 'JUMP_TO_SHOW', value: 'abc' } })).toEqual({ show: 'abc' })
    expect(mediaTarget({ action: { type: 'JUMP_TO_VIDEO', value: 'XNj==' } })).toEqual({ video: 'XNj==' })
    expect(shortVideoTarget('ykshortvideo://video_play?vid=XA==&groupType=show&groupId=sh1&context={"appid":1}')).toEqual({ show: 'sh1' })
    expect(shortVideoTarget('ykshortvideo://video_play?vid=XA%3D%3D')).toEqual({ video: 'XA==' })
    expect(shortVideoTarget('youku://other?vid=x')).toBeUndefined()
  })

  it('maps section styles', () => {
    expect(sectionStyle('KU_FLIX_LUNBO')).toBe('hero')
    expect(sectionStyle('FEED_SUBSCRIBE_X')).toBe('continueWatching')
    expect(sectionStyle('KU_FLIX_BILLOARD')).toBe('ranking')
    expect(sectionStyle('SHORT_VIDEO_A')).toBe('shortVideo')
    expect(sectionStyle('OTHER')).toBe('row')
  })

  it('reads the channel navigation without the home page and non-feeds', () => {
    const root = { nodes: [
      { data: { nodeKey: 'WEBHOME', title: '首页' } },
      { data: { nodeKey: 'WEBTV', title: '电视剧' } },
      { data: { nodeKey: 'H5', title: '繁星', type: 'H5' } },
      { data: { nodeKey: 'WEBLIVE', title: '直播' } },
    ] }
    expect(parseChannels(root)).toEqual([{ id: 'WEBTV', title: '电视剧' }])
    expect(channelFilterCategories({ id: 'WEBTV', title: '电视剧' })).toEqual([{ id: '电视剧', title: '电视剧' }])
    expect(channelFilterCategories({ id: 'X', title: '人文' })).toEqual([{ id: '文化', title: '人文' }])
  })

  it('reads a first page: sections, ranks, more and the next session', () => {
    const card = (title: string, id: string, extra: object = {}) => ({ data: { title, img: '//img/' + id, action: { type: 'JUMP_TO_SHOW', value: id }, ...extra } })
    const root = { nodes: [{ nodes: [
      { level: 2, id: 's1', typeName: 'KU_FLIX_BILLBOARD', data: { title: '榜单', moreAction: { type: 'JUMP', value: 'youku://kuflix/node?bizKey=kuflix_node_page&nodeKey=N1&bizContext=%7B%22a%22%3A1%7D&title=全部' } },
        nodes: [card('A', 'a', { playPercent: 14, mark: { data: { text: 'VIP', color: 'YELLOW' } } }), card('B', 'b')] },
      { level: 2, typeName: 'YK_AD_COMPONENT', nodes: [card('Ad', 'ad')] },
      { typeName: 'FEED_DRAWER_PAGINATION', data: { session: { subIndex: 8 } } },
    ] }], data: { pageNumMax: 5 } }
    const page = parseFeedPage(root, 1)
    expect(page.sections).toHaveLength(1)
    const [section] = page.sections
    expect(section.style).toBe('ranking')
    expect(section.items[0]).toMatchObject({ id: 'a', rank: 1, progress: 0.14, badge: { text: 'VIP', tone: 'gold' }, posterURL: 'https://img/a' })
    expect(JSON.parse(section.more!.route)).toEqual({ bizContext: '{"a":1}', nodeKey: 'N1' })
    expect(section.more!.title).toBe('全部')
    expect(page.nextSession).toBe('{"subIndex":8}')
    expect(parseFeedPage(root, 5).nextSession).toBeUndefined()
  })

  it('needs a typed more action', () => {
    expect(more({ value: 'youku://kuflix/node?bizKey=kuflix_node_page&nodeKey=N&bizContext=x' })).toBeUndefined()
  })

  it('reads a filter row', () => {
    const row = { nodes: [
      { data: { filterType: 'sort', title: '综合排序' } },
      { data: { value: '7', title: '热度最高' } },
      { data: { value: '1', title: '最新上线' } },
    ] }
    expect(parseDimension(row)).toEqual({ id: 'sort', title: '排序', options: [{ id: '', title: '综合排序' }, { id: '7', title: '热度最高' }, { id: '1', title: '最新上线' }], defaultOptionID: '', isSort: true })
  })
})

describe('search', () => {
  it('reads routes and highlighting', () => {
    expect(routeTarget('youku://play?source=search&showid=abc123')).toEqual({ show: 'abc123' })
    expect(plainText('<em>谷雨</em> ')).toBe('谷雨')
    expect(titleMatches('大明风华 TV版(别名:大明皇妃孙若微传)', '大明风华tv版')).toBe(true)
    expect(titleMatches('《谷雨》', '谷雨')).toBe(true)
  })

  it('reads suggestions once each', () => {
    const root = { nodes: [{ type: 1526, data: { w: '<em>谷</em>雨', sugIconDTO: { tagText: '电视剧' } } }, { type: 1526, data: { keyword: '谷雨' } }] }
    expect(parseSuggestions(root)).toEqual([{ keyword: '谷雨', tag: '电视剧' }])
  })

  it('takes the exact big card as the top match with its episodes', () => {
    const show = (type: number, id: string, name: string) => ({ type, data: { isYouku: 1, showId: id, titleDTO: { displayName: name }, info: '简介：好看', posterDTO: { vThumbUrl: '//p/' + id } } })
    const root = { nodes: [
      { nodes: [{ nodes: [show(1027, 's2', '谷雨2')] }] },
      { nodes: [{ nodes: [show(1027, 's1', '<em>谷雨</em>')] }, { type: 1035, nodes: [{ data: { videoId: 'v1', showVideoStage: '1', title: '谷雨 01', seconds: 2725 } }] }] },
    ] }
    const results = parseResults(root, '谷雨')
    expect(results.topMatch?.show.id).toBe('s1')
    expect(results.topMatch?.summary).toBe('好看')
    expect(results.topMatch?.episodes[0]).toMatchObject({ id: 'v1', title: '谷雨 第1集', caption: '45:25', showID: 's1' })
    expect(results.shows.map((s) => s.id)).toEqual(['s2'])
  })
})

describe('detail', () => {
  it('parses counts and Beijing times', () => {
    expect(countOf('3.4万粉丝')).toBe(34000)
    expect(countOf('1.2亿')).toBe(120000000)
    expect(beijingTime('2026-10-09 10:44:18')).toBe('2026-10-09T02:44:18.000Z')
  })

  it('reads a show page with episodes, ranges and ratings', () => {
    const session = JSON.stringify({ id: 1, index: 3 })
    const root = {
      data: { extra: { showId: 'sh', videoId: 'v1', showName: '剧', showImg: '//l', paid: 0 } },
      nodes: [{ nodes: [
        { typeName: '播放页推荐理由组件', nodes: [{ data: { title: '7818' } }, { data: { title: '9.1分', icon: 'x/4f0b7036130ca8ed3a4953939002ac4a.png' } }, { data: { title: '罪案' } }] },
        { typeName: 'Web播放页选集组件', data: { session, stageTabs: [{ title: '1-30', itemStartStage: 1, itemEndStage: 30, selected: true }] },
          nodes: [{ data: { title: '剧 第1集', stage: 1, action: { type: 'JUMP_TO_VIDEO', value: 'v1' }, videoType: '正片' } }] },
      ] }],
    }
    const detail = parseDetail(root)
    expect(detail).toMatchObject({ showID: 'sh', title: '剧', heat: 7818, ratings: [{ source: 'douban', score: '9.1' }], tags: ['罪案'], isPaid: false, defaultVideoID: 'v1' })
    expect(detail.episodes?.episodes[0]).toMatchObject({ id: 'v1', stage: '1', isFeature: true })
    const range = detail.episodes!.ranges![0]
    expect(detail.episodes!.selectedRange).toEqual(range)
    const decoded = decodeComponentCursor(range.cursor)!
    expect(decoded.showID).toBe('sh')
    expect(JSON.parse(decoded.nextSession)).toEqual({ id: 1, index: 3, itemEndStage: 30, itemStartStage: 1 })
  })

  it('builds component cursors only with a show and session', () => {
    expect(componentCursor(undefined, '{}', {})).toBeUndefined()
    expect(componentCursor('s', undefined, {})).toBeUndefined()
    expect(episodeList({ data: {}, nodes: [] }, 's').episodes).toEqual([])
  })

  it('finds emotes', () => {
    expect(emotesIn('好[哈哈][没有]')).toEqual({ '[哈哈]': expect.stringContaining('alicdn.com') })
    expect(emotesIn('无')).toBeUndefined()
  })
})

describe('history and danmaku', () => {
  it('reads a history entry', () => {
    const item = historyItem({ videoId: 'v', showId: 's', displayTitle: '剧 第11集', point: 600, duration: 2400, playPercent: 25, lastUpdate: 1700000000, deviceName: '电视', hwClass: 2, cornerMark: 'VIP', markColor: 'GOLDEN', isPlayable: 0 })
    expect(item).toMatchObject({ id: 'v', showID: 's', progress: 0.25, watchedPercent: 25, device: { kind: 'tv', name: '电视' }, badge: { text: 'VIP', tone: 'gold' }, isPlayable: true, historyKey: 'v' })
    expect(item?.lastWatched).toBe('2023-11-14T22:13:20.000Z')
  })

  it('signs danmaku requests like the barrage component', () => {
    const p = danmakuParameters('XA==', 2, 'g/+', 1700000000000)
    const msg = Buffer.from('{"ctime":1700000000000,"ctype":10004,"cver":"v1.0","guid":"g/+","mat":2,"mcount":1,"pid":0,"sver":"3.1.0","type":1,"vid":"XA=="}').toString('base64')
    expect(p.msg).toBe(msg)
    expect(p.sign).toBe(createHash('md5').update(msg + 'MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr').digest('hex'))
  })

  it('reads danmaku without brand ads', () => {
    const result = JSON.stringify({ code: 1, data: { result: [
      { id: 1, playat: 60441, content: '你好\n', propertis: '{"pos":4,"color":16711680}' },
      { id: 2, playat: 1, content: '广告', propertis: '{"isBrandAdDanmu":true}' },
    ] } })
    expect(parseDanmaku({ result })).toEqual([{ id: '1', time: 60.441, text: '你好', position: 'top', color: '#FF0000' }])
  })
})

describe('links', () => {
  it('reads videos and shows like the App', () => {
    expect(matchLink('https://v.youku.com/v_show/id_XNjU2OTEyMDczMg==.html')).toEqual({ video: 'XNjU2OTEyMDczMg==' })
    expect(matchLink('http://v.youku.com/v_show/id_XNjU2OTEyMDczMg==.html?spm=a2h0c')).toEqual({ video: 'XNjU2OTEyMDczMg==' })
    expect(matchLink('https://v.youku.com/video?s=ffefaad54c434973b4d6')).toEqual({ show: 'ffefaad54c434973b4d6' })
    expect(matchLink('https://player.youku.com/embed/XNjU2OTEyMDczMg==')).toEqual({ video: 'XNjU2OTEyMDczMg==' })
    expect(matchLink('https://m.youku.com/x?vid=XNjU2OTEyMDczMg==')).toEqual({ video: 'XNjU2OTEyMDczMg==' })
    expect(matchLink('https://www.youku.com/')).toBeUndefined()
    expect(matchLink('https://example.com/id_XNjU2OTEyMDczMg==')).toBeUndefined()
  })

  it('declares patterns the App can match', () => {
    const pattern = new RegExp(LINK_PATTERNS[0])
    expect(pattern.test('https://v.youku.com/v_show/id_X.html')).toBe(true)
    expect(pattern.test('https://m.youku.tv/s')).toBe(true)
    expect(pattern.test('https://youku.com.evil.example/')).toBe(false)
  })
})

describe('playback', () => {
  it('builds UPS parameters with the private client', () => {
    const p = upsParameters({ vid: 'XA==', ckey: '140#x', utid: 'cna', privateClient: 'pc', hevc: true, now: 1700000000000 })
    expect(JSON.parse(p.biz_params)).toMatchObject({ vid: 'XA==', encryptR_client: 'pc', drm_type: 3, h265: 1, master_m3u8: 1, play_ability: 16782592 | (1 << 18) | (1 << 20) })
    expect(JSON.parse(p.steal_params)).toEqual({ ccode: '0502', utid: 'cna', version: '9.0.21', ckey: '140#x', client_ip: '192.168.1.1', client_ts: 1700000000 })
  })

  it('maps clarity tiers', () => {
    expect(quality('mp4hd3', 0).rank).toBe(1080)
    expect(quality('cmfv5hd4_hbr', 0).rank).toBe(2160)
    expect(quality('flvhd', 0).rank).toBe(360)
    expect(quality('x', 720).rank).toBe(720)
  })

  it('turns UPS errors and previews into protocol errors', () => {
    expect(() => checkUPS({ error: { code: -6004, note: 'x' } })).toThrowError(UPSError)
    try { checkUPS({ error: { code: -3001 } }) } catch (e) { expect((e as UPSError).code).toBe('restricted') }
    try { checkUPS({ error: { code: -4008 } }) } catch (e) { expect((e as UPSError).code).toBe('unplayable') }
    expect(trialRestriction({ trial: { time: 360, type: 'time' }, video: { seconds: 2700 } })).toContain('VIP')
    expect(trialRestriction({ trial: { time: 2698 }, video: { seconds: 2700 } })).toBeUndefined()
  })

  it('reads expiry from the raw query', () => {
    expect(expiry(['http://x/a.m3u8?ups_ts=1700000000&expire=18000&k=a%2Bb', 'http://x/b?ups_ts=1700000100&expire=18000'])).toBe(1700018000000)
  })

  it('keeps signed bytes when deriving the 4K selector', () => {
    const source = 'https://pl-ali.youku.com/playlist/m3u8?ups_key=a%2Bb%2Fc%3D&type=cmfv4hd3&streamcoding=cmfva4&utid=x%2By'
    expect(private4KURL(source)).toBe(source.replace('type=cmfv4hd3', 'type=cmfv5hd4_hbr').replace('streamcoding=cmfva4', 'streamcoding=cmfva5-hbr'))
    expect(private4KURL('https://other.test/playlist/m3u8?type=x&streamcoding=y')).toBeUndefined()
  })

  it('prefers H.264 over HEVC TS at a tier, and marks what it cannot play', () => {
    const stream = (type: string, height: number, drm = 'default', size = 1) => ({ stream_type: type, height, drm_type: drm, size, m3u8_url: `http://cdn/${type}.m3u8` })
    const ups = { stream: [stream('mp4hd2', 720), stream('mp5hd2', 720, 'default', 9), stream('mp5hd4', 2160), stream('cmfv4hd3', 1080, 'cbcs')] }
    const off = pickStreams(ups, { canProcess: false })
    expect(off.map((s) => [s.id, s.path])).toEqual([['mp5hd4-default', 'unsupported'], ['cmfv4hd3-default', 'unsupported'], ['mp4hd2-default', 'direct']])
    const on = pickStreams(ups, { canProcess: true })
    expect(on.find((s) => s.id === 'mp5hd4-default')?.path).toBe('remux')
  })

  it('reads markers and resume points', () => {
    expect(markers({ head: 85000, tail: 1290000, point: [{ ctype: 'story', start: 1000, end: 2000, title: '开场' }] })).toEqual({ introEnd: 85, outroStart: 1290, chapters: [{ start: 1, end: 2, title: '开场' }] })
    expect(markers({ point: [{ ctype: 'license_head', start: 8000 }] })).toEqual({ introEnd: 8 })
    expect(startPosition(312, 2700)).toBe(312)
    expect(startPosition(312000, 2700)).toBe(312)
    expect(startPosition(2690, 2700)).toBeUndefined()
  })

  it('reports progress like KuPlayer', () => {
    const p = progressParameters({ event: 'seek', video: 'v', position: 12.5, duration: 2700, reportContext: { videoId: 'main', showId: 's', hd: 2, lang: 'default' } }, 'cna', 1700000000000)
    expect(p).toMatchObject({ videoId: 'main', showId: 's', point: '12500', logType: 3, hd: 2, seconds: 2700, nlid: 'cna', lastUpdate: 1700000000 })
  })
})

describe('private streams', () => {
  it('matches the official JS vectors for the key exchange', () => {
    const session = new PrivateKeySession('0123456789ABCDEF')
    expect(session.client).toBe('fEamSazWhB5iJlvlmCVrig==')
    const ecb = (data: Buffer, key: Buffer) => {
      const c = createCipheriv('aes-128-ecb', key, null)
      c.setAutoPadding(false)
      return Buffer.concat([c.update(data), c.final()])
    }
    const intermediate = Buffer.from('abcdefghijklmnop')
    const server = ecb(intermediate, Buffer.from('0123456789ABCDEF'))
    const expected = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 17))
    const wrapped = Buffer.concat([Buffer.from(expected.toString('base64')), Buffer.alloc(32 - 24)])
    const copyright = ecb(wrapped, intermediate)
    expect(session.recover(server.toString('base64'), copyright.toString('base64'))).toEqual(expected)
    expect(() => session.recover('bad', 'bad')).toThrow()
  })

  const base = 'https://pl-ali.youku.com/p/index.m3u8?key=a%2Bb'

  it('rewrites TS playlists with a map per segment and seek times', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-PRIVINF:FILESIZE=12,DRM_NOTENCRYPT\n#EXTINF:11.4,\na.ts?key=a%2Bb\n#EXTINF:8.2,\nb.ts\n#EXT-X-ENDLIST'
    const segments: Segment[] = []
    const out = rewritePrivatePlaylist(text, base, false, (u) => u, (s) => {
      segments.push(s)
      return { initialization: `/i${segments.length}.mp4`, media: `/s${segments.length}.m4s` }
    })
    expect(segments.map((s) => [s.encrypted, s.start])).toEqual([[false, 0], [true, 11.4]])
    expect(segments[0].url).toBe('https://pl-ali.youku.com/p/a.ts?key=a%2Bb')
    expect(out).toContain('#EXT-X-VERSION:7')
    expect(out).toContain('#EXT-X-MAP:URI="/i1.mp4"\n#EXTINF:11.4,')
    expect(out).not.toContain('DRM_NOTENCRYPT')
  })

  it('keeps CMAF inits and audio renditions as inputs', () => {
    let received: Segment | undefined
    const out = rewritePrivatePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://kid"\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6,\ns.m4s\n#EXT-X-ENDLIST', base, true, (u) => u, (s) => {
      received = s
      return { initialization: '/i', media: '/s' }
    })
    expect(received?.audio).toBe(true)
    expect(received?.initialization).toBe('https://pl-ali.youku.com/p/i.mp4')
    expect(out).not.toContain('skd://')
    const flags: boolean[] = []
    rewritePrivatePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="a.m3u8"\n#EXT-X-STREAM-INF:CODECS="hvc1,aac",BANDWIDTH=42\nv.m3u8', base, false, (u, audio) => {
      flags.push(audio)
      return u
    }, () => ({ initialization: '', media: '' }))
    expect(flags).toEqual([true, false])
    expect(attribute('CODECS', '#EXT-X-STREAM-INF:CODECS="hvc1,aac",BANDWIDTH=42')).toBe('hvc1,aac')
  })

  it('refuses playlists it cannot handle', () => {
    for (const text of ['#EXTM3U\n#EXT-X-TARGETDURATION:-403002', '#EXTM3U\n#EXTINF:6,\ns.ts', '#EXTM3U\n#EXT-X-BYTERANGE:20\n#EXTINF:6,\ns.ts\n#EXT-X-ENDLIST']) {
      expect(() => rewritePrivatePlaylist(text, base, false, (u) => u, () => ({ initialization: '', media: '' }))).toThrow()
    }
  })

  it('decrypts with Node AES inside the media engine (FIPS-197 / SP 800-38A vectors)', () => {
    const engine = new MediaEngine() as unknown as { load(): import('node:vm').Context; key: Buffer }
    const context = engine.load()
    engine.key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex')
    const result = vm.runInContext(`(function(){
      function hex(s){return new Uint8Array(s.match(/../g).map(function(x){return parseInt(x,16)}))}
      function toHex(a){return Array.prototype.map.call(a,function(x){return ('0'+x.toString(16)).slice(-2)}).join('')}
      var ecb=YoukuPrivateFilters.ecb({data:hex('3ad77bb40d7a3660a89ecaf32466ef97ff')});
      var cbc=YoukuPrivateFilters.cbc({data:hex('7649abac8119b246cee98e9b12e9197d'),encrypted:true,default_encryption:{default_constant_IV:hex('000102030405060708090a0b0c0d0e0f'),default_crypt_byte_block:0,default_skip_byte_block:0}});
      return [toHex(ecb),toHex(cbc)];
    })()`, context) as string[]
    expect(result[0]).toBe('6bc1bee22e409f96e93d7e117393172aff')
    expect(result[1]).toBe('6bc1bee22e409f96e93d7e117393172a')
  })
})

describe('account', () => {
  it('reads the login form of the passport page', () => {
    const html = 'viewData = {"loginFormData":{"appName":"youku","_csrf_token":"c","umidToken":"u","hsiz":"h","mainPage":false,"fromSite":23}};'
    expect(loginFormData(html)).toEqual({ appName: 'youku', _csrf_token: 'c', umidToken: 'u', hsiz: 'h', mainPage: 'false', fromSite: '23' })
    expect(loginFormData('<html></html>')).toBeUndefined()
  })

  it('reads membership from wherever it is', () => {
    expect(parseMembership({ vip: { is_vip: 1, exptime: 1800000000, vipName: '黄金会员' } }, 1700000000000)).toEqual({ tier: '黄金会员', active: true, endsAt: '2027-01-15T08:00:00.000Z' })
    expect(parseMembership({ expireTime: '2023-01-01' }, 1700000000000)).toMatchObject({ active: false })
    expect(parseMembership({ uname: 'x' })).toBeUndefined()
  })

  it('finds the uab module in awsc.js', () => {
    expect(uabPath('var g_moduleConfig={uabModule:{grey:["AWSC/uab/1.140.1/collina.js"],stable:["AWSC/uab/1.140.0/collina.js"],greyBr:[]}}')).toBe('AWSC/uab/1.140.0/collina.js')
  })
})
