import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { serveFile } from './media.ts'
import type { RequestLog } from './requestLog.ts'

const here = dirname(fileURLToPath(import.meta.url))

function hlsScriptPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('hls.js')), 'hls.min.js')
  } catch {
    return undefined
  }
}

/**
 * 调试页（不属于协议，SERVER.md §11.5）：`/debug`。和协议接口一样只对局域网开放。
 * 页面直接调用协议接口；这里只补二维码、请求日志和 hls.js。
 */
export function registerDebug(app: FastifyInstance, options: { requestLog: RequestLog }): void {
  const page = join(here, 'debug', 'index.html')
  const hls = hlsScriptPath()

  app.get('/', async (_request, reply) => reply.redirect('/debug'))

  app.get('/debug', async (_request, reply) => {
    // 每次读文件，改页面不用重启。
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store')
    return readFileSync(page, 'utf8')
  })

  app.get('/debug/hls.js', async (request, reply) => {
    if (!hls) {
      reply.code(404)
      return ''
    }
    reply.header('cache-control', 'max-age=86400')
    serveFile(hls, 'text/javascript; charset=utf-8', request, reply)
    return reply
  })

  app.get('/debug/api/log', async () => options.requestLog.recent())

  app.get('/debug/api/qr', async (request, reply) => {
    const text = (request.query as { text?: string }).text ?? ''
    reply.header('content-type', 'image/svg+xml')
    return QRCode.toString(text, { type: 'svg', margin: 1, width: 240 })
  })
}
