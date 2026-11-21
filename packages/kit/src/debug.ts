import type { ExitPool } from './exits.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { serveFile } from './media.ts'
import type { RequestLog } from './requestLog.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 页面用的三方库（不走 CDN：局域网里的设备不一定能上网）。 */
function vendorPath(module: string, file: string): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve(`${module}/package.json`)), file)
  } catch {
    return undefined
  }
}

const STATIC: Record<string, string> = { 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' }

/**
 * 调试页（不属于协议，SERVER.md §11.5）：`/debug`。和协议接口一样只对局域网开放。
 * 页面（Vue 3 免构建版，`debug/` 下的 index.html / app.js / app.css）直接调用协议接口；这里只补二维码、请求日志和三方库。
 */
export function registerDebug(app: FastifyInstance, options: { requestLog: RequestLog; exits?: ExitPool }): void {
  const page = join(here, 'debug', 'index.html')
  const vendor: Record<string, string | undefined> = {
    'hls.js': vendorPath('hls.js', 'dist/hls.min.js'),
    'vue.js': vendorPath('vue', 'dist/vue.global.prod.js'),
  }

  app.get('/', async (_request, reply) => reply.redirect('/debug'))

  app.get('/debug', async (_request, reply) => {
    // 每次读文件，改页面不用重启。
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store')
    return readFileSync(page, 'utf8')
  })

  // 页面的脚本和样式也每次读文件。
  app.get('/debug/:file', async (request, reply) => {
    const file = (request.params as { file: string }).file
    const type = STATIC[file]
    if (!type) return reply.callNotFound()
    reply.header('content-type', type).header('cache-control', 'no-store')
    return readFileSync(join(here, 'debug', file), 'utf8')
  })

  app.get('/debug/vendor/:file', async (request, reply) => {
    const path = vendor[(request.params as { file: string }).file]
    if (!path) return reply.callNotFound()
    reply.header('cache-control', 'max-age=86400')
    serveFile(path, 'text/javascript; charset=utf-8', request, reply)
    return reply
  })

  app.get('/debug/api/log', async () => options.requestLog.recent())

  // 出口池的状态（SERVER.md §18）：每个用途的出口、冷却到几点、最近一次被限的原因。
  app.get('/debug/api/exits', async () => options.exits?.status() ?? {})

  app.get('/debug/api/qr', async (request, reply) => {
    const text = (request.query as { text?: string }).text ?? ''
    reply.header('content-type', 'image/svg+xml')
    return QRCode.toString(text, { type: 'svg', margin: 1, width: 240 })
  })
}
