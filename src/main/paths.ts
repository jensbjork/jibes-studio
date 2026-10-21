// Where everything lives inside the base folder (grundmapp) the user chooses, and the file operations that keep
// the folders and the database in step. Paths stored in the database are relative to the base folder
// whenever they point inside it, so the whole library can be moved by moving its folders.

import { constants, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readdir, rename, rm, rmdir, stat, utimes } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { referenceVideosOf } from '@shared/models'
import type { AssetKind, GenerationParams, SequenceKind } from '@shared/types'
import * as db from './db'
import { FILE_MANAGER, IS_WINDOWS } from './platform'

/** The folders the user sees in Finder, plus the hidden app data folder. */
export const FOLDERS = {
  characters: 'Karaktärer',
  environments: 'Miljöer',
  /** Products: one folder per product with its photos (packshots) and description. */
  products: 'Produkter',
  outfits: 'Kläder',
  poses: 'Poser',
  /** Directors: one folder per director with its style frames, style videos and description. */
  directors: 'Regissörer',
  references: 'Referensbilder',
  generations: 'Genereringar',
  sequences: 'Sekvenser',
  storyboards: 'Storyboards',
  /** The user's own imported films, by import day (Egna klipp/<YYYY-MM-DD>/). */
  ownClips: 'Egna klipp',
  /** The Editor: one folder per edit, with its versions, AI takes (Tagningar/), audio (Ljud/) and inputs (Underlag/). */
  edits: 'Redigeringar',
  appData: '.studio'
} as const

/** The folder each kind of asset (character, environment, product, outfit, pose, director) keeps its own folders in. */
export const ASSET_FOLDERS: Readonly<Record<AssetKind, string>> = {
  character: FOLDERS.characters,
  environment: FOLDERS.environments,
  product: FOLDERS.products,
  outfit: FOLDERS.outfits,
  pose: FOLDERS.poses,
  director: FOLDERS.directors
}

/** A kind this version of Studio knows (the database may come from a newer one). */
export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ASSET_FOLDERS, value)
}

/** Phase-2 folders, directly in the library folder next to studio.db; emptied when such a library is converted. */
export const LEGACY_FOLDERS = {
  generations: 'generations',
  thumbs: 'thumbs',
  characters: 'characters',
  exports: 'exports',
  frames: 'frames'
} as const

/**
 * Inside FOLDERS.appData. stammar: separated voice/background stems (an LRU cache). redigering: scratch of paid
 * edit jobs, one folder per job. tidslinje: the editor's filmstrip and waveform cache. Only tmp is cleared when a
 * library is opened.
 */
export const APP_DATA = {
  thumbs: 'miniatyrer',
  frames: 'bildrutor',
  tmp: 'tmp',
  stems: 'stammar',
  editJobs: 'redigering',
  timeline: 'tidslinje'
} as const

/** Inside a sequence folder. */
export const TAKES_FOLDER = 'Tagningar'

/** Inside a sequence folder: the sequence's stills (keyframes generated, uploaded or saved from takes). */
export const STORYBOARD_FOLDER = 'Storyboard'

/** Inside a storyboard folder: the takes of its transitions. */
export const TRANSITIONS_FOLDER = 'Övergångar'

/** Inside a storyboard folder: its stills (board images generated, uploaded or saved from takes). */
export const BOARD_IMAGES_FOLDER = 'Bilder'

/** Inside an edit folder (Redigeringar/<name>/): the edit's subfolders. */
export const EDIT_FOLDERS = {
  /** AI takes made for picture operations. */
  takes: 'Tagningar',
  /** edit_media: converted voices, spoken lines, music, effects, added audio and rendered beds. */
  audio: 'Ljud',
  /** What was sent to Venice: frames and proxies. */
  inputs: 'Underlag'
} as const

/**
 * Where a sequence or a storyboard keeps its files: its own folder in `parent` (named after it), its takes in
 * `takes` and its stills in `stills` inside that, its exports in the folder itself.
 */
export const KIND_FOLDERS: Readonly<Record<SequenceKind, { parent: string; takes: string; stills: string }>> = {
  sequence: { parent: FOLDERS.sequences, takes: TAKES_FOLDER, stills: STORYBOARD_FOLDER },
  storyboard: { parent: FOLDERS.storyboards, takes: TRANSITIONS_FOLDER, stills: BOARD_IMAGES_FOLDER }
}

/** The kind a row's `kind` column names; anything this version doesn't know is treated as a plain sequence. */
export function sequenceKindOf(value: unknown): SequenceKind {
  return value === 'storyboard' ? 'storyboard' : 'sequence'
}

export const DB_FILE_NAME = 'studio.db'

export const LIBRARY_NOT_READY = 'Choose a library folder first.'
export const LIBRARY_LOST =
  `The library folder no longer exists where it was. Was it moved or renamed in ${FILE_MANAGER}, or disconnected?`
export const LIBRARY_OPERATION_RUNNING =
  'The library is already being moved or tidied. Wait a moment and try again.'

let activeRoot: string | undefined
/**
 * The base folder's file system identity when it was opened. A folder renamed, moved or unmounted while
 * Studio runs no longer matches, and nothing may then recreate an empty folder at the old path (see
 * assertRootIntact).
 */
let activeRootId: { dev: number; ino: number } | undefined
let onLost: (() => void) | undefined

/** Absolute, without a trailing slash, NFC (macOS file names may arrive decomposed). */
function normalizeAbs(p: string): string {
  return resolve(p).normalize('NFC')
}

export function isLibraryReady(): boolean {
  return activeRoot !== undefined
}

/**
 * A message with the folders of every local path in it left out – the file names stay: "…/Sekvenser/Sommar/
 * Tagningar/a.mp4: Invalid data" → "a.mp4: Invalid data". For ffmpeg's stderr and the like, before such a message is
 * stored or shown outside the window (an unseen row's error, an agent's answer): the library's place on disk and the
 * user's home folder are nobody else's business.
 */
export function withoutLocalPaths(text: string): string {
  const roots = new Set<string>()
  if (activeRoot) roots.add(activeRoot)
  for (const dir of [tmpdir(), homedir()]) {
    if (!dir) continue
    roots.add(normalizeAbs(dir))
    try {
      roots.add(realpathSync(dir).normalize('NFC'))
    } catch {
      // Then only the path as given.
    }
  }
  let out = text.normalize('NFC')
  // Folders end in "/"; on Windows in a backslash or "/" (both are used there), and letter case doesn't matter.
  const slash = IS_WINDOWS ? '[\\\\/]' : '/'
  const nameChar = IS_WINDOWS ? `[^\\\\/\n'":]` : `[^/\n'":]`
  // The longest first: the library usually lies inside the home folder.
  for (const root of [...roots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // The root and every folder after it, up to the file name (names may hold spaces, not quotes, colons or newlines).
    out = out.replace(new RegExp(`${escaped}(?:${slash}${nameChar}*)*${slash}`, IS_WINDOWS ? 'gi' : 'g'), '')
    out = out.split(root).join('…')
  }
  return out
}

/** Absolute base folder; throws Error(LIBRARY_NOT_READY) when not ready. */
export function libraryRoot(): string {
  if (!activeRoot) throw new Error(LIBRARY_NOT_READY)
  return activeRoot
}

/** Set by library-root.ts when a library is prepared/closed. */
export function setActiveRoot(root: string | undefined): void {
  activeRoot = root === undefined ? undefined : normalizeAbs(root)
  activeRootId = undefined
  if (!activeRoot) return
  try {
    const s = statSync(activeRoot)
    activeRootId = { dev: s.dev, ino: s.ino }
  } catch {
    // Checked again by isRootLost.
  }
}

/** The open base folder is no longer where it was opened: renamed, moved, deleted, replaced or unmounted. */
export function isRootLost(): boolean {
  if (!activeRoot) return false
  try {
    const s = statSync(activeRoot)
    if (!s.isDirectory()) return true
    return !!activeRootId && (s.dev !== activeRootId.dev || s.ino !== activeRootId.ino)
  } catch {
    return true
  }
}

/** library-root.ts closes the library when the base folder turns out to be gone (see assertRootIntact). */
export function setRootLostHandler(handler: (() => void) | undefined): void {
  onLost = handler
}

/**
 * Throws when the base folder is gone. Called before anything creates folders in the library: mkdir -p on
 * the old path would otherwise bring back an empty base folder there, put new files into it and record them
 * in the database, which has moved along with the real folder. The library is closed first, so pending jobs
 * stay pending (they resume when the folder is opened again) rather than being marked failed.
 */
export function assertRootIntact(): void {
  if (!isRootLost()) return
  try {
    onLost?.()
  } catch (err) {
    console.error('Closing the lost library failed:', err)
  }
  throw new Error(LIBRARY_LOST)
}

// ── Library-wide operations ──────────────────────────────────────────────────

/** Resolves when the switch, move or "Tidy up" in progress (library-root.ts) has finished. */
let operationDone: Promise<void> | undefined

/** Marks a library-wide operation as running; the returned function ends it. They never overlap. */
export function beginLibraryOperation(): () => void {
  if (operationDone) throw new Error(LIBRARY_OPERATION_RUNNING)
  let end!: () => void
  const done = new Promise<void>((resolve) => {
    end = resolve
  })
  operationDone = done
  return () => {
    if (operationDone === done) operationDone = undefined
    end()
  }
}

/**
 * Waits until no switch, move or clean-up runs. Asset, sequence and delete work queue behind them:
 * "Tidy up" decides where files go from the folder names it reads, so a rename or delete in between would
 * put files into a folder that no longer belongs to anything, or leave a deleted video behind untracked.
 */
export async function libraryOperationSettled(): Promise<void> {
  while (operationDone) await operationDone
}

// ── Stored paths ─────────────────────────────────────────────────────────────

/** POSIX path of abs relative to root, or undefined when abs is not strictly inside root. */
function relativeInside(root: string, abs: string): string | undefined {
  const rel = relative(root, normalizeAbs(abs))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/** Top-level folders the library owns: the current layout's, and phase-2 ones (until they are converted). */
const LIBRARY_TOP_FOLDERS = new Set<string>([...Object.values(FOLDERS), ...Object.values(LEGACY_FOLDERS)])

/** True for a stored relative path inside one of the library's own folders. */
export function isLibraryRelative(rel: string): boolean {
  return LIBRARY_TOP_FOLDERS.has(rel.normalize('NFC').split('/')[0])
}

/**
 * The path relative to the base folder when it lies in one of the library's own folders, else undefined.
 * Anything else in the base folder (the setup screen invites a folder that already holds the user's own files)
 * stays theirs: 'move' only takes the library's folders along, so such a file keeps an absolute path.
 */
function libraryRelative(abs: string): string | undefined {
  if (!activeRoot || typeof abs !== 'string' || !isAbsolute(abs)) return undefined
  const rel = relativeInside(activeRoot, abs)
  return rel && isLibraryRelative(rel) ? rel : undefined
}

/** Inside one of the library's own folders (Karaktärer, Miljöer, .studio, …), i.e. a file Studio manages. */
export function isInsideRoot(absPath: string): boolean {
  return libraryRelative(absPath) !== undefined
}

/** Relative (POSIX, no "./") when inside one of the library's folders, otherwise unchanged. */
export function toStoredPath(absPath: string): string {
  return libraryRelative(absPath) ?? absPath
}

/** Absolute; relative paths are resolved against the base folder. */
export function fromStoredPath(stored: string): string {
  if (typeof stored !== 'string' || !stored || isAbsolute(stored)) return stored
  return join(libraryRoot(), stored)
}

/**
 * Applies map to every file path in params: the start, end and reference images, the reference audio, and the
 * source and reference videos of video-to-video models.
 */
function mapParamPaths(p: GenerationParams, map: (path: string) => string): GenerationParams {
  if (!p || typeof p !== 'object') return p
  const out: GenerationParams = { ...p }
  if (typeof out.startImage === 'string' && out.startImage) out.startImage = map(out.startImage)
  if (typeof out.endImage === 'string' && out.endImage) out.endImage = map(out.endImage)
  if (Array.isArray(out.referenceImages)) {
    out.referenceImages = out.referenceImages.map((r) => (typeof r === 'string' && r ? map(r) : r))
  }
  if (Array.isArray(out.referenceAudios)) {
    out.referenceAudios = out.referenceAudios.map((a) =>
      a && typeof a === 'object' && typeof a.path === 'string' && a.path ? { ...a, path: map(a.path) } : a
    )
  }
  if (typeof out.sourceVideo === 'string' && out.sourceVideo) out.sourceVideo = map(out.sourceVideo)
  // Plain path strings (rows from before windows existed) are read as { path } windows (referenceVideosOf).
  if (Array.isArray(out.referenceVideos)) {
    out.referenceVideos = referenceVideosOf(out).map((v) => ({ ...v, path: map(v.path) }))
  }
  return out
}

/** Converts every params path (images, audio, videos; see mapParamPaths) to the stored form. */
export function toStoredParams(p: GenerationParams): GenerationParams {
  return mapParamPaths(p, toStoredPath)
}

export function fromStoredParams(p: GenerationParams): GenerationParams {
  return mapParamPaths(p, fromStoredPath)
}

// ── Names ────────────────────────────────────────────────────────────────────

/** Strips spaces and dots from both ends (a leading dot would hide the file in Finder). */
function trimName(s: string): string {
  return s.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')
}

/** Names Windows keeps for devices, case-insensitive and also with an extension ("nul.txt" is NUL). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])[ ]*(?=\.|$)/i
/** On Windows a name is kept shorter, so paths stay well within MAX_PATH (260) under the library's folders. */
const WINDOWS_MAX_NAME = 80

/** A name Windows would take for a device gets an underscore: "Con" → "Con_", "NUL.txt" → "NUL_.txt". */
export function avoidReservedName(name: string): string {
  return name.replace(WINDOWS_RESERVED, (device) => `${device.trimEnd()}_`)
}

/**
 * A file or folder name that reads like the text: å ä ö and ordinary punctuation are kept; characters that
 * macOS, Windows or external (exFAT) drives reject become "-" or disappear; whitespace collapses; long text is cut
 * at a word boundary with "…". Empty → fallback. On Windows (`platform`, given only by tests) names are at most 80
 * characters and never a device name (CON, NUL, COM1 …).
 */
export function safeName(
  text: string,
  opts: { max?: number; fallback?: string; platform?: NodeJS.Platform } = {}
): string {
  const windows = (opts.platform ?? process.platform) === 'win32'
  const wanted = opts.max ?? 60
  const max = Math.max(2, Math.floor(windows ? Math.min(wanted, WINDOWS_MAX_NAME) : wanted))
  const fallback = opts.fallback ?? 'Namnlös'
  let s = (typeof text === 'string' ? text : '')
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    // "12:30" → "12.30", "Scen 1: Anna" → "Scen 1 - Anna"; other separators become "-".
    .replace(/(\d):(?=\d)/g, '$1.')
    .replace(/\s*:\s+/g, ' - ')
    .replace(/[/\\:|]/g, '-')
    .replace(/"/g, "'")
    .replace(/[*?<>]/g, '')
    .replace(/\s+/gu, ' ')
  s = trimName(s)
  const chars = Array.from(s)
  if (chars.length > max) {
    const room = max - 1
    let cut = chars.slice(0, room).join('')
    const space = cut.lastIndexOf(' ')
    if (space >= Math.floor(cut.length / 2)) cut = cut.slice(0, space)
    cut = trimName(cut.replace(/[\s,;.\-–—]+$/u, ''))
    s = cut ? `${cut}…` : ''
  }
  const name = s || fallback
  return windows ? avoidReservedName(name) : name
}

/** Destinations of moves in progress, so two concurrent moves never pick the same free name. */
const inFlight = new Set<string>()

/** macOS volumes are normally case-insensitive, so names that differ only in case collide. */
function flightKey(p: string): string {
  return normalizeAbs(p).toLowerCase()
}

function entryExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * A file/folder NAME (not path) that doesn't exist yet in dir: base+ext, "base (2)"+ext, … Names that a
 * database row still records (its file deleted in Finder) count as taken too (see db.isStoredPathRecorded).
 */
export function uniqueName(dir: string, base: string, ext = ''): string {
  const suffix = ext && !ext.startsWith('.') ? `.${ext}` : ext
  const trimmed = trimName(base.replace(/[/\\]/g, '-')) || 'Namnlös'
  const stem = IS_WINDOWS ? avoidReservedName(trimmed) : trimmed
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${suffix}` : `${stem} (${n})${suffix}`
    const path = join(dir, name)
    if (!entryExists(path) && !inFlight.has(flightKey(path)) && !recordedInDb(path)) return name
  }
}

function recordedInDb(path: string): boolean {
  if (!activeRoot || !db.isDbOpen()) return false
  const stored = toStoredPath(path)
  return !isAbsolute(stored) && db.isStoredPathRecorded(stored)
}

/**
 * Whether the database still records paths inside this (possibly missing) library folder, so a folder
 * name picked for an asset or sequence must count it as taken (see db.isStoredPrefixRecorded).
 */
export function folderRecordedInDb(path: string): boolean {
  if (!activeRoot || !db.isDbOpen()) return false
  const stored = toStoredPath(path)
  return !isAbsolute(stored) && db.isStoredPrefixRecorded(stored)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "2026-10-06" (local time). */
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "14.32" (local time; colons are not allowed in Finder names). */
export function timeStamp(d: Date): string {
  return `${pad(d.getHours())}.${pad(d.getMinutes())}`
}

/** First line of the prompt as a name part ("@Image1" tokens kept), "Utan prompt" when empty. */
export function promptExcerpt(prompt: string, max = 50): string {
  const firstLine = (typeof prompt === 'string' ? prompt : '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  return safeName(firstLine, { max, fallback: 'Utan prompt' })
}

// ── Folders ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): string {
  assertRootIntact()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Creates a folder inside the open library (and its parents) and returns it; throws when the base folder is gone
 * (see assertRootIntact), so a vanished library is never brought back as an empty folder.
 */
export function ensureLibraryDir(dir: string): string {
  return ensureDir(dir)
}

/** Before creating folders for a destination: one inside the open library needs the base folder to be intact. */
function assertDestinationIntact(dest: string): void {
  if (activeRoot && relativeInside(activeRoot, dest) !== undefined) assertRootIntact()
}

/** A single folder name from the database must never reach outside its parent. */
function folderSegment(name: string): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error('Invalid folder name.')
  }
  return name
}

/** Karaktärer, Miljöer, Produkter, Kläder, Poser or Regissörer by kind [/<folder>] */
export function assetsDir(kind: AssetKind, folder?: string): string {
  if (!isAssetKind(kind)) throw new Error('Unknown kind of library item.')
  const base = join(libraryRoot(), ASSET_FOLDERS[kind])
  return ensureDir(folder === undefined ? base : join(base, folderSegment(folder)))
}

/** Referensbilder/<day> */
export function referencesDayDir(d: Date): string {
  return ensureDir(join(libraryRoot(), FOLDERS.references, dayStamp(d)))
}

/** Genereringar/<day> */
export function generationsDayDir(d: Date): string {
  return ensureDir(join(libraryRoot(), FOLDERS.generations, dayStamp(d)))
}

/** Egna klipp/<day>: where an import made on that day is kept. */
export function ownClipsDayDir(d: Date): string {
  return ensureDir(join(libraryRoot(), FOLDERS.ownClips, dayStamp(d)))
}

/** Redigeringar/<folder>[/Tagningar|Ljud|Underlag]: an edit's folder or one of its subfolders. */
export function editDir(folder: string, sub?: keyof typeof EDIT_FOLDERS): string {
  const base = join(libraryRoot(), FOLDERS.edits, folderSegment(folder))
  return ensureDir(sub ? join(base, EDIT_FOLDERS[sub]) : base)
}

/** Sekvenser/<folder>, or Storyboards/<folder> for a storyboard */
export function sequenceDir(folder: string, kind: SequenceKind = 'sequence'): string {
  return ensureDir(join(libraryRoot(), KIND_FOLDERS[kind].parent, folderSegment(folder)))
}

/** Sekvenser/<folder>/Tagningar, or Storyboards/<folder>/Övergångar for a storyboard */
export function sequenceTakesDir(folder: string, kind: SequenceKind = 'sequence'): string {
  const layout = KIND_FOLDERS[kind]
  return ensureDir(join(libraryRoot(), layout.parent, folderSegment(folder), layout.takes))
}

/** .studio[/...] */
export function appDataDir(...sub: string[]): string {
  return ensureDir(join(libraryRoot(), FOLDERS.appData, ...sub))
}

export function thumbsDir(): string {
  return appDataDir(APP_DATA.thumbs)
}

export function framesDir(): string {
  return appDataDir(APP_DATA.frames)
}

export function tmpDir(): string {
  return appDataDir(APP_DATA.tmp)
}

/** Inside .studio/tmp: files agents upload, one folder per upload (cleared with tmp at every library open). */
export const AGENT_UPLOADS_FOLDER = 'agent-uploads'

/** .studio/tmp/agent-uploads (created if needed): where agent uploads are staged until a tool copies them in. */
export function agentUploadsDir(): string {
  return appDataDir(APP_DATA.tmp, AGENT_UPLOADS_FOLDER)
}

/**
 * Where agentUploadsDir is, without creating anything (for checks); undefined while no library is open. The base
 * folder may be gone, in which case the path simply doesn't exist.
 */
export function agentUploadsPath(): string | undefined {
  return activeRoot ? join(activeRoot, FOLDERS.appData, APP_DATA.tmp, AGENT_UPLOADS_FOLDER) : undefined
}

/** .studio/stammar: the voice/background stem cache. */
export function stemsDir(): string {
  return appDataDir(APP_DATA.stems)
}

/** .studio/redigering[/<jobId>]: scratch of a paid edit job (removed when the job is finished). */
export function editJobDir(jobId?: string): string {
  return jobId === undefined ? appDataDir(APP_DATA.editJobs) : appDataDir(APP_DATA.editJobs, folderSegment(jobId))
}

/** .studio/tidslinje: the editor's filmstrip and waveform cache. */
export function timelineDir(): string {
  return appDataDir(APP_DATA.timeline)
}

const DAY_FOLDER = new RegExp(
  `^(${FOLDERS.generations}|${FOLDERS.references}|${FOLDERS.ownClips})/\\d{4}-\\d{2}-\\d{2}$`
)

/**
 * Removes a Genereringar/<day>, Referensbilder/<day> or Egna klipp/<day> folder that a move or delete has just
 * emptied (Finder's own files aside), so Finder doesn't fill up with empty days. Anything else is left alone;
 * never throws.
 */
export async function removeDayFolderIfEmpty(dir: string): Promise<void> {
  if (!activeRoot || !DAY_FOLDER.test(toStoredPath(dir))) return
  try {
    const names = await readdir(dir)
    if (names.some((n) => n !== '.DS_Store' && n !== '.localized')) return
    for (const n of names) await rm(join(dir, n), { force: true })
    // rmdir refuses a folder that got a new file meanwhile.
    await rmdir(dir)
  } catch {
    // Gone already, or in use again.
  }
}

/** <root>/.studio/studio.db */
export function dbFile(root?: string): string {
  return join(root ? normalizeAbs(root) : libraryRoot(), FOLDERS.appData, DB_FILE_NAME)
}

// ── Moving ───────────────────────────────────────────────────────────────────

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function alreadyExists(path: string): Error {
  return Object.assign(new Error(`“${basename(path)}” already exists in ${dirname(path)}.`), { code: 'EEXIST' })
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

/** Same file system entry, e.g. "anna" and "Anna" on a case-insensitive volume. */
async function sameEntry(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([lstat(a), lstat(b)])
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/** Finder's own files come and go by themselves (opening a folder writes one); they are not the user's content. */
const FINDER_FILES = new Set(['.DS_Store', '.localized'])

/**
 * Every file and link under src exists under dest with the same size. Finder's own files are skipped, and so
 * is an entry removed from src since it was copied (there is nothing of it left to lose).
 */
async function verifyCopy(src: string, dest: string): Promise<void> {
  let a: Stats
  try {
    a = await lstat(src)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return
    throw err
  }
  const b = await lstat(dest).catch(() => undefined)
  if (!b) throw new Error(`The copy of ${basename(src)} was incomplete.`)
  if (a.isDirectory()) {
    if (!b.isDirectory()) throw new Error(`The copy of ${basename(src)} was incomplete.`)
    for (const name of await readdir(src)) {
      if (!FINDER_FILES.has(name)) await verifyCopy(join(src, name), join(dest, name))
    }
  } else if (a.isFile()) {
    if (!b.isFile() || a.size !== b.size) throw new Error(`The copy of ${basename(src)} was incomplete.`)
  } else if (a.isSymbolicLink() !== b.isSymbolicLink()) {
    throw new Error(`The copy of ${basename(src)} was incomplete.`)
  }
}

/**
 * Copies a file or folder to dest (which must not exist) and checks the copy; on failure the partial copy is
 * removed. The source is left untouched.
 */
export async function copyPathVerified(from: string, to: string, info?: Stats): Promise<void> {
  const src = resolve(from)
  const dest = resolve(to)
  const s = info ?? (await lstat(src))
  if (await pathExists(dest)) throw alreadyExists(dest)
  assertDestinationIntact(dest)
  await mkdir(dirname(dest), { recursive: true })
  try {
    if (s.isDirectory()) {
      await cp(src, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true
      })
    } else if (s.isFile()) {
      await copyFile(src, dest, constants.COPYFILE_EXCL)
      await utimes(dest, s.atime, s.mtime).catch(() => {})
    } else {
      throw new Error(`${basename(src)} cannot be copied.`)
    }
    await verifyCopy(src, dest)
  } catch (err) {
    // Only remove what this call created: an EEXIST means the destination belongs to someone else.
    if (errorCode(err) !== 'EEXIST' && errorCode(err) !== 'ERR_FS_CP_EEXIST') {
      await rm(dest, { recursive: true, force: true }).catch(() => {})
    }
    throw err
  }
}

/**
 * fs.rename with EXDEV fallback (copy → verify size → remove source). Creates the parent dir. Never
 * overwrites: an existing destination is an error (code EEXIST), except when it is the source itself under
 * another letter case.
 */
export async function movePath(from: string, to: string): Promise<void> {
  const src = resolve(from)
  const dest = resolve(to)
  if (src === dest) return
  const key = flightKey(dest)
  if (inFlight.has(key)) throw alreadyExists(dest)
  inFlight.add(key)
  try {
    const info = await lstat(src)
    if ((await pathExists(dest)) && !(await sameEntry(src, dest))) throw alreadyExists(dest)
    assertDestinationIntact(dest)
    await mkdir(dirname(dest), { recursive: true })
    try {
      await rename(src, dest)
    } catch (err) {
      if (errorCode(err) !== 'EXDEV') throw err
      await copyPathVerified(src, dest, info)
      // The copy is complete and verified; a source that can't be removed only leaves a duplicate behind.
      await rm(src, { recursive: true, force: true }).catch((e: unknown) =>
        console.warn(`Moved ${src} to ${dest} but could not remove the original:`, e)
      )
    }
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Rename a library folder on disk and rewrite every stored path under it (DB transaction; on DB failure
 * rename back). `inTransaction` runs inside the same transaction, e.g. to record the new folder name, so
 * the folder and its row can't disagree. A folder that is already gone is recreated under the new name.
 */
export async function renameLibraryFolder(
  oldAbsDir: string,
  newAbsDir: string,
  inTransaction?: () => void
): Promise<void> {
  // A gone base folder would otherwise be recreated below (the "already gone" case) at its old path.
  assertRootIntact()
  const oldDir = normalizeAbs(oldAbsDir)
  const newDir = normalizeAbs(newAbsDir)
  const oldRel = toStoredPath(oldDir)
  const newRel = toStoredPath(newDir)
  if (isAbsolute(oldRel) || isAbsolute(newRel)) throw new Error('The folder is outside the library.')
  const conn = db.getDb()
  if (oldRel === newRel) {
    if (inTransaction) conn.transaction(inTransaction)()
    return
  }
  if (newRel.startsWith(`${oldRel}/`)) throw new Error('A folder cannot be moved into itself.')

  const existed = await pathExists(oldDir)
  if (existed) {
    await movePath(oldDir, newDir)
  } else {
    if (await pathExists(newDir)) throw alreadyExists(newDir)
    await mkdir(newDir, { recursive: true })
  }
  try {
    conn.transaction(() => {
      db.rewriteStoredPrefix(oldRel, newRel)
      inTransaction?.()
    })()
  } catch (err) {
    if (existed) {
      await movePath(newDir, oldDir).catch((e: unknown) =>
        console.error(`Could not move ${newDir} back to ${oldDir}:`, e)
      )
    } else {
      await rmdir(newDir).catch(() => {})
    }
    throw err
  }
}

/**
 * Move one tracked file and return its new absolute path (uniqueName in the target dir; same dir → no-op).
 * The name is baseName (or the current name) plus the current extension. Stored paths are not touched:
 * the caller updates (or rewrites) them.
 */
export async function moveFileInto(absFile: string, targetDir: string, baseName?: string): Promise<string> {
  const src = resolve(absFile)
  const dir = normalizeAbs(targetDir)
  if (dirname(src).normalize('NFC') === dir) return absFile
  const ext = extname(src)
  assertDestinationIntact(dir)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, uniqueName(dir, baseName ?? basename(src, ext), ext))
  await movePath(src, dest)
  return dest
}
