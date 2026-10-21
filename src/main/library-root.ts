// The base folder (grundmapp): opening it at startup, switching to another folder or moving the library
// there, converting a phase-2 library (~/Movies/Studio with studio.db, generations/, thumbs/, …) to the
// new layout, and "Tidy up", which puts every file the library knows about in its proper folder:
// characters, environments, products, outfits, poses and directors (assets) in Karaktärer/, Miljöer/, Produkter/,
// Kläder/, Poser/ and Regissörer/, one folder each holding the asset's photos and audio clips (a director's style
// frames and style videos); a sequence's takes, stills and exports in its
// folder in Sekvenser/ (Tagningar/, Storyboard/ and the folder itself), and a storyboard's in its folder in
// Storyboards/ (Övergångar/, Bilder/ and the folder itself); the user's own films in Egna klipp/<day>/, and an edit's
// versions, AI takes and audio in its folder in Redigeringar/ (the folder itself, Tagningar/ and Ljud/). Where a
// generation's file belongs is decided by its row (the file home rule, jobs.videoHome).

import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats
} from 'node:fs'
import { access, constants, lstat, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import type {
  AssetKind,
  FolderInspection,
  LibraryFolderTarget,
  LibraryMode,
  LibraryStatus,
  ReorganizeReport,
  SequenceKind
} from '@shared/types'
import * as db from './db'
import { removeLeftoverPartialFiles } from './ffmpeg'
import { originalHome, videoHome } from './jobs'
import { assetFolderPath } from './library'
import {
  APP_DATA,
  ASSET_FOLDERS,
  assertRootIntact,
  beginLibraryOperation,
  copyPathVerified,
  DB_FILE_NAME,
  dayStamp,
  dbFile,
  EDIT_FOLDERS,
  FOLDERS,
  folderRecordedInDb,
  fromStoredPath,
  isAssetKind,
  isInsideRoot,
  isLibraryReady,
  isRootLost,
  KIND_FOLDERS,
  LEGACY_FOLDERS,
  LIBRARY_OPERATION_RUNNING,
  libraryRoot,
  moveFileInto,
  movePath,
  renameLibraryFolder,
  safeName,
  sequenceKindOf,
  setActiveRoot,
  setRootLostHandler,
  toStoredPath,
  uniqueName
} from './paths'
import { FILE_MANAGER, hideFolderOnWindows, IS_WINDOWS } from './platform'
import { fileErrorReason } from './references'
import {
  getLibraryRoot,
  legacyLibraryDir,
  libraryLocation,
  restoreLibraryLocation,
  setLibraryRootSetting,
  suggestedLibraryRoot
} from './settings'

/** Phase-2 folders, directly in the library folder next to studio.db. */
const LEGACY = LEGACY_FOLDERS

/** Phase-2 exports belonged to no recorded sequence; they get a folder of their own under Sekvenser. */
const LEGACY_EXPORTS_FOLDER = 'Äldre exporter'
/** Present while a phase-2 library is being converted; a conversion that was cut short resumes on next open. */
const MIGRATION_MARKER = 'legacy-migration.json'
const DESCRIPTION_FILE = 'Beskrivning.txt'
/** Folder-name fallbacks for names that leave nothing (as assets, sequence-store and edits name them): data on disk. */
const UNNAMED_ASSET = 'Namnlös'
const UNNAMED_SEQUENCE = 'Namnlös sekvens'
const UNNAMED_STORYBOARD = 'Namnlös storyboard'
const UNNAMED_EDIT = 'Namnlös redigering'
/** Finder's own files don't make a folder "non-empty". */
const IGNORABLE = new Set(['.DS_Store', '.localized'])
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/
/**
 * The library's visible folders: created when a library is opened (ensureStructure), taken along by 'move'
 * (LIBRARY_FOLDERS), and the only places tracked files may lie in for a move (strandedFiles). A folder left out
 * here would make a library using it impossible to move.
 */
const VISIBLE_FOLDERS = [
  FOLDERS.characters,
  FOLDERS.environments,
  FOLDERS.products,
  FOLDERS.outfits,
  FOLDERS.poses,
  FOLDERS.directors,
  FOLDERS.references,
  FOLDERS.generations,
  FOLDERS.sequences,
  FOLDERS.storyboards,
  FOLDERS.ownClips,
  FOLDERS.edits
]
/** Everything 'move' takes along. */
const LIBRARY_FOLDERS = [...VISIBLE_FOLDERS, FOLDERS.appData]

const INSIDE_CURRENT = 'The folder is inside the current library. Choose a folder outside it.'
const HAS_LIBRARY = 'The folder already holds a Studio library. Open it instead.'
const NO_LIBRARY = 'The folder holds no Studio library.'
const NOTHING_TO_MOVE = 'There is no library to move.'
const OPERATION_RUNNING = LIBRARY_OPERATION_RUNNING

export interface LibraryRootDeps {
  /** Why the library can't be switched or tidied right now (generations, exports, runs). */
  busy: () => string | undefined
  /** A library has just been opened: at startup or after a switch. */
  onOpened: () => void
  /**
   * The open library was closed (its folder went missing, a switch, a failed open): what was told about it – the Dock
   * badge, Activity – must not outlive it.
   */
  onClosed?: () => void
  /** "Tidy up" finished; these generations' files or posters moved (assets and sequences may too). */
  onReorganized: (movedGenerationIds: string[]) => void
  /**
   * The open library is about to be closed by a switch: background work that writes into it (the poster
   * backfill) stops and is waited for, so nothing lands in the old folder after it has moved.
   */
  beforeClose?: () => Promise<void>
}

let deps: LibraryRootDeps = { busy: () => undefined, onOpened: () => {}, onReorganized: () => {} }
/** Why the configured folder couldn't be opened last time. */
let lastError: string | undefined
/** A switch, move or clean-up in progress; they never overlap. */
let operation = false
/** A switch or move in progress (part of `operation`). */
let switching = false

export function configureLibraryRoot(d: LibraryRootDeps): void {
  deps = d
  setRootLostHandler(() => closeLostLibrary(true))
}

// ── Small file system helpers ────────────────────────────────────────────────

const SQLITE_REASONS: [RegExp, string][] = [
  [/^SQLITE_(NOTADB|CORRUPT)/, 'the database in the folder is damaged'],
  [/^SQLITE_CANTOPEN/, 'the database could not be opened'],
  [/^SQLITE_READONLY/, 'the database cannot be written to'],
  [/^SQLITE_FULL/, 'the disk is full'],
  [/^SQLITE_(IOERR|BUSY|LOCKED)/, 'the database could not be read or written (is the disk connected?)']
]

/**
 * A message for the UI. Errors from the file system and SQLite carry English text ("EPERM: operation
 * not permitted, rename '/…' -> '/…'"); those get a short reason. Studio's own errors pass through.
 */
function message(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && code.startsWith('SQLITE_')) {
    return SQLITE_REASONS.find(([re]) => re.test(code))?.[1] ?? 'the database could not be used'
  }
  if (typeof (err as NodeJS.ErrnoException | undefined)?.syscall === 'string') {
    switch (code) {
      case 'EBUSY':
        return 'the file is in use by another program'
      case 'EROFS':
        return 'the disk is write-protected'
      case 'EEXIST':
        return 'something with the same name already exists'
      case 'ENOTEMPTY':
        return 'the folder is not empty'
      case 'ENAMETOOLONG':
        return 'the name is too long'
      case 'EIO':
      case 'ENXIO':
        return 'the disk could not be read (is it connected?)'
      default:
        return fileErrorReason(err)
    }
  }
  return err instanceof Error ? err.message : String(err)
}

/** The error as shown in the UI: a file system or SQLite error gets a reason and the file's name. */
function readableError(err: unknown, what: string): Error {
  const text = message(err)
  if (err instanceof Error && text === err.message) return err
  const path = (err as NodeJS.ErrnoException | undefined)?.path
  return new Error(`${what}: ${text}${path ? ` (“${basename(path)}”)` : ''}.`)
}

function entryExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Names in dir apart from Finder's own files; undefined when it can't be read (or isn't a folder). */
function listEntries(dir: string): string[] | undefined {
  try {
    return readdirSync(dir).filter((n) => !IGNORABLE.has(n))
  } catch {
    return undefined
  }
}

/** A folder with something in it, or anything that isn't a folder. */
function isOccupied(p: string): boolean {
  if (!entryExists(p)) return false
  if (!isDir(p)) return true
  const names = listEntries(p)
  return names === undefined || names.length > 0
}

function containsFiles(dir: string, depth: number): boolean {
  for (const name of listEntries(dir) ?? []) {
    const p = join(dir, name)
    if (isFile(p)) return true
    if (depth > 0 && isDir(p) && containsFiles(p, depth - 1)) return true
  }
  return false
}

/** Removes a folder that holds nothing but Finder's own files; never removes anything else. */
async function removeIfEmpty(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir)
    if (names.some((n) => !IGNORABLE.has(n))) return false
    for (const n of names) await rm(join(dir, n), { force: true })
    await rmdir(dir)
    return true
  } catch {
    return false
  }
}

/** Creates dir if missing and counts it in the report. */
function ensureDirCounted(dir: string, report?: ReorganizeReport): void {
  if (isDir(dir)) return
  // Inside an open library whose folder is gone, mkdir -p would bring the old base folder back.
  if (isLibraryReady() && isStrictlyInside(dir, libraryRoot())) assertRootIntact()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'there is a file with the same name' : message(err)
    throw new Error(`The folder “${basename(dir)}” could not be created in ${dirname(dir)}: ${reason}.`)
  }
  if (report) report.foldersCreated++
}

/** Real path (letter case and symlinks resolved as far as the path exists), NFC. */
function canonical(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs).normalize('NFC')
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs.normalize('NFC') : join(canonical(parent), basename(abs)).normalize('NFC')
  }
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(canonical(parent), canonical(child))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** A folder name from the database that stays inside its parent. */
function isPlainName(name: string | null | undefined): name is string {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

const lower = (s: string): string => s.normalize('NFC').toLowerCase()

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "“A”", "“A” and “B”", "“A”, “B” and “C”". */
function quotedList(names: string[]): string {
  return andList(names.map((n) => `“${n}”`))
}

function conflictMessage(names: string[]): string {
  return `The folder already contains ${quotedList(names)}. Choose an empty folder or move ${
    names.length === 1 ? 'it' : 'them'
  } away first.`
}

function newReport(): ReorganizeReport {
  return { moved: 0, missing: 0, foldersCreated: 0, errors: [] }
}

/**
 * Runs a switch, move or clean-up. They never overlap, and asset, sequence and delete work waits for them
 * (paths.libraryOperationSettled), so nothing renames or deletes files under them.
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (operation) throw new Error(OPERATION_RUNNING)
  const end = beginLibraryOperation()
  operation = true
  try {
    return await fn()
  } finally {
    operation = false
    end()
  }
}

function refuseIfBusy(): void {
  const reason = deps.busy()
  if (reason) throw new Error(reason)
}

// ── Library detection ────────────────────────────────────────────────────────

/** Phase-2 layout: studio.db directly in the folder. */
function hasLegacyDb(root: string): boolean {
  return isFile(join(root, DB_FILE_NAME))
}

function hasNewDb(root: string): boolean {
  return isFile(dbFile(root))
}

function hasLibrary(root: string): boolean {
  return hasLegacyDb(root) || hasNewDb(root)
}

function markerFile(root: string): string {
  return join(root, FOLDERS.appData, MIGRATION_MARKER)
}

/** The library from before the base folder could be chosen, if there is one and it isn't the configured one. */
function legacyLibrary(configured: string | undefined): string | undefined {
  const dir = legacyLibraryDir()
  if (configured && samePath(dir, configured)) return undefined
  return hasLibrary(dir) ? dir : undefined
}

/**
 * Whether a library database has any rows. Checked on a throwaway copy: even a read-only connection leaves
 * -shm/-wal files next to a WAL database, and a status check must not change anything in the folder.
 */
function databaseHasRows(file: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'studio-check-'))
  try {
    const copy = join(dir, DB_FILE_NAME)
    copyFileSync(file, copy)
    if (isFile(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`)
    const conn = new Database(copy, { fileMustExist: true })
    try {
      // 'characters' in a library that this version hasn't opened yet (its tables are renamed on open).
      for (const table of ['generations', 'assets', 'characters', 'prompts', 'sequences']) {
        const known = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        if (known && conn.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true
      }
      return false
    } finally {
      conn.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether a library holds anything worth taking along: rows in its database or files in its folders. */
function libraryHasContent(dir: string): boolean {
  try {
    if (databaseHasRows(hasNewDb(dir) ? dbFile(dir) : join(dir, DB_FILE_NAME))) return true
  } catch {
    // Can't tell: better to offer moving it than to leave something behind unnoticed.
    return true
  }
  return [...Object.values(LEGACY), ...VISIBLE_FOLDERS].some((name) => containsFiles(join(dir, name), 4))
}

/** What 'move' takes along: the open library, or (while none is open) the legacy one. */
function moveSource(): string | undefined {
  return isLibraryReady() ? libraryRoot() : legacyLibrary(getLibraryRoot())
}

/** Top-level folders that 'move' would collide with. */
function conflictsIn(target: string): string[] {
  return LIBRARY_FOLDERS.filter((name) => isOccupied(join(target, name)))
}

const CLOUD_SEGMENTS = [/^dropbox/i, /^google ?drive/i, /^onedrive/i, /^icloud ?drive/i]

/**
 * iCloud's "Desktop & Documents" sync keeps ~/Desktop and ~/Documents at their usual paths; it shows as
 * Desktop/Documents folders inside iCloud Drive.
 */
function inSyncedHomeFolder(p: string): boolean {
  const home = homedir()
  const iCloudDrive = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  return ['Desktop', 'Documents'].some((name) => {
    const local = join(home, name)
    return (samePath(p, local) || isStrictlyInside(p, local)) && isDir(join(iCloudDrive, name))
  })
}

function isCloudSynced(p: string): boolean {
  const paths = [resolve(p), canonical(p)]
  return (
    paths.some(
      (path) =>
        path.includes('/Library/Mobile Documents/') ||
        path.includes('/Library/CloudStorage/') ||
        path.split(sep).some((segment) => CLOUD_SEGMENTS.some((re) => re.test(segment)))
    ) || inSyncedHomeFolder(p)
  )
}

async function isWritable(target: string): Promise<boolean> {
  if (isDir(target)) {
    const probe = join(target, `.studio-skrivtest-${randomUUID()}`)
    try {
      await writeFile(probe, '', { flag: 'wx' })
      await rm(probe, { force: true })
      return true
    } catch {
      return false
    }
  }
  if (entryExists(target)) return false
  // Not created yet: possible when the nearest existing folder above it is writable.
  let dir = dirname(resolve(target))
  while (!entryExists(dir) && dirname(dir) !== dir) dir = dirname(dir)
  try {
    await access(dir, constants.W_OK)
    return isDir(dir)
  } catch {
    return false
  }
}

async function ensureWritableFolder(target: string): Promise<void> {
  try {
    await mkdir(target, { recursive: true })
  } catch (err) {
    throw new Error(`The folder “${target}” could not be created: ${message(err)}`)
  }
  if (!(await isWritable(target))) throw new Error(`Studio cannot write in “${target}”. Choose another folder.`)
}

// ── Opening and closing ──────────────────────────────────────────────────────

function closeLibrary(): void {
  try {
    db.closeDb()
  } finally {
    setActiveRoot(undefined)
    try {
      deps.onClosed?.()
    } catch (err) {
      console.warn('Announcing the closed library failed:', err)
    }
  }
}

/**
 * The open base folder disappeared (renamed or moved in Finder, a drive unplugged): the library is closed so
 * nothing recreates the old path or writes rows for files that would land there. Pending jobs stay pending
 * in its database and resume once the folder is opened again; the windows show the setup screen.
 */
function closeLostLibrary(reload: boolean): void {
  if (!isLibraryReady()) return
  console.warn(`The library folder ${libraryRoot()} is gone; closing the library.`)
  closeLibrary()
  lastError = undefined
  if (reload) reloadWindows()
}

function activate(root: string, create: boolean): void {
  setActiveRoot(root)
  try {
    db.openDb(dbFile(root), { create })
    db.relativizeStoredPaths()
  } catch (err) {
    closeLibrary()
    throw err
  }
}

/** Why a folder without a database isn't opened as a library (it is never silently made an empty one). */
function missingDatabaseMessage(root: string): string {
  return LIBRARY_FOLDERS.some((name) => isOccupied(join(root, name)))
    ? `The library database (${FOLDERS.appData}/${DB_FILE_NAME}) is missing from the folder, so Studio doesn't know ` +
        'what the files in it belong to. Was it deleted, or was the library moved? Choose the folder where the library is now.'
    : `The folder holds no Studio library. Was the library moved or renamed in ${FILE_MANAGER}? Choose the folder ` +
        'where it is now.'
}

/**
 * The folders later versions added next to Karaktärer and Sekvenser, with the schema version from which a library
 * owns each one, and what this version keeps in it.
 */
const ADDED_FOLDERS: readonly { name: string; since: number; what: string }[] = [
  { name: FOLDERS.environments, since: db.ASSETS_SCHEMA_VERSION, what: 'environments' },
  { name: FOLDERS.outfits, since: db.ASSETS_SCHEMA_VERSION, what: 'outfits' },
  { name: FOLDERS.poses, since: db.POSES_SCHEMA_VERSION, what: 'poses' },
  { name: FOLDERS.storyboards, since: db.STORYBOARDS_SCHEMA_VERSION, what: 'storyboards' },
  { name: FOLDERS.ownClips, since: db.EDITS_SCHEMA_VERSION, what: 'own clips' },
  { name: FOLDERS.edits, since: db.EDITS_SCHEMA_VERSION, what: 'edits' },
  { name: FOLDERS.products, since: db.PRODUCTS_SCHEMA_VERSION, what: 'products' },
  { name: FOLDERS.directors, since: db.DIRECTORS_SCHEMA_VERSION, what: 'directors' }
]

/**
 * A library from before one of those folders whose base folder already holds a folder of the user's own by
 * that name, e.g. Miljöer, Kläder, Poser, Storyboards, Egna klipp, Redigeringar, Produkter or Regissörer (the setup screen
 * promised that files already there are left alone): opening it would make it the library's – its paths stored
 * relative, "Move" taking it along, submits using its files in place instead of copying them into
 * Referensbilder. Refused, before anything changes, until they have renamed it.
 */
function refuseOwnAssetFolders(root: string): void {
  const occupied = ADDED_FOLDERS.filter((f) => isOccupied(join(root, f.name)))
  if (!occupied.length) return
  const version = db.schemaVersion(dbFile(root))
  const own = occupied.filter((f) => version < f.since)
  if (!own.length) return
  const one = own.length === 1
  const where = one ? 'a folder with that name' : 'folders with those names'
  throw new Error(
    `The library folder already contains ${quotedList(own.map((f) => f.name))} with files of your own. This version ` +
      `of Studio keeps ${andList(own.map((f) => f.what))} in ${where}, so rename ${one ? 'the folder' : 'the folders'} ` +
      `in ${FILE_MANAGER} and try again.`
  )
}

/** The visible folders and the hidden app data folders (every APP_DATA folder; only tmp is cleared at open). */
function ensureStructure(root: string, report?: ReorganizeReport): void {
  for (const name of VISIBLE_FOLDERS) ensureDirCounted(join(root, name), report)
  for (const name of Object.values(APP_DATA)) ensureDirCounted(join(root, FOLDERS.appData, name))
}

function clearTmp(root: string): void {
  const dir = join(root, FOLDERS.appData, APP_DATA.tmp)
  for (const name of listEntries(dir) ?? []) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
    } catch (err) {
      console.warn(`Could not clear ${join(dir, name)}:`, err)
    }
  }
}

/**
 * Half-written exports (written next to the finished film), posters, frames and stills left by a crash or a
 * force quit. Takes are never written in place (they arrive through .studio/tmp), so Tagningar is left alone.
 * Imports write their working copies next to the original in Egna klipp/<day>/, and the edit service renders
 * versions, audio and proxies in place in Redigeringar/<edit>/ (and its Ljud/ and Underlag/), so those are
 * scanned too, as are the stem and timeline caches.
 */
function removePartials(root: string): void {
  const dirs = [
    join(root, FOLDERS.appData, APP_DATA.thumbs),
    join(root, FOLDERS.appData, APP_DATA.frames),
    join(root, FOLDERS.appData, APP_DATA.stems),
    join(root, FOLDERS.appData, APP_DATA.timeline),
    ...Object.values(LEGACY).map((name) => join(root, name))
  ]
  const ownClips = join(root, FOLDERS.ownClips)
  for (const name of listEntries(ownClips) ?? []) {
    const dir = join(ownClips, name)
    if (isDir(dir)) dirs.push(dir)
  }
  const edits = join(root, FOLDERS.edits)
  for (const name of listEntries(edits) ?? []) {
    const dir = join(edits, name)
    if (!isDir(dir)) continue
    dirs.push(dir)
    for (const sub of [EDIT_FOLDERS.audio, EDIT_FOLDERS.inputs, EDIT_FOLDERS.takes]) {
      if (isDir(join(dir, sub))) dirs.push(join(dir, sub))
    }
  }
  // Sequences' and storyboards' folders hold their exports, and their Storyboard/ and Bilder/ their stills.
  for (const layout of Object.values(KIND_FOLDERS)) {
    const parent = join(root, layout.parent)
    for (const name of listEntries(parent) ?? []) {
      const dir = join(parent, name)
      if (!isDir(dir)) continue
      dirs.push(dir)
      if (isDir(join(dir, layout.stills))) dirs.push(join(dir, layout.stills))
    }
  }
  removeLeftoverPartialFiles(dirs)
}

/**
 * Opens the library in root (DB open and root active afterwards), converting a phase-2 layout first. Does not
 * run deps.onOpened. Only `create` (a new library) may create the database; otherwise a folder without one
 * is refused. Resolves with the report of a phase-2 conversion that ran (or resumed), if any.
 */
async function openLibraryAt(root: string, create = false): Promise<ReorganizeReport | undefined> {
  if (hasLegacyDb(root)) {
    if (hasNewDb(root)) {
      throw new Error(
        `The folder holds both an old Studio database (${DB_FILE_NAME}) and a new one ` +
          `(${FOLDERS.appData}/${DB_FILE_NAME}). Move one of them away and try again.`
      )
    }
    await moveLegacyDatabase(root)
  }
  // Before anything is created in the folder: a configured folder without a database is not a library (a
  // renamed library's old path, say), and an empty one created here would hide the real one.
  if (!create && !hasNewDb(root)) throw new Error(missingDatabaseMessage(root))
  // A newer Studio's library is refused before this build touches the folder (openDb refuses it too).
  if (!create && db.isNewerSchema(db.schemaVersion(dbFile(root)))) throw new Error(db.NEWER_LIBRARY_MESSAGE)
  if (!create) refuseOwnAssetFolders(root)
  ensureStructure(root)
  // On Windows a leading dot doesn't hide .studio (the database and caches) from File Explorer: an attribute does.
  hideFolderOnWindows(join(root, FOLDERS.appData))
  clearTmp(root)
  activate(root, create)
  let conversion: ReorganizeReport | undefined
  if (existsSync(markerFile(root))) {
    try {
      conversion = await finishLegacyMigration(root)
    } catch (err) {
      // The library itself is usable; the conversion picks up where it stopped next time it is opened.
      console.error(`Converting the old library layout in ${root} stopped:`, err)
      conversion = { ...newReport(), errors: [message(err)] }
    }
  }
  removePartials(root)
  return conversion
}

/**
 * Opens the configured library when it is reachable (converting a legacy layout in place, creating the
 * folders, clearing scratch files) and runs deps.onOpened. Never throws: problems end up in the status.
 * `create` is only for a switch to a new library.
 */
export async function prepareLibrary(opts: { create?: boolean } = {}): Promise<LibraryStatus> {
  const root = getLibraryRoot()
  if (isLibraryReady()) {
    if (isRootLost()) closeLostLibrary(false)
    else if (root && resolve(root).normalize('NFC') === libraryRoot()) return libraryStatus()
    else closeLibrary()
  }
  lastError = undefined
  if (!root || !isDir(root)) return libraryStatus()
  try {
    await openLibraryAt(root, opts.create)
  } catch (err) {
    closeLibrary()
    lastError = message(err)
    console.error(`Could not open the library in ${root}:`, err)
    return libraryStatus()
  }
  try {
    deps.onOpened()
  } catch (err) {
    console.error('Starting the library failed:', err)
  }
  return libraryStatus()
}

export function libraryStatus(): LibraryStatus {
  const suggested = suggestedLibraryRoot()
  if (isLibraryReady()) return { state: 'ready', root: libraryRoot(), suggested }
  const root = getLibraryRoot()
  const legacy = legacyLibrary(root)
  return {
    state: root ? 'missing' : 'unconfigured',
    root,
    suggested,
    legacy: legacy
      ? { path: legacy, hasContent: libraryHasContent(legacy), oldLayout: isOldLayout(legacy) }
      : undefined,
    error: root ? lastError : undefined
  }
}

// ── Choosing a folder ────────────────────────────────────────────────────────

/** A library in the phase-2 layout (or one whose conversion was cut short): opening it reorganizes it. */
function isOldLayout(dir: string): boolean {
  return hasLegacyDb(dir) || existsSync(markerFile(dir))
}

/** In one of the library's own folders under root, which 'move' carries along and "Tidy up" works in. */
function inLibraryFolders(target: string, root: string): boolean {
  return [...LIBRARY_FOLDERS, ...Object.values(LEGACY)].some((name) => {
    const dir = join(root, name)
    return samePath(target, dir) || isStrictlyInside(target, dir)
  })
}

/**
 * A folder inside the library 'move' would take along can't be chosen, except to open another library kept
 * there outside the library's own folders: that is the way back to a library the user left by starting a new
 * one in a folder around it ("You can switch back whenever you like").
 */
function blockedAsInside(target: string, source: string | undefined, mode?: LibraryMode): boolean {
  if (!source || !isStrictlyInside(target, source)) return false
  const openable = isDir(target) && hasLibrary(target) && !inLibraryFolders(target, source)
  return !openable || (mode !== undefined && mode !== 'open')
}

export async function inspectLibraryFolder(path: string): Promise<FolderInspection> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose a folder.')
  const target = resolve(path).normalize('NFC')
  const exists = isDir(target)
  const source = moveSource()
  return {
    path: target,
    exists,
    empty: !exists || (listEntries(target) ?? ['?']).length === 0,
    hasLibrary: exists && hasLibrary(target),
    oldLayout: exists && isOldLayout(target),
    isCurrent: isLibraryReady() && samePath(libraryRoot(), target),
    insideCurrent: blockedAsInside(target, source),
    cloudSynced: isCloudSynced(target),
    writable: await isWritable(target),
    conflicts: exists ? conflictsIn(target) : []
  }
}

/**
 * Switches the base folder. move: the current library's folders move into `path` (a legacy library is
 * converted in place first); open: use the library already there; new: start empty there, leaving the old
 * one untouched. Refused while busy, for a folder inside the current library, or one Studio can't write to.
 * Everything happens in this process: the database is closed, files move, the new library is opened and
 * deps.onOpened runs; the caller then reloads the windows.
 */
export async function setLibraryRoot(path: string, mode: LibraryMode): Promise<void> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose a folder.')
  if (mode !== 'move' && mode !== 'open' && mode !== 'new') throw new Error('Unknown way to switch library.')
  const target = resolve(path).normalize('NFC')

  await exclusive(async () => {
    switching = true
    try {
      await switchLibrary(target, mode)
    } finally {
      switching = false
    }
  })
}

async function switchLibrary(target: string, mode: LibraryMode): Promise<void> {
  // A base folder that has vanished (renamed in Finder, a drive unplugged) is closed first, so its dead
  // database handle isn't kept and choosing the same folder again reopens it.
  if (isLibraryReady() && isRootLost()) closeLostLibrary(false)
  refuseIfBusy()
  if (isLibraryReady() && samePath(libraryRoot(), target)) return
  const source = moveSource()
  if (blockedAsInside(target, source, mode)) throw new Error(INSIDE_CURRENT)
  if (entryExists(target) && !isDir(target)) throw new Error(`“${basename(target)}” is a file. Choose a folder.`)

  if (mode === 'move') {
    if (!source) throw new Error(NOTHING_TO_MOVE)
    if (!samePath(source, target)) {
      if (hasLibrary(target)) throw new Error(HAS_LIBRARY)
      const conflicts = conflictsIn(target)
      if (conflicts.length) throw new Error(conflictMessage(conflicts))
      await ensureWritableFolder(target)
      await switchByMoving(source, target)
      return
    }
    // Moving the legacy library onto itself: use it where it is.
  }
  if (mode !== 'new' && !hasLibrary(target)) throw new Error(NO_LIBRARY)
  if (mode === 'new' && hasLibrary(target)) throw new Error(HAS_LIBRARY)
  await ensureWritableFolder(target)
  await switchTo(target, mode === 'new')
}

/** Restarts the open library's background work (polling, poster backfill) after a switch was called off. */
function restartBackground(): void {
  try {
    deps.onOpened()
  } catch (err) {
    console.error('Restarting the library failed:', err)
  }
}

/**
 * Stops background work that writes into the open library (the poster backfill) before a switch closes it,
 * and checks again that nothing else is running: the awaits since the first check (the folder check, the
 * backfill's current step) leave room for a generation to start, which would then be saved into a library
 * that is closed or has moved.
 */
async function quiesceForSwitch(): Promise<void> {
  if (!isLibraryReady()) return
  await deps.beforeClose?.()
  const reason = deps.busy()
  if (reason) {
    restartBackground()
    throw new Error(reason)
  }
}

/** Opens the library in target (an empty one is only created for a new library). */
async function switchTo(target: string, create: boolean): Promise<void> {
  // Restored exactly on failure, including a phase-2 library's location that the new setting drops.
  const saved = libraryLocation()
  await quiesceForSwitch()
  closeLibrary()
  try {
    setLibraryRootSetting(target)
  } catch (err) {
    await prepareLibrary()
    throw new Error(`The setting could not be saved: ${message(err)}`)
  }
  const status = await prepareLibrary({ create })
  if (status.state === 'ready') return
  const reason = status.error ?? 'The folder could not be reached.'
  // Go back to the library that was in use, so a failed switch doesn't leave Studio without one.
  try {
    restoreLibraryLocation(saved)
  } catch (err) {
    console.error('Could not restore the library setting:', err)
  }
  await prepareLibrary()
  throw new Error(`The library could not be opened: ${reason}`)
}

interface MovedFolders {
  /** Removes what is left in the old place (copies across volumes). */
  commit: () => Promise<void>
  /** Puts everything back as it was. */
  rollback: () => Promise<void>
}

/** Modification times on FAT/exFAT drives are only kept to 2 s (and copies get them to the millisecond). */
const MTIME_SLACK_MS = 2000

/**
 * Removes the originals of a verified copy (src copied to dest), entry by entry and only where the copy
 * still matches: same kind, size and modification time. Anything added to or changed in src after it was
 * copied (the user working in Finder during a long copy, a sync client) stays where it is and is listed in
 * kept, together with every folder still holding something.
 */
async function removeCopiedOriginal(src: string, dest: string, kept: string[]): Promise<void> {
  let a: Stats
  try {
    a = await lstat(src)
  } catch {
    return
  }
  if (a.isDirectory()) {
    let names: string[]
    try {
      names = await readdir(src)
    } catch {
      kept.push(src)
      return
    }
    for (const name of names) {
      if (!IGNORABLE.has(name)) await removeCopiedOriginal(join(src, name), join(dest, name), kept)
    }
    await removeIfEmpty(src)
    return
  }
  const b = await lstat(dest).catch(() => undefined)
  const same =
    !!b &&
    (a.isFile()
      ? b.isFile() && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < MTIME_SLACK_MS
      : a.isSymbolicLink() && b.isSymbolicLink())
  if (!same) {
    kept.push(src)
    return
  }
  await rm(src, { force: true }).catch((e: unknown) => {
    console.warn(`Could not remove ${src} after copying it:`, e)
    kept.push(src)
  })
}

/**
 * Moves the library folders from source into target. On the same volume each folder is renamed (instant);
 * across volumes everything is copied and verified first and the originals are only removed by commit().
 * A failure part-way puts back what was already moved.
 */
async function moveLibraryFolders(source: string, target: string): Promise<MovedFolders> {
  const names = LIBRARY_FOLDERS.filter((name) => entryExists(join(source, name)))
  await mkdir(target, { recursive: true })
  for (const name of names) {
    const dest = join(target, name)
    // An empty folder of the same name gives way; anything else was refused before the library was closed.
    if (entryExists(dest) && !(await removeIfEmpty(dest))) throw new Error(conflictMessage([name]))
  }

  let sameVolume: boolean
  try {
    sameVolume = statSync(source).dev === statSync(target).dev
  } catch {
    sameVolume = false
  }

  if (sameVolume) {
    const moved: string[] = []
    const putBack = async (): Promise<void> => {
      for (const name of [...moved].reverse()) {
        await movePath(join(target, name), join(source, name)).catch((e: unknown) =>
          console.error(`Could not move ${name} back to ${source}:`, e)
        )
      }
    }
    try {
      for (const name of names) {
        await movePath(join(source, name), join(target, name))
        moved.push(name)
      }
    } catch (err) {
      await putBack()
      throw err
    }
    return { commit: async () => {}, rollback: putBack }
  }

  const copied: string[] = []
  const removeCopies = async (): Promise<void> => {
    for (const name of copied) {
      await rm(join(target, name), { recursive: true, force: true }).catch((e: unknown) =>
        console.error(`Could not remove the copy ${join(target, name)}:`, e)
      )
    }
  }
  try {
    for (const name of names) {
      await copyPathVerified(join(source, name), join(target, name))
      copied.push(name)
    }
  } catch (err) {
    await removeCopies()
    throw err
  }
  return {
    commit: async () => {
      // Not rm -rf: the copy of each folder was verified minutes ago, and Finder isn't blocked meanwhile.
      const kept: string[] = []
      for (const name of names) await removeCopiedOriginal(join(source, name), join(target, name), kept)
      if (kept.length) {
        console.warn(`The library was copied to ${target}; these changed or appeared afterwards and stay in ${source}:`, kept)
      }
    },
    rollback: removeCopies
  }
}

/**
 * Every stored path to a file the database tracks itself: videos, imports' originals, posters, asset photos and
 * audio, edit media, stills, storyboard board images, exports.
 */
function trackedFilePaths(): string[] {
  return db
    .getDb()
    .prepare(
      `SELECT file_path FROM generations WHERE file_path IS NOT NULL
       UNION ALL SELECT original_path FROM generations WHERE original_path IS NOT NULL
       UNION ALL SELECT thumb_path FROM generations WHERE thumb_path IS NOT NULL
       UNION ALL SELECT file_path FROM edit_media
       UNION ALL SELECT file_path FROM asset_images
       UNION ALL SELECT file_path FROM asset_audio
       UNION ALL SELECT file_path FROM stills
       UNION ALL SELECT image_path FROM storyboard_boards WHERE image_path IS NOT NULL
       UNION ALL SELECT file_path FROM exports`
    )
    .pluck()
    .all() as string[]
}

/** In the open library: names of tracked files that lie outside its current folders, where 'move' leaves them. */
function strandedFiles(root: string): string[] {
  const own = new Set<string>(LIBRARY_FOLDERS)
  const names = new Set<string>()
  for (const p of trackedFilePaths()) {
    if (isAbsolute(p) || own.has(p.normalize('NFC').split('/')[0])) continue
    if (entryExists(join(root, p))) names.add(basename(p))
  }
  return [...names]
}

/**
 * Why the open library in root can't be moved yet: a phase-2 conversion that didn't finish (a file locked in
 * Finder, say), so files still lie in the old-layout folders, which 'move' doesn't take along. Moved anyway,
 * their rows would point into the new folder while the files stay behind.
 */
function unmovableReason(root: string, conversion?: ReorganizeReport): string | undefined {
  const stranded = strandedFiles(root)
  if (!stranded.length && !existsSync(markerFile(root))) return undefined
  const examples = conversion?.errors.length
    ? [...new Set(conversion.errors)].slice(0, 3).join('; ')
    : stranded.length
      ? quotedList(stranded.slice(0, 3)) + (stranded.length > 3 ? ' and more' : '')
      : undefined
  return (
    'The library cannot be moved yet: some files from the earlier version of Studio could not be sorted into ' +
    `the new folders${examples ? ` (${examples})` : ''}. ` +
    (IS_WINDOWS
      ? 'If they are read-only (Properties → Read-only in File Explorer), clear that and try again. '
      : 'If they are locked in Finder (Get Info → Locked), unlock them and try again. ') +
    'Nothing has been moved.'
  )
}

/**
 * Picture paths in params that point into the base folder outside its library folders (left in an
 * old-layout folder) become absolute, so they keep pointing at the files, which stay in the old folder.
 */
function pinPathsLeftBehind(root: string): void {
  const own = new Set<string>(LIBRARY_FOLDERS)
  db.mapStoredPaths((p) => (isAbsolute(p) || own.has(p.normalize('NFC').split('/')[0]) ? p : join(root, p)))
}

async function switchByMoving(source: string, target: string): Promise<void> {
  // Restored exactly on failure, including a phase-2 library's location that the new setting drops.
  const saved = libraryLocation()
  const wasOpen = isLibraryReady()
  const reopenPrevious = async (): Promise<void> => {
    closeLibrary()
    try {
      restoreLibraryLocation(saved)
    } catch (err) {
      console.error('Could not restore the library setting:', err)
    }
    if (wasOpen) await prepareLibrary()
  }

  await quiesceForSwitch()
  let moved: MovedFolders
  try {
    let conversion: ReorganizeReport | undefined
    if (!wasOpen || isOldLayout(source)) {
      // A phase-2 library is converted where it is first (a cut-short conversion resumes), so only the new
      // layout's folders have to move.
      closeLibrary()
      conversion = await openLibraryAt(source)
    }
    const reason = unmovableReason(source, conversion)
    if (!reason) pinPathsLeftBehind(source)
    closeLibrary()
    if (reason) throw new Error(reason)
    moved = await moveLibraryFolders(source, target)
  } catch (err) {
    await reopenPrevious()
    throw readableError(err, 'The library could not be moved, nothing has changed')
  }

  let failure: string | undefined
  try {
    setLibraryRootSetting(target)
    const status = await prepareLibrary()
    if (status.state !== 'ready') failure = `The library could not be opened in the new folder: ${status.error ?? 'unknown error'}`
  } catch (err) {
    failure = `The setting could not be saved: ${message(err)}`
  }
  if (failure) {
    closeLibrary()
    await moved.rollback()
    await reopenPrevious()
    throw new Error(failure)
  }
  await moved.commit()
  // The old base folder goes only if nothing else was kept in it.
  await removeIfEmpty(source)
}

// ── Converting a phase-2 library ─────────────────────────────────────────────

/** Opens the database once so a WAL or hot journal is folded into studio.db and a single file has to move. */
function checkpointLegacyDb(file: string): void {
  const conn = new Database(file, { fileMustExist: true })
  try {
    conn.prepare('SELECT count(*) FROM sqlite_master').get()
    conn.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    conn.close()
  }
}

/** studio.db → .studio/studio.db, leaving a marker so the rest of the conversion runs (or resumes). */
async function moveLegacyDatabase(root: string): Promise<void> {
  const legacyDb = join(root, DB_FILE_NAME)
  checkpointLegacyDb(legacyDb)
  const appData = join(root, FOLDERS.appData)
  await mkdir(appData, { recursive: true })
  await writeFile(markerFile(root), `${JSON.stringify({ startedAt: new Date().toISOString() })}\n`)
  const moved: [string, string][] = []
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const from = legacyDb + suffix
      if (!entryExists(from)) continue
      const to = join(appData, DB_FILE_NAME + suffix)
      await movePath(from, to)
      moved.push([from, to])
    }
  } catch (err) {
    for (const [from, to] of moved.reverse()) {
      await movePath(to, from).catch((e: unknown) => console.error(`Could not move ${to} back to ${from}:`, e))
    }
    await rm(markerFile(root), { force: true }).catch(() => {})
    throw err
  }
}

/** Files a phase-2 library put in its folders itself; group 1 is that library's folder. */
const LEGACY_FILE_PATTERNS = [
  /^(\/.*)\/(?:generations|thumbs)\/[^/]+$/,
  // A character photo: characters/<character id>/<image id>.<ext>
  /^(\/.*)\/characters\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.\w+$/i
]

/**
 * Phase-2 libraries stored absolute paths (<old root>/generations/…, /thumbs/…, /characters/…, /frames/…).
 * Inside the folder they are made relative on open; this handles a phase-2 library that was moved or copied
 * by hand, whose paths still point at the old place: they are pointed at the files in this folder when those
 * exist. Files at the old place are never touched.
 */
function rebaseLegacyPaths(root: string): void {
  const conn = db.getDb()
  const stored = conn
    .prepare(
      `SELECT file_path FROM generations WHERE file_path IS NOT NULL
       UNION SELECT thumb_path FROM generations WHERE thumb_path IS NOT NULL
       UNION SELECT file_path FROM asset_images`
    )
    .pluck()
    .all() as string[]
  const oldRoots = new Set<string>()
  for (const p of stored) {
    for (const pattern of LEGACY_FILE_PATTERNS) {
      const m = pattern.exec(p)
      if (m && m[1] !== root) oldRoots.add(m[1])
    }
  }
  if (!oldRoots.size) return
  const legacyFolders = new Set<string>(Object.values(LEGACY))
  db.mapStoredPaths((p) => {
    if (!isAbsolute(p)) return p
    for (const oldRoot of oldRoots) {
      if (!p.startsWith(`${oldRoot}/`)) continue
      const rel = p.slice(oldRoot.length + 1)
      if (legacyFolders.has(rel.split('/')[0]) && existsSync(join(root, rel))) return rel
    }
    return p
  })
}

/** Name of the folder under Sekvenser for phase-2 exports, avoiding a sequence's own folder. */
function legacyExportsFolder(): string {
  const taken = new Set(
    (
      db
        .getDb()
        .prepare(`SELECT folder FROM sequences WHERE folder IS NOT NULL AND kind = 'sequence'`)
        .pluck()
        .all() as string[]
    ).map(lower)
  )
  for (let n = 1; ; n++) {
    const name = n === 1 ? LEGACY_EXPORTS_FOLDER : `${LEGACY_EXPORTS_FOLDER} (${n})`
    if (!taken.has(lower(name))) return name
  }
}

/**
 * Moves the files directly in srcDir into the folder target() picks for each (database references follow).
 * For files nothing refers to any more: those the database knows about have been moved already.
 */
async function moveLooseFiles(
  srcDir: string,
  report: ReorganizeReport,
  target: (name: string, stats: Stats) => string,
  opts: { count?: boolean; onMoved?: (dest: string, stats: Stats) => void } = {}
): Promise<void> {
  for (const name of listEntries(srcDir) ?? []) {
    const abs = join(srcDir, name)
    let stats: Stats
    try {
      stats = lstatSync(abs)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    try {
      const dir = target(name, stats)
      ensureDirCounted(dir, opts.count === false ? undefined : report)
      await relocate(abs, dir, report, {
        count: opts.count,
        inTransaction: opts.onMoved && ((dest) => opts.onMoved!(dest, stats))
      })
    } catch (err) {
      report.errors.push(`${name}: ${message(err)}`)
    }
  }
}

/** characters/<id>/ leftovers go into that character's folder; folders of unknown characters stay. */
async function moveLooseCharacterFiles(dir: string, report: ReorganizeReport): Promise<void> {
  const conn = db.getDb()
  const find = conn.prepare('SELECT kind, folder FROM assets WHERE id = ?')
  for (const id of listEntries(dir) ?? []) {
    const sub = join(dir, id)
    if (!isDir(sub)) continue
    const row = find.get(id) as { kind: string; folder: string | null } | undefined
    if (row && isAssetKind(row.kind) && isPlainName(row.folder)) {
      const target = join(libraryRoot(), ASSET_FOLDERS[row.kind], row.folder)
      await moveLooseFiles(sub, report, () => target)
    }
    await removeIfEmpty(sub)
  }
}

/**
 * The rest of a phase-2 conversion, with the database already in .studio and open: every file moves into
 * the new layout. Safe to run again after an interruption; the marker is removed once nothing failed.
 */
async function finishLegacyMigration(root: string): Promise<ReorganizeReport> {
  const report = newReport()
  const legacy = (name: string): string => join(root, name)
  removeLeftoverPartialFiles(Object.values(LEGACY).map(legacy))
  rebaseLegacyPaths(root)

  // Continuation frames first: the params of takes point at them.
  await moveLooseFiles(legacy(LEGACY.frames), report, () => join(root, FOLDERS.appData, APP_DATA.frames), {
    count: false
  })
  await reorganizeTracked(report)

  const exportsDir = join(root, FOLDERS.sequences, legacyExportsFolder())
  const insertExport = db
    .getDb()
    .prepare('INSERT INTO exports (id, sequence_id, file_path, created_at) VALUES (?, NULL, ?, ?)')
  await moveLooseFiles(legacy(LEGACY.exports), report, () => exportsDir, {
    onMoved: (dest, stats) => insertExport.run(randomUUID(), toStoredPath(dest), Math.round(stats.mtimeMs))
  })
  await moveLooseFiles(legacy(LEGACY.thumbs), report, () => join(root, FOLDERS.appData, APP_DATA.thumbs), {
    count: false
  })
  // Videos the database has forgotten are still the user's: they go by their date like every other generation.
  await moveLooseFiles(legacy(LEGACY.generations), report, (_name, stats) =>
    join(root, FOLDERS.generations, dayStamp(stats.mtime))
  )
  await moveLooseCharacterFiles(legacy(LEGACY.characters), report)

  for (const name of Object.values(LEGACY)) await removeIfEmpty(legacy(name))
  const kept = Object.values(LEGACY).filter((name) => entryExists(legacy(name)))
  // Kept while a tracked file still lies in an old-layout folder: the conversion then resumes on the next
  // open, and a 'move' (which only takes the new folders along) refuses to leave the file behind.
  if (!report.errors.length && !strandedFiles(root).length) await rm(markerFile(root), { force: true })
  console.info(
    `Converted the old library layout in ${root}:`,
    report,
    kept.length ? `(kept non-empty: ${kept.join(', ')})` : ''
  )
  return report
}

// ── Tidy up ──────────────────────────────────────────────────────────────────

/**
 * Moves abs into dir (as base + its extension when given) and rewrites every stored path that pointed at it,
 * in one transaction together with `inTransaction`; on a database failure the file goes back. A file already
 * in dir stays put unless renameInPlace asks for the new name.
 */
async function relocate(
  abs: string,
  dir: string,
  report: ReorganizeReport,
  opts: {
    base?: string
    renameInPlace?: boolean
    count?: boolean
    inTransaction?: (dest: string) => void
    /**
     * For a tracked file: whether its row still exists. One deleted while the file moved (the delete trashed
     * the old path, which was already empty) has its file trashed here, as the delete would have.
     */
    stillTracked?: () => boolean
  } = {}
): Promise<string> {
  const sameDir = dirname(abs).normalize('NFC') === resolve(dir).normalize('NFC')
  let dest: string
  if (sameDir) {
    const ext = extname(abs)
    if (!opts.renameInPlace || !opts.base || basename(abs, ext) === opts.base) {
      if (opts.inTransaction) db.getDb().transaction(() => opts.inTransaction!(abs))()
      return abs
    }
    dest = join(dir, uniqueName(dir, opts.base, ext))
    await movePath(abs, dest)
  } else {
    dest = await moveFileInto(abs, dir, opts.base)
  }
  let gone = false
  try {
    db.getDb().transaction(() => {
      gone = !!opts.stillTracked && !opts.stillTracked()
      if (gone) return
      db.rewriteStoredPrefix(toStoredPath(abs), toStoredPath(dest))
      opts.inTransaction?.(dest)
    })()
  } catch (err) {
    await movePath(dest, abs).catch((e: unknown) => console.error(`Could not move ${dest} back to ${abs}:`, e))
    throw err
  }
  if (gone) {
    await shell.trashItem(dest).catch((err: unknown) => console.warn(`Could not move ${dest} to the trash:`, err))
    return dest
  }
  if (opts.count !== false) report.moved++
  return dest
}

/**
 * What owns a folder: an asset (in the folder of its kind: Karaktärer, Miljöer, Produkter, Kläder, Poser or Regissörer), a
 * sequence (in Sekvenser), a storyboard (in Storyboards) or an edit (in Redigeringar). Folder names only have to be
 * unique among owners that share a parent folder.
 */
type FolderOwner =
  | { table: 'assets'; kind: AssetKind }
  | { table: 'sequences'; kind: SequenceKind }
  | { table: 'edits' }

const sequenceOwner = (kind: unknown): FolderOwner => ({ table: 'sequences', kind: sequenceKindOf(kind) })

/** The folder that holds the owners' own folders. */
function ownerParent(owner: FolderOwner): string {
  if (owner.table === 'edits') return join(libraryRoot(), FOLDERS.edits)
  return join(libraryRoot(), owner.table === 'assets' ? ASSET_FOLDERS[owner.kind] : KIND_FOLDERS[owner.kind].parent)
}

interface EntityRow {
  id: string
  name: string
  folder: string | null
}

/** "Anna" follows the name "Anna"; so does "Anna (2)", given when "Anna" was taken. */
function followsName(folder: string, desired: string): boolean {
  const f = folder.normalize('NFC')
  const d = desired.normalize('NFC')
  if (f === d || !f.startsWith(`${d} (`)) return f === d
  return /^ \(\d+\)$/.test(f.slice(d.length))
}

/** Folder names other rows with the same parent folder have claimed (their folder may be missing on disk). */
function claimedFolders(owner: FolderOwner, selfId: string): Set<string> {
  const conn = db.getDb()
  const names =
    owner.table === 'edits'
      ? conn.prepare('SELECT folder FROM edits WHERE folder IS NOT NULL AND id != ?').pluck().all(selfId)
      : owner.table === 'assets'
        ? conn
            .prepare('SELECT folder FROM assets WHERE kind = ? AND folder IS NOT NULL AND id != ?')
            .pluck()
            .all(owner.kind, selfId)
        : (conn.prepare('SELECT folder, kind FROM sequences WHERE folder IS NOT NULL AND id != ?').all(selfId) as {
            folder: string
            kind: string
          }[])
            .filter((r) => sequenceKindOf(r.kind) === owner.kind)
            .map((r) => r.folder)
  return new Set((names as string[]).map(lower))
}

/**
 * A folder name under parent that neither exists on disk, nor belongs to another row, nor is still recorded
 * in generations or clips (a deleted asset's photos they used): a folder moved there would put its own
 * same-named files at those paths.
 */
function freeFolderName(owner: FolderOwner, parent: string, desired: string, selfId: string): string {
  const taken = claimedFolders(owner, selfId)
  for (let n = 1; ; n++) {
    const name = n === 1 ? desired : `${desired} (${n})`
    const path = join(parent, name)
    if (!taken.has(lower(name)) && !entryExists(path) && !folderRecordedInDb(path)) return name
  }
}

/**
 * The asset's or sequence's folder: assigned when missing (rows from before folders), renamed when it no
 * longer follows the name (e.g. a rename during an export), created on disk when gone.
 */
async function ensureEntityFolder(owner: FolderOwner, row: EntityRow, report: ReorganizeReport): Promise<string> {
  const conn = db.getDb()
  const parent = ownerParent(owner)
  ensureDirCounted(parent, report)
  const fallback =
    owner.table === 'edits'
      ? UNNAMED_EDIT
      : owner.table === 'assets'
        ? UNNAMED_ASSET
        : owner.kind === 'storyboard'
          ? UNNAMED_STORYBOARD
          : UNNAMED_SEQUENCE
  const desired = safeName(row.name, { fallback })
  const record = (folder: string) => (): void => {
    conn.prepare(`UPDATE ${owner.table} SET folder = ? WHERE id = ?`).run(folder, row.id)
  }

  let folder = isPlainName(row.folder) ? row.folder : undefined
  if (folder && !followsName(folder, desired)) {
    const next = lower(folder) === lower(desired) ? desired : freeFolderName(owner, parent, desired, row.id)
    try {
      await renameLibraryFolder(join(parent, folder), join(parent, next), record(next))
      folder = next
    } catch (err) {
      report.errors.push(`The folder “${folder}” could not be renamed to “${next}”: ${message(err)}`)
    }
  }
  if (!folder) {
    folder = freeFolderName(owner, parent, desired, row.id)
    record(folder)()
  }
  ensureDirCounted(join(parent, folder), report)
  if (owner.table === 'sequences') ensureDirCounted(join(parent, folder, KIND_FOLDERS[owner.kind].takes), report)
  row.folder = folder
  return folder
}

async function writeDescriptionIfMissing(dir: string, description: string): Promise<void> {
  const text = description.trim()
  if (!text) return
  try {
    await writeFile(join(dir, DESCRIPTION_FILE), `${text}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') console.warn(`Could not write ${DESCRIPTION_FILE}:`, err)
  }
}

/** How a report names an asset of each kind: "The character “Anna”: …". */
const ASSET_LABELS: Readonly<Record<AssetKind, string>> = {
  character: 'The character',
  environment: 'The environment',
  product: 'The product',
  outfit: 'The outfit',
  pose: 'The pose',
  director: 'The director'
}

/**
 * Folder, photos, audio clips and description file of one character, environment, product, outfit or pose: everything
 * goes into <folder of its kind>/<its folder>/. Returns its folder name; undefined when the row is gone, or of
 * a kind this version doesn't know (a library opened by a newer Studio), whose files are left where they are.
 */
async function tidyAsset(id: string, report: ReorganizeReport): Promise<string | undefined> {
  const conn = db.getDb()
  const row = conn.prepare('SELECT id, kind, name, description, folder FROM assets WHERE id = ?').get(id) as
    | (EntityRow & { kind: string; description: string })
    | undefined
  if (!row || !isAssetKind(row.kind)) return undefined
  const owner: FolderOwner = { table: 'assets', kind: row.kind }
  const folder = await ensureEntityFolder(owner, row, report)
  const dir = join(ownerParent(owner), folder)
  const label = safeName(row.name, { fallback: UNNAMED_ASSET })
  const images = conn
    .prepare('SELECT id, file_path FROM asset_images WHERE asset_id = ? ORDER BY position, created_at')
    .all(id) as { id: string; file_path: string }[]
  const imageExists = conn.prepare('SELECT 1 FROM asset_images WHERE id = ?')

  for (const [index, image] of images.entries()) {
    const abs = fromStoredPath(image.file_path)
    // Files outside the library are the user's own; they are never moved.
    if (!isInsideRoot(abs)) continue
    if (!isFile(abs)) {
      report.missing++
      continue
    }
    // Phase-2 copies were named after their row id; they get readable names.
    const idNamed = basename(abs, extname(abs)) === image.id
    try {
      await relocate(abs, dir, report, {
        base: idNamed ? `${label} ${index + 1}` : undefined,
        renameInPlace: idNamed,
        stillTracked: () => !!imageExists.get(image.id)
      })
    } catch (err) {
      report.errors.push(`${basename(abs)}: ${message(err)}`)
    }
  }

  // Audio clips keep their own (original) names; generations and clips that send one follow its move.
  const clips = conn
    .prepare('SELECT id, file_path FROM asset_audio WHERE asset_id = ? ORDER BY position, created_at')
    .all(id) as { id: string; file_path: string }[]
  const clipExists = conn.prepare('SELECT 1 FROM asset_audio WHERE id = ?')
  for (const clip of clips) {
    const abs = fromStoredPath(clip.file_path)
    if (!isInsideRoot(abs)) continue
    if (!isFile(abs)) {
      report.missing++
      continue
    }
    try {
      await relocate(abs, dir, report, { stillTracked: () => !!clipExists.get(clip.id) })
    } catch (err) {
      report.errors.push(`${basename(abs)}: ${message(err)}`)
    }
  }

  // A director's style videos (assets.direction) keep their own names too; their stored paths follow the move.
  if (row.kind === 'director') {
    for (const stored of styleVideoPathsOf(id)) {
      const abs = fromStoredPath(stored)
      if (!isInsideRoot(abs)) continue
      if (!isFile(abs)) {
        report.missing++
        continue
      }
      try {
        await relocate(abs, dir, report, { stillTracked: () => styleVideoPathsOf(id).includes(toStoredPath(abs)) })
      } catch (err) {
        report.errors.push(`${basename(abs)}: ${message(err)}`)
      }
    }
  }
  await writeDescriptionIfMissing(dir, row.description)
  return folder
}

/** The stored paths of a director's style videos (assets.direction), as the row has them now. */
function styleVideoPathsOf(id: string): string[] {
  const json = db.getDb().prepare('SELECT direction FROM assets WHERE id = ?').pluck().get(id) as string | null | undefined
  if (typeof json !== 'string' || !json) return []
  try {
    const videos = (JSON.parse(json) as { videos?: unknown } | null)?.videos
    return Array.isArray(videos)
      ? videos
          .map((v: unknown) => (v && typeof v === 'object' ? (v as { path?: unknown }).path : undefined))
          .filter((p): p is string => typeof p === 'string' && p !== '')
      : []
  } catch {
    return []
  }
}

/**
 * Every file of the generations to its home by the file home rule (jobs.videoHome): Venice's takes into Tagningar
 * (a transition's into its storyboard's Övergångar) or back to Genereringar when free; the user's own clips into
 * Egna klipp/<day>/ (the untouched original next to its working copy), even when they are takes; edit versions
 * and AI takes made in the Editor into the edit's folder (and its Tagningar). Imports and versions are never named
 * after an empty prompt or moved into Tagningar. Then posters; `only` limits it to some ids.
 */
async function tidyGenerations(report: ReorganizeReport, only?: Set<string>): Promise<void> {
  const conn = db.getDb()
  const root = libraryRoot()
  const ids = conn.prepare('SELECT id FROM generations ORDER BY created_at').pluck().all() as string[]
  const stillTracked = (id: string) => (): boolean => !!db.getGeneration(id)

  for (const id of ids) {
    if (only && !only.has(id)) continue
    // Re-read: an earlier move may have rewritten this row's paths too. Folder names are looked up per
    // generation (in videoHome), not once up front: they must be the ones current at each move.
    let g = db.getGeneration(id)
    if (!g) continue
    if (g.filePath && isInsideRoot(g.filePath)) {
      if (!isFile(g.filePath)) {
        if (g.status === 'completed') report.missing++
      } else {
        try {
          const { dir, base } = videoHome(g)
          if (dirname(g.filePath) !== dir) ensureDirCounted(dir, report)
          await relocate(g.filePath, dir, report, { base, stillTracked: stillTracked(g.id) })
        } catch (err) {
          report.errors.push(`${basename(g.filePath)}: ${message(err)}`)
        }
      }
    }
    // An import's untouched original (its file is then a working copy) lives next to the working copy.
    g = db.getGeneration(id)
    if (g?.originalPath && isInsideRoot(g.originalPath)) {
      if (!isFile(g.originalPath)) {
        report.missing++
      } else {
        try {
          const home = originalHome(g)
          if (home) {
            if (dirname(g.originalPath) !== home.dir) ensureDirCounted(home.dir, report)
            await relocate(g.originalPath, home.dir, report, { base: home.base, stillTracked: stillTracked(g.id) })
          }
        } catch (err) {
          report.errors.push(`${basename(g.originalPath)}: ${message(err)}`)
        }
      }
    }
    if (!g) continue
    if (g.thumbPath && isInsideRoot(g.thumbPath) && isFile(g.thumbPath)) {
      try {
        const dir = join(root, FOLDERS.appData, APP_DATA.thumbs)
        ensureDirCounted(dir)
        await relocate(g.thumbPath, dir, report, { base: g.id, count: false, stillTracked: stillTracked(g.id) })
      } catch (err) {
        report.errors.push(`${basename(g.thumbPath)}: ${message(err)}`)
      }
    }
  }
}

/**
 * Each edit's audio (converted voices, spoken lines, music, effects, added files, rendered beds) into its Ljud/
 * folder, keeping their names; `editId` limits it to one edit's.
 */
async function tidyEditMedia(report: ReorganizeReport, editId?: string): Promise<void> {
  const conn = db.getDb()
  const rows = conn
    .prepare(
      `SELECT m.id, e.folder FROM edit_media m JOIN edits e ON e.id = m.edit_id
       WHERE ? IS NULL OR m.edit_id = ? ORDER BY m.created_at`
    )
    .all(editId ?? null, editId ?? null) as { id: string; folder: string | null }[]
  const mediaExists = conn.prepare('SELECT 1 FROM edit_media WHERE id = ?')
  for (const r of rows) {
    // Re-read: an earlier move may have rewritten this row's path.
    const stored = conn.prepare('SELECT file_path FROM edit_media WHERE id = ?').pluck().get(r.id) as
      | string
      | undefined
    if (!stored) continue
    const abs = fromStoredPath(stored)
    if (!isInsideRoot(abs)) continue
    if (!isFile(abs)) {
      report.missing++
      continue
    }
    if (!isPlainName(r.folder)) continue
    try {
      const dir = join(libraryRoot(), FOLDERS.edits, r.folder, EDIT_FOLDERS.audio)
      if (dirname(abs) !== dir) ensureDirCounted(dir, report)
      await relocate(abs, dir, report, { stillTracked: () => !!mediaExists.get(r.id) })
    } catch (err) {
      report.errors.push(`${basename(abs)}: ${message(err)}`)
    }
  }
}

/** Finished films into their sequence's (storyboard's) folder; those of deleted ones stay where they are. */
async function tidyExports(report: ReorganizeReport, sequenceId?: string): Promise<void> {
  const rows = db
    .getDb()
    .prepare(
      `SELECT e.id, e.file_path, q.folder, q.kind FROM exports e LEFT JOIN sequences q ON q.id = e.sequence_id
       WHERE ? IS NULL OR e.sequence_id = ?`
    )
    .all(sequenceId ?? null, sequenceId ?? null) as {
    id: string
    file_path: string
    folder: string | null
    kind: string | null
  }[]
  for (const r of rows) {
    const abs = fromStoredPath(r.file_path)
    if (!isInsideRoot(abs)) continue
    if (!isFile(abs)) {
      report.missing++
      continue
    }
    if (!isPlainName(r.folder)) continue
    try {
      const dir = join(libraryRoot(), KIND_FOLDERS[sequenceKindOf(r.kind)].parent, r.folder)
      ensureDirCounted(dir, report)
      await relocate(abs, dir, report, {
        stillTracked: () => !!db.getDb().prepare('SELECT 1 FROM exports WHERE id = ?').get(r.id)
      })
    } catch (err) {
      report.errors.push(`${basename(abs)}: ${message(err)}`)
    }
  }
}

/**
 * Stills into their sequence's Storyboard/ (their storyboard's Bilder/), or Referensbilder/<the day they were made>/
 * when they belong to neither (any more); `sequenceId` limits it to one sequence's. They keep their names:
 * generations, clips and boards that use one as a start, end, reference or board image follow it.
 */
async function tidyStills(report: ReorganizeReport, sequenceId?: string): Promise<void> {
  const conn = db.getDb()
  const rows = conn
    .prepare(
      `SELECT t.id, t.file_path, t.created_at, q.folder, q.kind FROM stills t
       LEFT JOIN sequences q ON q.id = t.sequence_id
       WHERE ? IS NULL OR t.sequence_id = ? ORDER BY t.created_at`
    )
    .all(sequenceId ?? null, sequenceId ?? null) as {
    id: string
    file_path: string
    created_at: number
    folder: string | null
    kind: string | null
  }[]
  const stillExists = conn.prepare('SELECT 1 FROM stills WHERE id = ?')
  for (const r of rows) {
    // Re-read: an earlier move (a still another one was made from) may have rewritten this row's path.
    const stored = conn.prepare('SELECT file_path FROM stills WHERE id = ?').pluck().get(r.id) as string | undefined
    if (!stored) continue
    const abs = fromStoredPath(stored)
    if (!isInsideRoot(abs)) continue
    if (!isFile(abs)) {
      report.missing++
      continue
    }
    try {
      const layout = KIND_FOLDERS[sequenceKindOf(r.kind)]
      const dir = isPlainName(r.folder)
        ? join(libraryRoot(), layout.parent, r.folder, layout.stills)
        : join(libraryRoot(), FOLDERS.references, dayStamp(new Date(r.created_at)))
      if (dirname(abs) !== dir) ensureDirCounted(dir, report)
      await relocate(abs, dir, report, { stillTracked: () => !!stillExists.get(r.id) })
    } catch (err) {
      report.errors.push(`${basename(abs)}: ${message(err)}`)
    }
  }
}

/** Folder of one sequence (or storyboard) plus its takes, stills and exports. Returns its folder name. */
async function tidySequence(id: string, report: ReorganizeReport): Promise<string | undefined> {
  const conn = db.getDb()
  const row = conn.prepare('SELECT id, name, folder, kind FROM sequences WHERE id = ?').get(id) as
    | (EntityRow & { kind: string })
    | undefined
  if (!row) return undefined
  const folder = await ensureEntityFolder(sequenceOwner(row.kind), row, report)
  const takes = conn
    .prepare('SELECT g.id FROM generations g JOIN segments s ON s.id = g.segment_id WHERE s.sequence_id = ?')
    .pluck()
    .all(id) as string[]
  await tidyGenerations(report, new Set(takes))
  await tidyStills(report, id)
  await tidyExports(report, id)
  return folder
}

/** Every file the database knows about, in its canonical place. */
async function reorganizeTracked(report: ReorganizeReport): Promise<void> {
  const conn = db.getDb()
  const assets = conn.prepare('SELECT id, kind, name FROM assets ORDER BY created_at').all() as {
    id: string
    kind: string
    name: string
  }[]
  for (const r of assets) {
    try {
      await tidyAsset(r.id, report)
    } catch (err) {
      const label = isAssetKind(r.kind) ? ASSET_LABELS[r.kind] : 'The item'
      report.errors.push(`${label} “${r.name}”: ${message(err)}`)
    }
  }
  const sequences = conn
    .prepare('SELECT id, name, folder, kind FROM sequences ORDER BY created_at')
    .all() as (EntityRow & { kind: string })[]
  for (const r of sequences) {
    const storyboard = sequenceKindOf(r.kind) === 'storyboard'
    try {
      await ensureEntityFolder(sequenceOwner(r.kind), r, report)
    } catch (err) {
      report.errors.push(`${storyboard ? 'The storyboard' : 'The sequence'} “${r.name}”: ${message(err)}`)
    }
  }
  // Edits get their folders before their versions, takes and audio are put in them.
  const edits = conn.prepare('SELECT id, name, folder FROM edits ORDER BY created_at').all() as EntityRow[]
  for (const r of edits) {
    try {
      await ensureEntityFolder({ table: 'edits' }, r, report)
    } catch (err) {
      report.errors.push(`The edit “${r.name}”: ${message(err)}`)
    }
  }
  await tidyGenerations(report)
  await tidyEditMedia(report)
  await tidyStills(report)
  await tidyExports(report)
}

/** Day folders that moves have emptied, and phase-2 folders with nothing left in them. */
async function removeEmptyFolders(root: string): Promise<void> {
  for (const parent of [FOLDERS.generations, FOLDERS.references, FOLDERS.ownClips]) {
    const dir = join(root, parent)
    for (const name of listEntries(dir) ?? []) {
      if (DAY_FOLDER.test(name)) await removeIfEmpty(join(dir, name))
    }
  }
  const legacyCharacters = join(root, LEGACY.characters)
  for (const name of listEntries(legacyCharacters) ?? []) await removeIfEmpty(join(legacyCharacters, name))
  for (const name of Object.values(LEGACY)) await removeIfEmpty(join(root, name))
}

/**
 * "Tidy up": moves every tracked file to its canonical location, gives assets of every kind and sequences their
 * folders, rewrites stored paths and removes emptied day folders and empty phase-2 folders. Idempotent, never
 * overwrites anything; files missing on disk are counted, not errors. Refused while the library is busy.
 */
export async function reorganizeLibrary(): Promise<ReorganizeReport> {
  return exclusive(async () => {
    const root = libraryRoot()
    refuseIfBusy()
    assertRootIntact()
    // A phase-2 conversion that was cut short (a locked file, say) is finished here too, so "Tidy up"
    // is also the way to retry it; its report covers everything the clean-up does.
    if (existsSync(markerFile(root))) {
      ensureStructure(root)
      const report = await finishLegacyMigration(root)
      await removeEmptyFolders(root)
      return report
    }
    const report = newReport()
    ensureStructure(root, report)
    await reorganizeTracked(report)
    await removeEmptyFolders(root)
    return report
  })
}

// ── Finder ───────────────────────────────────────────────────────────────────

/**
 * The sequence's (or storyboard's) folder; one from before folders existed gets one now, with its takes moved in.
 * `kind` is the one asked for: a storyboard's id given for a sequence (or the other way round) is refused.
 */
async function sequenceFolderPath(id: string, kind: SequenceKind): Promise<string> {
  const row = db.getDb().prepare('SELECT folder, kind FROM sequences WHERE id = ?').get(id) as
    | { folder: string | null; kind: string }
    | undefined
  if (!row) throw new Error(kind === 'storyboard' ? 'The storyboard no longer exists.' : 'The sequence no longer exists.')
  if (sequenceKindOf(row.kind) !== kind) {
    throw new Error(
      kind === 'storyboard'
        ? 'This is a sequence, not a storyboard. It is under Sequences.'
        : 'This is a storyboard, not a sequence. It is under Storyboards.'
    )
  }
  const parent = join(libraryRoot(), KIND_FOLDERS[kind].parent)
  const folder = row.folder
  if (isPlainName(folder)) return join(parent, folder)
  // Takes and exports moving under a running job or export would end up in the wrong place: open Sekvenser.
  if (operation || deps.busy()) return parent
  const report = newReport()
  const assigned = await exclusive(() => tidySequence(id, report))
  if (report.errors.length) console.warn(`Tidying sequence ${id}:`, report.errors)
  return assigned ? join(parent, assigned) : parent
}

/** The top-level folder each reveal target opens (without an id). */
const REVEAL_FOLDERS: Readonly<Record<Exclude<LibraryFolderTarget, 'root'>, string>> = {
  characters: FOLDERS.characters,
  environments: FOLDERS.environments,
  products: FOLDERS.products,
  outfits: FOLDERS.outfits,
  poses: FOLDERS.poses,
  directors: FOLDERS.directors,
  references: FOLDERS.references,
  generations: FOLDERS.generations,
  sequences: FOLDERS.sequences,
  storyboards: FOLDERS.storyboards,
  ownClips: FOLDERS.ownClips,
  edits: FOLDERS.edits
}

const ASSET_TARGETS: ReadonlySet<LibraryFolderTarget> = new Set<LibraryFolderTarget>([
  'characters',
  'environments',
  'products',
  'outfits',
  'poses',
  'directors'
])

/** Targets arrive over IPC: anything else is refused rather than opening some other folder. */
function isRevealTarget(target: unknown): target is LibraryFolderTarget {
  if (target === 'root') return true
  return typeof target === 'string' && Object.prototype.hasOwnProperty.call(REVEAL_FOLDERS, target)
}

function isAssetId(id: string): boolean {
  return !!db.getDb().prepare('SELECT 1 FROM assets WHERE id = ?').get(id)
}

/**
 * An edit's folder (Redigeringar/<folder>); one without a folder gets one now, unless something is running (its
 * files would move under a job), in which case Redigeringar opens.
 */
async function editFolderPath(id: string): Promise<string> {
  const row = db.getDb().prepare('SELECT id, name, folder FROM edits WHERE id = ?').get(id) as EntityRow | undefined
  if (!row) throw new Error('The edit no longer exists.')
  const parent = join(libraryRoot(), FOLDERS.edits)
  if (isPlainName(row.folder)) return join(parent, row.folder)
  if (operation || deps.busy()) return parent
  const report = newReport()
  const folder = await exclusive(() => ensureEntityFolder({ table: 'edits' }, row, report))
  if (report.errors.length) console.warn(`Giving edit ${id} a folder:`, report.errors)
  return join(parent, folder)
}

/**
 * Opens a library folder in Finder, creating it if needed. With an id: an asset's folder whatever the target
 * (a character, environment, product, outfit or pose), a sequence's folder for 'sequences', a storyboard's for
 * 'storyboards', an edit's for 'edits'.
 */
export async function revealLibraryFolder(target: LibraryFolderTarget, id?: string): Promise<void> {
  if (!isRevealTarget(target)) throw new Error('Unknown folder.')
  const root = libraryRoot()
  const entityId = typeof id === 'string' && id ? id : undefined
  let dir: string
  if (entityId && (ASSET_TARGETS.has(target) || isAssetId(entityId))) {
    // Through the asset module's queue, so it can't interleave with a rename or an image import.
    dir = await assetFolderPath(entityId)
  } else if (entityId && (target === 'sequences' || target === 'storyboards')) {
    dir = await sequenceFolderPath(entityId, target === 'storyboards' ? 'storyboard' : 'sequence')
  } else if (entityId && target === 'edits') {
    dir = await editFolderPath(entityId)
  } else {
    dir = target === 'root' ? root : join(root, REVEAL_FOLDERS[target])
  }
  assertRootIntact()
  await mkdir(dir, { recursive: true })
  const error = await shell.openPath(dir)
  if (error) {
    console.warn(`Could not open ${dir}:`, error)
    throw new Error(`The folder “${basename(dir)}” could not be opened in ${FILE_MANAGER}.`)
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** Every window reloads (onto the library now open), shortly after the IPC reply in flight has reached it. */
export function reloadWindows(): void {
  // After the IPC reply has reached the renderer, so its promise settles before the page goes away.
  setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.reload()
  }, 300)
}

/** Stored file, original and poster path of every generation, to tell which ones a clean-up moved. */
function generationPaths(): Map<string, string> {
  const rows = db.getDb().prepare('SELECT id, file_path, thumb_path, original_path FROM generations').all() as {
    id: string
    file_path: string | null
    thumb_path: string | null
    original_path: string | null
  }[]
  return new Map(rows.map((r) => [r.id, `${r.file_path ?? ''}\n${r.thumb_path ?? ''}\n${r.original_path ?? ''}`]))
}

/** The folder a dialog starts in: the given one, or its nearest existing parent. */
function existingFolder(p: string): string {
  let dir = resolve(p)
  while (!isDir(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

export function registerLibraryRootIpc(d: LibraryRootDeps): void {
  configureLibraryRoot(d)

  ipcMain.handle('library:status', async (): Promise<LibraryStatus> => {
    // A window reloaded or opened during a switch or move: every window reloads once it is done.
    if (switching) return { state: 'switching', suggested: suggestedLibraryRoot() }
    // The open folder may have vanished (renamed in Finder, a drive unplugged): it is closed, and the
    // setup screen asks for it.
    if (!operation && isLibraryReady() && isRootLost()) closeLostLibrary(false)
    // A missing folder may be back (a drive plugged in again): "Try again" asks for the status again.
    if (!isLibraryReady() && !operation && getLibraryRoot()) await exclusive(() => prepareLibrary())
    return libraryStatus()
  })

  ipcMain.handle('library:choose', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    let start = isLibraryReady() ? libraryRoot() : (getLibraryRoot() ?? suggestedLibraryRoot())
    // Not inside the library itself: "Choose" right away, or "New Folder" there, would only be refused (it is the
    // current library, or inside the one that would be moved). Its parent is where a choice makes sense.
    const source = moveSource()
    if (source && (samePath(start, source) || isStrictlyInside(start, source))) start = dirname(source)
    const options: OpenDialogOptions = {
      title: 'Choose library folder',
      message: 'Choose the base folder where Studio should save everything.',
      buttonLabel: 'Choose',
      defaultPath: existingFolder(start),
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle('library:inspect', (_e, path: string) => inspectLibraryFolder(path))

  ipcMain.handle('library:setRoot', async (_e, path: string, mode: LibraryMode) => {
    const wasReady = isLibraryReady()
    try {
      await setLibraryRoot(path, mode)
    } catch (err) {
      // A failed switch that also lost the open library: show the setup screen rather than a broken app.
      if (wasReady && !isLibraryReady()) reloadWindows()
      throw err
    }
    reloadWindows()
  })

  ipcMain.handle('library:reorganize', async () => {
    const before = generationPaths()
    const report = await reorganizeLibrary()
    try {
      const after = generationPaths()
      deps.onReorganized([...after].filter(([id, paths]) => before.get(id) !== paths).map(([id]) => id))
    } catch (err) {
      console.error('Broadcasting the clean-up failed:', err)
    }
    return report
  })

  ipcMain.handle('library:reveal', (_e, target: LibraryFolderTarget, id?: string) => revealLibraryFolder(target, id))
}
