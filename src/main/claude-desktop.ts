import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import type { ClaudeDesktopStatus } from '@shared/types'
import type { AgentService } from './agent'
import { isAgentCall } from './agent/local-ipc'
import { LOOPBACK } from './agent/network'
import { IS_MAC, THIS_COMPUTER } from './platform'
import { VARIANT } from './variant'

// Studio in Claude Desktop: Claude Desktop installs local MCP servers as Desktop Extensions (.mcpb, a zip with a
// manifest.json – https://github.com/modelcontextprotocol/mcpb, manifest version 0.3). Studio's extension is a small
// stdio → Streamable HTTP bridge (src/mcpb/bridge.ts) that Claude Desktop runs with its own Node.js; its parts are
// built into build/mcpb by scripts/build-mcpb.mjs and shipped in the app's resources. Adding Studio zips them here,
// with this Studio's address and its current token filled in as the extension's settings, and hands the file to
// Claude Desktop (which asks the user to install it) – or saves it for Claude Desktop on another computer in the
// tailnet. Only the window can do this; agents never can.

const USER_ONLY = 'Only you can do this in Studio.'
/** The file Claude Desktop is given, and the name a saved one gets ("Studio Test.mcpb" for a variant). */
const FILE_NAME = VARIANT ? `Studio ${VARIANT}.mcpb` : 'Studio.mcpb'
/** A file handed to Claude Desktop holds the token: it is deleted this long after, or when Studio quits. */
const TEMP_LIFETIME_MS = 15 * 60_000
const TEMP_PREFIX = 'studio-claude-'
/** When leftovers of an earlier run are looked for. */
const SWEEP_DELAY_MS = 60_000
/** Claude Desktop shows the icon small; 512 × 512 is what it recommends. */
const ICON_SIZE = 512

// ── Finding Claude Desktop ───────────────────────────────────────────────────

/**
 * Where Claude Desktop may be installed. macOS: Claude.app in /Applications or ~/Applications. Windows: the
 * installer's per-user copy (%LOCALAPPDATA%\AnthropicClaude, older versions), or the Microsoft Store / MSIX package,
 * whose program folder can't be read but whose data folder (%LOCALAPPDATA%\Packages\Claude_<publisher>) is there for
 * every user who has it.
 */
export function claudeDesktopCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): { apps: string[]; packagesDir?: string } {
  if (platform === 'darwin') return { apps: ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')] }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
    return {
      apps: [win32.join(local, 'AnthropicClaude', 'claude.exe'), win32.join(local, 'Programs', 'Claude', 'Claude.exe')],
      packagesDir: win32.join(local, 'Packages')
    }
  }
  return { apps: [] }
}

/** The MSIX package's per-user folder name: "Claude_" and the publisher's 13-character id. */
const MSIX_PACKAGE = /^Claude_[0-9a-z]{13}$/i

/** Whether Claude Desktop is on this computer, and where. Only looks: never opens or reads its settings. */
export function findClaudeDesktop(
  candidates = claudeDesktopCandidates(),
  exists: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => readdirSync(dir)
): ClaudeDesktopStatus {
  const found = candidates.apps.find((p) => exists(p))
  if (found) return { installed: true, appPath: found }
  if (candidates.packagesDir) {
    try {
      const pkg = list(candidates.packagesDir).find((name) => MSIX_PACKAGE.test(name))
      if (pkg) return { installed: true, appPath: win32.join(candidates.packagesDir, pkg) }
    } catch {
      // No Packages folder: no Store apps at all.
    }
  }
  return { installed: false }
}

// ── The extension ────────────────────────────────────────────────────────────

/** Where the extension's parts are: the app's resources, or build/mcpb in development. */
export function bundleDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'mcpb') : join(app.getAppPath(), 'build', 'mcpb')
}

/** The settings the bridge reads (src/mcpb/manifest.json's user_config). */
interface UserConfigOption {
  default?: unknown
}

/**
 * The manifest with `url` and `token` as the defaults of the extension's two settings. A variant's extension has its
 * own name ("studio-test", "JIBES Studio Test"), so Claude Desktop can have it beside Studio's.
 */
export function personalizedManifest(
  template: unknown,
  url: string,
  token: string,
  variant = VARIANT
): Record<string, unknown> {
  const manifest = structuredClone(template) as {
    name?: string
    display_name?: string
    user_config?: Record<string, UserConfigOption>
  }
  const config = manifest.user_config
  if (!config?.studio_url || !config.studio_token) {
    throw new Error("The Claude Desktop extension in this copy of Studio is incomplete (its manifest has no settings).")
  }
  config.studio_url.default = url
  config.studio_token.default = token
  if (variant) {
    manifest.name = `studio-${variant.toLowerCase()}`
    manifest.display_name = `JIBES Studio ${variant}`
  }
  return manifest as Record<string, unknown>
}

/** The icon at the size Claude Desktop recommends (build/icon.png is 1024 × 1024); as it is if it can't be scaled. */
function iconPng(bytes: Buffer): Buffer {
  try {
    const image = nativeImage.createFromBuffer(bytes)
    if (!image.isEmpty() && image.getSize().width > ICON_SIZE) {
      const png = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: 'best' }).toPNG()
      if (png.length) return png
    }
  } catch {
    // The full-size icon works too.
  }
  return bytes
}

/**
 * The .mcpb for `url` with `token`: the manifest, the bridge, its licences and the icon, zipped. Throws when the
 * build has no extension (build/mcpb wasn't built).
 */
export function makeExtension(url: string, token: string, dir = bundleDir()): Buffer {
  const read = (name: string): Buffer => {
    const file = join(dir, ...name.split('/'))
    if (!existsSync(file)) {
      throw new Error(
        app.isPackaged
          ? 'This copy of Studio was built without its Claude Desktop extension. Download Studio again.'
          : 'The Claude Desktop extension hasn’t been built yet: run `npm run build:helpers` and try again.'
      )
    }
    return readFileSync(file)
  }
  const manifest = personalizedManifest(JSON.parse(read('manifest.json').toString('utf8')), url, token)
  const entries = [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: 'server/index.js', data: read('server/index.js') },
    { name: 'icon.png', data: iconPng(read('icon.png')) }
  ]
  if (existsSync(join(dir, 'server', 'LICENSES.txt'))) {
    entries.push({ name: 'server/LICENSES.txt', data: read('server/LICENSES.txt') })
  }
  return zipFiles(entries)
}

// ── Zip ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A zip of `entries` (no folders of their own; names with "/"), each deflated unless that makes it bigger. Written
 * the way a Unix zip is (rw-r--r-- in the external attributes), which is what Claude Desktop's unpacker reads; no
 * zip64, so each file and the whole must stay under 4 GB (the extension is under 1 MB).
 */
export function zipFiles(entries: { name: string; data: Buffer }[], when = new Date()): Buffer {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)
  const date = ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  const UTF8_NAMES = 0x0800
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const stored = deflated.length >= entry.data.length
    const body = stored ? entry.data : deflated
    const method = stored ? 0 : 8
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix, zip 2.0
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(UTF8_NAMES, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    // Extra field, comment, disk number and internal attributes stay 0.
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38) // a regular file, rw-r--r--
    header.writeUInt32LE(offset, 42)

    parts.push(local, name, body)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

// ── Adding Studio to Claude Desktop ──────────────────────────────────────────

export interface AddOptions {
  /** The host Claude Desktop reaches Studio at: 127.0.0.1 (default), the Tailscale address or its MagicDNS name. */
  address?: string
  /** Save the file where the user chooses instead of opening it in Claude Desktop here. */
  save?: boolean
}

/** What adding needs from the system; replaced in tests (which must never open the real Claude Desktop). */
export interface AddDeps {
  find: () => ClaudeDesktopStatus
  /** Opens the file with Claude Desktop; false when that didn't work. */
  open: (file: string, appPath: string | undefined) => Promise<boolean>
  /** Asks where to save; undefined when the user cancelled. */
  chooseSavePath: (win: BrowserWindow | undefined) => Promise<string | undefined>
  /** Where a file handed to Claude Desktop is written (a new private folder per file). */
  tempDir: () => Promise<string>
}

/** The address an agent's URL uses: one Studio listens on now, and the port it listens on. */
export function agentUrl(agent: Pick<AgentService, 'status'>, address: string | undefined): string {
  const status = agent.status()
  if (!status.enabled) {
    throw new Error('Switch on “Allow agents to connect” first: Claude Desktop connects to Studio through it.')
  }
  const host = (address ?? LOOPBACK).trim().toLowerCase().replace(/\.$/, '')
  const known = [LOOPBACK, status.tailscaleAddress, status.tailscaleDnsName?.toLowerCase().replace(/\.$/, '')]
  if (!host || !known.includes(host)) {
    throw new Error('Studio doesn’t listen on that address. Choose one of the addresses under Agent connection.')
  }
  return `http://${host}:${status.port}/mcp`
}

async function openWithClaude(file: string, appPath: string | undefined): Promise<boolean> {
  if (IS_MAC) {
    return new Promise((resolve) => {
      execFile('/usr/bin/open', ['-a', appPath ?? 'Claude', file], { timeout: 20_000 }, (err) => resolve(!err))
    })
  }
  // Windows: Claude Desktop is the program for .mcpb files.
  return (await shell.openPath(file)) === ''
}

const defaultDeps: AddDeps = {
  find: () => findClaudeDesktop(),
  open: openWithClaude,
  async chooseSavePath(win) {
    const options = {
      title: 'Save the Claude Desktop extension',
      buttonLabel: 'Save',
      defaultPath: join(app.getPath('downloads'), FILE_NAME),
      filters: [{ name: 'Claude Desktop extension', extensions: ['mcpb'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return res.canceled || !res.filePath ? undefined : res.filePath
  },
  tempDir: () => mkdtemp(join(app.getPath('temp'), TEMP_PREFIX))
}

/** Folders of files handed to Claude Desktop that haven't been deleted yet. */
const pendingTemp = new Set<string>()

function removeTempLater(dir: string): void {
  pendingTemp.add(dir)
  const timer = setTimeout(() => {
    pendingTemp.delete(dir)
    void rm(dir, { recursive: true, force: true }).catch(() => {})
  }, TEMP_LIFETIME_MS)
  timer.unref?.()
}

/** Deletes every file still waiting (on quit): none of them may outlive Studio with the token in it. */
export function removeTempFilesNow(): void {
  for (const dir of pendingTemp) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Gone already, or the system cleans its temp folder.
    }
  }
  pendingTemp.clear()
}

/** Leftovers of a Studio that didn't get to delete them (it crashed): removed a while after the next start. */
async function sweepStaleTempFiles(): Promise<void> {
  let temp: string
  try {
    temp = app.getPath('temp')
  } catch {
    return
  }
  const names = await readdir(temp).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue
    const dir = join(temp, name)
    const info = await stat(dir).catch(() => undefined)
    if (info?.isDirectory() && Date.now() - info.mtimeMs > TEMP_LIFETIME_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Makes the extension for this Studio and opens it in Claude Desktop, or saves it (`save`). Resolves with what
 * happened: `opened` false and no `savedTo` when the user cancelled the save, or Claude Desktop couldn't open it.
 */
export async function addToClaudeDesktop(
  agent: Pick<AgentService, 'status' | 'getToken'>,
  opts: AddOptions,
  win: BrowserWindow | undefined,
  deps: AddDeps = defaultDeps
): Promise<{ opened: boolean; savedTo?: string }> {
  const url = agentUrl(agent, opts.address)
  const bytes = makeExtension(url, agent.getToken())
  if (opts.save) {
    const path = await deps.chooseSavePath(win)
    if (!path) return { opened: false }
    await writeFile(path, bytes, { mode: 0o600 })
    return { opened: false, savedTo: path }
  }
  const claude = deps.find()
  if (!claude.installed) {
    throw new Error(`Claude Desktop isn’t on ${THIS_COMPUTER}. Install it from claude.ai/download, or save the file instead.`)
  }
  const dir = await deps.tempDir()
  const file = join(dir, FILE_NAME)
  await writeFile(file, bytes, { mode: 0o600 })
  removeTempLater(dir)
  const opened = await deps.open(file, IS_MAC ? claude.appPath : undefined)
  if (!opened) {
    pendingTemp.delete(dir)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return { opened }
}

function userOnly(e: IpcMainInvokeEvent): void {
  if (isAgentCall(e)) throw new Error(USER_ONLY)
}

function optionsOf(value: unknown): AddOptions {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    address: typeof o.address === 'string' && o.address ? o.address : undefined,
    save: o.save === true
  }
}

/** `claude:status` and `claude:addExtension`, for Settings → Agent connection. Neither is ever an agent's. */
export function registerClaudeDesktopIpc(agent: AgentService): void {
  ipcMain.handle('claude:status', (e) => {
    userOnly(e)
    return findClaudeDesktop()
  })
  ipcMain.handle('claude:addExtension', (e, opts: unknown) => {
    userOnly(e)
    const win = e.sender ? (BrowserWindow.fromWebContents(e.sender) ?? undefined) : undefined
    return addToClaudeDesktop(agent, optionsOf(opts), win)
  })
  app.on('will-quit', removeTempFilesNow)
  // Not at start, where every moment counts; nothing depends on it.
  const sweep = setTimeout(() => void sweepStaleTempFiles().catch(() => {}), SWEEP_DELAY_MS)
  sweep.unref?.()
}
