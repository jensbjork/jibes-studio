import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { app, safeStorage } from 'electron'
import { normalizeBudget } from '@shared/budget'
import { asProvider, providerName, rememberProvider, type Provider } from '@shared/provider'
import type { BudgetSettings, PromptLanguage, Settings } from '@shared/types'
import { isLibraryReady, libraryRoot } from './paths'
import { VARIANT } from './variant'

/** Where the agent connection (MCP server) listens unless the user picks another port. */
export const DEFAULT_AGENT_PORT = 8770
/** Studio Dev's, one up, so it can listen at the same time as JIBES Studio.app or Studio Test. */
export const DEV_AGENT_PORT = DEFAULT_AGENT_PORT + 1

/** The agent connection: off by default; the token is what agents authenticate with. */
interface StoredAgentSettings {
  enabled: boolean
  port: number
  /** Bearer token encrypted with the macOS keychain via safeStorage, base64. */
  tokenEncrypted?: string
}

interface StoredSettings {
  /** Venice's API key, encrypted with the macOS keychain via safeStorage, base64. */
  apiKeyEncrypted?: string
  /** fal.ai's API key, encrypted the same way. */
  falKeyEncrypted?: string
  /** The service new work is made with (Settings → Service); Venice unless the user picked fal.ai. */
  provider?: Provider
  /** Absolute path of the base folder (grundmapp). Unset until the user has chosen one. */
  libraryRoot?: string
  /** Phase-2 library location (never set by the app itself); only read to find a legacy library. */
  libraryDir?: string
  /** Accepted provider consent versions, keyed by consent flow (e.g. "seedance"). */
  consents?: Record<string, string>
  /** "Prompt language"; English unless the user picks Swedish. */
  promptLanguage?: PromptLanguage
  /**
   * "Safe mode for images": Venice blurs adult content in generated stills. Unset means on, Venice's own
   * default; only an explicit `false` turns it off.
   */
  imageSafeMode?: boolean
  /** Spending caps in USD (Settings → Spending); a cap left out means none. */
  budget?: BudgetSettings
  agent?: StoredAgentSettings
  /** Look for a newer Studio once a day (Settings → About); unset means on, only `false` turns it off. */
  autoUpdateCheck?: boolean
  /** When Studio last got an answer from GitHub about its newest release (ISO): the daily check counts from it. */
  lastUpdateCheck?: string
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

/**
 * Proposed base folder for a first run, after the program's name: ~/Movies/JIBES Studio (JIBES Studio Dev, JIBES Studio
 * Test). Libraries made before keep their folders (~/Movies/Studio …): the settings say where they are.
 */
export function suggestedLibraryRoot(): string {
  const name = ['JIBES Studio', VARIANT, isDevProfile() ? 'Dev' : ''].filter(Boolean).join(' ')
  return join(app.getPath('videos'), name)
}

/** Running as "Studio Dev" (npm run dev), with its own settings and library. */
export function isDevProfile(): boolean {
  return !!process.env.STUDIO_DEV_PROFILE
}

/**
 * STUDIO_UPDATE_TEST_SERVER, for tests only: a stand-in for GitHub on this computer (http://127.0.0.1:<port>) that
 * updates.ts asks instead, so a test instance can be shown an update. Anything else in it is ignored.
 */
export function updateTestServer(): URL | undefined {
  const raw = process.env.STUDIO_UPDATE_TEST_SERVER
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return url.protocol === 'http:' && local && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * A development build – Studio Dev, any other unpackaged one (`npm run dev:real`) or a variant (variant.ts, where a
 * release would replace it with Studio) – never looks for updates: it is updated from git. A test instance pointed at
 * a stand-in for GitHub (updateTestServer) behaves as a release, except that it never replaces itself (updates.ts).
 */
export function isDevelopmentBuild(): boolean {
  return (!app.isPackaged || isDevProfile() || !!VARIANT) && !updateTestServer()
}

/** Where a phase-2 library would be: its old setting if one was ever written, else ~/Movies/Studio. */
export function legacyLibraryDir(): string {
  const old = load().libraryDir
  // Phase 2 had no choice of folder: ~/Movies/<the app's name inside>, Studio (Studio Dev).
  return typeof old === 'string' && isAbsolute(old) ? resolve(old) : join(app.getPath('videos'), app.getName())
}

function decrypt(enc: string | undefined): string | null {
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

/** Venice's API key. */
export function getApiKey(): string | null {
  return decrypt(load().apiKeyEncrypted)
}

/** fal.ai's API key. */
export function getFalKey(): string | null {
  return decrypt(load().falKeyEncrypted)
}

/** The key of a service. */
export function getKeyOf(provider: Provider): string | null {
  return provider === 'fal' ? getFalKey() : getApiKey()
}

/** The key of the active service (Settings → Service). */
export function getActiveKey(): string | null {
  return getKeyOf(getProvider())
}

/** Stores a service's key encrypted ('' removes it); Venice's when no service is named, as before fal existed. */
export function setApiKey(key: string, provider: Provider = 'venice'): void {
  const s = load()
  const trimmed = typeof key === 'string' ? key.trim() : ''
  // Electron's own message for this is about its internals; Settings shows this one.
  if (trimmed && !safeStorage.isEncryptionAvailable()) {
    throw new Error("The key can't be stored encrypted on this computer right now.")
  }
  const field = provider === 'fal' ? 'falKeyEncrypted' : 'apiKeyEncrypted'
  if (trimmed) s[field] = safeStorage.encryptString(trimmed).toString('base64')
  else delete s[field]
  save(s)
}

/** The service new work is made with. */
export function getProvider(): Provider {
  return asProvider(load().provider) ?? 'venice'
}

/** Switches the service new work is made with; shared code (default models) follows at once. */
export function setProvider(value: unknown): Provider {
  const provider = asProvider(value)
  if (!provider) throw new Error('Unknown service.')
  const s = load()
  if (provider === 'venice') delete s.provider
  else s.provider = provider
  save(s)
  rememberProvider(provider)
  return provider
}

/** Reads the stored choice into shared code; main calls it once at start (setProvider keeps it current after). */
export function loadProvider(): Provider {
  const provider = getProvider()
  rememberProvider(provider)
  return provider
}

/** "Venice" / "fal.ai": the active service's name, for messages. */
export function activeServiceName(): string {
  return providerName(getProvider())
}

export function getSettings(): Settings {
  const s = load()
  const provider = asProvider(s.provider) ?? 'venice'
  return {
    provider,
    hasApiKey: provider === 'fal' ? !!s.falKeyEncrypted : !!s.apiKeyEncrypted,
    keys: { venice: !!s.apiKeyEncrypted, fal: !!s.falKeyEncrypted },
    libraryDir: isLibraryReady() ? libraryRoot() : '',
    devProfile: isDevProfile(),
    variant: VARIANT || undefined,
    autoUpdateCheck: s.autoUpdateCheck !== false,
    lastUpdateCheck: lastUpdateCheckOf(s)?.toISOString(),
    developmentBuild: isDevelopmentBuild(),
    promptLanguage: promptLanguageOf(s),
    imageSafeMode: s.imageSafeMode !== false,
    budget: budgetOf(s)
  }
}

/** The stored caps that are usable (a file edited by hand may hold anything). */
function budgetOf(s: StoredSettings): BudgetSettings {
  try {
    return normalizeBudget(s.budget)
  } catch {
    return {}
  }
}

/** The spending caps of this profile (Settings → Spending); {} when none is set. */
export function getBudget(): BudgetSettings {
  return budgetOf(load())
}

/** Replaces both caps: a cap left out (or null) is removed. Throws for an amount that isn't one. */
export function setBudget(raw: unknown): BudgetSettings {
  const budget = normalizeBudget(raw)
  const s = load()
  if (budget.dailyUsd === undefined && budget.monthlyUsd === undefined) delete s.budget
  else s.budget = budget
  save(s)
  return budget
}

function promptLanguageOf(s: StoredSettings): PromptLanguage {
  return s.promptLanguage === 'sv' ? 'sv' : 'en'
}

export function getPromptLanguage(): PromptLanguage {
  return promptLanguageOf(load())
}

export function setPromptLanguage(lang: unknown): void {
  if (lang !== 'en' && lang !== 'sv') throw new Error('Unknown prompt language.')
  const s = load()
  s.promptLanguage = lang
  save(s)
}

/** Whether stills are generated with Venice's safe mode (adult content blurred); on unless switched off. */
export function getImageSafeMode(): boolean {
  return load().imageSafeMode !== false
}

export function setImageSafeMode(on: unknown): void {
  if (typeof on !== 'boolean') throw new Error('Invalid value for safe mode.')
  const s = load()
  s.imageSafeMode = on
  save(s)
}

// ── Updates ──────────────────────────────────────────────────────────────────

/** Whether Studio looks for a newer version once a day (updates.ts); on unless switched off. */
export function getAutoUpdateCheck(): boolean {
  return load().autoUpdateCheck !== false
}

export function setAutoUpdateCheck(on: unknown): void {
  if (typeof on !== 'boolean') throw new Error('Invalid value for checking for updates.')
  const s = load()
  s.autoUpdateCheck = on
  save(s)
}

function lastUpdateCheckOf(s: StoredSettings): Date | undefined {
  const at = typeof s.lastUpdateCheck === 'string' ? new Date(s.lastUpdateCheck) : undefined
  return at && Number.isFinite(at.getTime()) ? at : undefined
}

/** When Studio last got an answer from GitHub about its newest release; undefined if never (or unreadable). */
export function getLastUpdateCheck(): Date | undefined {
  return lastUpdateCheckOf(load())
}

export function setLastUpdateCheck(at: Date): void {
  const s = load()
  s.lastUpdateCheck = at.toISOString()
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
  const fallback = isDevProfile() ? DEV_AGENT_PORT : DEFAULT_AGENT_PORT
  return { enabled: agent?.enabled === true, port: isValidAgentPort(port) ? port : fallback }
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
  if (!isValidAgentPort(port)) throw new Error('The port must be a whole number between 1024 and 65535.')
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
