import { isIP } from 'node:net'

function ipv4Parts(ip: string): number[] {
  return ip.split('.').map(Number)
}

/**
 * True for any address a server-side connection made on a customer's behalf must never reach:
 * loopback, private, link-local, carrier-grade NAT, cloud metadata, benchmarking, multicast and
 * other reserved ranges. Used by the website importer and the IMAP/SMTP mailbox connection.
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ipv4Parts(ip)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::' || v6 === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (mapped) return isBlockedAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8')
  }
  return true
}
