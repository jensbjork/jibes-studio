import { createHash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Fetching a file an agent names by URL. Studio runs on a Mac that can reach the user's LAN, services on the Mac
// itself and every device on the tailnet, so a prompt-injected agent must never get to use it as a proxy into
// those: only public addresses are fetched – plus the agent's own machine, which it can reach anyway. The host name
// is resolved here and the socket connects to the very address that was checked (no DNS rebinding); every redirect
// is checked again. Node's own http/https are used, never Electron's net (which would follow a system proxy past
// the check).

export const MAX_URL_LENGTH = 2048
const MAX_REDIRECTS = 3
const CONNECT_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 30_000

export const ONLY_HTTP = 'Bara http- och https-adresser kan hämtas.'
export const PRIVATE_ADDRESS = 'Adressen pekar på ett privat eller lokalt nätverk, som Studio inte hämtar från.'
export const TOO_SLOW = 'Hämtningen tog för lång tid.'
export const TOO_MANY_REDIRECTS = 'För många omdirigeringar.'

/** A refusal or failure that carries its Swedish message (and, for the size cap, a code the caller maps). */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly code?: 'too-large' | 'blocked' | 'aborted'
  ) {
    super(message)
  }
}

// ── Addresses ────────────────────────────────────────────────────────────────

function ipv4Bytes(address: string): number[] | undefined {
  if (!isIPv4(address)) return undefined
  return address.split('.').map(Number)
}

/** The 16 bytes of an IPv6 address (a zone id dropped, a dotted IPv4 tail read as its 4 bytes). */
export function ipv6Bytes(raw: string): number[] | undefined {
  let address = raw.split('%')[0]
  if (!isIPv6(address)) return undefined
  let tail: number[] | undefined
  const lastColon = address.lastIndexOf(':')
  if (address.slice(lastColon + 1).includes('.')) {
    tail = ipv4Bytes(address.slice(lastColon + 1))
    if (!tail) return undefined
    address = `${address.slice(0, lastColon + 1)}0:0`
  }
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const part = (s: string): string[] => (s ? s.split(':') : [])
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : undefined
  const groups = rest === undefined ? head : [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest]
  if (groups.length !== 8) return undefined
  const out: number[] = []
  for (const g of groups) {
    const n = parseInt(g, 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return undefined
    out.push(n >> 8, n & 0xff)
  }
  if (tail) out.splice(12, 4, ...tail)
  return out
}

function publicIPv4(o: readonly number[]): boolean {
  const [a, b, c] = o
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT, the tailnet among it
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false // multicast, reserved and the broadcast address
  return true
}

function publicIPv6(x: readonly number[]): boolean {
  const zero = (from: number, to: number): boolean => x.slice(from, to).every((v) => v === 0)
  const v4 = (at: number): number[] => x.slice(at, at + 4)
  // IPv4-compatible (::/96, which holds :: and ::1 too) and IPv4-mapped (::ffff:0:0/96): the IPv4 decides.
  if (zero(0, 12)) return publicIPv4(v4(12))
  if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) return publicIPv4(v4(12))
  const nat64 = x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b
  if (nat64 && zero(4, 12)) return publicIPv4(v4(12)) // 64:ff9b::/96
  if (nat64 && x[4] === 0 && x[5] === 1) return false // 64:ff9b:1::/48, local NAT64
  if (x[0] === 0x20 && x[1] === 0x02) return publicIPv4(v4(2)) // 6to4
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0 && x[3] === 0) return false // Teredo
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) return false // documentation
  // Everything else outside global unicast (2000::/3) is local, link-local, unique-local (the tailnet's
  // fd7a:115c:a1e0::/48 among it), multicast or reserved.
  return (x[0] & 0xe0) === 0x20
}

/** True for an address on the public internet; false for loopback, private, link-local, tailnet, special ones. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Bytes(address)
  if (v4) return publicIPv4(v4)
  const v6 = ipv6Bytes(address)
  return v6 ? publicIPv6(v6) : false
}

/** An address in a comparable form: IPv4 as dotted text (also when mapped into IPv6), IPv6 as its bytes. */
function canonical(address: string): string | undefined {
  if (isIPv4(address)) return address
  const v6 = ipv6Bytes(address)
  if (!v6) return undefined
  if (v6.slice(0, 10).every((v) => v === 0) && v6[10] === 0xff && v6[11] === 0xff) return v6.slice(12).join('.')
  return v6.map((v) => v.toString(16).padStart(2, '0')).join('')
}

function isLoopback(address: string): boolean {
  const c = canonical(address)
  if (!c) return false
  if (isIPv4(c)) return c.startsWith('127.')
  return c === '0'.repeat(31) + '1'
}

/** Where the agent connects from and which port is Studio's own, for the one exception to the rules. */
export interface AddressRules {
  /** The agent session's peer address: the agent's own machine (loopback for an agent on this Mac). */
  peer: string
  /** Studio's agent port, which is never fetched from (not even on the agent's machine). */
  ownPort?: number
}

/** The address is the agent's own machine (for a local agent: any loopback address of this Mac). */
export function isPeerAddress(address: string, peer: string): boolean {
  if (!peer) return false
  if (isLoopback(peer)) return isLoopback(address)
  const a = canonical(address)
  return a !== undefined && a === canonical(peer)
}

/** May a request connect to this address and port? */
export function allowedTarget(address: string, port: number, rules: AddressRules): boolean {
  if (isPublicAddress(address)) return true
  return isPeerAddress(address, rules.peer) && port !== rules.ownPort
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/** Parses and checks a URL an agent gave (scheme, no user info, length); throws the Swedish refusal. */
export function checkUrl(raw: string, base?: URL): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new FetchError('Ange en adress (url).')
  if (raw.length > MAX_URL_LENGTH) throw new FetchError(`Adressen är för lång (högst ${MAX_URL_LENGTH} tecken).`)
  let url: URL
  try {
    url = new URL(raw.trim(), base)
  } catch {
    throw new FetchError('Adressen går inte att läsa som en webbadress.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError(ONLY_HTTP)
  if (url.username || url.password) throw new FetchError('Adressen får inte innehålla användarnamn eller lösenord.')
  if (url.href.length > MAX_URL_LENGTH) throw new FetchError(`Adressen är för lång (högst ${MAX_URL_LENGTH} tecken).`)
  return url
}

/** The host name of a URL as Studio names it to the user (no brackets around an IPv6 address, no port). */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1')
}

const effectivePort = (url: URL): number => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80)

// ── Fetching ─────────────────────────────────────────────────────────────────

type Resolver = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => callback(err, addresses ?? []))

export interface FetchOptions {
  url: string
  /** The file written (created; removed again on failure). */
  dest: string
  /** More than this many bytes is refused – before reading when the server says so, else as they arrive. */
  maxBytes: number
  tooLarge: string
  /** The whole fetch, redirects included. */
  totalMs: number
  rules: AddressRules
  userAgent: string
  signal?: AbortSignal
  onProgress?: (received: number, total: number | undefined) => void
  /** Stand-in for DNS (tests). */
  resolve?: Resolver
}

export interface FetchResult {
  /** The host of the URL the agent gave (never the URL: it may carry tokens). */
  host: string
  bytes: number
  sha256: string
}

/** A `lookup` for http.request that only ever answers with an address the rules allow. */
function guardedLookup(port: number, rules: AddressRules, resolve: Resolver) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
  ): void => {
    resolve(hostname, (err, addresses) => {
      if (err) {
        callback(new FetchError(`Kunde inte hitta servern ${hostname}.`), '')
        return
      }
      const allowed = addresses.filter((a) => allowedTarget(a.address, port, rules))
      if (!allowed.length) {
        callback(new FetchError(PRIVATE_ADDRESS, 'blocked'), '')
        return
      }
      if (options?.all) callback(null, allowed)
      else callback(null, allowed[0].address, allowed[0].family)
    })
  }
}

/** Says a network error in Swedish. */
function networkError(err: unknown, host: string): FetchError {
  if (err instanceof FetchError) return err
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError(`Kunde inte hitta servern ${host}.`)
  if (code === 'ECONNREFUSED') return new FetchError(`Servern ${host} tog inte emot anslutningen.`)
  if (code === 'ETIMEDOUT') return new FetchError(TOO_SLOW)
  const message = err instanceof Error ? err.message : String(err)
  return new FetchError(`Kunde inte hämta filen från ${host}: ${message}`)
}

interface Response {
  req: ClientRequest
  res: IncomingMessage
}

/** One request (no redirects followed), connected only to an allowed address. */
function requestOnce(url: URL, o: FetchOptions, signal: AbortSignal): Promise<Response> {
  const host = hostOf(url)
  const port = effectivePort(url)
  // A literal IP needs no lookup (and Node does none): it is checked as it is.
  if (isIP(host) && !allowedTarget(host, port, o.rules))
    return Promise.reject(new FetchError(PRIVATE_ADDRESS, 'blocked'))
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(url, {
      method: 'GET',
      agent: false,
      lookup: guardedLookup(port, o.rules, o.resolve ?? systemResolver) as never,
      headers: { 'User-Agent': o.userAgent, Accept: '*/*', 'Accept-Encoding': 'identity' },
      signal
    })
    const connectTimer = setTimeout(() => req.destroy(new FetchError(TOO_SLOW)), CONNECT_TIMEOUT_MS)
    req.once('socket', (socket) => {
      const connected = (): void => clearTimeout(connectTimer)
      if (!socket.connecting) connected()
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new FetchError(TOO_SLOW)))
    req.once('response', (res) => {
      clearTimeout(connectTimer)
      resolve({ req, res })
    })
    req.once('error', (err) => {
      clearTimeout(connectTimer)
      reject(signal.aborted ? new FetchError(TOO_SLOW, 'aborted') : networkError(err, host))
    })
    req.end()
  })
}

/**
 * Fetches `url` into `dest`: GET only, no cookies or credentials, status 200 only, at most MAX_REDIRECTS redirects
 * (each one checked like the first, never from https down to http), within the byte cap and the time limits.
 * Rejects with a FetchError in Swedish; `dest` is then removed.
 */
export async function fetchToFile(o: FetchOptions): Promise<FetchResult> {
  let url = checkUrl(o.url)
  const host = hostOf(url)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  o.signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const total = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, o.totalMs)
  const failed = (err: unknown): FetchError => {
    if (timedOut) return new FetchError(TOO_SLOW)
    if (o.signal?.aborted) return new FetchError('Hämtningen avbröts.', 'aborted')
    return err instanceof FetchError ? err : networkError(err, host)
  }
  let response: Response | undefined
  try {
    for (let hop = 0; ; hop++) {
      response = await requestOnce(url, o, controller.signal)
      const { res } = response
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        response.req.destroy()
        if (hop >= MAX_REDIRECTS) throw new FetchError(TOO_MANY_REDIRECTS)
        const next = checkUrl(res.headers.location, url)
        if (url.protocol === 'https:' && next.protocol === 'http:') {
          throw new FetchError('Servern skickade vidare från https till http, och dit följer Studio inte med.')
        }
        url = next
        continue
      }
      if (status !== 200) {
        res.resume()
        throw new FetchError(`Servern svarade ${status}.`)
      }
      break
    }
    const { res } = response
    const declared = Number(res.headers['content-length'])
    const length = Number.isFinite(declared) && declared >= 0 ? declared : undefined
    if (length !== undefined && length > o.maxBytes) {
      response.req.destroy()
      throw new FetchError(o.tooLarge, 'too-large')
    }
    const hash = createHash('sha256')
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length
        if (received > o.maxBytes) {
          done(new FetchError(o.tooLarge, 'too-large'))
          return
        }
        hash.update(chunk)
        o.onProgress?.(received, length)
        done(null, chunk)
      }
    })
    await pipeline(res, counter, createWriteStream(o.dest, { flags: 'wx' }), { signal: controller.signal })
    if (length !== undefined && received !== length) throw new FetchError('Servern skickade inte hela filen.')
    return { host, bytes: received, sha256: hash.digest('hex') }
  } catch (err) {
    response?.req.destroy()
    await rm(o.dest, { force: true }).catch(() => {})
    throw failed(err)
  } finally {
    clearTimeout(total)
    o.signal?.removeEventListener('abort', abort)
  }
}
