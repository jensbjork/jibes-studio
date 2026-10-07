import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app, safeStorage } from 'electron'
import type { PromptLanguage, Settings } from '@shared/types'
import { isLibraryReady, libraryRoot } from './paths'

/** Where the agent connection (MCP server) listens unless the user picks another port. */
export const DEFAULT_AGENT_PORT = 8770

/** The agent connection: off by default; the token is what agents authenticate with. */
interface StoredAgentSettings {
  enabled: boolean
  port: number
  /** Bearer token encrypted with the macOS keychain via safeStorage, base64. */
  tokenEncrypted?: string
}

interface StoredSettings {
  /** API key encrypted with the macOS keychain via safeStorage, base64. */
  apiKeyEncrypted?: string
  /** Absolute path of the base folder (grundmapp). Unset until the user has chosen one. */
  libraryRoot?: string
  /** Phase-2 library location (never set by the app itself); only read to find a legacy library. */
  libraryDir?: string
  /** Accepted provider consent versions, keyed by consent flow (e.g. "seedance"). */
  consents?: Record<string, string>
  /** "Promptspråk"; English unless the user picks Swedish. */
  promptLanguage?: PromptLanguage
  /**
   * "Säkert läge för bilder": Venice blurs adult content in generated stills. Unset means on, Venice's own
   * default; only an explicit `false` turns it off.
   */
  imageSafeMode?: boolean
  agent?: StoredAgentSettings
}

const file = () => join(app.getPath('userData'), 'settings.json')

function load(): StoredSettings {
  if (!existsSync(file())) return {}
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as StoredSettings
  } catch {
    return {}
  }
}

/** Written to a temp file and renamed, so a crash mid-write can't lose the key or the library location. */
function save(s: StoredSettings): void {
  const target = file()
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, target)
}

/** The configured base folder, or undefined while unconfigured. */
export function getLibraryRoot(): string | undefined {
  const root = load().libraryRoot
  return typeof root === 'string' && isAbsolute(root) ? resolve(root) : undefined
}

/** Records the base folder (undefined → unconfigured). The phase-2 key is dropped at the same time. */
export function setLibraryRootSetting(root: string | undefined): void {
  const s = load()
  if (root) s.libraryRoot = resolve(root)
  else delete s.libraryRoot
  delete s.libraryDir
  save(s)
}

/** The stored keys that say where the library is, as they are on disk. */
export interface LibraryLocation {
  libraryRoot?: string
  libraryDir?: string
}

/** Taken before a switch, so a failed one can put the setting back exactly (see restoreLibraryLocation). */
export function libraryLocation(): LibraryLocation {
  const s = load()
  return { libraryRoot: s.libraryRoot, libraryDir: s.libraryDir }
}

/**
 * Puts the library keys back as they were. setLibraryRootSetting drops the phase-2 key, which may be the
 * only record of where an old library outside ~/Movies/Studio lies; a switch that failed must not lose it.
 */
export function restoreLibraryLocation(location: LibraryLocation): void {
  const s = load()
  if (location.libraryRoot === undefined) delete s.libraryRoot
  else s.libraryRoot = location.libraryRoot
  if (location.libraryDir === undefined) delete s.libraryDir
  else s.libraryDir = location.libraryDir
  save(s)
}

/** Proposed base folder for a first run: ~/Movies/Studio. */
export function suggestedLibraryRoot(): string {
  return join(app.getPath('videos'), app.getName())
}

/** Running as "Studio Dev" (npm run dev), with its own settings and library. */
export function isDevProfile(): boolean {
  return !!process.env.STUDIO_DEV_PROFILE
}

/** Where a phase-2 library would be: its old setting if one was ever written, else ~/Movies/Studio. */
export function legacyLibraryDir(): string {
  const old = load().libraryDir
  return typeof old === 'string' && isAbsolute(old) ? resolve(old) : suggestedLibraryRoot()
}

export function getApiKey(): string | null {
  const enc = load().apiKeyEncrypted
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function setApiKey(key: string): void {
  const s = load()
  const trimmed = key.trim()
  if (trimmed) s.apiKeyEncrypted = safeStorage.encryptString(trimmed).toString('base64')
  else delete s.apiKeyEncrypted
  save(s)
}

export function getSettings(): Settings {
  const s = load()
  return {
    hasApiKey: !!s.apiKeyEncrypted,
    libraryDir: isLibraryReady() ? libraryRoot() : '',
    devProfile: isDevProfile(),
    promptLanguage: promptLanguageOf(s),
    imageSafeMode: s.imageSafeMode !== false
  }
}

function promptLanguageOf(s: StoredSettings): PromptLanguage {
  return s.promptLanguage === 'sv' ? 'sv' : 'en'
}

export function getPromptLanguage(): PromptLanguage {
  return promptLanguageOf(load())
}

export function setPromptLanguage(lang: unknown): void {
  if (lang !== 'en' && lang !== 'sv') throw new Error('Okänt promptspråk.')
  const s = load()
  s.promptLanguage = lang
  save(s)
}

/** Whether stills are generated with Venice's safe mode (adult content blurred); on unless switched off. */
export function getImageSafeMode(): boolean {
  return load().imageSafeMode !== false
}

export function setImageSafeMode(on: unknown): void {
  if (typeof on !== 'boolean') throw new Error('Ogiltigt värde för säkert läge.')
  const s = load()
  s.imageSafeMode = on
  save(s)
}

// ── Agent connection ─────────────────────────────────────────────────────────

/** A port Studio may listen on: not a privileged one (below 1024), which macOS reserves. */
export function isValidAgentPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
}

/** Whether the agent connection is switched on, and its port (the stored value when it is a usable one). */
export function getAgentSettings(): { enabled: boolean; port: number } {
  const agent = load().agent
  const port = agent?.port
  return { enabled: agent?.enabled === true, port: isValidAgentPort(port) ? port : DEFAULT_AGENT_PORT }
}

function updateAgent(patch: Partial<StoredAgentSettings>): void {
  const s = load()
  const current = getAgentSettings()
  s.agent = { ...s.agent, enabled: current.enabled, port: current.port, ...patch }
  save(s)
}

export function setAgentEnabledSetting(enabled: boolean): void {
  updateAgent({ enabled })
}

export function setAgentPortSetting(port: number): void {
  if (!isValidAgentPort(port)) throw new Error('Porten måste vara ett heltal mellan 1024 och 65535.')
  updateAgent({ port })
}

/** The stored token, or undefined when there is none yet (or it can't be decrypted on this Mac). */
export function getStoredAgentToken(): string | undefined {
  const enc = load().agent?.tokenEncrypted
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64')) || undefined
  } catch {
    return undefined
  }
}

/** The token agents connect with; one is created (and stored encrypted) the first time it is needed. */
export function getAgentToken(): string {
  return getStoredAgentToken() ?? regenerateAgentToken()
}

/** Replaces the token with a new random one (256 bits, base64url) and returns it. */
export function regenerateAgentToken(): string {
  const token = randomBytes(32).toString('base64url')
  updateAgent({ tokenEncrypted: safeStorage.encryptString(token).toString('base64') })
  return token
}

export function getAcceptedConsents(): Record<string, string> {
  return load().consents ?? {}
}

export function acceptConsent(flow: string, version: string): void {
  const s = load()
  s.consents = { ...s.consents, [flow]: version }
  save(s)
}
