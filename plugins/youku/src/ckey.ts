// ckey（docs/youku-web/REPORT.md §3）：UPS 要的环境指纹串 `140#…`，由阿里人机识别组件 AWSC/uab（collina.js）生成。
// App 在 WebView 里打开优酷让页面自己算（YoukuCkeyFetcher）；这里用 node:vm 跑同一段 collina.js，给它一个最小的浏览器外壳
// （document / navigator / screen / canvas 等），再调 `uab.getUA()`。脚本每次从阿里 CDN 取当前版本（awsc.js 里写的那个），
// 缓存一天。实测（2026-11-22）这样算出的 ckey 配上 log.mmstat.com 发的 `cna`，UPS 照常给流。
import vm from 'node:vm'
import { SourceError } from '@iyt-source/kit'
import { request } from './mtop.ts'

const AWSC_URL = 'https://g.alicdn.com/AWSC/AWSC/awsc.js'
const CDN = 'https://g.alicdn.com/'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const SCRIPT_TTL = 24 * 3600_000

export interface CollinaScript {
  path: string
  code: string
  fetchedAt: number
}

/** awsc.js 里 uab 模块的稳定版路径（`AWSC/uab/1.140.0/collina.js`）。 */
export function uabPath(awsc: string): string | undefined {
  const match = /uabModule:\{[^}]*?stable:\["([^"]+)"/.exec(awsc)
  return match?.[1]
}

export async function fetchCollina(signal?: AbortSignal): Promise<CollinaScript> {
  const awsc = await (await request(AWSC_URL, { signal }, '阿里 CDN')).text()
  const path = uabPath(awsc)
  if (!path) throw new SourceError('upstream_changed', 'AWSC 里找不到 uab 模块，生成不了播放密钥')
  const response = await request(CDN + path, { signal }, '阿里 CDN')
  if (!response.ok) throw new SourceError('unavailable', `取 collina.js 失败（HTTP ${response.status}）`, { retryable: true })
  return { path, code: await response.text(), fetchedAt: Date.now() }
}

export function scriptIsFresh(script: CollinaScript | undefined): script is CollinaScript {
  return Boolean(script?.code && Date.now() - script.fetchedAt < SCRIPT_TTL)
}

/** 在 vm 里建浏览器外壳（对象都在上下文自己的 realm 里，原型链像浏览器那样）。 */
const SHIM = String.raw`(function (g, host) {
  function getters(proto, values) {
    Object.keys(values).forEach(function (k) {
      var v = values[k]
      Object.defineProperty(proto, k, { get: function () { return v }, configurable: true, enumerable: true })
    })
  }
  function EventTarget() {}
  EventTarget.prototype.addEventListener = function () {}
  EventTarget.prototype.removeEventListener = function () {}
  EventTarget.prototype.dispatchEvent = function () { return true }
  function Node() {}
  Node.prototype = Object.create(EventTarget.prototype)
  Node.prototype.appendChild = function (c) { (this.childNodes || (this.childNodes = [])).push(c); c.parentNode = this; return c }
  Node.prototype.removeChild = function (c) { return c }
  Node.prototype.insertBefore = function (c) { return c }
  function Element() {}
  Element.prototype = Object.create(Node.prototype)
  Element.prototype.setAttribute = function (k, v) { (this.__a || (this.__a = {}))[k] = String(v) }
  Element.prototype.getAttribute = function (k) { return this.__a && k in this.__a ? this.__a[k] : null }
  Element.prototype.getAttributeNames = function () { return Object.keys(this.__a || {}) }
  Element.prototype.hasAttribute = function (k) { return !!(this.__a && k in this.__a) }
  Element.prototype.removeAttribute = function (k) { if (this.__a) delete this.__a[k] }
  Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } }
  Element.prototype.getElementsByTagName = function () { return [] }
  Element.prototype.querySelector = function () { return null }
  Element.prototype.querySelectorAll = function () { return [] }
  function HTMLElement() {}
  HTMLElement.prototype = Object.create(Element.prototype)
  function HTMLCanvasElement() {}
  HTMLCanvasElement.prototype = Object.create(HTMLElement.prototype)
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type !== '2d') return null
    var noop = function () {}
    return { canvas: this, fillRect: noop, fillText: noop, strokeText: noop, arc: noop, beginPath: noop, closePath: noop, fill: noop, stroke: noop, rect: noop,
      moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
      isPointInPath: function () { return false }, measureText: function (t) { return { width: String(t).length * 7.5 } },
      getImageData: function (x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } },
      createLinearGradient: function () { return { addColorStop: noop } }, createRadialGradient: function () { return { addColorStop: noop } },
      font: '10px sans-serif', fillStyle: '#000000', strokeStyle: '#000000', textBaseline: 'alphabetic', globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)' }
  }
  HTMLCanvasElement.prototype.toDataURL = function () { return host.canvasData }
  function HTMLScriptElement() {}
  HTMLScriptElement.prototype = Object.create(HTMLElement.prototype)
  function HTMLImageElement() {}
  HTMLImageElement.prototype = Object.create(HTMLElement.prototype)
  // 组件出错时会往 acjs.aliyun.com 发图片打点：收下，不发。
  ;[HTMLImageElement, HTMLScriptElement].forEach(function (C) {
    Object.defineProperty(C.prototype, 'src', { set: function (v) { host.report(String(v)) }, get: function () { return '' }, configurable: true })
  })
  var kinds = { canvas: HTMLCanvasElement, script: HTMLScriptElement, img: HTMLImageElement }
  function make(tag) {
    var C = kinds[tag] || HTMLElement
    var el = Object.create(C.prototype)
    el.tagName = el.nodeName = tag.toUpperCase()
    el.style = {}
    el.childNodes = []
    el.children = []
    el.attributes = []
    el.innerHTML = ''
    el.parentNode = null
    var page = tag === 'html' || tag === 'body'
    el.clientWidth = el.offsetWidth = page ? host.innerWidth : 0
    el.clientHeight = el.offsetHeight = page ? host.innerHeight : 0
    if (tag === 'canvas') { el.width = 300; el.height = 150 }
    return el
  }
  function Document() {}
  Document.prototype = Object.create(Node.prototype)
  function HTMLDocument() {}
  HTMLDocument.prototype = Object.create(Document.prototype)
  var html = make('html'), head = make('head'), body = make('body')
  html.appendChild(head)
  html.appendChild(body)
  var cookie = host.cookie
  getters(Document.prototype, { documentElement: html, head: head, body: body, URL: host.href, documentURI: host.href, referrer: '', title: '优酷',
    readyState: 'complete', hidden: false, visibilityState: 'visible', characterSet: 'UTF-8', charset: 'UTF-8', compatMode: 'CSS1Compat', domain: host.hostname, currentScript: null })
  Object.defineProperty(Document.prototype, 'cookie', {
    get: function () { return cookie },
    set: function (v) {
      var pair = String(v).split(';')[0], name = pair.split('=')[0]
      cookie = cookie.split('; ').filter(function (p) { return p && p.split('=')[0] !== name }).concat(pair).join('; ')
    },
    configurable: true,
  })
  Document.prototype.createElement = function (t) { return make(String(t).toLowerCase()) }
  Document.prototype.createEvent = function () { return { initEvent: function () {} } }
  Document.prototype.getElementsByTagName = function (t) { t = String(t).toLowerCase(); return t === 'head' ? [head] : t === 'body' ? [body] : t === 'html' ? [html] : [] }
  Document.prototype.getElementById = function () { return null }
  Document.prototype.getElementsByName = function () { return [] }
  Document.prototype.querySelector = function () { return null }
  Document.prototype.querySelectorAll = function () { return [] }
  Document.prototype.hasFocus = function () { return true }
  var document = Object.create(HTMLDocument.prototype)
  function Navigator() {}
  getters(Navigator.prototype, host.navigator)
  Navigator.prototype.javaEnabled = function () { return false }
  function PluginArray() {}
  PluginArray.prototype.item = function () { return null }
  PluginArray.prototype.namedItem = function () { return null }
  PluginArray.prototype.refresh = function () {}
  var plugins = Object.create(PluginArray.prototype)
  plugins.length = 0
  function MimeTypeArray() {}
  var mimeTypes = Object.create(MimeTypeArray.prototype)
  mimeTypes.length = 0
  getters(Navigator.prototype, { plugins: plugins, mimeTypes: mimeTypes, languages: host.languages })
  var navigator = Object.create(Navigator.prototype)
  function Screen() {}
  getters(Screen.prototype, host.screen)
  var screen = Object.create(Screen.prototype)
  function Location() {}
  var location = Object.create(Location.prototype)
  location.href = host.href
  location.protocol = 'https:'
  location.host = location.hostname = host.hostname
  location.port = ''
  location.pathname = host.pathname
  location.search = ''
  location.hash = ''
  location.origin = 'https://' + host.hostname
  location.toString = function () { return this.href }
  function Storage() { this.__d = {} }
  Storage.prototype.getItem = function (k) { return k in this.__d ? this.__d[k] : null }
  Storage.prototype.setItem = function (k, v) { this.__d[k] = String(v) }
  Storage.prototype.removeItem = function (k) { delete this.__d[k] }
  Storage.prototype.clear = function () { this.__d = {} }
  function History() {}
  var history = Object.create(History.prototype)
  history.length = 2
  function Window() {}
  Window.prototype = Object.create(EventTarget.prototype)
  Object.setPrototypeOf(g, Window.prototype)
  var values = {
    window: g, self: g, top: g, parent: g, frames: g, document: document, navigator: navigator, screen: screen, location: location, history: history,
    localStorage: new Storage(), sessionStorage: new Storage(),
    innerWidth: host.innerWidth, innerHeight: host.innerHeight, outerWidth: host.screen.availWidth, outerHeight: host.screen.availHeight, devicePixelRatio: 2,
    screenX: 0, screenY: 25, screenLeft: 0, screenTop: 25, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, name: '', closed: false, length: 0,
    setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, setInterval: host.setInterval, clearInterval: host.clearInterval,
    EventTarget: EventTarget, Node: Node, Element: Element, HTMLElement: HTMLElement, HTMLCanvasElement: HTMLCanvasElement, HTMLScriptElement: HTMLScriptElement,
    HTMLImageElement: HTMLImageElement, Document: Document, HTMLDocument: HTMLDocument, Navigator: Navigator, Screen: Screen, Location: Location, Storage: Storage,
    History: History, Window: Window, PluginArray: PluginArray, MimeTypeArray: MimeTypeArray,
    Image: function () { return make('img') },
    XMLHttpRequest: function () { return { open: function () {}, send: function () {}, setRequestHeader: function () {}, readyState: 0 } },
    performance: { now: host.now, timing: { navigationStart: host.navigationStart } },
    btoa: host.btoa, atob: host.atob, escape: host.escape, unescape: host.unescape,
    matchMedia: function () { return { matches: false, addListener: function () {}, removeListener: function () {} } },
    getComputedStyle: function () { return { getPropertyValue: function () { return '' } } },
    AWSCInner: { register: function (module, feature, exported) { host.register(feature, exported) } },
  }
  Object.keys(values).forEach(function (k) { g[k] = values[k] })
})(globalThis, __host)`

/** 一张写死的小图，canvas 指纹用（真浏览器每台机器各不相同）。 */
const CANVAS_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABkW7XSAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA'

export interface CkeyOptions {
  /** 页面的设备 id（cookie `cna`）：ckey 和它一起交给 UPS。 */
  cna: string
  /** 等组件准备好的时间（毫秒）。 */
  settle?: number
  log?: (message: string) => void
}

/** 跑一遍 collina.js，返回 `140#…`。每次一个新上下文，跑完清掉它开的定时器。 */
export async function generateCkey(script: CollinaScript, options: CkeyOptions): Promise<string> {
  const timers = new Set<NodeJS.Timeout>()
  const intervals = new Set<NodeJS.Timeout>()
  let uab: { getUA?: (config?: unknown) => unknown } | undefined
  const started = Date.now()
  const host = {
    cookie: `cna=${options.cna}`,
    href: 'https://www.youku.com/ku/webhome',
    hostname: 'www.youku.com',
    pathname: '/ku/webhome',
    innerWidth: 1512,
    innerHeight: 860,
    languages: ['zh-CN'],
    navigator: {
      userAgent: SAFARI_UA, appVersion: SAFARI_UA.slice('Mozilla/'.length), appName: 'Netscape', appCodeName: 'Mozilla', product: 'Gecko', productSub: '20030107',
      vendor: 'Apple Computer, Inc.', vendorSub: '', platform: 'MacIntel', language: 'zh-CN', cookieEnabled: true, onLine: true, doNotTrack: null,
      hardwareConcurrency: 8, maxTouchPoints: 0, webdriver: false, pdfViewerEnabled: true,
    },
    screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 944, availLeft: 0, availTop: 38, colorDepth: 30, pixelDepth: 30 },
    canvasData: CANVAS_DATA,
    report: (url: string) => options.log?.(`collina report ${decodeURIComponent(url).slice(0, 160)}`),
    register: (feature: string, exported: typeof uab) => {
      if (feature === 'uab') uab = exported
    },
    setTimeout: (fn: () => void, ms?: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        try { fn() } catch { /* 页面脚本的异常不影响服务 */ }
      }, ms)
      timer.unref()
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer: NodeJS.Timeout) => { clearTimeout(timer); timers.delete(timer) },
    setInterval: (fn: () => void, ms?: number) => {
      const timer = setInterval(() => { try { fn() } catch { /* 同上 */ } }, Math.max(ms ?? 0, 10))
      timer.unref()
      intervals.add(timer)
      return timer
    },
    clearInterval: (timer: NodeJS.Timeout) => { clearInterval(timer); intervals.delete(timer) },
    now: () => Date.now() - started + 3000,
    navigationStart: started - 3000,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    escape,
    unescape,
  }
  const context = vm.createContext({ __host: host }, { name: 'youku-collina', codeGeneration: { strings: true, wasm: false } })
  try {
    vm.runInContext(SHIM, context, { timeout: 2000 })
    vm.runInContext(script.code, context, { timeout: 5000, filename: script.path })
    await new Promise((resolve) => setTimeout(resolve, options.settle ?? 1000))
    if (!uab?.getUA) throw new SourceError('upstream_changed', 'collina.js 没有注册 uab，生成不了播放密钥')
    const value = String(vm.runInContext('__getUA()', Object.assign(context, { __getUA: () => uab!.getUA!() }), { timeout: 5000 }))
    if (!value.startsWith('140#')) throw new SourceError('upstream_changed', `生成的播放密钥不对（${value.slice(0, 24)}）`)
    return value
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('upstream_changed', '运行 collina.js 生成播放密钥失败', { cause: error })
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const timer of intervals) clearInterval(timer)
  }
}
