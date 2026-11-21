// 调试页（SERVER.md §11.5）：门户样式，照 YouTube 网页版。Vue 3 免构建版，hash 路由，页面直接调用协议接口。
// 顶栏：当前源（点开切换）、搜索（联想）、账号；左侧导航当标签：首页 / 频道 / 筛选 / 我 / 历史 / 收藏夹 / 源 / 调试。
/* global Vue, Hls */
const { createApp, reactive, computed, watch, ref, nextTick } = Vue
const BASE = '/iyt/v1'

// MARK: 工具

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString()
const msg = (error) => (error ? String(error.message || error) : '')
const targetString = (target) => (target.show !== undefined ? `show:${target.show}` : `video:${target.video}`)
const pad = (n) => String(n).padStart(2, '0')

function fmtDuration(seconds) {
  if (seconds == null) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

function fmtCount(n) {
  if (n == null) return ''
  const trim = (x) => x.toFixed(1).replace(/\.0$/, '')
  return n >= 1e8 ? `${trim(n / 1e8)}亿` : n >= 1e4 ? `${trim(n / 1e4)}万` : String(n)
}

function ago(date) {
  if (!date) return ''
  const s = (Date.now() - new Date(date).getTime()) / 1000
  if (!Number.isFinite(s)) return ''
  const units = [[31536000, '年'], [2592000, '个月'], [604800, '周'], [86400, '天'], [3600, '小时'], [60, '分钟']]
  for (const [size, name] of units) if (s >= size) return `${Math.floor(s / size)}${name}前`
  return '刚刚'
}

// MARK: 路由（#/path?query）

const route = reactive({ path: '/', query: {} })
function parseHash() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?')
  route.path = path || '/'
  route.query = Object.fromEntries(new URLSearchParams(query))
}
window.addEventListener('hashchange', () => { parseHash(); window.scrollTo(0, 0) })
parseHash()
const href = (path, query = {}) => { const q = qs(query); return `#${path}${q ? `?${q}` : ''}` }
const go = (path, query) => { location.hash = href(path, query) }
const watchHref = (item) => href('/watch', { t: targetString(item.target) })

// MARK: 状态与请求

const store = reactive({
  manifest: null,
  manifestError: null,
  sourceId: localStorage.getItem('iyt.source'),
  guide: localStorage.getItem('iyt.guide') ? localStorage.getItem('iyt.guide') === '1' : innerWidth >= 1300,
  channels: {},
  last: null,
  toast: null,
  login: null,
  epoch: 0,
  watchGuide: false,
})
const source = () => store.manifest?.sources.find((s) => s.id === store.sourceId) ?? store.manifest?.sources[0] ?? null
const sid = () => source()?.id
const src = (path) => `${BASE}/sources/${sid()}/${path}`

async function api(path, { method = 'GET', body, quiet } = {}) {
  const started = performance.now()
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!quiet) store.last = { method, path, status: response.status, ms: Math.round(performance.now() - started), data }
  if (!response.ok) {
    const error = new Error(data?.error ? `${data.error.code}：${data.error.message}` : `HTTP ${response.status}`)
    error.code = data?.error?.code
    throw error
  }
  return data
}

let toastTimer
function toast(error) {
  store.toast = msg(error)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { store.toast = null }, 8000)
}
const attempt = (run) => Promise.resolve().then(run).catch(toast)

async function loadManifest() {
  try {
    store.manifest = await api(`${BASE}/manifest`, { quiet: true })
    store.manifestError = null
  } catch (error) {
    store.manifestError = error
  }
}

function selectSource(id) {
  store.sourceId = id
  localStorage.setItem('iyt.source', id)
  go('/')
}

function channelsOf() {
  const id = sid()
  if (!id) return Promise.resolve(null)
  store.channels[id] ??= api(src('feed/channels')).catch((error) => { delete store.channels[id]; throw error })
  return store.channels[id]
}
const homeOf = (channels) => source()?.features.feed.home ?? channels.home

/** deps 是数组时逐项比较：路由的 query 每次都是新对象，没变的那几项不该触发重新加载。 */
function watchDeps(deps, run) {
  watch(deps, (now, before) => {
    if (Array.isArray(now) && Array.isArray(before) && now.length === before.length && now.every((x, i) => Object.is(x, before[i]))) return
    run()
  }, { immediate: true })
}

/** 一次加载：deps 变了就重来，旧的结果丢掉。 */
function useLoad(load, deps) {
  const state = reactive({ data: null, error: null, loading: false })
  let token = 0
  state.reload = async () => {
    const mine = ++token
    Object.assign(state, { loading: true, error: null, data: null })
    try {
      const data = await load()
      if (mine === token) state.data = data
    } catch (error) {
      if (mine === token) state.error = error
    } finally {
      if (mine === token) state.loading = false
    }
  }
  watchDeps(deps, state.reload)
  return state
}

/** 分页：fetch(cursor) → { items, next, extra }；next 为空就到头了。 */
function usePager(fetchPage, deps) {
  const state = reactive({ items: [], next: undefined, loading: false, error: null, done: false, extra: null })
  let token = 0
  const load = async (reset) => {
    if (!reset && (state.loading || state.done)) return
    const mine = reset ? ++token : token
    if (reset) Object.assign(state, { items: [], next: undefined, done: false, error: null, extra: null })
    state.loading = true
    try {
      const page = await fetchPage(reset ? undefined : state.next)
      if (mine !== token) return
      state.items.push(...page.items)
      state.next = page.next
      state.done = page.next == null
      if (page.extra) state.extra = page.extra
    } catch (error) {
      if (mine === token) { state.error = error; state.done = true }
    } finally {
      if (mine === token) state.loading = false
    }
  }
  state.more = () => load(false)
  state.retry = () => { state.error = null; state.done = false; load(false) }
  watchDeps(deps, () => load(true))
  return state
}

// 节目分集、UP 主视频（Episode）和历史（VideoItem）也画成卡片。
const episodeItem = (episode, show) => ({
  id: episode.id, title: episode.title, landscapeURL: episode.imageURL, duration: episode.duration, badge: episode.badge,
  stats: episode.views ? { views: episode.views } : undefined, publishedAt: episode.publishedAt,
  target: { video: episode.id }, show,
})
const historyItem = (item) => ({
  id: item.id, title: item.title, landscapeURL: item.coverURL, posterURL: item.posterURL, progress: item.progress, badge: item.badge,
  subtitle: [item.subtitle, item.caption].filter(Boolean).join(' · '),
  extra: [item.lastWatched ? `${ago(item.lastWatched)}看过` : null, item.device?.name, item.unplayableReason].filter(Boolean).join(' · '),
  target: item.showID ? { show: item.showID } : { video: item.id }, video: item.showID ? item.id : undefined,
})
const itemLink = (item) => (item.show || item.video ? href('/watch', { t: item.show ? `show:${item.show}` : targetString(item.target), v: item.video ?? item.id }) : watchHref(item))

// MARK: 图标（Material Symbols 的路径）

const ICONS = {
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  explore: 'M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z',
  history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  you: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88a9.947 9.947 0 0 1 12.28 0C16.43 19.18 14.03 20 12 20z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  filter: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  code: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  server: 'M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
  like: 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
  dislike: 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  down: 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  playlist: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
  people: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  video: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
}
// 收藏夹（Shelf.systemImage 是 SF Symbols 的名字）对应的图标。
const shelfIcon = (name) => ({ clock: 'clock', 'hand.thumbsup': 'like', 'person.2': 'people', star: 'star', heart: 'heart', folder: 'folder' })[name?.split('.fill')[0]] ?? 'playlist'

// MARK: 小组件

const Ic = { props: ['n'], template: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICONS[n] || ICONS.playlist"/></svg>', setup: () => ({ ICONS }) }

const Avatar = {
  props: ['url', 'name'],
  template: `<img v-if="url" class="avatar" :src="url" referrerpolicy="no-referrer" alt="">
    <span v-else class="avatar" :style="{ background: color }">{{ (name || '?').slice(0, 1).toUpperCase() }}</span>`,
  computed: {
    color() { let h = 0; for (const c of this.name || '') h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)` },
  },
}

const Spinner = { template: '<div class="loading"><div class="spinner"></div></div>' }

/** 出错：要登录的给出登录入口。 */
const ErrorBox = {
  props: ['error', 'retry'],
  template: `<div class="empty"><Ic n="video"/><div class="error">{{ msg(error) }}</div>
    <div class="row" style="justify-content:center">
      <button v-if="error.code === 'login_required' && source()?.account.login.length" class="pill dark" @click="startLogin(source(), source().account.login[0])">登录</button>
      <button v-if="retry" class="pill" @click="retry">重试</button></div></div>`,
}

const Empty = { props: ['text', 'icon'], template: '<div class="empty"><Ic :n="icon || \'video\'"/><div>{{ text }}</div><slot/></div>' }

/** 列表底部：滚到附近就加载下一页。 */
const LoadMore = {
  props: ['pager'],
  template: `<div ref="el"><Spinner v-if="pager.loading"/><ErrorBox v-else-if="pager.error" :error="pager.error" :retry="pager.retry"/></div>`,
  mounted() {
    this.io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) this.pager.more() }, { rootMargin: '800px' })
    this.io.observe(this.$refs.el)
  },
  unmounted() { this.io.disconnect() },
  watch: {
    // 加载完还看得见（一页不够一屏）就接着加载。
    'pager.loading'(loading) {
      if (loading) return
      nextTick(() => { if (this.$refs.el && this.$refs.el.getBoundingClientRect().top < innerHeight + 800) this.pager.more() })
    },
  },
}

const Thumb = {
  props: ['item', 'portrait'],
  template: `<div class="thumb">
      <img v-if="picture" :src="picture" loading="lazy" referrerpolicy="no-referrer" alt="">
      <span v-if="item.badge" class="badge" :class="item.badge.tone">{{ item.badge.text }}</span>
      <span v-if="item.rank" class="rank">{{ item.rank }}</span>
      <span v-if="item.duration" class="time">{{ fmtDuration(item.duration) }}</span>
      <span v-else-if="item.caption" class="time">{{ item.caption }}</span>
      <div v-if="item.progress" class="bar"><i :style="{ width: item.progress * 100 + '%' }"></i></div>
    </div>`,
  computed: { picture() { return this.portrait ? this.item.posterURL || this.item.landscapeURL : this.item.landscapeURL || this.item.posterURL } },
}

const metaLine = (item) => [
  item.subtitle || [item.stats?.views != null ? `${fmtCount(item.stats.views)}次观看` : null, ago(item.publishedAt)].filter(Boolean).join(' · '),
  item.duration ? item.caption : null,
].filter(Boolean).join(' · ')

/** 网格里的卡片：缩略图在上，头像、标题、作者、播放量在下。 */
const MediaCard = {
  props: ['item', 'portrait'],
  template: `<a class="card" :href="itemLink(item)">
      <Thumb :item="item" :portrait="portrait"/>
      <div class="meta">
        <Avatar v-if="item.uploader && !portrait" :url="item.uploader.avatarURL" :name="item.uploader.name" class="lg"/>
        <div class="text">
          <div class="title" :title="item.title">{{ item.title }}</div>
          <div v-if="item.uploader" class="sub">{{ item.uploader.name }}</div>
          <div v-if="line" class="sub">{{ line }}</div>
        </div>
      </div></a>`,
  computed: { line() { return metaLine(this.item) } },
}

/** 横排的卡片：搜索结果、历史、观看页右栏。 */
const HCard = {
  props: ['item', 'playing'],
  template: `<a class="hcard" :class="{ playing }" :href="itemLink(item)">
      <Thumb :item="item"/>
      <div class="meta"><div class="text">
        <div class="title" :title="item.title">{{ item.title }}</div>
        <div v-if="line" class="sub">{{ line }}</div>
        <div v-if="item.uploader" class="sub" style="display:flex;gap:8px;align-items:center;margin:4px 0">
          <Avatar :url="item.uploader.avatarURL" :name="item.uploader.name" style="width:24px;height:24px;font-size:11px"/>{{ item.uploader.name }}</div>
        <div v-if="item.extra" class="desc">{{ item.extra }}</div>
      </div><slot/></div></a>`,
  computed: { line() { return metaLine(this.item) } },
}

/** 一组卡片：竖图（节目海报）多的就用竖排网格。 */
const CardGrid = {
  props: ['items'],
  template: `<div class="grid" :class="{ portrait }"><MediaCard v-for="(item, i) in items" :key="item.id + ':' + i" :item="item" :portrait="portrait"/></div>`,
  computed: { portrait() { return this.items.length > 0 && this.items.filter((i) => i.posterURL && !i.landscapeURL).length > this.items.length / 2 } },
}

const Section = {
  props: ['section'],
  template: `<section class="section">
      <div v-if="section.title || section.more" class="section-head"><h2>{{ section.title }}</h2>
        <a v-if="section.more" class="pill sm" :href="href('/more', { route: section.more.route, title: section.more.title || section.title })">{{ section.more.title || '更多' }}</a></div>
      <CardGrid :items="section.items"/></section>`,
}

// MARK: 首页、频道、收藏夹

const FeedView = {
  template: `<div>
    <template v-if="shelf"><h1 class="page-title">{{ route.query.title }}</h1></template>
    <div v-else class="chips sticky">
      <a v-for="c in chips" :key="c.id" class="chip" :class="{ on: c.id === channel?.id }" :href="href('/', { c: c.id })">{{ c.title }}</a>
      <a v-if="channel?.filterCategories?.length" class="chip" :href="href('/filter', { cat: channel.filterCategories[0].id })">筛选</a>
    </div>
    <div v-if="subchannels.length" class="chips">
      <a v-for="c in subchannels" :key="c.id" class="chip" :class="{ on: c.id === feedID }" :href="href(route.path, { ...route.query, sub: c.id })">{{ c.title }}</a>
    </div>
    <ErrorBox v-if="channels.error" :error="channels.error" :retry="channels.reload"/>
    <Section v-for="s in pager.items" :key="s.id" :section="s"/>
    <LoadMore :pager="pager"/>
    <Empty v-if="feedID && pager.done && !pager.items.length && !pager.error" text="这里还没有内容"/>
  </div>`,
  setup() {
    const shelf = computed(() => route.path === '/shelf')
    const channels = useLoad(() => (shelf.value ? null : channelsOf()), () => sid())
    const listed = useLoad(
      () => (shelf.value && route.query.content === 'subchannels' ? api(src(`feed/subchannels?${qs({ id: route.query.id })}`)) : null),
      () => [sid(), route.path, route.query.id],
    )
    const chips = computed(() => {
      const c = channels.data
      if (!c) return []
      const seen = new Set()
      return [homeOf(c), ...c.pinned, ...c.channels].filter((x) => x && !seen.has(x.id) && seen.add(x.id))
    })
    const channel = computed(() => (shelf.value ? { id: route.query.id, title: route.query.title } : chips.value.find((c) => c.id === route.query.c) ?? chips.value[0]))
    // 有子频道的：频道本身在前；收藏夹里的子频道列表：只有子频道。
    const subchannels = computed(() => {
      if (listed.data) return listed.data
      const subs = channel.value?.subchannels
      return subs?.length ? [{ id: channel.value.id, title: '全部' }, ...subs] : []
    })
    const feedID = computed(() => {
      if (subchannels.value.length) return subchannels.value.find((c) => c.id === route.query.sub)?.id ?? subchannels.value[0].id
      return channel.value?.id
    })
    const pager = usePager(async (cursor) => {
      if (!feedID.value || (shelf.value && route.query.content === 'subchannels' && !listed.data)) return { items: [], next: null }
      const page = await api(src(`feed/channel?${qs({ id: feedID.value, cursor })}`))
      return { items: page.sections, next: page.next }
    }, () => [sid(), feedID.value])
    return { shelf, channels, chips, channel, subchannels, feedID, pager }
  },
}

const ChannelsView = {
  template: `<div><h1 class="page-title">频道</h1>
    <ErrorBox v-if="channels.error" :error="channels.error" :retry="channels.reload"/>
    <Spinner v-else-if="!channels.data"/>
    <div v-else class="tiles">
      <a v-for="c in all" :key="c.id" class="tile" :href="href('/', { c: c.id })">{{ c.title }}
        <small v-if="c.subchannels?.length">{{ c.subchannels.map((s) => s.title).join(' · ') }}</small></a>
    </div>
    <template v-if="channels.data?.library.length"><h2 class="page-title" style="font-size:20px">收藏夹</h2>
      <div class="tiles"><a v-for="s in channels.data.library" :key="s.channel.id" class="tile" :href="shelfHref(s)"><Ic :n="shelfIcon(s.systemImage)"/><br>{{ s.channel.title }}</a></div></template>
  </div>`,
  setup() {
    const channels = useLoad(channelsOf, () => sid())
    const all = computed(() => {
      const c = channels.data
      if (!c) return []
      const seen = new Set()
      return [homeOf(c), ...c.pinned, ...c.channels].filter((x) => x && !seen.has(x.id) && seen.add(x.id))
    })
    return { channels, all }
  },
}
const shelfHref = (shelf) => href('/shelf', { id: shelf.channel.id, content: shelf.content, title: shelf.channel.title })

const MoreView = {
  template: `<div><h1 class="page-title">{{ route.query.title || '更多' }}</h1>
    <CardGrid :items="pager.items"/><LoadMore :pager="pager"/></div>`,
  setup() {
    const pager = usePager(async (cursor) => {
      const page = await api(src(`feed/more?${qs({ route: route.query.route, cursor })}`))
      return { items: page.items, next: page.next }
    }, () => [sid(), route.query.route])
    return { pager }
  },
}

/** 收藏夹里「关注的 UP 主」一类：头像墙。 */
const UploaderList = {
  template: `<div><h1 class="page-title">{{ route.query.title }}</h1>
    <div class="people">
      <a v-for="p in pager.items" :key="p.uploader.id" class="person" :href="href('/uploader', { id: p.uploader.id })">
        <Avatar :url="p.uploader.avatarURL" :name="p.uploader.name"/><b>{{ p.uploader.name }}</b>
        <small class="muted">{{ [p.uploader.followers != null ? fmtCount(p.uploader.followers) + ' 位订阅者' : null, p.signature].filter(Boolean).join(' · ') }}</small></a>
    </div><LoadMore :pager="pager"/></div>`,
  setup() {
    const pager = usePager(async (cursor) => {
      const page = await api(src(`feed/uploaders?${qs({ id: route.query.id, cursor })}`))
      return { items: page.uploaders, next: page.next }
    }, () => [sid(), route.query.id])
    return { pager }
  },
}

// MARK: 筛选

const FilterView = {
  template: `<div>
    <div class="chips sticky"><a v-for="c in categories.data || []" :key="c.id" class="chip" :class="{ on: c.id === category }" :href="href('/filter', { cat: c.id })">{{ c.title }}</a></div>
    <ErrorBox v-if="categories.error" :error="categories.error"/>
    <div class="dims">
      <div v-for="d in dimensions.data || []" :key="d.id" class="chips"><b>{{ d.title }}</b>
        <a v-for="o in d.options" :key="o.id" class="chip" :class="{ on: (selection[d.id] ?? d.defaultOptionID) === o.id }" :href="pick(d, o)">{{ o.title }}</a></div>
    </div>
    <CardGrid :items="pager.items"/><LoadMore :pager="pager"/>
  </div>`,
  setup() {
    const categories = useLoad(() => api(src('filter/categories')), () => sid())
    const category = computed(() => route.query.cat || categories.data?.[0]?.id)
    const dimensions = useLoad(() => (category.value ? api(src(`filter/dimensions?${qs({ category: category.value })}`)) : null), () => [sid(), category.value])
    const selection = computed(() => { try { return JSON.parse(route.query.sel || '{}') } catch { return {} } })
    const pick = (d, o) => href('/filter', { cat: category.value, sel: JSON.stringify({ ...selection.value, [d.id]: o.id }) })
    const pager = usePager(async (cursor) => {
      if (!category.value) return { items: [], next: null }
      const page = await api(src(`filter/results?${qs({ category: category.value, selection: JSON.stringify(selection.value), cursor })}`))
      return { items: page.items, next: page.next }
    }, () => [sid(), category.value, route.query.sel])
    return { categories, category, dimensions, selection, pick, pager }
  },
}

// MARK: 搜索

const SearchView = {
  template: `<div style="max-width:1100px;padding-top:16px">
    <template v-if="!route.query.q">
      <Empty v-if="!features?.rankings" icon="search" text="在上面搜索"/>
      <Section v-for="r in rankings.data || []" :key="r.id" :section="{ title: r.title, items: r.items }"/>
    </template>
    <template v-else>
      <div v-if="top" class="descbox" style="margin-bottom:24px">
        <HCard :item="top.show"/>
        <div v-if="top.facts" class="facts" style="margin-top:8px">{{ top.facts }}</div><p v-if="top.summary">{{ top.summary }}</p>
        <div v-if="top.episodes.length" class="chips"><a v-for="e in top.episodes" :key="e.id" class="chip" :href="href('/watch', { t: 'show:' + top.show.target.show, v: e.id })">{{ e.title }}</a></div>
      </div>
      <template v-if="shows.length"><div class="section-head"><h2>节目</h2></div><CardGrid :items="shows"/><div style="height:32px"></div></template>
      <div class="list"><HCard v-for="(v, i) in pager.items" :key="v.id + ':' + i" :item="v"/></div>
      <LoadMore :pager="pager"/>
      <Empty v-if="pager.done && !pager.error && !pager.items.length && !shows.length && !top" icon="search" text="没有结果"/>
    </template>
  </div>`,
  setup() {
    const features = computed(() => source()?.features.search)
    const rankings = useLoad(() => (!route.query.q && features.value?.rankings ? api(src('search/rankings')) : null), () => [sid(), route.query.q])
    const pager = usePager(async (cursor) => {
      if (cursor === undefined) {
        const data = await api(src(`search?${qs({ q: route.query.q })}`))
        return { items: data.videos, next: data.moreVideos, extra: { top: data.topMatch, shows: data.shows } }
      }
      const page = await api(src(`search/videos?${qs({ q: route.query.q, cursor })}`))
      return { items: page.items, next: page.next }
    }, () => [sid(), route.query.q])
    return { features, rankings, pager, top: computed(() => pager.extra?.top), shows: computed(() => pager.extra?.shows ?? []) }
  },
}

// MARK: 观看页

const Player = {
  props: ['media', 'streamId', 'report', 'video', 'show', 'poster'],
  template: '<div class="player"><video ref="video" controls playsinline autoplay :poster="poster"></video></div>',
  mounted() {
    const video = this.$refs.video
    video.addEventListener('playing', () => { if (!this.started) { this.started = true; this.send('start') } })
    video.addEventListener('seeked', () => this.send('seek'))
    video.addEventListener('pause', () => { if (!video.ended) this.send('leave') })
    video.addEventListener('ended', () => this.send('end'))
    this.timer = setInterval(() => { if (!video.paused) this.send('progress') }, 15000)
    this.attach()
  },
  unmounted() { clearInterval(this.timer); this.hls?.destroy() },
  watch: { streamId() { this.attach() }, media() { this.attach() } },
  methods: {
    attach() {
      const video = this.$refs.video
      this.hls?.destroy()
      this.hls = null
      this.started = false
      const stream = this.media.streams.find((s) => s.id === this.streamId) ?? this.media.streams[0]
      const position = video.currentTime > 1 ? video.currentTime : this.media.startPosition
      video.addEventListener('loadedmetadata', () => { if (position) video.currentTime = position; video.play().catch(() => {}) }, { once: true })
      // Safari 原生播 HLS；其他浏览器用 hls.js（新版 Chrome 也说能原生播，但解不了字节区间的 fMP4）。
      if (stream.format === 'hls' && !/Apple/.test(navigator.vendor) && window.Hls?.isSupported()) {
        this.hls = new Hls()
        this.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) toast(`hls.js：${data.type} ${data.details}`) })
        this.hls.loadSource(stream.url)
        this.hls.attachMedia(video)
      } else {
        video.src = stream.url
      }
    },
    send(event) {
      if (!this.report) return
      const video = this.$refs.video
      api(src('playback/progress'), { method: 'POST', quiet: true, body: {
        event, video: this.video, show: this.show ?? null, position: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null, reportContext: this.media.reportContext,
      } }).catch(toast)
    },
  },
}

const Comments = {
  props: ['video'],
  template: `<div class="comments">
    <h2>{{ total != null ? fmtCount(total) + ' 条评论' : '评论' }}
      <span class="chips" style="padding:0"><button class="chip" :class="{ on: sort === 'hot' }" @click="sort = 'hot'">最热</button><button class="chip" :class="{ on: sort === 'latest' }" @click="sort = 'latest'">最新</button></span></h2>
    <CommentRow v-for="c in pager.items" :key="c.id" :comment="c"/>
    <LoadMore :pager="pager"/>
    <div v-if="pager.done && !pager.error && !pager.items.length" class="muted">没有评论</div>
  </div>`,
  setup(props) {
    const sort = ref('hot')
    const total = ref(null)
    const pager = usePager(async (cursor) => {
      const page = cursor ? await api(src(`comments/page?${qs({ cursor })}`)) : await api(src(`comments?${qs({ video: props.video, sort: sort.value })}`))
      if (!cursor) total.value = page.total ?? null
      return { items: page.comments, next: page.next }
    }, () => [sid(), props.video, sort.value])
    return { sort, total, pager }
  },
}

const CommentRow = {
  name: 'CommentRow',
  props: ['comment'],
  template: `<div class="comment"><Avatar :url="comment.author.avatarURL" :name="comment.author.name" class="lg"/>
    <div style="min-width:0;flex:1">
      <div class="who" :style="{ color: comment.author.nameColor }">{{ comment.author.name }}<small>{{ [comment.isPinned ? '置顶' : null, ago(comment.date), comment.location].filter(Boolean).join(' · ') }}</small></div>
      <p>{{ comment.text }}</p>
      <div v-if="comment.pictures?.length" class="pics"><img v-for="p in comment.pictures" :key="p" :src="p" referrerpolicy="no-referrer"></div>
      <div class="acts"><Ic n="like"/>{{ comment.likes ? fmtCount(comment.likes) : '' }}</div>
      <template v-if="!replies">
        <CommentRow v-for="r in comment.previewReplies || []" :key="r.id" :comment="r"/>
        <button v-if="comment.replies && comment.replyCount" class="link" style="margin-top:6px" @click="open">{{ comment.replyCount }} 条回复</button>
      </template>
      <template v-else><CommentRow v-for="r in replies.items" :key="r.id" :comment="r"/><LoadMore :pager="replies"/></template>
    </div></div>`,
  data: () => ({ replies: null }),
  methods: {
    open() {
      this.replies = usePager(async (cursor) => {
        const page = await api(src(`comments/page?${qs({ cursor: cursor ?? this.comment.replies })}`))
        return { items: page.comments, next: page.next }
      }, () => this.comment.id)
    },
  },
}

const WatchView = {
  template: `<div class="watch">
    <div>
      <ErrorBox v-if="detail.error" :error="detail.error" :retry="detail.reload"/>
      <Player v-if="media.data" :media="media.data" :stream-id="streamID" :report="report" :video="videoID" :show="d?.showID" :poster="poster"/>
      <div v-else class="player"><img v-if="poster" :src="poster" referrerpolicy="no-referrer" alt="">
        <div class="over"><div v-if="media.loading" class="spinner"></div>
          <template v-else-if="media.error"><div>{{ msg(media.error) }}</div>
            <div class="row" style="justify-content:center"><button v-if="media.error.code === 'login_required' && source()?.account.login.length" class="pill dark" @click="startLogin(source(), source().account.login[0])">登录</button>
            <button class="pill" style="background:#fff3;color:#fff" @click="media.reload">重试</button></div></template></div></div>

      <template v-if="d">
        <h1>{{ title }}</h1>
        <div class="owner">
          <a v-if="d.uploader" class="who" :href="features.detail.uploader ? href('/uploader', { id: d.uploader.id }) : undefined">
            <Avatar :url="d.uploader.avatarURL" :name="d.uploader.name" class="lg"/>
            <span><b>{{ d.uploader.name }}</b><small v-if="d.uploader.followers != null">{{ fmtCount(d.uploader.followers) }} 位订阅者</small></span></a>
          <button v-if="d.uploader && can.follow" class="pill" :class="{ dark: !state.data?.isFollowingUploader }" @click="follow">{{ state.data?.isFollowingUploader ? '已订阅' : '订阅' }}</button>
          <span v-for="u in d.coUploaders || []" :key="u.id" class="pill sm"><Avatar :url="u.avatarURL" :name="u.name" style="width:20px;height:20px;font-size:10px"/>{{ u.name }}</span>
          <span class="spacer"></span>
          <span v-if="can.like || can.dislike" class="seg">
            <button v-if="can.like" :class="{ on: state.data?.isLiked }" @click="toggle('like', 'isLiked')"><Ic n="like"/>{{ d.stats?.likes ? fmtCount(d.stats.likes) : '' }}</button>
            <button v-if="can.dislike" :class="{ on: state.data?.isDisliked }" @click="toggle('dislike', 'isDisliked')"><Ic n="dislike"/></button></span>
        </div>
        <div class="descbox" :class="{ clamped: !expanded }" @click="expanded = true">
          <div class="facts">{{ facts }}</div>
          <div v-if="d.tags.length" class="tags"><span v-for="t in d.tags" :key="t">#{{ t }}</span></div>
          <p v-if="d.summary || d.shortSummary">{{ d.summary || d.shortSummary }}</p>
          <p v-if="d.credits.length" class="muted">{{ d.credits.map((c) => c.role ? c.name + '（' + c.role + '）' : c.name).join('、') }}</p>
          <button v-if="!expanded" class="link" style="margin-top:4px">…展开</button>
        </div>

        <details class="panel"><summary>调试：取流</summary>
          <div class="row">最高清晰度 <select v-model="maxQuality" class="field"><option value="">不限</option><option v-for="r in [2160, 1440, 1080, 720, 480, 360]" :key="r" :value="r">{{ r }}</option></select>
            <label><input type="checkbox" v-model="adaptive"> 自动清晰度</label>
            <label><input type="checkbox" v-model="report"> 上报进度</label>
            <span v-if="media.data?.expiresAt" class="muted">地址到期 {{ new Date(media.data.expiresAt).toLocaleString() }}</span></div>
          <table v-if="media.data"><tr><th></th><th>id</th><th>清晰度</th><th>语言</th><th>格式</th><th>说明</th></tr>
            <tr v-for="s in media.data.streams" :key="s.id"><td><span v-if="s.unavailableReason" class="muted">{{ s.unavailableReason }}</span>
              <button v-else class="pill sm" :class="{ dark: s.id === streamID }" @click="stream = s.id">播放</button></td>
              <td class="mono">{{ s.id }}</td><td>{{ s.quality.label }}</td><td>{{ s.language?.name }}</td><td>{{ s.format }}</td><td><a class="link" :href="s.url" target="_blank">{{ s.description }}</a></td></tr></table>
          <div v-if="media.data?.subtitles?.length" class="row" style="margin-top:12px">字幕原文：
            <button v-for="t in media.data.subtitles" :key="t.key" class="pill sm" :disabled="!t.cues" @click="cues(t)">{{ t.name }}</button></div>
          <pre v-if="cueText">{{ cueText }}</pre>
          <div v-if="media.data?.diagnostics" class="muted mono" style="margin-top:8px">{{ JSON.stringify(media.data.diagnostics) }}</div>
          <details style="margin-top:8px"><summary class="muted">解析结果 JSON</summary><pre>{{ JSON.stringify(media.data, null, 2) }}</pre></details>
          <details><summary class="muted">详情 JSON</summary><pre>{{ JSON.stringify(d, null, 2) }}</pre></details>
        </details>

        <Comments v-if="features.detail.comments && videoID" :key="videoID" :video="videoID"/>
      </template>
      <Spinner v-else-if="detail.loading"/>
    </div>

    <div v-if="d">
      <div v-if="episodes" class="episodes">
        <header><b>{{ d.uploads && !d.episodes ? '作者的视频' : d.title }}</b><span class="muted">{{ episodes.summary || (episodes.episodes.length + ' 个视频') }}</span>
          <div v-if="episodes.ranges?.length" class="chips" style="padding:8px 0 0"><button v-for="r in episodes.ranges" :key="r.cursor" class="chip" :class="{ on: episodes.selectedRange?.cursor === r.cursor }" @click="range(r)">{{ r.title }}</button></div>
          <div v-if="episodes.parts?.length" class="chips" style="padding:8px 0 0"><a v-for="p in episodes.parts" :key="p.id" class="chip" :class="{ on: p.isCurrent }" :href="href('/watch', { t: 'show:' + p.id })">{{ p.title }}</a></div></header>
        <div class="scroll"><a v-for="(e, i) in episodes.episodes" :key="e.id" class="ep" :class="{ on: e.id === videoID }" :href="href('/watch', { t: route.query.t, v: e.id })">
          <span class="n">{{ e.id === videoID ? '▶' : i + 1 }}</span>
          <div v-if="e.imageURL" class="thumb"><img :src="e.imageURL" loading="lazy" referrerpolicy="no-referrer" alt=""><span v-if="e.duration" class="time">{{ fmtDuration(e.duration) }}</span></div>
          <div style="min-width:0"><div class="t">{{ e.stage && !e.title.includes(e.stage) ? e.stage + ' ' : '' }}{{ e.title }}</div>
            <div class="muted" style="font-size:12px">{{ [e.badge?.text, e.isPaid ? '付费' : null, e.views ? fmtCount(e.views) + '次观看' : null].filter(Boolean).join(' · ') }}</div></div></a></div>
      </div>
      <template v-if="d.series.length"><div class="chips"><a v-for="s in d.series" :key="s.id" class="chip" :href="watchHref(s)">{{ s.title }}</a></div></template>
      <div v-if="d.recommendations.tabs.length > 1" class="chips"><button v-for="(t, i) in d.recommendations.tabs" :key="i" class="chip" :class="{ on: i === tab }" @click="recommend(i)">{{ t.title }}</button></div>
      <div class="list compact"><HCard v-for="(r, i) in recommendations" :key="r.id + ':' + i" :item="r"/></div>
    </div>
  </div>`,
  setup() {
    const features = computed(() => source().features)
    const detail = useLoad(() => api(src(`detail?${qs({ target: route.query.t })}`)), () => [sid(), route.query.t])
    const d = computed(() => detail.data)
    const videoID = computed(() => route.query.v || d.value?.resume?.videoID || d.value?.defaultVideoID || (route.query.t?.startsWith('video:') ? route.query.t.slice(6) : null))
    const maxQuality = ref(localStorage.getItem('iyt.maxQuality') ?? '')
    const adaptive = ref(false)
    const report = ref(false)
    watch(maxQuality, (value) => localStorage.setItem('iyt.maxQuality', value))
    const media = useLoad(async () => {
      if (!videoID.value || !d.value) return null
      return api(src('playback/resolve'), { method: 'POST', body: {
        video: videoID.value, show: d.value.showID ?? null,
        preferences: { maxQualityRank: maxQuality.value ? Number(maxQuality.value) : null, adaptive: adaptive.value },
      } })
    }, () => [sid(), videoID.value, d.value, maxQuality.value, adaptive.value])
    const stream = ref(null)
    watch(() => media.data, () => { stream.value = null })
    const streamID = computed(() => stream.value ?? media.data?.selectedStream)

    const episodeList = ref(null)
    watch(d, () => { episodeList.value = null })
    const episodes = computed(() => episodeList.value ?? d.value?.episodes ?? d.value?.uploads ?? null)
    const range = (r) => attempt(async () => {
      const list = await api(src(`detail/episodes?${qs({ cursor: r.cursor })}`))
      episodeList.value = { ...episodes.value, ...list, ranges: list.ranges ?? episodes.value.ranges, selectedRange: r }
    })
    const current = computed(() => episodes.value?.episodes.find((e) => e.id === videoID.value))
    const title = computed(() => {
      const show = d.value?.title ?? ''
      const episode = current.value && d.value?.episodes ? current.value.title : ''
      return episode && !episode.includes(show) ? `${show} ${episode}` : episode || show
    })
    const facts = computed(() => {
      const x = d.value
      // attributes 往往已经有播放量和日期。
      return [x.attributes || [x.stats?.views != null ? `${fmtCount(x.stats.views)}次观看` : null, ago(x.publishedAt)].filter(Boolean).join(' '), x.category, x.updateInfo,
        ...x.ratings.map((r) => `${r.source === 'douban' ? '豆瓣' : '评分'} ${r.score}`)].filter(Boolean).join('  ')
    })
    const poster = computed(() => current.value?.imageURL || d.value?.landscapeURL || d.value?.posterURL)

    // 推荐：第一个标签是详情带来的，其余按需取。
    const tab = ref(0)
    const tabItems = ref(null)
    watch(d, () => { tab.value = 0; tabItems.value = null })
    const recommendations = computed(() => tabItems.value ?? d.value?.recommendations.items ?? [])
    const recommend = (i) => attempt(async () => {
      tab.value = i
      const cursor = d.value.recommendations.tabs[i].cursor
      tabItems.value = cursor ? await api(src(`detail/recommendations?${qs({ cursor })}`)) : null
    })

    // 互动
    const can = computed(() => (source().account.loggedIn || !source().account.login.length ? features.value.detail.actions ?? {} : {}))
    const state = useLoad(() => (Object.keys(can.value).length && videoID.value && d.value
      ? api(src(`actions/state?${qs({ video: videoID.value, uploader: d.value.uploader?.id })}`), { quiet: true }) : null),
    () => [sid(), videoID.value, d.value])
    const toggle = (action, key) => attempt(async () => {
      const value = !state.data?.[key]
      await api(src(`actions/${action}`), { method: 'POST', body: { video: videoID.value, value } })
      state.data = { ...state.data, [key]: value, ...(value ? { [key === 'isLiked' ? 'isDisliked' : 'isLiked']: false } : {}) }
    })
    const follow = () => attempt(async () => {
      const value = !state.data?.isFollowingUploader
      await api(src('actions/follow'), { method: 'POST', body: { uploader: d.value.uploader.id, value } })
      state.data = { ...state.data, isFollowingUploader: value }
    })

    const cueText = ref('')
    const cues = (track) => attempt(async () => {
      const data = await api(track.cues)
      cueText.value = `${track.name}：${data.cues.length} 句\n` + data.cues.slice(0, 20).map((c) => `${fmtDuration(c.start)}  ${c.text}`).join('\n')
    })
    return {
      features, detail, d, videoID, media, maxQuality, adaptive, report, stream, streamID, episodes, range, title, facts, poster,
      tab, recommendations, recommend, can, state, toggle, follow, cueText, cues, expanded: ref(false),
    }
  },
}

// MARK: UP 主

const UploaderView = {
  template: `<div>
    <ErrorBox v-if="profile.error" :error="profile.error" :retry="profile.reload"/>
    <div v-else-if="p" class="channel-head"><Avatar :url="p.uploader.avatarURL" :name="p.uploader.name" class="xl"/>
      <div><h1>{{ p.uploader.name }}</h1>
        <div class="muted">{{ [p.uploader.followers != null ? fmtCount(p.uploader.followers) + ' 位订阅者' : null, p.videoCount != null ? p.videoCount + ' 个视频' : null, p.followingCount != null ? '关注 ' + p.followingCount : null].filter(Boolean).join(' · ') }}</div>
        <p v-if="p.signature" class="muted" style="margin:8px 0">{{ p.signature }}</p>
        <button v-if="p.isFollowing != null" class="pill" :class="{ dark: !p.isFollowing }" @click="follow">{{ p.isFollowing ? '已订阅' : '订阅' }}</button></div></div>
    <Spinner v-else/>
    <div class="tabs"><button :class="{ on: tab === 'videos' }" @click="tab = 'videos'">视频</button>
      <button v-if="collections.data?.length" :class="{ on: tab === 'collections' }" @click="tab = 'collections'">合集</button></div>
    <template v-if="tab === 'videos'"><ErrorBox v-if="videos.error" :error="videos.error"/><Spinner v-else-if="videos.loading"/>
      <CardGrid v-else-if="videos.data" :items="videos.data.episodes.map((e) => episodeItem(e))"/>
      <Empty v-else text="没有视频"/></template>
    <template v-else>
      <div class="chips"><button v-for="c in collections.data" :key="c.cursor" class="chip" :class="{ on: c === collection }" @click="open(c)">{{ c.title }}</button></div>
      <CardGrid v-if="collectionEpisodes" :items="collectionEpisodes.map((e) => episodeItem(e))"/></template>
  </div>`,
  setup() {
    const profile = useLoad(() => api(src(`uploader?${qs({ id: route.query.id })}`)), () => [sid(), route.query.id])
    const videos = useLoad(() => api(src(`uploader/videos?${qs({ id: route.query.id })}`)), () => [sid(), route.query.id])
    const collections = useLoad(() => api(src(`uploader/collections?${qs({ id: route.query.id })}`), { quiet: true }).catch(() => []), () => [sid(), route.query.id])
    const collection = ref(null)
    const collectionEpisodes = ref(null)
    const open = (c) => attempt(async () => {
      collection.value = c
      collectionEpisodes.value = (await api(src(`detail/episodes?${qs({ cursor: c.cursor })}`))).episodes
    })
    const follow = () => attempt(async () => {
      const value = !profile.data.isFollowing
      await api(src('actions/follow'), { method: 'POST', body: { uploader: route.query.id, value } })
      profile.data = { ...profile.data, isFollowing: value }
    })
    return { profile, p: computed(() => profile.data), videos, collections, collection, collectionEpisodes, open, follow, tab: ref('videos') }
  },
}

// MARK: 我、历史

const HistoryView = {
  template: `<div style="max-width:1100px">
    <div class="section-head" style="margin-top:24px"><h2 style="font-size:28px">观看历史</h2>
      <button v-if="features?.delete" class="pill" @click="clear">清空观看历史</button></div>
    <Empty v-if="!features" icon="history" text="这个源没有观看历史"/>
    <template v-else><div class="list">
      <HCard v-for="(v, i) in pager.items" :key="v.id + ':' + i" :item="historyItem(v)">
        <button v-if="features.delete && v.historyKey" class="icon-btn" title="删除" @click.prevent="remove(v)"><Ic n="close"/></button></HCard>
    </div><LoadMore :pager="pager"/>
    <Empty v-if="pager.done && !pager.error && !pager.items.length" icon="history" text="还没有观看记录"/></template>
  </div>`,
  setup() {
    const features = computed(() => source()?.features.history)
    const pager = usePager(async (cursor) => {
      if (!features.value) return { items: [], next: null }
      const page = cursor ?? 1
      const data = await api(src(`history?${qs({ page })}`))
      return { items: data.items, next: data.hasMore ? page + 1 : null }
    }, () => sid())
    const remove = (item) => attempt(async () => {
      await api(src('history/delete'), { method: 'POST', body: { keys: [item.historyKey] } })
      pager.items.splice(pager.items.indexOf(item), 1)
    })
    const clear = () => attempt(async () => {
      if (!confirm('清空这个源的观看历史？')) return
      await api(src('history/clear'), { method: 'POST', body: {} })
      pager.items.splice(0)
    })
    return { features, pager, remove, clear }
  },
}

const YouView = {
  template: `<div>
    <div class="channel-head"><Avatar :url="account.profile?.avatarURL" :name="account.profile?.name || source().name" class="xl"/>
      <div><h1>{{ account.loggedIn ? account.profile?.name : source().name }}</h1>
        <div class="muted">{{ account.loggedIn ? membership : account.login.length ? '未登录：账号由服务保管，全家共用' : '这个源不用登录' }}</div>
        <div class="row" style="margin-top:12px">
          <template v-if="!account.loggedIn"><button v-for="m in account.login" :key="m" class="pill dark" @click="startLogin(source(), m)">{{ methodName(m) }}</button></template>
          <button v-else class="pill" @click="logout(source())"><Ic n="logout"/>退出登录</button></div></div></div>
    <template v-if="source().features.history">
      <div class="section-head"><h2>观看历史</h2><a class="pill sm" :href="href('/history')">查看全部</a></div>
      <ErrorBox v-if="recent.error" :error="recent.error"/><CardGrid v-else-if="recent.data" :items="recent.data.items.slice(0, 8).map(historyItem)"/></template>
    <template v-if="channels.data?.library.length"><div class="section-head" style="margin-top:32px"><h2>收藏夹</h2></div>
      <div class="tiles"><a v-for="s in channels.data.library" :key="s.channel.id" class="tile" :href="shelfHref(s)"><Ic :n="shelfIcon(s.systemImage)"/><br>{{ s.channel.title }}</a></div></template>
  </div>`,
  setup() {
    const account = computed(() => source().account)
    const membership = computed(() => {
      const m = account.value.profile?.membership
      return m ? `${m.tier}${m.active ? '' : '（已过期）'}${m.endsAt ? ` · 到 ${new Date(m.endsAt).toLocaleDateString()}` : ''}` : '已登录'
    })
    const recent = useLoad(() => (source().features.history ? api(src('history?page=1'), { quiet: true }) : null), () => [sid(), account.value.loggedIn])
    const channels = useLoad(channelsOf, () => sid())
    return { account, membership, recent, channels }
  },
}

// MARK: 调试：服务、接口、请求日志

const ServerView = {
  template: `<div v-if="store.manifest">
    <h1 class="page-title">{{ store.manifest.server.name }}</h1>
    <p class="muted">协议 v{{ store.manifest.protocol }} · {{ store.manifest.server.software }} {{ store.manifest.server.version }}
      <template v-for="(v, k) in store.manifest.server.components || {}" :key="k"> · {{ k }} {{ v }}</template> · <span class="mono">{{ store.manifest.server.id }}</span></p>
    <div class="sources">
      <div v-for="s in store.manifest.sources" :key="s.id" class="source-card">
        <div class="name"><img v-if="s.brand.logo" :src="s.brand.logo" alt="">{{ s.name }}<span class="dot" :class="s.status.state" :title="s.status.state"></span>
          <img v-if="s.brand.tabIcon" :src="s.brand.tabIcon" alt="" title="首页标签图标" style="height:21px;width:auto;margin-left:auto;border-radius:0;background:#8884"></div>
        <div class="muted mono">id: {{ s.id }}<span v-if="s.brand.tint"> · tint {{ s.brand.tint }}</span></div>
        <div v-if="s.status.message" class="muted">{{ s.status.message }}</div>
        <div>{{ capabilities(s) }}</div>
        <div v-if="!s.account.login.length" class="muted">无需登录</div>
        <div v-else-if="s.account.loggedIn" class="row" style="margin:0">已登录：{{ s.account.profile?.name }}<button class="pill sm" @click="logout(s)">退出</button></div>
        <div v-else class="row" style="margin:0"><span class="muted">未登录（{{ { nothing: '可选', play: '播放需要', browse: '必须' }[s.account.requiredFor] }}）</span>
          <button v-for="m in s.account.login" :key="m" class="pill sm" @click="startLogin(s, m)">{{ methodName(m) }}</button></div>
        <div class="row" style="margin:0"><button class="pill sm" @click="selectSource(s.id)">打开</button></div>
      </div>
    </div>
    <Empty v-if="!store.manifest.sources.length" icon="server" text="配置里没有源：在数据目录的 config.yaml 的 sources 里加上，再重启服务"/>
    <details class="panel"><summary>manifest</summary><pre>{{ JSON.stringify(store.manifest, null, 2) }}</pre></details>
  </div>`,
  setup() {
    const capabilities = (s) => {
      const f = s.features
      return [f.feed.channelBrowser ? '频道' : null, f.filter ? '筛选' : null, f.search ? '搜索' : null, f.detail.comments ? '评论' : null,
        f.detail.actions ? '互动' : null, f.history ? '历史' : null, f.danmaku ? '弹幕' : null, f.subtitles ? '字幕' : null,
        f.progress ? '进度上报' : null, f.fairPlay ? 'FairPlay' : null, s.links ? '链接' : null].filter(Boolean).join(' · ')
    }
    return { capabilities }
  },
}

const ConsoleView = {
  template: `<div><h1 class="page-title">接口</h1>
    <div class="row"><select v-model="method" class="field"><option>GET</option><option>POST</option></select>
      <input v-model="path" class="field mono" style="flex:1;min-width:320px" @keydown.enter="send"><button class="pill dark" @click="send">发送</button></div>
    <div class="chips"><button v-for="e in examples" :key="e" class="chip" @click="path = e === 'manifest' ? BASE + '/manifest' : prefix + e">{{ e }}</button></div>
    <textarea v-if="method === 'POST'" v-model="body" class="field" rows="6" placeholder="JSON 体"></textarea>
    <div class="panel"><div class="muted" style="margin-bottom:8px">{{ store.last ? store.last.method + ' ' + store.last.path + ' → ' + store.last.status + '（' + store.last.ms + ' ms）' : '最近一次响应' }}</div>
      <pre>{{ store.last ? (typeof store.last.data === 'string' ? store.last.data : JSON.stringify(store.last.data, null, 2)) : '' }}</pre></div>
  </div>`,
  setup() {
    const prefix = computed(() => (sid() ? `${BASE}/sources/${sid()}/` : `${BASE}/`))
    const method = ref('GET')
    const path = ref(`${prefix.value}feed/channels`)
    const body = ref('')
    const send = () => api(path.value, { method: method.value, body: method.value === 'POST' ? JSON.parse(body.value || '{}') : undefined }).catch(() => {})
    const examples = ['manifest', 'account', 'feed/channels', 'search?q=', 'detail?target=video:', 'history?page=1', 'links/resolve']
    return { BASE, prefix, method, path, body, send, examples }
  },
}

const LogView = {
  template: `<div><template v-if="exitRows.length"><h1 class="page-title">出口</h1>
    <p class="muted">按用途的上游代理出口：被平台限流的冷却后换下一个（SERVER.md §18）</p>
    <table><tr><th>用途</th><th>出口</th><th>状态</th><th>被限次数</th><th>最近一次被限</th><th>最近成功</th></tr>
      <tr v-for="e in exitRows" :key="e.purpose + e.url"><td>{{ e.purpose }}</td><td class="mono">{{ e.url }}</td>
        <td :class="{ error: e.coolingUntil }">{{ e.coolingUntil ? '冷却到 ' + new Date(e.coolingUntil).toLocaleTimeString() : '可用' }}</td>
        <td>{{ e.limited }}</td><td>{{ e.lastFailureAt ? new Date(e.lastFailureAt).toLocaleTimeString() + ' ' + e.lastFailure : '' }}</td>
        <td class="muted">{{ e.lastSuccessAt ? new Date(e.lastSuccessAt).toLocaleTimeString() : '' }}</td></tr></table></template>
    <h1 class="page-title">请求日志</h1><p class="muted">最近 300 条，每 3 秒刷新（调试页自己的请求不记）</p>
    <table><tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>错误</th><th>对端</th></tr>
      <tr v-for="(r, i) in records" :key="i"><td>{{ new Date(r.at).toLocaleTimeString() }}</td><td>{{ r.method }}</td><td class="mono" style="word-break:break-all">{{ r.path }}</td>
        <td :class="{ error: r.status >= 400 }">{{ r.status }}</td><td>{{ r.ms }} ms</td><td>{{ r.errorCode ? r.errorCode + '：' + r.errorMessage : '' }}</td><td class="muted">{{ r.peer }}</td></tr></table></div>`,
  data: () => ({ records: [], exits: {} }),
  computed: {
    exitRows() {
      return Object.entries(this.exits).flatMap(([purpose, list]) => list.map((e) => ({ purpose, ...e })))
    },
  },
  mounted() {
    const refresh = async () => {
      this.records = await api('/debug/api/log', { quiet: true }).catch(() => this.records)
      this.exits = await api('/debug/api/exits', { quiet: true }).catch(() => this.exits)
      this.timer = setTimeout(refresh, 3000)
    }
    refresh()
  },
  unmounted() { clearTimeout(this.timer) },
}

// MARK: 登录

const methodName = (method) => ({ qr: '扫码登录', deviceCode: '设备码登录', webCookie: '导入 Cookie' })[method] || method

async function startLogin(target, method) {
  const login = reactive({ source: target, method, step: null, id: null, error: null, cookies: '' })
  store.login = login
  if (method === 'webCookie') return
  try {
    let current = await api(`${BASE}/sources/${target.id}/login/start`, { method: 'POST', body: { method } })
    login.id = current.loginId
    while (store.login === login) {
      login.step = current.step
      if (current.step.kind === 'completed' || current.step.kind === 'failed') { if (current.step.kind === 'completed') afterLogin(); break }
      current = await api(`${BASE}/sources/${target.id}/login/${current.loginId}?${qs({ after: current.seq, wait: 25 })}`, { quiet: true })
    }
  } catch (error) {
    login.error = error
  }
}

async function submitCookies() {
  const login = store.login
  await attempt(async () => {
    const result = await api(`${BASE}/sources/${login.source.id}/login/cookie`, { method: 'POST', body: { cookies: JSON.parse(login.cookies), userAgent: navigator.userAgent } })
    login.step = result.step
    if (result.step.kind === 'completed') afterLogin()
  })
}

function afterLogin() {
  store.channels = {}
  loadManifest()
}

function closeLogin() {
  const login = store.login
  store.login = null
  if (login?.id) api(`${BASE}/sources/${login.source.id}/login/${login.id}/cancel`, { method: 'POST', body: {}, quiet: true }).catch(() => {})
}

async function logout(target) {
  if (!confirm(`退出 ${target.name} 的账号？连这个服务的所有设备都会退出。`)) return
  await attempt(async () => {
    await api(`${BASE}/sources/${target.id}/account/logout`, { method: 'POST', body: {} })
    afterLogin()
  })
}

const LoginDialog = {
  template: `<dialog ref="dialog" @close="closeLogin">
    <template v-if="login"><h3>{{ login.source.name }} · {{ methodName(login.method) }}</h3>
      <div v-if="login.error" class="error">{{ msg(login.error) }}</div>
      <template v-else-if="login.method === 'webCookie' && !login.step">
        <p class="muted">App 会打开登录网页自动完成；这里可以粘贴 cookie JSON 调试。<br v-if="login.source.account.webLogin">{{ login.source.account.webLogin?.url }}</p>
        <textarea v-model="login.cookies" class="field" rows="8" placeholder='[{"name":"SID","value":"…","domain":".example.com"}]'></textarea>
        <div class="row" style="margin-top:12px"><button class="pill dark" @click="submitCookies">提交</button></div></template>
      <Spinner v-else-if="!login.step"/>
      <template v-else-if="login.step.kind === 'showCode'"><div>{{ login.step.title }}</div>
        <img class="qr" :src="'/debug/api/qr?' + qs({ text: login.step.content })" width="240" height="240" alt="">
        <div>{{ login.step.message }}</div>
        <a v-if="login.step.openURL" class="link" :href="login.step.openURL" target="_blank">{{ login.step.openURL }}</a>
        <div v-if="login.step.expiresAt" class="muted">到期 {{ new Date(login.step.expiresAt).toLocaleTimeString() }}</div></template>
      <div v-else-if="login.step.kind === 'waiting'">{{ login.step.message }}</div>
      <div v-else-if="login.step.kind === 'completed'">已登录：{{ login.step.profile.name }}</div>
      <div v-else class="error">{{ login.step.message }}</div>
      <div class="row" style="justify-content:flex-end;margin:16px 0 0"><button class="pill" @click="$refs.dialog.close()">关闭</button></div></template>
  </dialog>`,
  computed: { login: () => store.login },
  watch: {
    login(login) {
      const dialog = this.$refs.dialog
      if (login && !dialog.open) dialog.showModal()
      if (!login && dialog.open) dialog.close()
    },
  },
}

// MARK: 顶栏、导航

const SearchBox = {
  template: `<form class="search" @submit.prevent="submit()">
    <input v-model="text" :placeholder="features?.prompt || '搜索'" :disabled="!features" @focus="open = true" @blur="blur" @input="suggest" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)">
    <button class="go" title="搜索"><Ic n="search"/></button>
    <div v-if="open && suggestions.length" class="suggest">
      <div v-for="(s, i) in suggestions" :key="s.keyword" :class="{ on: i === active }" @mousedown.prevent="submit(s.keyword)"><Ic n="search"/>{{ s.keyword }}<span class="muted">{{ s.tag || s.detail }}</span></div></div>
  </form>`,
  setup() {
    const text = ref(route.query.q ?? '')
    watch(() => route.query.q, (q) => { text.value = q ?? '' })
    const suggestions = ref([])
    const open = ref(false)
    const active = ref(-1)
    const features = computed(() => source()?.features.search)
    let timer
    const suggest = () => {
      active.value = -1
      clearTimeout(timer)
      if (!features.value?.suggestions || !text.value.trim()) { suggestions.value = []; return }
      timer = setTimeout(() => api(src(`search/suggestions?${qs({ q: text.value })}`), { quiet: true }).then((list) => { suggestions.value = list }).catch(() => {}), 200)
    }
    const move = (step) => {
      if (!suggestions.value.length) return
      active.value = (active.value + step + suggestions.value.length) % suggestions.value.length
      text.value = suggestions.value[active.value].keyword
    }
    const submit = (keyword) => {
      if (keyword) text.value = keyword
      open.value = false
      if (text.value.trim()) go('/search', { q: text.value.trim() })
    }
    const blur = () => setTimeout(() => { open.value = false }, 100)
    return { text, suggestions, open, active, features, suggest, move, submit, blur }
  },
}

const TopBar = {
  template: `<header class="topbar">
    <button class="icon-btn" title="导航" @click="toggleGuide"><Ic n="menu"/></button>
    <div style="position:relative">
      <button class="brand" @click="menu = menu === 'source' ? null : 'source'" title="切换源">
        <img v-if="s?.brand.logo" :src="s.brand.logo" alt=""><span class="name">{{ s?.name ?? '自建源' }}</span><sup>{{ store.manifest?.server.name }}</sup><Ic n="down" style="width:18px"/></button>
      <div v-if="menu === 'source'" class="menu left" @click="menu = null">
        <button v-for="x in store.manifest?.sources || []" :key="x.id" class="item" @click="selectSource(x.id)">
          <img v-if="x.brand.logo" :src="x.brand.logo" alt=""><Ic v-else n="video"/><span style="flex:1">{{ x.name }}</span><span class="dot" :class="x.status.state"></span></button>
        <a class="item" :href="href('/server')"><Ic n="server"/>服务与源</a></div>
    </div>
    <SearchBox/>
    <button class="icon-btn" title="刷新" @click="refresh"><Ic n="refresh"/></button>
    <div v-if="s?.account.login.length" style="position:relative">
      <button v-if="s.account.loggedIn" class="icon-btn" @click="menu = menu === 'account' ? null : 'account'"><Avatar :url="s.account.profile?.avatarURL" :name="s.account.profile?.name"/></button>
      <button v-else class="pill outline" @click="menu = menu === 'account' ? null : 'account'"><Ic n="you"/>登录</button>
      <div v-if="menu === 'account'" class="menu" @click="menu = null">
        <div v-if="s.account.loggedIn" class="head"><Avatar :url="s.account.profile?.avatarURL" :name="s.account.profile?.name" class="lg"/>
          <div><b>{{ s.account.profile?.name }}</b><div class="muted">{{ s.name }} · 全家共用</div></div></div>
        <a class="item" :href="href('/you')"><Ic n="you"/>我</a>
        <template v-if="!s.account.loggedIn"><button v-for="m in s.account.login" :key="m" class="item" @click="startLogin(s, m)"><Ic n="you"/>{{ methodName(m) }}</button></template>
        <button v-else class="item" @click="logout(s)"><Ic n="logout"/>退出登录</button></div>
    </div>
  </header>`,
  data: () => ({ menu: null }),
  computed: { s: () => source() },
  mounted() { this.close = (e) => { if (!this.$el.contains(e.target)) this.menu = null }; document.addEventListener('click', this.close) },
  unmounted() { document.removeEventListener('click', this.close) },
  methods: {
    toggleGuide() {
      if (route.path === '/watch') { store.watchGuide = !store.watchGuide; return }
      store.guide = !store.guide
      localStorage.setItem('iyt.guide', store.guide ? '1' : '0')
    },
    refresh() { store.channels = {}; store.epoch++; loadManifest() },
  },
}

const Guide = {
  template: `<nav v-if="mode === 'wide' || mode === 'overlay'" class="guide" :class="{ floating: mode === 'overlay' }" @click="mode === 'overlay' && (store.watchGuide = false)">
    <template v-if="s">
      <a :href="href('/')" :class="{ on: route.path === '/' }"><Ic n="home"/><span>首页</span></a>
      <a v-if="s.features.feed.channelBrowser" :href="href('/channels')" :class="{ on: route.path === '/channels' }"><Ic n="explore"/><span>频道</span></a>
      <a v-if="s.features.filter" :href="href('/filter')" :class="{ on: route.path === '/filter' }"><Ic n="filter"/><span>筛选</span></a>
      <hr>
      <a :href="href('/you')" :class="{ on: route.path === '/you' }"><Ic n="you"/><span>我</span></a>
      <a v-if="s.features.history" :href="href('/history')" :class="{ on: route.path === '/history' }"><Ic n="history"/><span>历史</span></a>
      <a v-for="x in library" :key="x.channel.id" :href="shelfHref(x)" :class="{ on: route.path === '/shelf' && route.query.id === x.channel.id }"><Ic :n="shelfIcon(x.systemImage)"/><span>{{ x.channel.title }}</span></a>
      <hr>
    </template>
    <h4>源</h4>
    <button v-for="x in store.manifest?.sources || []" :key="x.id" class="row" :style="x.id === s?.id ? 'background:var(--chip);font-weight:600' : ''" @click="selectSource(x.id)">
      <img v-if="x.brand.logo" :src="x.brand.logo" alt=""><Ic v-else n="video"/><span>{{ x.name }}</span><i class="dot" :class="x.status.state"></i></button>
    <hr><h4>调试</h4>
    <a :href="href('/server')" :class="{ on: route.path === '/server' }"><Ic n="server"/><span>服务与源</span></a>
    <a :href="href('/console')" :class="{ on: route.path === '/console' }"><Ic n="code"/><span>接口</span></a>
    <a :href="href('/log')" :class="{ on: route.path === '/log' }"><Ic n="list"/><span>请求日志</span></a>
  </nav>
  <nav v-else-if="mode === 'rail'" class="rail">
    <a :href="href('/')"><Ic n="home"/>首页</a>
    <a v-if="s?.features.feed.channelBrowser" :href="href('/channels')"><Ic n="explore"/>频道</a>
    <a v-if="s?.features.history" :href="href('/history')"><Ic n="history"/>历史</a>
    <a v-if="s" :href="href('/you')"><Ic n="you"/>我</a>
    <a :href="href('/server')"><Ic n="server"/>调试</a>
  </nav>`,
  setup() {
    const s = computed(() => source())
    const channels = useLoad(channelsOf, () => [sid(), s.value?.account.loggedIn])
    return { s, library: computed(() => channels.data?.library ?? []), mode: guideMode }
  },
}

/** 左侧导航：宽的整列、窄的图标列；观看页照 YouTube 收起，点菜单才浮出来。 */
const guideMode = computed(() => (route.path === '/watch' ? (store.watchGuide ? 'overlay' : 'none') : store.guide ? 'wide' : 'rail'))
watch(() => route.path, () => { store.watchGuide = false })

const VIEWS = {
  '/': FeedView, '/shelf': FeedView, '/channels': ChannelsView, '/more': MoreView, '/filter': FilterView, '/search': SearchView,
  '/watch': WatchView, '/uploader': UploaderView, '/history': HistoryView, '/you': YouView,
  '/server': ServerView, '/console': ConsoleView, '/log': LogView,
}
const SOURCELESS = new Set(['/server', '/console', '/log'])

const App = {
  template: `<TopBar/><Guide/>
    <main class="main" :class="mode">
      <ErrorBox v-if="store.manifestError" :error="store.manifestError" :retry="loadManifest"/>
      <Spinner v-else-if="!store.manifest"/>
      <Empty v-else-if="!source() && !SOURCELESS.has(route.path)" icon="server" text="配置里没有源：在数据目录的 config.yaml 的 sources 里加上，再重启服务"><a class="pill" :href="href('/server')">服务与源</a></Empty>
      <component v-else :is="view" :key="[route.path, sid(), source()?.account.loggedIn, store.epoch].join('|')"/>
    </main>
    <LoginDialog/>
    <div v-if="store.toast" class="toast"><span>{{ store.toast }}</span><button @click="store.toast = null"><Ic n="close" style="width:20px;height:20px"/></button></div>`,
  computed: {
    mode: () => guideMode.value,
    view() {
      if (route.path === '/shelf' && route.query.content === 'uploaders') return UploaderList
      return VIEWS[route.path] ?? FeedView
    },
  },
}

const app = createApp(App)
Object.assign(app.config.globalProperties, {
  store, route, source, sid, href, msg, qs, fmtDuration, fmtCount, ago, watchHref, itemLink, shelfHref, shelfIcon, episodeItem, historyItem,
  methodName, startLogin, submitCookies, closeLogin, logout, selectSource, loadManifest, SOURCELESS, BASE, JSON,
})
for (const [name, component] of Object.entries({
  Ic, Avatar, Spinner, ErrorBox, Empty, LoadMore, Thumb, MediaCard, HCard, CardGrid, Section, Player, Comments, CommentRow,
  LoginDialog, SearchBox, TopBar, Guide,
})) app.component(name, component)
app.mount('#app')
loadManifest()
