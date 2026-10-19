import { promises as dns } from 'node:dns'
import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

// Who may reach the agent connection: this Mac itself and the devices on the user's tailnet. Tailscale gives every
// device an IPv4 in the carrier-grade NAT range 100.64.0.0/10 and an IPv6 in fd7a:115c:a1e0::/48.

/** Loopback, which is all that is ever used to reach this Mac from itself. */
export const LOOPBACK = '127.0.0.1'

/** Tailscale's own DNS resolver ("quad 100"). Only Tailscale answers it, never the network the user is on. */
const TAILSCALE_DNS = '100.100.100.100'

function ipv4Octets(address: string): number[] | undefined {
  if (!isIPv4(address)) return undefined
  return address.split('.').map(Number)
}

function ipv4Number(address: string): number | undefined {
  const o = ipv4Octets(address)
  return o ? ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0 : undefined
}

/** 100.64.0.0/10: 100.64.0.0 – 100.127.255.255. */
export function isTailscaleIPv4(address: string): boolean {
  const o = ipv4Octets(address)
  return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** fd7a:115c:a1e0::/48. */
export function isTailscaleIPv6(address: string): boolean {
  if (!isIPv6(address)) return false
  const groups = address.toLowerCase().split(':')
  return groups[0] === 'fd7a' && groups[1] === '115c' && groups[2] === 'a1e0'
}

/** An IPv4 peer on a dual-stack socket shows up as "::ffff:1.2.3.4"; this gives "1.2.3.4". */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return ''
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return mapped ? mapped[1] : address
}

function isLoopback(address: string): boolean {
  if (address === '::1') return true
  const o = ipv4Octets(address)
  return !!o && o[0] === 127
}

// Node reports the family as 'IPv4' (or 4 in some versions).
const isV4 = (e: NetworkInterfaceInfo): boolean => e.family === 'IPv4' || (e.family as unknown) === 4
const isV6 = (e: NetworkInterfaceInfo): boolean => e.family === 'IPv6' || (e.family as unknown) === 6

/** The length of an IPv4 netmask's prefix ("255.192.0.0" → 10), or undefined when it isn't one. */
function prefixLength(netmask: string): number | undefined {
  const n = ipv4Number(netmask)
  if (n === undefined) return undefined
  const bits = n.toString(2).padStart(32, '0')
  return /^1*0*$/.test(bits) ? bits.replace(/0+$/, '').length : undefined
}

/**
 * The interfaces Tailscale has set up, by what Tailscale always gives its tunnel rather than by the address
 * range alone: other VPNs (Cloudflare WARP, NetBird) and some hotel, carrier or Starlink networks hand out
 * addresses in the same carrier-grade NAT range (100.64/10) too, and Studio must never listen there. Always with
 * Tailscale's own IPv6 (fd7a:115c:a1e0::/48) beside an IPv4 in that range:
 * - macOS (and Linux): a utun (tailscale0) tunnel whose IPv4 is a single address (/32); a Wi-Fi or Ethernet network
 *   can't put addresses on a utun interface.
 * - Windows: the adapter Tailscale installs, named "Tailscale" (Node gives the adapter's name); its IPv4 netmask may
 *   be /32 or as wide as the whole range (/10), so it is only required to lie within the range.
 * `platform` and `interfaces` are given by tests.
 */
export function pickTailscaleInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  platform: NodeJS.Platform = process.platform
): Map<string, NetworkInterfaceInfo[]> {
  const windows = platform === 'win32'
  const found = new Map<string, NetworkInterfaceInfo[]>()
  for (const [name, list] of Object.entries(interfaces)) {
    const named = windows ? /^tailscale(?: \d+)?$/i.test(name) : /^(?:utun|tailscale)\d*$/.test(name)
    if (!list || !named) continue
    if (!list.some((e) => isV6(e) && isTailscaleIPv6(e.address))) continue
    const v4 = list.filter(
      (e) =>
        isV4(e) &&
        !e.internal &&
        isTailscaleIPv4(e.address) &&
        (windows ? (prefixLength(e.netmask) ?? 0) >= 10 : e.netmask === '255.255.255.255')
    )
    if (v4.length) found.set(name, v4)
  }
  return found
}

function tailscaleInterfaces(): Map<string, NetworkInterfaceInfo[]> {
  return pickTailscaleInterfaces(networkInterfaces())
}

/** This Mac's Tailscale IPv4 addresses (normally one, on a utun interface); empty when Tailscale is off. */
export function tailscaleAddresses(): string[] {
  const found = new Set<string>()
  for (const list of tailscaleInterfaces().values()) for (const e of list) found.add(e.address)
  return [...found].sort()
}

/**
 * True when the IPv4 address lies in a network this Mac is directly attached to other than Tailscale's (a
 * LAN or VPN that numbers its devices in 100.64.0.0/10). Such a peer is a neighbour, not a tailnet device.
 */
function onAttachedNetwork(address: string): boolean {
  const n = ipv4Number(address)
  if (n === undefined) return false
  const tailscale = tailscaleInterfaces()
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!list || tailscale.has(name)) continue
    for (const e of list) {
      if (!isV4(e) || e.internal) continue
      const own = ipv4Number(e.address)
      const mask = ipv4Number(e.netmask)
      if (own !== undefined && mask !== undefined && ((own & mask) >>> 0) === ((n & mask) >>> 0)) return true
    }
  }
  return false
}

/**
 * True for this Mac itself and for devices on the tailnet; every other peer is turned away. `local` is the
 * address of the socket the connection came in on: the loopback one only serves this Mac, and the Tailscale
 * one only tailnet peers. That matters because macOS accepts packets for any of its addresses on any
 * interface, so a neighbour on a LAN numbered in 100.64.0.0/10 could otherwise reach the Tailscale socket.
 */
export function isAllowedPeer(rawAddress: string | undefined, rawLocal?: string): boolean {
  const address = normalizeAddress(rawAddress)
  if (rawLocal === undefined) return isLoopback(address) || isTailscaleIPv4(address) || isTailscaleIPv6(address)
  const local = normalizeAddress(rawLocal)
  if (isLoopback(local)) return isLoopback(address)
  if (isTailscaleIPv4(local)) return isTailscaleIPv4(address) && !onAttachedNetwork(address)
  return false
}

/**
 * The MagicDNS name of a Tailscale address (e.g. "<your-mac>.<tailnet>.ts.net"). Asked of
 * Tailscale's own resolver, never the network's: the name goes into the agent configuration together with the
 * token, so a café's DNS must not get to choose it. Only a .ts.net name that leads back to the same address
 * counts. Undefined when it can't be found in time.
 */
export async function magicDnsName(address: string, timeoutMs = 1500): Promise<string | undefined> {
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers([TAILSCALE_DNS])
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolver.cancel()
      resolve(undefined)
    }, timeoutMs * 2)
    timer.unref?.()
  })
  const lookup = async (): Promise<string | undefined> => {
    const names = await resolver.reverse(address)
    const name = names.map((n) => n.replace(/\.$/, '')).find((n) => /\.ts\.net$/i.test(n))
    if (!name) return undefined
    const back = await resolver.resolve4(name)
    return back.includes(address) ? name : undefined
  }
  try {
    return await Promise.race([lookup().catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}
