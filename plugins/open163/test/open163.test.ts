import { describe, expect, it } from 'vitest'
import { parseHome, plain, quantitySeconds } from '../src/api.ts'
import { entryItem, linkTarget, movieStreams, splitVideoID, videoID } from '../src/index.ts'

describe('网易公开课 links', () => {
  it('reads course and lesson addresses', () => {
    expect(linkTarget('https://open.163.com/newview/movie/free?pid=M6GOB7TT6&mid=M6GOBOPBJ')).toEqual({ target: { video: 'M6GOB7TT6_M6GOBOPBJ' } })
    expect(linkTarget('https://open.163.com/newview/movie/courseintro?newurl=MCM2CNJD3')).toEqual({ target: { show: 'MCM2CNJD3' } })
    expect(linkTarget('https://open.163.com/movie/2010/9/B/J/M6GOB7TT6_M6GOBOPBJ.html')).toEqual({ target: { video: 'M6GOB7TT6_M6GOBOPBJ' } })
    expect(linkTarget('https://c.open.163.com/mob/video.htm?plid=MCM2CNJD3&mid=MCM2CSB51#share-mob')).toEqual({ target: { video: 'MCM2CNJD3_MCM2CSB51' } })
    expect(linkTarget('https://open.163.com/ted/')).toBeNull()
    expect(linkTarget('https://example.com/?pid=M6GOB7TT6')).toBeNull()
  })

  it('splits lesson ids', () => {
    expect(splitVideoID(videoID('MCM2CNJD3', 'MCM2CSB51'))).toEqual({ plid: 'MCM2CNJD3', mid: 'MCM2CSB51' })
    expect(splitVideoID('nonsense')).toBeNull()
  })
})

describe('网易公开课 cards', () => {
  it('keeps courses only', () => {
    expect(entryItem({ contentId: 'MCM2CNJD3', type: 1, title: '恋爱<em>心理学</em>', plid: 'MCM2CNJD3', quantity: '8课时', playAmount: 10, subscribeName: '万门大学公开课' }))
      .toMatchObject({ id: 'MCM2CNJD3', title: '恋爱心理学', caption: '8课时', subtitle: '万门大学公开课', target: { show: 'MCM2CNJD3' } })
    expect(entryItem({ contentId: '2007', type: 88, title: '心理学' })).toBeUndefined()
    expect(plain(' <em>a</em>b ')).toBe('ab')
    expect(quantitySeconds("13' 41''")).toBe(821)
  })

  it('prefers HLS per tier, then the original copy, then MP4', () => {
    const streams = movieStreams({
      mid: 'M', plid: 'P', title: 't',
      m3u8ShdUrl: '', mp4ShdUrl: 'https://x/shd.mp4',
      m3u8HdUrl: 'https://x/hd.m3u8',
      m3u8SdUrl: '', m3u8SdUrlOrign: 'https://x/sd-orig.m3u8',
    })
    expect(streams.map((s) => [s.id, s.format, s.url])).toEqual([
      ['shd', 'mp4', 'https://x/shd.mp4'],
      ['hd', 'hls', 'https://x/hd.m3u8'],
      ['sd', 'hls', 'https://x/sd-orig.m3u8'],
    ])
    expect(movieStreams({ mid: 'M', plid: 'P', title: 't' })).toEqual([])
  })
})

describe('网易公开课 home', () => {
  it('reads the homepage blocks', () => {
    const html = `
      <div id="j-category-ted" class="g-container"><h2 class="ciTitle">个人提升</h2>
        <ul class="ciList"><li><a href="https://open.163.com/newview/search/%E6%83%85%E7%BB%AA?query=x">情绪管理</a></li></ul>
        <a href="https://open.163.com/newview/movie/free?pid=EHIL2JJ4C&mid=PHIL2JJ56" class="f-db f-fl u-openVideoItem">
          <img class="lazy" data-original="https://cms-bucket.ws.126.net/a.png" alt="学英语效率低？">
          <span class="f-db f-pa f-cf oviImgText ">碎片式口语练习更有效</span></a>
        <a href="https://open.163.com/newview/movie/free?pid=MBMJS4JNL" class="f-db f-fl"><img alt="自律是一种习惯"></a>
      </div>
      <div id="j-category-empty"><h2 class="ciTitle">空</h2></div>`
    expect(parseHome(html)).toEqual([{
      id: 'ted', title: '个人提升', keywords: ['情绪管理'],
      items: [
        { plid: 'EHIL2JJ4C', mid: 'PHIL2JJ56', title: '学英语效率低？', image: 'https://cms-bucket.ws.126.net/a.png', note: '碎片式口语练习更有效' },
        { plid: 'MBMJS4JNL', mid: undefined, title: '自律是一种习惯', image: undefined, note: undefined },
      ],
    }])
  })
})
