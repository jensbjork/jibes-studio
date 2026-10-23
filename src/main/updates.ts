// Updates from GitHub Releases: whether a newer Studio is out, and installing it in place of this one.
//
// A check is one GET of the repository's latest release (GitHub's API), compared with this Studio's version by semver.
// It runs once a day when Studio starts (unless switched off in Settings → About, and never in a development
// build, which is updated from git), and when the user asks: Check for Updates… in the macOS app menu, or Check for
// updates in Settings. A newer release is offered by a notice in the window (updates:available).
//
// Installing (updates:install, only from the window) downloads this computer's file of the release over https – from
// github.com and GitHub's asset host, nothing else –, checks its SHA-256 against the digest GitHub's API gives for the
// file (or, without one, the release's SHA256SUMS.txt), and then:
//   macOS – unpacks the zip with ditto next to the app (same volume), checks that it holds one app with the same
//           bundle id, the release's version (newer than this one), an intact signature and a macOS this Mac has, swaps
//           the bundles (this one aside, the new one into its place, this one to the Trash), starts a small helper that
//           opens the new Studio once this one has quit, and quits;
//   Windows – starts the release's NSIS installer silently ("--updated /S --force-run": it waits for Studio to close,
//           installs over it where it is and opens it again) and quits.
// Nothing happens while the library is busy (generations, exports, imports, an archive, an agent's request …): the
// same reasons a library switch is refused for. Anything that fails before the swap leaves this Studio untouched and
// says why; where Studio can't replace itself (a copy it can't write, macOS' read-only "translocation", the portable
// Windows zip) the check says so up front (installBlocked) and the window offers the release page instead.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, renameSync, mkdirSync } from 'node:fs'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { UpdateInfo, UpdateProgress } from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import { IS_MAC, IS_WINDOWS, THIS_COMPUTER } from './platform'
import {
  getAutoUpdateCheck,
  getLastUpdateCheck,
  isDevelopmentBuild,
  setAutoUpdateCheck,
  setLastUpdateCheck,
  updateTestServer
} from './settings'

/** "owner/name" of Studio's repository on GitHub, read at build time from install.sh (electron.vite.config.ts). */
declare const __STUDIO_REPO__: string
const REPO = typeof __STUDIO_REPO__ === 'string' ? __STUDIO_REPO__ : ''

/** The release file with every file's SHA-256 (the release workflow's publish job), for files without a digest. */
export const CHECKSUMS_NAME = 'SHA256SUMS.txt'
/** Folders the macOS update works in, next to the app; left-overs are cleared at the next start. */
const MAC_WORK_PREFIX = '.Studio-update-'
/** The same in the temp folder on Windows (the installer is run from there). */
const WIN_WORK_PREFIX = 'Studio-update-'
/** electron-builder's NSIS uninstaller, next to JIBES Studio.exe in an installed copy (never in the portable zip). */
const WIN_UNINSTALLER = 'Uninstall JIBES Studio.exe'

const DAY_MS = 24 * 60 * 60_000
/** The daily check waits this long after start, so it never slows Studio's start down. */
const START_DELAY_MS = 8_000
/** And looks again whether a day has passed this often while Studio runs. */
const RECHECK_MS = 60 * 60_000
const API_TIMEOUT_MS = 20_000
/** A download that receives nothing for this long is given up. */
const DOWNLOAD_IDLE_MS = 60_000
const MAX_REDIRECTS = 5
const MAX_NOTES = 4_000
const MAX_CHECKSUMS_BYTES = 64 * 1024

const USER_ONLY = 'Only you can do this in Studio.'
export const DEV_BUILD = 'Development build – updates come from git.'
const DEV_BUILD_INSTALL = 'A development build never replaces itself – it is updated from git.'
const OTHER_SYSTEM = 'Studio can only update itself on macOS and Windows.'
const OFFLINE = 'Could not reach GitHub. Check your internet connection and try again.'
const STALLED = 'The download stopped. Check your internet connection and try again.'
const NO_CHECKSUM =
  'The release has no checksum for its file, so Studio won’t install it. Download it from the release page instead.'
const MISMATCH = 'The download doesn’t match the release’s checksum, so it wasn’t installed. Try again later.'
const TRANSLOCATED =
  'macOS runs this copy of Studio from a temporary, read-only place. Move Studio to Applications, open it from there and update again.'
const WINDOWS_PORTABLE =
  'This copy of Studio was unzipped rather than installed, so it can’t replace itself. Download the new version from the release page.'

// ── Versions ─────────────────────────────────────────────────────────────────

interface Version {
  core: [number, number, number]
  /** Pre-release identifiers ("beta.2" → ['beta', 2]); empty for a release. */
  pre: (string | number)[]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** A semantic version, with or without the tag's "v"; undefined for anything else. */
export function parseVersion(text: string): Version | undefined {
  const m = SEMVER.exec(text.trim())
  if (!m) return undefined
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
}

/** Semver precedence: < 0 when a is older than b, 0 when equal, > 0 when newer. Throws for a non-version. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) throw new Error(`Not a version: ${va ? b : a}`)
  for (let i = 0; i < 3; i++) if (va.core[i] !== vb.core[i]) return va.core[i] - vb.core[i]
  // A pre-release comes before its release; identifiers compare one by one (numbers below words).
  if (!va.pre.length || !vb.pre.length) return vb.pre.length - va.pre.length
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i]
    const y = vb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Whether `latest` is a newer version than `current`; false when either isn't a version. */
export function isNewer(latest: string, current: string): boolean {
  try {
    return compareVersions(latest, current) > 0
  } catch {
    return false
  }
}

/** The release's version as Studio shows it: without the "v" and any build metadata. */
function versionText(tag: string): string {
  return tag.trim().replace(/^v/, '').replace(/\+.*$/, '')
}

// ── Releases ─────────────────────────────────────────────────────────────────

/** Where updates come from: GitHub, or (tests only) a stand-in on this computer. */
export interface UpdateSource {
  /** The newest release, as GitHub's API answers it (releases/latest). */
  latestUrl: string
  /** The repository's releases, for when a release's own page is unknown. */
  releasesPage: string
  /** May the release metadata be read from this URL (also after a redirect)? */
  apiAllowed(url: URL): boolean
  /** May the window open this URL as a release's page? */
  pageAllowed(url: URL): boolean
  /** May a release's file be downloaded starting at this URL? */
  assetAllowed(url: URL): boolean
  /** May a download continue at this URL (a redirect to GitHub's asset host)? */
  downloadAllowed(url: URL): boolean
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

/** GitHub's releases of `repo` ("owner/name"): https only, github.com and GitHub's asset host. */
export function githubSource(repo: string): UpdateSource {
  if (!REPO_NAME.test(repo)) throw new Error('This build of Studio doesn’t know where its releases are.')
  const releases = `/${repo}/releases/`.toLowerCase()
  const downloads = `${releases}download/`
  const https = (u: URL): boolean => u.protocol === 'https:' && !u.username && !u.password && !u.port
  return {
    latestUrl: `https://api.github.com/repos/${repo}/releases/latest`,
    releasesPage: `https://github.com/${repo}/releases`,
    apiAllowed: (u) => https(u) && u.hostname === 'api.github.com',
    pageAllowed: (u) => https(u) && u.hostname === 'github.com' && u.pathname.toLowerCase().startsWith(releases),
    assetAllowed: (u) => https(u) && u.hostname === 'github.com' && u.pathname.toLowerCase().startsWith(downloads),
    downloadAllowed: (u) => https(u) && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))
  }
}

/** A stand-in for GitHub at `server` (STUDIO_UPDATE_TEST_SERVER, tests only): the same paths, on that origin only. */
export function testSource(server: URL, repo: string): UpdateSource {
  const base = githubSource(repo)
  const local = (u: URL): boolean => u.origin === server.origin
  const releases = `/${repo}/releases/`.toLowerCase()
  return {
    latestUrl: new URL(`/repos/${repo}/releases/latest`, server).href,
    releasesPage: new URL(`/${repo}/releases`, server).href,
    apiAllowed: local,
    pageAllowed: (u) => local(u) && u.pathname.toLowerCase().startsWith(releases),
    assetAllowed: (u) => local(u) && base.assetAllowed(new URL(u.pathname, 'https://github.com')),
    downloadAllowed: local
  }
}

/** One file of a release. */
export interface ReleaseAsset {
  name: string
  size: number
  /** Where it is downloaded from (its browser_download_url). */
  url: string
  /** GitHub's "sha256:<hex>" for the file, when the API gives one. */
  digest?: string
}

export interface Release {
  /** The version, without the tag's "v". */
  version: string
  notesUrl: string
  notes?: string
  publishedAt?: string
  assets: ReleaseAsset[]
}

/** GitHub's answer for a release, checked: throws when it isn't one Studio can use. */
export function parseRelease(json: unknown, source: UpdateSource): Release {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const tag = typeof r.tag_name === 'string' ? r.tag_name : ''
  if (!parseVersion(tag)) throw new Error('GitHub’s newest release has no version Studio understands.')
  if (r.draft === true || r.prerelease === true) throw new Error('GitHub’s newest release is not a final one.')
  const page = typeof r.html_url === 'string' ? safeUrl(r.html_url) : undefined
  const assets = (Array.isArray(r.assets) ? r.assets : []).flatMap((raw): ReleaseAsset[] => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const url = typeof a.browser_download_url === 'string' ? safeUrl(a.browser_download_url) : undefined
    if (typeof a.name !== 'string' || !a.name || !url || !source.assetAllowed(url)) return []
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? a.size : 0
    const digest = typeof a.digest === 'string' ? a.digest : undefined
    return [{ name: a.name, size, url: url.href, ...(digest ? { digest } : {}) }]
  })
  const body = typeof r.body === 'string' ? r.body.trim() : ''
  return {
    version: versionText(tag),
    notesUrl: page && source.pageAllowed(page) ? page.href : source.releasesPage,
    ...(body ? { notes: trimNotes(body) } : {}),
    ...(typeof r.published_at === 'string' ? { publishedAt: r.published_at } : {}),
    assets
  }
}

function safeUrl(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

/** At most MAX_NOTES characters, cut at a line where it can be. */
function trimNotes(notes: string): string {
  if (notes.length <= MAX_NOTES) return notes
  const cut = notes.slice(0, MAX_NOTES)
  const line = cut.lastIndexOf('\n')
  return `${(line > MAX_NOTES / 2 ? cut.slice(0, line) : cut).trimEnd()}\n…`
}

/**
 * The release file this computer installs: JIBES-Studio-mac-arm64.zip, JIBES-Studio-win-x64-setup.exe
 * (electron-builder.yml's artifact names).
 */
export function assetNameFor(platform: string, arch: string): string | undefined {
  if (platform === 'darwin') return `JIBES-Studio-mac-${arch}.zip`
  if (platform === 'win32') return `JIBES-Studio-win-${arch}-setup.exe`
  return undefined
}

export function pickAsset(release: Release, platform: string, arch: string): ReleaseAsset | undefined {
  const name = assetNameFor(platform, arch)
  return name ? release.assets.find((a) => a.name === name) : undefined
}

// ── Checksums ────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/

/** The hex SHA-256 in GitHub's asset digest ("sha256:<hex>"); undefined for another kind or none. */
export function sha256OfDigest(digest: string | undefined): string | undefined {
  const m = digest ? /^sha256:([0-9a-fA-F]{64})$/.exec(digest.trim()) : null
  return m ? m[1].toLowerCase() : undefined
}

/** SHA256SUMS.txt: "<hex>  <name>" lines (sha256sum, also "<hex> *<name>"), and BSD's "SHA256 (<name>) = <hex>". */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const gnu = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line)
    const bsd = /^SHA256 \((.+)\) = ([0-9a-fA-F]{64})$/.exec(line)
    if (gnu) sums.set(basename(gnu[2].trim()), gnu[1].toLowerCase())
    else if (bsd) sums.set(basename(bsd[1].trim()), bsd[2].toLowerCase())
  }
  return sums
}

/** The SHA-256 of a file on disk, as hex. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const fh = await open(file, 'r')
  try {
    const chunk = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      hash.update(chunk.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

/** Throws (MISMATCH) unless the file's SHA-256 is `expected` (hex). */
export async function verifyChecksum(file: string, expected: string): Promise<void> {
  const want = expected.trim().toLowerCase()
  if (!HEX64.test(want)) throw new Error(NO_CHECKSUM)
  if ((await sha256File(file)) !== want) throw new Error(MISMATCH)
}

// ── Network ──────────────────────────────────────────────────────────────────

function userAgent(): string {
  return `Studio/${app.getVersion()}`
}

/** fetch, following at most MAX_REDIRECTS redirects itself, each only to a URL `allowed` accepts. */
async function fetchAllowed(url: string, allowed: (u: URL) => boolean, init: RequestInit): Promise<Response> {
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(current)) throw new Error(`Studio only downloads updates from GitHub over https, not from ${current.host}.`)
    let res: Response
    try {
      res = await fetch(current, { ...init, redirect: 'manual' })
    } catch (err) {
      throw networkError(err)
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!location) throw new Error(`GitHub answered ${res.status} without saying where the file is.`)
      current = new URL(location, current)
      continue
    }
    return res
  }
  throw new Error('GitHub sent Studio on too many detours. Try again later.')
}

function networkError(err: unknown): Error {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError') return new Error('GitHub didn’t answer. Check your internet connection and try again.')
  if (err instanceof Error && err.message === STALLED) return err
  return new Error(OFFLINE)
}

/** GitHub's newest release of the source, checked. */
export async function fetchLatestRelease(source: UpdateSource): Promise<Release> {
  const res = await fetchAllowed(source.latestUrl, source.apiAllowed, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent()
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (res.status === 404) throw new Error('No release of Studio was found on GitHub.')
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const minutes = Number.isFinite(reset) && reset > 0 ? Math.ceil((reset * 1000 - Date.now()) / 60_000) : 0
    throw new Error(
      minutes > 0 && minutes < 120
        ? `GitHub has had too many requests from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'GitHub has had too many requests from this network. Try again later.'
    )
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('GitHub’s answer couldn’t be read. Try again later.')
  }
  return parseRelease(json, source)
}

/**
 * Downloads `url` (a release file) to `dest`, following redirects only where the source allows. `size` (the file's
 * size from the release) is what must arrive: more or less is an error. Resolves with the bytes written.
 */
export async function downloadFile(
  url: string,
  dest: string,
  o: { source: UpdateSource; size?: number; onProgress?: (fraction: number) => void; idleMs?: number }
): Promise<number> {
  if (!o.source.assetAllowed(new URL(url))) throw new Error('The release’s file isn’t on GitHub, so Studio won’t download it.')
  const controller = new AbortController()
  let idle: ReturnType<typeof setTimeout> | undefined
  const wait = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new Error(STALLED)), o.idleMs ?? DOWNLOAD_IDLE_MS)
  }
  wait()
  const fh = await open(dest, 'w')
  try {
    const res = await fetchAllowed(url, o.source.downloadAllowed, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': userAgent() },
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`The download failed: GitHub answered ${res.status}. Try again later.`)
    const expected = o.size || Number(res.headers.get('content-length')) || 0
    let bytes = 0
    const reader = res.body.getReader()
    // A stall ends the read that waits, whether or not the stream itself hears of the abort.
    controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err) {
        throw controller.signal.aborted ? new Error(STALLED) : networkError(err)
      }
      if (controller.signal.aborted) throw new Error(STALLED)
      if (chunk.done) break
      wait()
      bytes += chunk.value.byteLength
      if (o.size && bytes > o.size) throw new Error('The download is bigger than the release’s file. Try again later.')
      await fh.write(chunk.value)
      if (expected) o.onProgress?.(Math.min(1, bytes / expected))
    }
    if (o.size && bytes !== o.size) throw new Error('The download was incomplete. Try again.')
    return bytes
  } finally {
    if (idle) clearTimeout(idle)
    await fh.close()
  }
}

/** A small text file of the release (SHA256SUMS.txt), read into memory. */
async function downloadText(asset: ReleaseAsset, source: UpdateSource): Promise<string> {
  if (asset.size > MAX_CHECKSUMS_BYTES || !source.assetAllowed(new URL(asset.url))) throw new Error(NO_CHECKSUM)
  const res = await fetchAllowed(asset.url, source.downloadAllowed, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': userAgent() },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`The release’s checksums couldn’t be downloaded (GitHub answered ${res.status}).`)
  const text = await res.text()
  if (text.length > MAX_CHECKSUMS_BYTES) throw new Error(NO_CHECKSUM)
  return text
}

/** The SHA-256 the file must have: GitHub's digest of it, else its line in the release's SHA256SUMS.txt. */
export async function expectedSha256(release: Release, asset: ReleaseAsset, source: UpdateSource): Promise<string> {
  const fromApi = sha256OfDigest(asset.digest)
  if (fromApi) return fromApi
  const sums = release.assets.find((a) => a.name === CHECKSUMS_NAME)
  if (!sums) throw new Error(NO_CHECKSUM)
  const hex = parseChecksums(await downloadText(sums, source)).get(asset.name)
  if (!hex) throw new Error(NO_CHECKSUM)
  return hex
}

// ── This copy of Studio ──────────────────────────────────────────────────────

/** The running app bundle (macOS: JIBES Studio.app), from its executable; undefined when it isn't in one. */
function macBundle(): string | undefined {
  const bundle = resolve(app.getPath('exe'), '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : undefined
}

/** Why Studio can't replace the bundle at `bundle` (macOS), or undefined when it can. */
export function macInstallBlocked(bundle: string | undefined): string | undefined {
  if (!bundle) return 'Studio isn’t running from an app it can replace. Download the new version from the release page.'
  if (bundle.includes('/AppTranslocation/')) return TRANSLOCATED
  const folder = dirname(bundle)
  try {
    accessSync(folder, fsConstants.W_OK)
    accessSync(bundle, fsConstants.W_OK)
  } catch {
    return `Studio can’t replace itself in “${folder}”: it isn’t allowed to write there. Download the new version from the release page.`
  }
  return undefined
}

/** Why the installed Windows Studio can't update itself: only the portable zip can't (it has no uninstaller). */
function windowsInstallBlocked(): string | undefined {
  return existsSync(join(dirname(app.getPath('exe')), WIN_UNINSTALLER)) ? undefined : WINDOWS_PORTABLE
}

/** Why this copy can't install `asset` of a newer release; undefined when it can. */
function installBlockedReason(asset: ReleaseAsset | undefined): string | undefined {
  if (isDevelopmentBuild()) return DEV_BUILD
  if (!IS_MAC && !IS_WINDOWS) return OTHER_SYSTEM
  if (!asset) return `The release has no download for ${THIS_COMPUTER}.`
  // A test instance (an unpackaged build pointed at a stand-in for GitHub) refuses at the very last step instead.
  if (!app.isPackaged) return undefined
  return IS_MAC ? macInstallBlocked(macBundle()) : windowsInstallBlocked()
}

/** The source this build asks: the stand-in a test points it at, else GitHub; undefined for a development build. */
function updateSource(): UpdateSource | undefined {
  if (isDevelopmentBuild()) return undefined
  const test = updateTestServer()
  return test ? testSource(test, REPO_NAME.test(REPO) ? REPO : 'studio/studio') : githubSource(REPO)
}

function releasesPage(): string {
  return REPO_NAME.test(REPO) ? `https://github.com/${REPO}/releases` : 'https://github.com'
}

// ── macOS: replacing the bundle ──────────────────────────────────────────────

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolvePromise(String(stdout))
    })
  })
}

interface BundleInfo {
  id: string
  version: string
  executable: string
  minimumSystem?: string
}

/** What an app bundle's Info.plist says about it. */
export async function readBundleInfo(bundle: string): Promise<BundleInfo> {
  const plist = join(bundle, 'Contents', 'Info.plist')
  const key = (name: string): Promise<string | undefined> =>
    run('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist]).then(
      (out) => out.trim() || undefined,
      () => undefined
    )
  const [id, version, executable, minimumSystem] = await Promise.all([
    key('CFBundleIdentifier'),
    key('CFBundleShortVersionString'),
    key('CFBundleExecutable'),
    key('LSMinimumSystemVersion')
  ])
  if (!id || !version || !executable) throw new Error(`“${basename(bundle)}” isn’t an app Studio can read.`)
  return { id, version, executable, ...(minimumSystem ? { minimumSystem } : {}) }
}

/** Dotted numbers compared ("13.5" < "26.4.1"); NaN parts count as 0. */
function compareDotted(a: string, b: string): number {
  const x = a.split('.').map((n) => Number(n) || 0)
  const y = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** codesign's check that the bundle is intact (Studio is signed ad hoc): a damaged app would never start again. */
async function verifySignature(bundle: string): Promise<void> {
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  } catch {
    throw new Error('The downloaded Studio isn’t intact (its signature doesn’t match its files), so it wasn’t installed.')
  }
}

export interface MacInstall {
  /** The verified zip of the release. */
  zip: string
  /** The running app bundle, which is replaced (it keeps its name and place). */
  bundle: string
  /** An empty folder next to it (same volume): the new app is unpacked there and the old one put aside there. */
  workDir: string
  /** The release's version: the new app must say the same. */
  version: string
  /** This Studio's version: the new one must be newer. */
  current: string
  /** Why Studio can't quit right now; asked once more right before the swap. */
  busy: () => string | undefined
  /** Starts what opens the new app once this one has quit; throws if it can't (the swap is then undone). */
  relaunch: (bundle: string) => void
  /** Moves the old app to the Trash. */
  trash: (path: string) => Promise<void>
  /** The signature check (tests may pass their own); codesign by default. */
  verifySignature?: (bundle: string) => Promise<void>
  /** This Mac's macOS version, for the new app's minimum; unchecked when unknown. */
  systemVersion?: string
}

/**
 * Unpacks the release next to the app, checks it, and swaps it in: the running app is renamed into workDir, the new
 * one renamed into its place (one volume, so both are renames), the relaunch helper started and the old app trashed.
 * Every check comes before the first rename; a failed rename or helper puts the old app back. Throws with the reason.
 */
export async function installMacUpdate(o: MacInstall): Promise<void> {
  const unpacked = join(o.workDir, 'new')
  try {
    await run('/usr/bin/ditto', ['-x', '-k', o.zip, unpacked])
  } catch {
    throw new Error('The download couldn’t be unpacked, so it wasn’t installed.')
  }
  const apps = (await readdir(unpacked)).filter((n) => n.endsWith('.app'))
  if (apps.length !== 1) throw new Error('The download doesn’t hold Studio, so it wasn’t installed.')
  const next = join(unpacked, apps[0])
  const [mine, theirs] = await Promise.all([readBundleInfo(o.bundle), readBundleInfo(next)])
  if (theirs.id !== mine.id) throw new Error('The download isn’t this Studio (another app id), so it wasn’t installed.')
  if (theirs.version !== o.version || !isNewer(theirs.version, o.current)) {
    throw new Error(`The download holds Studio ${theirs.version}, not ${o.version}, so it wasn’t installed.`)
  }
  if (!existsSync(join(next, 'Contents', 'MacOS', theirs.executable))) {
    throw new Error('The downloaded Studio is incomplete, so it wasn’t installed.')
  }
  if (theirs.minimumSystem && o.systemVersion && compareDotted(o.systemVersion, theirs.minimumSystem) < 0) {
    throw new Error(`Studio ${o.version} needs macOS ${theirs.minimumSystem} or later; this Mac has ${o.systemVersion}.`)
  }
  await (o.verifySignature ?? verifySignature)(next)
  const reason = o.busy()
  if (reason) throw new Error(reason)

  const aside = join(o.workDir, 'old', basename(o.bundle))
  mkdirSync(dirname(aside), { recursive: true })
  try {
    renameSync(o.bundle, aside)
  } catch (err) {
    throw new Error(`Studio couldn’t move itself aside (${(err as NodeJS.ErrnoException).code ?? 'error'}), so nothing was changed.`)
  }
  /** Undoes the swap; should even that fail, says where this Studio is (and runInstall keeps the work folder). */
  const putBack = (newInPlace: boolean): void => {
    try {
      if (newInPlace) renameSync(o.bundle, next)
      renameSync(aside, o.bundle)
    } catch {
      throw new Error(`The update could be neither finished nor undone: the Studio you had is in “${aside}”.`)
    }
  }
  try {
    renameSync(next, o.bundle)
  } catch (err) {
    putBack(false)
    throw new Error(`The new Studio couldn’t be put in place (${(err as NodeJS.ErrnoException).code ?? 'error'}), so nothing was changed.`)
  }
  try {
    o.relaunch(o.bundle)
  } catch (err) {
    putBack(true)
    throw new Error(`Studio couldn’t arrange to open again (${err instanceof Error ? err.message : String(err)}), so nothing was changed.`)
  }
  // The running app's files stay open where they are; whatever can't be trashed now goes at the next start.
  try {
    await o.trash(aside)
    await rm(o.workDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('Putting the old Studio in the Trash failed; it is cleared at the next start:', err)
  }
}

/** Variables a test instance runs with, carried over to the relaunched Studio (open starts it with a clean environment). */
const CARRIED_ENV = ['STUDIO_PROFILE_DIR', 'STUDIO_UPDATE_TEST_SERVER']

/**
 * Starts a detached helper that waits (at most two minutes) for process `pid` to end, then opens `bundle` through
 * Launch Services – as a double-click in Finder would –, so the new Studio starts once this one has quit and released
 * its single-instance lock. `openCommand` is /usr/bin/open (tests pass their own).
 */
export function relaunchWhenQuit(bundle: string, pid = process.pid, openCommand = '/usr/bin/open'): void {
  const env = CARRIED_ENV.flatMap((name) => (process.env[name] ? ['--env', `${name}=${process.env[name]}`] : []))
  const script =
    'pid=$1; shift; n=0; while kill -0 "$pid" 2>/dev/null; do n=$((n+1)); [ "$n" -gt 1200 ] && exit 1; sleep 0.1; done; exec "$@"'
  const child = spawn('/bin/sh', ['-c', script, 'studio-relaunch', String(pid), openCommand, '-n', ...env, bundle], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

// ── Windows: the installer ───────────────────────────────────────────────────

/**
 * Starts the release's NSIS installer, detached, as electron-updater does: "--updated" (an update over the installed
 * copy, in its folder and install mode), "/S" (silent) and "--force-run" (open Studio when done). It waits for Studio
 * to close (and closes it if it must).
 */
function startWindowsInstaller(installer: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(installer, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' })
    child.once('error', (err) => reject(new Error(`The installer couldn’t be started (${err.message}).`)))
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}

// ── Checking, installing, the window ─────────────────────────────────────────

export interface UpdateDeps {
  /** Why Studio can't quit for an update right now (what a library switch is refused for, and archives). */
  busy: () => string | undefined
  /** Brings Studio's window to the front, opening one when none is open (Check for Updates…). */
  showWindow: () => BrowserWindow
}

let deps: UpdateDeps | undefined
/** The newer release last found, re-sent to a window that (re)loads; undefined when none is. */
let lastAvailable: UpdateInfo | undefined
/** The install in progress: one at a time, and nothing else starts once it has begun. */
let installing: Promise<void> | undefined

interface Found {
  info: UpdateInfo
  release?: Release
  asset?: ReleaseAsset
  source?: UpdateSource
}

function sendToWindows(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    } catch (err) {
      console.warn(`Sending ${channel} failed:`, err)
    }
  }
}

/** Asks the source for its newest release and compares it with this Studio. Throws with a reason the user can read. */
async function lookUp(): Promise<Found> {
  const current = app.getVersion()
  const source = updateSource()
  if (!source) {
    return { info: { current, latest: current, available: false, notesUrl: releasesPage(), installBlocked: DEV_BUILD } }
  }
  const release = await fetchLatestRelease(source)
  const asset = pickAsset(release, process.platform, process.arch)
  const available = isNewer(release.version, current)
  const info: UpdateInfo = {
    current,
    latest: release.version,
    available,
    notesUrl: release.notesUrl,
    ...(release.notes ? { notes: release.notes } : {}),
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    ...(asset ? { asset: { name: asset.name, size: asset.size } } : {})
  }
  if (available) {
    const blocked = installBlockedReason(asset)
    if (blocked) info.installBlocked = blocked
  }
  try {
    setLastUpdateCheck(new Date())
    // Settings → About shows when Studio last checked.
    sendToWindows('settings:change')
  } catch (err) {
    console.warn('Recording the update check failed:', err)
  }
  lastAvailable = available ? info : undefined
  return { info, release, asset, source }
}

function progress(p: UpdateProgress): void {
  sendToWindows('updates:progress', p)
}

/** Readable words for what went wrong on the way. */
function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') return 'There isn’t enough free space on the disk for the update.'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'Studio isn’t allowed to write where the update goes. Download the new version from the release page.'
  }
  return err instanceof Error && err.message ? err.message : String(err)
}

/** The whole install (see the top of the file); rejects with the reason, after broadcasting it as a failed stage. */
async function runInstall(d: UpdateDeps): Promise<void> {
  let workDir: string | undefined
  let keepWorkDir = false
  try {
    const before = d.busy()
    if (before) throw new Error(before)
    const { info, release, asset, source } = await lookUp()
    if (info.installBlocked) throw new Error(info.installBlocked)
    if (!info.available) throw new Error(`Studio ${info.current} is already the newest version.`)
    if (!release || !asset || !source) throw new Error(`The release has no download for ${THIS_COMPUTER}.`)
    lastAvailable = info

    progress({ stage: 'downloading', fraction: 0 })
    workDir = IS_MAC && app.isPackaged
      ? await mkdtemp(join(dirname(macBundle()!), MAC_WORK_PREFIX))
      : await mkdtemp(join(tmpdir(), WIN_WORK_PREFIX))
    const file = join(workDir, asset.name)
    let sent = -1
    let sentAt = 0
    await downloadFile(asset.url, file, {
      source,
      size: asset.size || undefined,
      onProgress: (fraction) => {
        // At most every 1 % or a quarter second: enough for the bar, little for IPC.
        const now = Date.now()
        if (fraction < 1 && fraction - sent < 0.01 && now - sentAt < 250) return
        sent = fraction
        sentAt = now
        progress({ stage: 'downloading', fraction })
      }
    })

    progress({ stage: 'verifying' })
    await verifyChecksum(file, await expectedSha256(release, asset, source))
    console.log(`Update: ${asset.name} of Studio ${info.latest} downloaded and verified.`)

    progress({ stage: 'installing' })
    if (!app.isPackaged) throw new Error(DEV_BUILD_INSTALL)
    if (IS_MAC) {
      const systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : undefined
      await installMacUpdate({
        zip: file,
        bundle: macBundle()!,
        workDir,
        version: info.latest,
        current: info.current,
        busy: d.busy,
        relaunch: (bundle) => relaunchWhenQuit(bundle),
        trash: (path) => shell.trashItem(path),
        ...(systemVersion ? { systemVersion } : {})
      })
      // Trashed and removed by installMacUpdate, or cleared at the next start.
      keepWorkDir = true
    } else if (IS_WINDOWS) {
      const reason = d.busy()
      if (reason) throw new Error(reason)
      await startWindowsInstaller(file)
      // The installer runs from there; the next start clears it.
      keepWorkDir = true
    } else {
      throw new Error(OTHER_SYSTEM)
    }

    console.log(`Update: Studio ${info.latest} installed; quitting.`)
    progress({ stage: 'restarting' })
    // A moment for the window to say so; quitting runs Studio's own duties (will-quit) as always.
    setTimeout(() => app.quit(), 400)
  } catch (err) {
    const reason = reasonOf(err)
    console.warn('Update failed:', reason)
    // Never a work folder still holding this Studio, put aside by a swap that couldn't be undone.
    const holdsOld = !!workDir && (await readdir(join(workDir, 'old')).catch(() => [] as string[])).length > 0
    if (workDir && !keepWorkDir && !holdsOld) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    progress({ stage: 'failed', error: reason })
    throw new Error(reason)
  }
}

/** Asked from the window (Update now): only one install at a time; it ends with Studio quitting. */
function installUpdate(d: UpdateDeps): Promise<void> {
  if (installing) return Promise.reject(new Error('Studio is already being updated.'))
  const started = runInstall(d)
  installing = started
  // A failed install may be tried again; a successful one keeps the lock until Studio has quit.
  started.catch(() => {
    if (installing === started) installing = undefined
  })
  return started
}

/** For the window when it (re)loads – a library switch reloads it –: the newer release last found. */
function resendTo(win: BrowserWindow): void {
  win.webContents.on('did-finish-load', () => {
    if (lastAvailable) win.webContents.send('updates:available', lastAvailable)
  })
}

/** Sends to the window once it has loaded (it may have just been opened for Check for Updates… or Settings…). */
export function sendWhenLoaded(win: BrowserWindow, channel: string, payload?: unknown): void {
  const wc = win.webContents
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, payload))
  else wc.send(channel, payload)
}

/**
 * Check for Updates… (the macOS app menu): the window comes to the front and shows the answer – a newer release, that
 * Studio is up to date, that this is a development build, or why the check failed.
 */
export function checkForUpdatesFromMenu(): void {
  if (!deps) return
  const win = deps.showWindow()
  void lookUp().then(
    ({ info }) => sendWhenLoaded(win, 'updates:available', { ...info, requested: true }),
    (err: unknown) => {
      const current = app.getVersion()
      const error = reasonOf(err)
      console.warn('Checking for updates failed:', error)
      sendWhenLoaded(win, 'updates:available', {
        current,
        latest: '',
        available: false,
        notesUrl: releasesPage(),
        requested: true,
        error
      } satisfies UpdateInfo)
    }
  )
}

function refuseAgent(e: IpcMainInvokeEvent | undefined): void {
  if (isAgentCall(e) || !e?.sender) throw new Error(USER_ONLY)
}

/** The window's update calls (updates:check, updates:install, settings:setAutoUpdateCheck); agents get none of them. */
export function registerUpdateIpc(d: UpdateDeps): void {
  deps = d
  ipcMain.handle('updates:check', async (e) => {
    refuseAgent(e)
    let found: Found
    try {
      found = await lookUp()
    } catch (err) {
      throw new Error(reasonOf(err))
    }
    // The notice offers it, even for a version "Later" hid: the user asked.
    if (found.info.available) sendToWindows('updates:available', { ...found.info, requested: true })
    return found.info
  })
  ipcMain.handle('updates:install', async (e) => {
    refuseAgent(e)
    return installUpdate(d)
  })
  ipcMain.handle('settings:setAutoUpdateCheck', async (e, on: unknown) => {
    refuseAgent(e)
    setAutoUpdateCheck(on)
    sendToWindows('settings:change')
    if (on === true) setTimeout(dailyCheck, START_DELAY_MS)
  })
  app.on('browser-window-created', (_e, win) => resendTo(win))
}

/** Whether the daily check is due: switched on and a day since the last answer (or never, or a clock set back). */
export function dailyCheckDue(now = Date.now()): boolean {
  if (!getAutoUpdateCheck()) return false
  const last = getLastUpdateCheck()?.getTime()
  return last === undefined || now - last >= DAY_MS || last > now
}

function dailyCheck(): void {
  if (installing || !updateSource() || !dailyCheckDue()) return
  lookUp().then(
    ({ info }) => {
      if (info.available) sendToWindows('updates:available', info)
    },
    (err: unknown) => console.warn('The daily update check failed:', reasonOf(err))
  )
}

/**
 * At start: clears what an earlier update left behind, then checks once a day – a few seconds after start when a day
 * has passed, and again whenever one has while Studio runs. Never in a development build.
 */
export function startUpdateChecks(): void {
  void cleanUpAfterUpdate().catch((err: unknown) => console.warn('Clearing an earlier update failed:', err))
  if (!updateSource()) return
  setTimeout(dailyCheck, START_DELAY_MS)
  setInterval(dailyCheck, RECHECK_MS)
}

/**
 * What an update leaves: on macOS the work folders next to the app (an old JIBES Studio.app goes to the Trash, the rest is
 * removed), on Windows the installer's folder in the temp folder. Only in an installed (packaged) Studio.
 */
async function cleanUpAfterUpdate(): Promise<void> {
  if (!app.isPackaged) return
  if (IS_MAC) {
    const bundle = macBundle()
    if (bundle) await clearWorkFolders(dirname(bundle), MAC_WORK_PREFIX, (p) => shell.trashItem(p))
  } else if (IS_WINDOWS) {
    await clearWorkFolders(tmpdir(), WIN_WORK_PREFIX)
  }
}

/** Removes `prefix`* folders in `dir`; apps put aside in their "old" folder are trashed first when `trash` is given. */
export async function clearWorkFolders(dir: string, prefix: string, trash?: (path: string) => Promise<void>): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue
    const work = join(dir, name)
    if (!(await stat(work).catch(() => undefined))?.isDirectory()) continue
    if (trash) {
      const old = join(work, 'old')
      for (const app_ of await readdir(old).catch(() => [] as string[])) {
        if (app_.endsWith('.app')) await trash(join(old, app_)).catch(() => {})
      }
    }
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
