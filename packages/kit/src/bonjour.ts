import { hostname, networkInterfaces } from 'node:os'
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
      // SRV 的目标和 A / AAAA 记录的名字：bonjour-service 默认用 os.hostname()（「mxc-nas」「Mac」，不带 .local），
      // 这种名字 mDNS 解析不了，只能靠路由器的 DNS；设备 DNS 不是路由器时就拿不到地址。补上 .local。
      host: localHostName(),
      txt: { v: String(PROTOCOL_VERSION), id: options.serverId, path: BASE_PATH },
    })
    // bonjour-service 把每块网卡的地址都发成 A / AAAA 记录，NAS 上就混进了 Docker、LXC 网桥的内部地址
    // （172.29.0.1、10.0.5.1……），App 挑中它们就连不上。只留局域网网卡的。
    const records = service.records.bind(service)
    const keep = new Set(lanAddresses())
    service.records = () => records().filter((record) => (record.type !== 'A' && record.type !== 'AAAA') || keep.has(String(record.data)))
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

/** 本机的 mDNS 主机名：`<hostname>.local`（已有 .local 的不重复加）。 */
export function localHostName(name = hostname()): string {
  const base = name.replace(/\.$/, '').replace(/\.local$/i, '')
  return `${base}.local`
}

/** 容器、虚拟机、VPN 的虚拟网卡（不在局域网上）。注意 QNAP 的局域网网卡本身就叫 qvs0，是个网桥，不能按「br」一概排除。 */
const VIRTUAL = /^(docker\d*|br-[0-9a-f]+|veth|lxcbr|lxdbr|virbr|vnet|cni|flannel|cali|tun|tap|utun|wg|zt|tailscale|awdl|llw|bridge\d+|vmnet|vboxnet)/i

/** 局域网网卡的地址（A / AAAA 记录用）：排除回环、虚拟网卡、IPv4 自动地址 169.254。 */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const out: string[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.internal || address.mac === '00:00:00:00:00:00') continue
      if (address.family === 'IPv4' && address.address.startsWith('169.254.')) continue
      out.push(address.address)
    }
  }
  return out
}
