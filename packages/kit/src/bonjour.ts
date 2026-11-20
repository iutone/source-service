import { Bonjour, type Service } from 'bonjour-service'
import { BASE_PATH, BONJOUR_TYPE, PROTOCOL_VERSION } from '@iyt-source/protocol'

/** 在局域网广播 `_iyt-source._tcp`（SERVER.md §2.4）。 */
export function advertise(options: { name: string; port: number; serverId: string }): { stop(): Promise<void> } {
  const bonjour = new Bonjour()
  const service: Service = bonjour.publish({
    name: options.name,
    type: BONJOUR_TYPE,
    protocol: 'tcp',
    port: options.port,
    txt: { v: String(PROTOCOL_VERSION), id: options.serverId, path: BASE_PATH },
  })
  return {
    stop: () =>
      new Promise((resolve) => {
        service.stop?.(() => bonjour.destroy(() => resolve()))
        if (!service.stop) bonjour.destroy(() => resolve())
      }),
  }
}
