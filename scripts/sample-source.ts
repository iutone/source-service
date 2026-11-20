// 生成 fixture 用的样例源：每个模块都实现，数据固定。App 侧 RemoteSource 的解码测试读的就是它经真实路由得到的响应
// （packages/protocol/fixtures，`pnpm fixtures` 重新生成）。不是可用的源，不进镜像。
import type { Comment, EpisodeList, LoginStep, MediaItem, ShowDetail, VideoItem } from '@iyt-source/protocol'
import { SourceError, type SourcePlugin } from '@iyt-source/kit'

const img = (name: string) => `https://img.example.com/${name}.jpg`

const show = (id: string, title: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  title,
  posterURL: img(`${id}-poster`),
  landscapeURL: img(`${id}-wide`),
  caption: '24集全',
  target: { show: id },
  ...extra,
})

const video = (id: string, title: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  title,
  landscapeURL: img(id),
  uploader: { id: 'u1', name: '某 UP 主', avatarURL: img('u1') },
  stats: { views: 12345, danmaku: 67, likes: 890 },
  duration: 754,
  publishedAt: '2026-11-19T08:00:00Z',
  target: { video: id },
  ...extra,
})

const episodes = (start: number, count: number): EpisodeList['episodes'] =>
  Array.from({ length: count }, (_, i) => ({
    id: `e${start + i}`,
    title: `第${start + i}集`,
    stage: String(start + i),
    isFeature: true,
    kind: '正片',
    imageURL: img(`e${start + i}`),
    isPaid: start + i > 20,
    badge: start + i > 20 ? { text: 'VIP', tone: 'gold' as const } : undefined,
  }))

const historyItem = (id: string, title: string, progress: number): VideoItem => ({
  id,
  showID: 's1',
  title,
  subtitle: '看到 12:30',
  coverURL: img(id),
  posterURL: img('s1-poster'),
  progress,
  watchedPercent: Math.round(progress * 100),
  caption: '24集全',
  lastWatched: '2026-11-20T10:00:00Z',
  device: { kind: 'tv', name: '电视' },
  isPlayable: true,
  historyKey: `h-${id}`,
})

const comment = (id: string, text: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  author: { name: '观众甲', avatarURL: img('a1'), nameColor: '#FB7299', role: 'UP主' },
  text,
  emotes: { '[doge]': img('doge') },
  date: '2026-11-20T09:00:00Z',
  location: '广东',
  likes: 321,
  ...extra,
})

export function createSampleSource(): SourcePlugin {
  return {
    info: {
      name: '示例平台',
      brand: { logo: 'https://img.example.com/logo.png', tabIcon: 'https://img.example.com/tab.png', tabIconIsWordmark: false, tint: '#FF1040' },
    },

    account: {
      methods: ['deviceCode', 'webCookie'],
      requiredFor: 'play',
      webLogin: { url: 'https://example.com/login', doneWhen: { cookie: 'SESSION', domain: '.example.com' }, userAgent: 'mobile' },
      async state(ctx) {
        return ctx.store.get<boolean>('loggedIn')
          ? { loggedIn: true, profile: { name: 'Alice', avatarURL: img('alice'), membership: { tier: '大会员', active: true, endsAt: '2027-01-01T00:00:00Z' } } }
          : { loggedIn: false }
      },
      async *begin(_method, ctx): AsyncIterable<LoginStep> {
        yield {
          kind: 'showCode',
          content: 'https://example.com/device?user_code=ABCD-EFGH',
          title: '用手机扫码',
          message: '或在浏览器打开 example.com/device，输入 ABCD-EFGH',
          openURL: 'https://example.com/device?user_code=ABCD-EFGH',
          expiresAt: '2026-11-20T10:15:00Z',
        }
        // 步骤之间停一下，fixture 的每次长轮询各拿到一步。
        await new Promise((resolve) => setTimeout(resolve, 100))
        yield { kind: 'waiting', message: '已扫码，请在手机上确认' }
        await new Promise((resolve) => setTimeout(resolve, 100))
        ctx.store.set('loggedIn', true)
        yield { kind: 'completed', profile: { name: 'Alice', avatarURL: img('alice') } }
      },
      async acceptCookies(cookies, _userAgent, ctx) {
        if (!cookies.some((cookie) => cookie.name === 'SESSION')) throw new SourceError('bad_request', '缺少登录 cookie')
        ctx.store.set('loggedIn', true)
        return { name: 'Alice' }
      },
      async logout(ctx) {
        ctx.store.set('loggedIn', false)
      },
    },

    feed: {
      homeShowsHistory: true,
      channelBrowser: true,
      async channels() {
        return {
          home: { id: 'home', title: '首页' },
          pinned: [{ id: 'tv', title: '电视剧' }],
          channels: [
            { id: 'tv', title: '电视剧', filterCategories: [{ id: 'tv', title: '电视剧' }] },
            { id: 'rank', title: '排行榜', subchannels: [{ id: 'rank-all', title: '全站' }, { id: 'rank-anime', title: '动画' }] },
          ],
          library: [
            { channel: { id: 'later', title: '稍后观看' }, systemImage: 'clock', content: 'feed' },
            { channel: { id: 'favorites', title: '收藏' }, systemImage: 'star', content: 'subchannels' },
            { channel: { id: 'following', title: '关注' }, systemImage: 'person.2', content: 'uploaders' },
          ],
        }
      },
      async channel(id, cursor) {
        if (cursor === 'p2') {
          return { sections: [{ id: 'feed', style: 'grid', items: [video('v3', '第二页的视频')] }], next: null }
        }
        return {
          sections: [
            { id: 'banner', style: 'hero', items: [show('s1', '示例剧', { badge: { text: '独播', tone: 'red' } })] },
            {
              id: 'hot',
              title: '热播',
              style: 'row',
              items: [show('s1', '示例剧'), show('s2', '另一部剧', { reservation: { id: 'r1', onlineText: '即将上线', count: 1200, isReserved: false } })],
              more: { title: '全部热播', route: 'more:hot' },
            },
            { id: 'top', title: '排行', style: 'ranking', items: [show('s1', '示例剧', { rank: 1 }), show('s2', '另一部剧', { rank: 2 })] },
            { id: 'continue', title: '继续观看', style: 'continueWatching', items: [show('s1', '示例剧', { progress: 0.42 })] },
            { id: 'feed', title: id === 'home' ? '推荐' : undefined, style: 'grid', items: [video('v1', '一个视频'), video('v2', '另一个视频')] },
          ],
          next: 'p2',
        }
      },
      async more(_route, cursor) {
        return cursor ? { items: [show('s3', '更多里的剧')], next: null } : { items: [show('s1', '示例剧'), show('s2', '另一部剧')], next: '2' }
      },
      async subchannels() {
        return [{ id: 'fav-1', title: '默认收藏夹' }, { id: 'fav-2', title: '纪录片' }]
      },
      async uploaders() {
        return {
          uploaders: [{ uploader: { id: 'u1', name: '某 UP 主', avatarURL: img('u1'), followers: 154000 }, signature: '做视频的', videoCount: 88, isFollowing: true, detail: '15.4万位订阅者' }],
          next: null,
        }
      },
    },

    filter: {
      async categories() {
        return [{ id: 'tv', title: '电视剧' }, { id: 'movie', title: '电影' }]
      },
      async dimensions() {
        return [
          { id: 'sort', title: '排序', options: [{ id: 'hot', title: '最热' }, { id: 'new', title: '最新' }], defaultOptionID: 'hot', isSort: true },
          { id: 'area', title: '地区', options: [{ id: 'all', title: '全部' }, { id: 'cn', title: '内地' }], defaultOptionID: 'all' },
        ]
      },
      async results() {
        return { items: [show('s1', '示例剧'), show('s2', '另一部剧')], next: '2' }
      },
    },

    search: {
      prompt: '搜索示例平台',
      async rankings() {
        return [{ id: 'hot', title: '热搜', items: [show('s1', '示例剧', { rank: 1 })] }]
      },
      async suggestions() {
        return [{ keyword: '示例剧', tag: '电视剧', detail: '2026 / 24集' }, { keyword: '示例' }]
      },
      async search() {
        return {
          topMatch: {
            show: show('s1', '示例剧'),
            facts: '电视剧 · 2026 · 中国',
            summary: '一部示例剧。',
            cast: '演员：甲 乙',
            episodes: [historyItem('e1', '示例剧 第1集', 0), historyItem('e2', '示例剧 第2集', 0)].map(({ historyKey: _k, lastWatched: _l, device: _d, ...rest }) => rest),
          },
          shows: [show('s2', '另一部剧')],
          videos: [video('v1', '示例剧 混剪')],
          moreVideos: 'v2',
        }
      },
      async videos() {
        return { items: [video('v4', '更多视频')], next: null }
      },
    },

    detail: {
      async detail(target): Promise<ShowDetail> {
        if ('video' in target && target.video.startsWith('v')) {
          return {
            kind: 'standalone',
            title: '一个视频',
            shortSummary: '一段简介',
            landscapeURL: img(target.video),
            ratings: [],
            tags: ['知识'],
            isPaid: false,
            credits: [],
            defaultVideoID: target.video,
            series: [],
            uploads: { episodes: [{ id: 'v9', title: '他的另一个视频', stage: '1', isFeature: true, isPaid: false, duration: 300, views: 1000, publishedAt: '2026-11-01T00:00:00Z' }], ranges: [{ title: '1-30', cursor: 'uploads:1' }] },
            recommendations: { tabs: [], items: [video('v2', '另一个视频')] },
            uploader: { id: 'u1', name: '某 UP 主', avatarURL: img('u1'), followers: 154000 },
            coUploaders: [{ id: 'u2', name: '合作者' }],
            stats: { views: 12345, likes: 890, coins: 12, favorites: 34, replies: 56 },
            publishedAt: '2026-11-19T08:00:00Z',
            duration: 754,
          }
        }
        return {
          showID: 's1',
          kind: 'series',
          title: '示例剧',
          tagline: '一句话介绍',
          shortSummary: '一两句话。',
          summary: '完整的剧情简介。',
          attributes: '中国 · 2026 · 爱情',
          category: '电视剧',
          posterURL: img('s1-poster'),
          landscapeURL: img('s1-wide'),
          badge: { text: '独播', tone: 'red' },
          updateInfo: '24集全',
          heat: 9800,
          ratings: [{ source: 'platform', score: '9.1' }, { source: 'douban', score: '8.5' }],
          tags: ['都市', '爱情'],
          isPaid: true,
          credits: [{ id: 'c1', name: '某导演', role: '导演', avatarURL: img('c1') }, { id: 'c2', name: '某演员', role: '饰主角' }],
          defaultVideoID: 'e3',
          episodes: {
            episodes: episodes(1, 3),
            ranges: [{ title: '1-30', section: '正片', cursor: 'eps:1' }, { title: '31-40', section: '正片', cursor: 'eps:31' }],
            selectedRange: { title: '1-30', section: '正片', cursor: 'eps:1' },
            summary: '更新至40集',
            parts: [{ id: 's1', title: '第一季', isCurrent: true }, { id: 's1b', title: '第二季', isCurrent: false }],
          },
          series: [],
          recommendations: {
            tabs: [{ title: '为你推荐' }, { title: '某演员的作品', imageURL: img('c2'), cursor: 'rec:c2' }],
            items: [show('s2', '另一部剧')],
          },
          resume: { videoID: 'e3', progress: 0.42 },
        }
      },
      async episodes(cursor) {
        return cursor.startsWith('uploads') ? { episodes: [], ranges: [] } : { episodes: episodes(31, 2), ranges: [{ title: '1-30', section: '正片', cursor: 'eps:1' }, { title: '31-40', section: '正片', cursor: 'eps:31' }], selectedRange: { title: '31-40', section: '正片', cursor: 'eps:31' } }
      },
      async recommendations() {
        return [show('s4', '某演员的另一部剧')]
      },
      async resume() {
        return { videoID: 'e3', progress: 0.42 }
      },
      async uploader(id) {
        return { uploader: { id, name: '某 UP 主', avatarURL: img(id), followers: 154000 }, signature: '做视频的', followingCount: 12, videoCount: 88, isFollowing: false, detail: '15.4万位订阅者' }
      },
      async uploaderVideos() {
        return { episodes: [{ id: 'v9', title: '他的另一个视频', stage: '1', isFeature: true, isPaid: false, duration: 300, views: 1000 }], ranges: [{ title: '1-30', cursor: 'uploads:1' }] }
      },
      async uploaderCollections() {
        return [{ title: '合集一', section: '合集', cursor: 'col:1' }]
      },
    },

    actions: {
      supports: { like: true, dislike: true, coins: true, favorite: true, follow: true },
      async state() {
        return { isLiked: true, coins: 1, maxCoins: 2, coinsToday: 3, coinsPerDay: 5, isFavorited: false, isFollowingUploader: true, isDisliked: false }
      },
      async like() {},
      async dislike() {},
      async coins() {},
      async favorites() {
        return [{ id: 'fav-1', title: '默认收藏夹', containsVideo: true }, { id: 'fav-2', title: '纪录片', containsVideo: false }]
      },
      async updateFavorites() {},
      async follow() {},
    },

    comments: {
      async first() {
        return {
          comments: [
            comment('c1', '好看[doge]', {
              pictures: [img('pic1')],
              replyCount: 12,
              previewReplies: [comment('c1r1', '同意', { likes: 3, repliesTo: '观众甲' })],
              replies: 'replies:c1',
              isPinned: true,
            }),
            comment('c2', '第二条评论'),
          ],
          next: 'comments:2',
          total: 1234,
        }
      },
      async page() {
        return { comments: [comment('c3', '下一页的评论')], next: null }
      },
    },

    danmaku: {
      segmentDuration: 60,
      async segment(_video, segment) {
        return [
          { id: `d${segment}-1`, time: segment * 60 + 1.5, text: '前方高能', position: 'scroll', color: '#FFFFFF' },
          { id: `d${segment}-2`, time: segment * 60 + 3, text: '顶部弹幕', position: 'top', color: '#FE0302' },
        ]
      },
    },

    history: {
      async page(page) {
        return { items: page === 1 ? [historyItem('e3', '示例剧 第3集', 0.42)] : [], hasMore: false }
      },
      async delete() {},
      async clear() {},
    },

    links: {
      patterns: ['^https?://(www\\.)?example\\.com/(watch|show)/[\\w-]+'],
      async resolve(url) {
        const match = /example\.com\/(watch|show)\/([\w-]+)/.exec(url)
        if (!match) return null
        return match[1] === 'show' ? { target: { show: match[2] }, title: '示例剧' } : { target: { video: match[2] }, title: '一个视频' }
      },
    },

    playback: {
      async resolve(request) {
        return {
          title: '示例剧 第3集',
          startPosition: 312.5,
          expiresAt: '2026-11-20T14:00:00Z',
          live: false,
          markers: { introEnd: 85, outroStart: 1290, chapters: [{ start: 0, end: 60, title: '开场', imageURL: img('ch1') }, { start: 60, title: '正片' }] },
          streams: [
            {
              id: '1080-zh',
              url: 'https://cdn.example.com/e3/1080/master.m3u8',
              format: 'hls',
              quality: { rank: 1080, label: '1080P' },
              language: { code: 'zh', name: '普通话' },
              description: 'avc1 1080p direct',
              lowerVariants: [{ peakBandwidths: [2400000], label: '720P' }],
            },
            {
              id: '2160-zh',
              url: '/iyt/v1/media/TOKEN/master.m3u8',
              format: 'hls',
              quality: { rank: 2160, label: '4K' },
              language: { code: 'zh', name: '普通话' },
              description: 'hvc1 2160p proxy',
              unavailableReason: '需要会员',
              fallback: { peakBandwidths: [12000000, 12500000], label: 'SDR' },
            },
            {
              id: '720-yue',
              url: 'https://cdn.example.com/e3/720-yue.mp4',
              format: 'mp4',
              quality: { rank: 720, label: '720P' },
              language: { code: 'yue', name: '粤语' },
              description: 'avc1 720p mp4',
            },
          ],
          selectedStream: '1080-zh',
          subtitles: [
            { key: 'zh', name: '中文', language: 'zh', generated: false, vtt: '/iyt/v1/media/TOKEN/zh.vtt', cues: `/iyt/v1/sources/sample/subtitles/${request.video}/zh` },
            { key: 'en.asr', name: '英语（自动生成）', language: 'en', generated: true, cues: `/iyt/v1/sources/sample/subtitles/${request.video}/en.asr` },
          ],
          reportContext: { show: 's1', episode: request.video, session: 42 },
          diagnostics: { client: 'sample', path: 'direct' },
        }
      },
      async progress() {},
      async cues(_ref, key) {
        return key === 'en.asr'
          ? [{ start: 1, end: 2.4, text: 'hello world', words: [{ start: 1, text: 'hello' }, { start: 1.6, text: 'world' }] }]
          : [{ start: 1, end: 2.5, text: '你好' }, { start: 3, end: 4, text: '世界' }]
      },
    },
  }
}
