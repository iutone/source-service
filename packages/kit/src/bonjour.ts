import { Bonjour, type Service } from 'bonjour-service'
import { BASE_PATH, BONJOUR_TYPE, PROTOCOL_VERSION } from '@iyt-source/protocol'

/**
 * 在局域网广播 `_iyt-source._tcp`（SERVER.md §2.4）。
 * 网络变化时 mDNS 发送会失败（EADDRNOTAVAIL 等）：bonjour-service 默认把错误抛出去，整个进程就崩了。这里接住它，
 * 过一会儿重新广播（网卡地址换了也跟着换）。
 */
export function advertise(options: { name: string; port: number; serverId: string; onError?: (error: Error) => void }): { stop(): Promise<void> } {
  let bonjour: Bonjour | undefined
  let service: Service | undefined
  let restart: NodeJS.Timeout | undefined
  let stopped = false

  const start = () => {
    bonjour = new Bonjour({}, (error: Error) => {
      options.onError?.(error)
      scheduleRestart()
    })
    service = bonjour.publish({
      name: options.name,
      type: BONJOUR_TYPE,
      protocol: 'tcp',
      port: options.port,
      txt: { v: String(PROTOCOL_VERSION), id: options.serverId, path: BASE_PATH },
    })
    service.on?.('error', (error: Error) => {
      options.onError?.(error)
      scheduleRestart()
    })
  }

  const teardown = () =>
    new Promise<void>((resolve) => {
      const current = bonjour
      bonjour = undefined
      service = undefined
      if (!current) return resolve()
      try {
        current.unpublishAll(() => current.destroy(() => resolve()))
      } catch {
        resolve()
      }
    })

  const scheduleRestart = () => {
    if (stopped || restart) return
    restart = setTimeout(() => {
      restart = undefined
      void teardown().then(() => {
        if (!stopped) start()
      })
    }, 10_000)
    restart.unref()
  }

  start()
  return {
    stop: async () => {
      stopped = true
      if (restart) clearTimeout(restart)
      await teardown()
    },
  }
}
