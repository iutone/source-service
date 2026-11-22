// 离线测试：样例取自 App 的 Tests/TencentTests/Fixtures（docs/tencent-web/samples），向量和 App 的测试相同。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { credentialFromLogin, qrContent } from '../src/account.ts'
import { decryptVinfo, vinfoKey } from '../src/cipher.ts'
import { cKey85, cKey92, ckey92Environment, decryptCKey85 } from '../src/ckey.ts'
import { USER_AGENT } from '../src/constants.ts'
import { danmakuOf } from '../src/danmaku.ts'
import { commentOf, detailOf, episodeList, flatten, province, recommendationItems } from '../src/detail.ts'
import { chasingItem, dataKeys, dimensions, filterParams, libraryItems, section } from '../src/feed.ts'
import { historyItem } from '../src/history.ts'
import { linkTarget, pageIDs, parseID } from '../src/ids.ts'
import { pageItems } from '../src/json.ts'
import {
  checkInfo, isFairPlay, isPlayableCodec, isProtected, markersOf, plain, playlistURLs, qualityLabel, qualityRank, restriction, saltFromPage,
} from '../src/playback.ts'
import { crc32Hex, decodeRequest, decodeResponse, encodeRequest, qimeiReport, qimeiRequestBody, rc4, uuid42, x64hash128, QIMEI_APP_KEY } from '../src/qimei.ts'
import { results, suggestions } from '../src/search.ts'
import { membershipOf, normalizeCredential, TencentSession } from '../src/session.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyValueStore } from '@iyt-source/kit'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

describe('Qimei', () => {
  it('makes the UUID42 from local calendar fields, random digits and the cookie flag', () => {
    const fields = { year: 2026, month: 11, day: 12, hour: 15, minute: 0, second: 0 }
    expect(uuid42(fields, true, () => 0.5)).toBe('1ab0c0f0000100c6fc88888888888888888888dee3')
    expect(uuid42(fields, false, () => 0.5)).toBe('1ab0c0f0000000c81b888888888888888888883632')
    expect(crc32Hex('abc')).toBe('352441c2')
  })

  it('hashes like the SDK', () => {
    const vectors: [string, string][] = [
      ['', '24700f9f1986800ab4fcc880530dd0ed'], ['a', 'f8b09930c1df727ef75677a1d6ae5bd6'],
      ['abc', '31844fd43df93041e52bcddd13312671'], ['0123456789abcdef', 'bd96b791c5d8e195dea62ef6707241b6'],
      ['0123456789abcdefg', '0478660c8e9d2928896c6acdc9f449e8'],
    ]
    for (const [input, expected] of vectors) expect(x64hash128(input)).toBe(expected)
  })

  it('encodes packets', () => {
    expect(Buffer.from(rc4(Buffer.from('Plaintext'), 'Key')).toString('hex')).toBe('bbf316e8d940af0ad3')
    const json = '{"header":{"cmd":12,"app_key":"example"},"data":"{\\"label\\":\\"设备样本\\",\\"uuid\\":\\"synthetic\\"}"}'
    const pms = encodeRequest(json)
    expect(pms.startsWith('148b1cb26d44cebb5384afe88851f405')).toBe(true)
    expect(pms.endsWith('0af0c15c8d139ae08a5a22')).toBe(true)
    expect(decodeRequest(pms)).toBe(json)
    const answer = decodeResponse('6ea974819d485ac9939ff63509d777e2f5eff1f0165e0383b2d92e0926c72964616337953889e28fdef4f7d4d738565a')
    expect(JSON.parse(answer!).h38).toBe('b885bc4221e145016f6a0d980000000c81ab0c')
    expect(decodeResponse('6ef6')).toBe('{}')
  })

  it('reports with the SDK field types', () => {
    const record = { uuid: '1ab0c0f0000100c6fc88888888888888888888dee3', canvas: '0123', h38: '' }
    const report = qimeiReport(record)
    expect(report.platform).toBe('MacIntel')
    expect(report.userId).toBe('{}')
    expect(report.upgrade).toBe(1)
    expect(report.uuid).toBe(record.uuid)
    expect(String(report.hid)).toHaveLength(32)
    expect(report.hid).toBe(report.oldHid)
    expect(qimeiReport({ ...record, canvas: '4567' }).hid).not.toBe(report.hid)
    const body = JSON.parse(qimeiRequestBody(12, report, 'ssid'))
    expect(body.cpt).toBe(3)
    const envelope = JSON.parse(decodeRequest(body.pms)!)
    expect(envelope.header.cmd).toBe(12)
    expect(envelope.header.app_key).toBe(QIMEI_APP_KEY)
    expect(envelope.data).toContain('"uuid":"1ab0c0f0000100c6fc88888888888888888888dee3"')
  })
})

describe('cKey', () => {
  it('8.5 encrypts the fields bound to the video', () => {
    const key = cKey85('c4102g9a01t', '0123456789abcdef', 1_792_306_607, '', 'ABCEFGHIJKL')
    expect(key.startsWith('--01')).toBe(true)
    const plainText = decryptCKey85(key)
    expect(plainText.startsWith('{"vid":"c4102g9a01t","sdkVer":"1.0.1","nonce":"ABCEFGHIJKL","rand":"')).toBe(true)
    expect(plainText.endsWith('"appVer":"1.74.0","guid":"0123456789abcdef","platform":"10201","ts":"1792306607","h38":"","sj":"","bj":"","os":"{}"}')).toBe(true)
  })

  it('9.2 truncates the page and the lowercased agent', () => {
    expect(ckey92Environment('https://v.qq.com/x/page/x0000000000.html', USER_AGENT))
      .toBe('https://v.qq.com/x/page/x0000000000.html|mozilla/5.0 (macintosh; intel mac os x 10_15_7) |https://v.qq.com/|Mozilla|Netscape|MacIntel')
  })

  it('9.2 matches the browser’s wasm', () => {
    const key = cKey92({
      vid: 'x0000000000', guid: '0123456789abcdef0123456789abcdef', h38: '0123456789abcdef0123456789abcdef012345',
      page: 'https://v.qq.com/x/page/x0000000000.html', timestamp: 1_794_467_592, nowMs: 1_794_467_592_000,
    })
    expect(key).toHaveLength(550)
    expect(createHash('sha256').update(`${key}\n`).digest('hex')).toBe('2193a2ff921399df5f450bea473d327e154682bb52f061bf9c24982cdae6b300')
  })
})

describe('vinfo_proxy cipher', () => {
  it('decodes like the play page', () => {
    const sample = fixture('vinfo-proxy-cipher')
    const key = vinfoKey(undefined, sample.guid, sample.cid, sample.vid, sample.flowid)
    expect(key.startsWith('guest0123456789abcdef')).toBe(true)
    const decoded = decryptVinfo(sample.cipher, key, sample.salt)
    expect(decoded).toBe(sample.plain)
    expect(decoded).toContain('标清')
    expect(decryptVinfo(sample.cipher, key, 'other')).not.toBe(decoded)
  })

  it('reads the salt from the play page', () => {
    expect(saltFromPage('window.__STARTUP_CONFIG__={"vinfoConfig":{"playerVersion":"1.80.0","xs":"abcDEF123"},"x":1}')).toBe('abcDEF123')
    expect(saltFromPage('<html></html>')).toBeUndefined()
  })
})

describe('ids and links', () => {
  it('parses ids and pages', () => {
    expect(parseID('cmzc00200803dr6b')).toEqual({ kind: 'cover', id: 'mzc00200803dr6b' })
    expect(parseID('vc4102g9a01t')).toEqual({ kind: 'video', id: 'c4102g9a01t' })
    expect(parseID('x123')).toBeUndefined()
    expect(parseID('v')).toBeUndefined()
    expect(pageIDs('https://v.qq.com/x/cover/mzc00200803dr6b/c4102g9a01t.html')).toEqual({ cover: 'mzc00200803dr6b', video: 'c4102g9a01t' })
    expect(pageIDs('https://v.qq.com/x/page/c4102g9a01t.html')?.video).toBe('c4102g9a01t')
  })

  it('resolves play page links', () => {
    expect(linkTarget('https://v.qq.com/x/cover/mzc00200803dr6b/c4102g9a01t.html')).toEqual({ video: 'vc4102g9a01t' })
    expect(linkTarget('https://v.qq.com/x/cover/mzc00200803dr6b.html?ptag=x')).toEqual({ show: 'cmzc00200803dr6b' })
    expect(linkTarget('https://v.qq.com/x/page/c4102g9a01t.html')).toEqual({ video: 'vc4102g9a01t' })
    expect(linkTarget('https://m.v.qq.com/x/m/play?cid=mzc00200803dr6b&vid=c4102g9a01t')).toEqual({ video: 'vc4102g9a01t' })
    expect(linkTarget('https://m.v.qq.com/x/m/play?cid=mzc00200803dr6b')).toEqual({ show: 'cmzc00200803dr6b' })
    expect(linkTarget('https://v.qq.com/channel/tv')).toBeUndefined()
    expect(linkTarget('https://example.com/x/cover/mzc00200803dr6b.html')).toBeUndefined()
  })
})

describe('feed', () => {
  it('keeps the carousel and the shelves', () => {
    const cards = fixture('channel-tv-p1').data.CardList as any[]
    const sections = cards.map((card, index) => section(card, '100113', index)).filter(Boolean)
    expect(sections[0]?.style).toBe('hero')
    expect(sections).toHaveLength(2)
    const shelf = sections[1]!
    expect(shelf.style).toBe('row')
    expect(shelf.items[0]).toMatchObject({ id: 'cmzc00200803dr6b', title: '兰香如故', badge: { text: '限免中' }, caption: '全47集', target: { show: 'cmzc00200803dr6b' } })
    expect(shelf.items[0]!.posterURL).toMatch(/^https:/)
  })

  it('reads library pages and dimensions', () => {
    const items = libraryItems(fixture('library-p1').data)
    expect(items).toHaveLength(21)
    expect(items.every((item) => item.id.startsWith('c') && item.posterURL)).toBe(true)
    const list = dimensions(fixture('library-p0').data)
    const sort = list[0]!
    expect(sort.isSort).toBe(true)
    expect(sort.options.map((o) => o.title)).toEqual(['最热', '最新上架', '高分好评'])
    expect(sort.defaultOptionID).toBe('75')
    const kind = list.find((d) => d.id === 'itype')!
    expect(kind.options[0]!.id).toBe('-1')
    expect(kind.defaultOptionID).toBe('-1')
    expect(filterParams({ itype: '2', iarea: '' })).toBe('itype=2&sort=75')
  })

  it('reads data keys and followed shows', () => {
    expect(dataKeys('source_key=100113+rec_module_id=7+rec_module_type=801002+rec_extend_info=\u0001x')).toEqual({ source_key: '100113', rec_module_id: '7', rec_module_type: '801002' })
    const items = fixture('album-chasing').data.list.map(chasingItem).filter(Boolean)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'cmzc00200b2nca4z', target: { show: 'cmzc00200b2nca4z' }, caption: '第4集 · 观看至17%' })
    expect(items[0].progress).toBeCloseTo(0.17)
    expect(items[0].landscapeURL).toBeTruthy()
  })
})

describe('detail', () => {
  it('reads episodes with trailers and ranges', () => {
    const list = episodeList(fixture('episode-list').data, 'mzc00200803dr6b')
    expect(list.episodes).toHaveLength(54)
    expect(list.episodes.filter((e) => e.isFeature)).toHaveLength(30)
    expect(list.episodes[0]).toMatchObject({ id: 'vc4102g9a01t', stage: '1', isFeature: true })
    expect(list.episodes.find((e) => !e.isFeature)?.kind).toBe('预告')
    expect(list.episodes.some((e) => e.isPaid && e.badge?.text === 'VIP')).toBe(true)
    expect(list.ranges?.map((r) => r.title)).toEqual(['1-30', '31-47'])
    expect(list.selectedRange).toEqual(list.ranges![0])
    expect(list.ranges![1]!.cursor.startsWith('ep:mzc00200803dr6b:chapter_name=')).toBe(true)
  })

  it('reads the introduction', () => {
    const intro = flatten(pageItems(fixture('detail-introduction').data)[0])
    const detail = detailOf(intro, 'mzc00200803dr6b', { defaultVideoID: 'vc4102g9a01t' })
    expect(detail).toMatchObject({ title: '兰香如故', showID: 'cmzc00200803dr6b', attributes: '内地·2026·古装', isPaid: true, updateInfo: '会员全集' })
    expect(detail.credits.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps recommendations in order', () => {
    const items = recommendationItems(fixture('detail-recommendations'), 'mzc00200803dr6b')
    expect(items).toHaveLength(6)
    expect(items[0]).toMatchObject({ title: '尚公主', id: 'cmzc002001w361jz' })
    expect(items.every((i) => i.posterURL)).toBe(true)
  })

  it('reads posts with their replies and roles', () => {
    const comments = pageItems(fixture('doki-posts').data).map((item) => commentOf(item, false)).filter(Boolean) as any[]
    expect(comments).toHaveLength(2)
    const first = comments[0]
    expect(first.author).toMatchObject({ name: '谭松韵', role: '演员' })
    expect(first.text).toBe('好啦朋友们 我要继续追剧啦 回见哦')
    expect(first.location).toBe('北京')
    expect(first.likes).toBeGreaterThan(0)
    expect(first.replyCount).toBeGreaterThan(0)
    expect(first.author.avatarURL).toMatch(/^https:/)
    expect(first.previewReplies.length).toBeGreaterThan(0)
    expect(first.previewReplies.every((r: any) => r.replyCount === 0)).toBe(true)
    const cursor = JSON.parse(first.replies)
    expect(cursor.page).toBe('feed_detail_comment')
    expect(cursor.key.startsWith(`id=${first.id}&`)).toBe(true)
    expect(comments[1].pictures.length).toBeGreaterThanOrEqual(1)
    expect(province('北京市')).toBe('北京')
    expect(province('广西壮族自治区')).toBe('广西')
    expect(province('香港特别行政区')).toBe('香港')
    expect(province('浙江省')).toBe('浙江')
  })
})

describe('search', () => {
  it('keeps Tencent covers and clips', () => {
    const list = results(fixture('search-qingyunian').data, '庆余年第二季')
    expect(list.topMatch?.show.id).toBe('cmzc002002kqssyu')
    expect(list.topMatch?.episodes.length).toBeGreaterThan(0)
    expect(list.topMatch?.show.badge?.text).toBe('独播')
    expect(list.shows.length).toBeGreaterThan(0)
    expect(list.videos.length).toBeGreaterThan(0)
    expect(list.shows.every((s) => !s.title.includes('<em>'))).toBe(true)
  })

  it('reads suggestions without highlights', () => {
    const list = suggestions(fixture('search-sug').data.result_list.item_list)
    expect(list[0]?.keyword).toBe('庆余年')
    expect(list.some((s) => s.keyword === '庆余年第二季' && s.tag === '电视剧')).toBe(true)
  })
})

describe('history and 弹幕', () => {
  it('reads records with progress', () => {
    const item = historyItem(fixture('history-GetList').data.msgs[0])!
    expect(item).toMatchObject({ id: 'vc4102g9a01t', showID: 'cmzc00200803dr6b', title: '兰香如故', subtitle: '第01集', historyKey: 'cid_mzc00200803dr6b' })
    expect(item.progress).toBeCloseTo(443 / 2812, 3)
  })

  it('reads styled comments', () => {
    const list = danmakuOf(fixture('danmaku-segment').barrage_list)
    expect(list).toHaveLength(600)
    expect(list[0]!.time).toBe(150)
    expect(list.some((d) => d.color !== '#FFFFFF')).toBe(true)
    expect(list.every((d) => /^#[0-9A-F]{6}$/.test(d.color))).toBe(true)
  })
})

describe('playback answers', () => {
  it('plays a free episode', () => {
    const info = fixture('vinfo-h264-720p')
    expect(() => checkInfo(info)).not.toThrow()
    expect(restriction(info)).toBeUndefined()
    expect(isProtected(info)).toBe(false)
    expect(playlistURLs(info)[0]).toMatch(/\.f321003\.ts\.m3u8\?ver=4$/)
    const formats = info.fl.fi
    expect(formats.map(qualityLabel)).toEqual(['480P 标清', '720P 准高清', '1080P 高清SDR'])
    expect(formats.map(qualityRank)).toEqual([480, 720, 1080])
  })

  it('restricts a preview', () => {
    const info = fixture('vinfo-vip-preview')
    expect(restriction(info)).toBe('该集需要腾讯视频 VIP')
    expect(playlistURLs(info)[0]).toContain('.m3u8')
    const markers = markersOf(info.vl.vi[0])
    expect(markers.introEnd).toBe(94)
    expect(markers.outroStart).toBeCloseTo(2812.52 - 142, 2)
  })

  it('gives a member the whole VIP episode', () => {
    const info = fixture('vinfo-vip-member')
    expect(info.preview).toBe(300)
    expect(restriction(info)).toBeUndefined()
    expect(isProtected(info)).toBe(false)
    const selected = info.fl.fi.find((f: any) => f.sl === 1)
    expect(selected.name).toBe('fhd')
    expect(isPlayableCodec(selected)).toBe(true)
    expect(new URL(playlistURLs(info)[0]!).hostname.endsWith('smtcdns.com')).toBe(true)
  })

  it('refuses what is sold separately, members too', () => {
    const note = restriction(fixture('vinfo-purchase-only'))
    expect(note).toContain('购买')
    expect(() => plain({ anc: 'e30=' })).toThrow()
    expect(restriction(fixture('vinfo-vip-preview'))).not.toBe(note)
  })

  it('knows FairPlay titles', () => {
    expect(isProtected(fixture('vinfo-avatar-safari'))).toBe(true)
    const member = fixture('vinfo-fairplay-member')
    expect(isProtected(member)).toBe(true)
    expect(member.fl.fi.every(isFairPlay)).toBe(true)
  })

  it('keeps H.264 only', () => {
    expect(fixture('vinfo-webkit-safari').fl.fi.filter(isPlayableCodec)).toHaveLength(0)
    expect(fixture('vinfo-h264-720p').fl.fi.filter(isPlayableCodec)).toHaveLength(3)
  })

  it('maps em codes to errors', () => {
    expect(() => checkInfo({ em: 80, msg: '您所在区域暂无此内容版权' })).toThrow(expect.objectContaining({ code: 'restricted' }))
    expect(() => checkInfo({ em: 85, code: '85.-12', msg: 'x' })).toThrow(expect.objectContaining({ code: 'upstream_changed' }))
    expect(() => checkInfo({ em: 61 })).toThrow(expect.objectContaining({ code: 'unplayable' }))
  })
})

describe('account', () => {
  it('reads a login response', () => {
    const login = {
      vuid: 123456789, vusession: 'session', vusession_expire_in: 7200, vurefresh: 'refresh',
      third_info: { third_type: 2, app_id: 'wx5ed58254bc0d6b7f', open_id: 'open', access_token: 'token' },
      user_info: { user_nick: 'nick', user_head: 'https://example.com/head' },
    }
    const credential = credentialFromLogin(login, '0123456789abcdef', 1_000_000_000)!
    expect(credential).toMatchObject({ vuserid: '123456789', mainLogin: 'wx', callerAppID: '3000010', guid: '0123456789abcdef', nick: 'nick' })
    expect(credential.sessionExpiry).toBe(1_000_000_000 + 7_200_000)
    expect(credentialFromLogin({ vuid: 0 }, 'g')).toBeUndefined()
    expect(qrContent('abc', 123)).toContain('qr_code_id=abc&qr_expire_at=123')
  })

  it('reads membership tiers', () => {
    const now = Date.UTC(2026, 10, 12)
    const lapsed = membershipOf({ vip: 0, endTime: '2023-10-02 15:01:38', svip_info: { vip: 0, endTime: '2023-07-24 16:16:28' } }, now)
    expect(lapsed).toMatchObject({ tier: 'VIP', active: false })
    expect(membershipOf({ vip: 1, endTime: '2027-01-01 00:00:00', svip_info: { vip: 1, endTime: '2027-01-01 00:00:00' } }, now)?.tier).toBe('SVIP')
    expect(membershipOf({ vip: 0 }, now)).toBeUndefined()
  })

  it('takes the App’s credential JSON, dropping its reference-date expiry', () => {
    const credential = normalizeCredential({ vuserid: '1', vusession: 's', vurefresh: 'r', mainLogin: 'phone', callerAppID: '1000006', sessionExpiry: 800_000_000 })
    expect(credential).toMatchObject({ vuserid: '1', callerAppID: '1000006', mainLogin: 'phone' })
    expect(credential?.sessionExpiry).toBeUndefined()
    expect(normalizeCredential({ vuserid: '1' })).toBeUndefined()
  })

  it('sends the cookies of the account system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iyt-tencent-'))
    try {
      const session = new TencentSession(new KeyValueStore(dir))
      expect(session.guid).toMatch(/^[0-9a-f]{16}$/)
      expect(new TencentSession(new KeyValueStore(dir)).guid).toBe(session.guid)
      session.apply({ vuserid: '1', vusession: 's', vurefresh: 'r', mainLogin: 'qq', appID: '101483052', openID: 'o', accessToken: 't', guid: '0123456789abcdef', callerAppID: '3000010' })
      expect(session.loginCookies.vqq_vusession).toBe('s')
      expect(session.loginCookies.vusession).toBeUndefined()
      expect(session.loginCookies.v_vusession).toBe('s')
      expect(session.loginCookies.video_guid).toBe('0123456789abcdef')
      session.apply({ vuserid: '1', vusession: 's', vurefresh: 'r', mainLogin: 'phone', callerAppID: '1000006' })
      expect(session.loginCookies.vusession).toBe('s')
      expect(session.loginCookies.main_login).toBe('phone')
      expect(session.loginToken).toContain('"main_login":"phone"')
      expect(new TencentSession(new KeyValueStore(dir)).credential?.callerAppID).toBe('1000006')
      session.clear()
      expect(new TencentSession(new KeyValueStore(dir)).loggedIn).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
