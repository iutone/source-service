import { isIP } from 'node:net'

/**
 * 对端是否在局域网内（SERVER.md §2.3）：回环、RFC 1918、CGNAT 之外的私有段、链路本地、ULA。
 * IPv4 映射的 IPv6（::ffff:192.168.1.2）按 IPv4 判断。
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false
  let value = address.trim()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)
  if (mapped) value = mapped[1]
  const family = isIP(value)
  if (family === 4) {
    const [a, b] = value.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    const lower = value.toLowerCase()
    if (lower === '::1') return true
    const first = parseInt(lower.split(':')[0] || '0', 16)
    // fe80::/10 链路本地，fc00::/7 ULA。
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00
  }
  return false
}

/**
 * `Host` 头是否可信（防 DNS rebinding）：IP 字面量、localhost、`*.local`，或配置列出的主机名。
 */
export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[] = []): boolean {
  if (!hostHeader) return false
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end > 0 ? host.slice(1, end) : host
  } else {
    const colon = host.lastIndexOf(':')
    if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon)
  }
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (isIP(host) !== 0) return true
  if (host === 'localhost' || host.endsWith('.local')) return true
  return allowed.some((name) => name.toLowerCase() === host)
}
