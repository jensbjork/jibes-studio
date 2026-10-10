// Export of the whole library to one zip file, and import of such a file in another Studio installation
// (Inställningar → Export och import).
//
// Export: a consistent copy of the database (SQLite's online backup, taken while the app runs) and every file in the
// library's own folders are packed by macOS's /usr/bin/zip, which streams them from disk (media stored as they are,
// Zip64 past 4 GB). Paths in the zip are relative to the base folder, so the zip unpacked anywhere is a library. Left
// out: the live database files (the copy stands in for them), the caches under .studio that Studio rebuilds by itself
// (posters, frames, stems, filmstrips, scratch) – except a cached file the database still points at, such as the
// frame a take was started from, which may be the only copy of that picture – and anything in the base folder outside
// the library's folders. Settings, the Venice API key and the agent token live in the app's own settings, never in
// the library, so they never come along. A manifest at the zip's root (studio-archive.json) says what it is: format,
// app and schema versions, when, and what it holds.
//
// Import: the manifest is checked first (a zip that isn't a Studio export, or one from a newer Studio, is refused
// before anything is unpacked), ditto unpacks it into a folder next to the destination, the files are checked against
// the zip and the database's integrity is checked, the folder takes its final name, and it is opened as the library
// exactly as when the user picks a library folder (setLibraryRoot 'open'). The library open before stays where it is.
// Nothing that exists is ever overwritten.
//
// Only the user does either, from Inställningar: no agent tool reaches them, and the handlers refuse an agent's call.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync, rmSync, statSync, type Dirent } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type SaveDialogOptions } from 'electron'
import type { ArchiveProgress, ArchiveResult } from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import * as db from './db'
import { inspectLibraryFolder, reloadWindows, setLibraryRoot } from './library-root'
import {
  APP_DATA,
  assertRootIntact,
  DB_FILE_NAME,
  dayStamp,
  FOLDERS,
  isLibraryReady,
  LEGACY_FOLDERS,
  libraryOperationSettled,
  libraryRoot
} from './paths'
import { fileErrorReason } from './references'

/** At the zip's root: what the zip is (see ArchiveManifest). */
export const ARCHIVE_MANIFEST = 'studio-archive.json'
const FORMAT = 'studio-library'
/** Raised when the layout of the zip changes in a way an older Studio can't import. */
const FORMAT_VERSION = 1

const ZIP = '/usr/bin/zip'
const UNZIP = '/usr/bin/unzip'
const DITTO = '/usr/bin/ditto'

/** Where the database sits in the zip, as in the library. */
const DATABASE_ENTRY = `${FOLDERS.appData}/${DB_FILE_NAME}`
/** The live database and its SQLite companions in .studio: the backup copy stands in for them. */
const LIVE_DB_FILES = new Set(['', '-wal', '-shm', '-journal'].map((suffix) => DB_FILE_NAME + suffix))
/** Caches and scratch in .studio that Studio rebuilds by itself: left out of an export. */
const CACHE_FOLDERS = new Set<string>([
  APP_DATA.thumbs,
  APP_DATA.frames,
  APP_DATA.stems,
  APP_DATA.timeline,
  APP_DATA.tmp
])
/**
 * Of those, the ones a file is still kept from when the database points at it (a frame a take was started from, whose
 * video may be gone). tmp is cleared whenever a library is opened, so nothing in it is ever kept.
 */
const CACHE_KEPT_WHEN_USED = new Set<string>([APP_DATA.thumbs, APP_DATA.frames, APP_DATA.stems, APP_DATA.timeline])
/** Finder's own files. */
const IGNORABLE = new Set(['.DS_Store', '.localized'])

const USER_ONLY = 'Det här kan bara du göra i Studio.'
const RUNNING = 'En export eller import av biblioteket pågår redan. Vänta tills den är klar.'
const EXPORT_RUNNING = 'Biblioteket exporteras just nu. Vänta tills exporten är klar och försök igen.'
const NO_LIBRARY = 'Inget bibliotek är öppet.'
const NOT_STUDIO = 'Filen är inte en export av ett Studio-bibliotek.'
const NEWER_ARCHIVE =
  'Biblioteket i filen har sparats av en nyare version av Studio. Uppdatera appen för att importera det.'
const DAMAGED =
  'Filen är skadad eller ofullständig: innehållet stämmer inte med det som exporterades. Exportera biblioteket igen.'
const UNSAFE = 'Filen innehåller sökvägar eller länkar som pekar utanför biblioteket och importeras inte.'

const POLL_MS = 500
/** Room left on the disk beyond the zip or the unpacked library. */
const SPACE_MARGIN = 200 * 1024 ** 2

/** studio-archive.json. */
export interface ArchiveManifest {
  format: typeof FORMAT
  formatVersion: number
  /** The Studio version that exported it. */
  appVersion: string
  /** The database's user_version. */
  schemaVersion: number
  /** ISO time of the export. */
  createdAt: string
  /** Files (not folders) in the zip apart from this manifest, and their size unpacked. */
  files: number
  bytes: number
  counts: ArchiveResult['counts']
  /** Rows per table, checked again after an import. */
  tables: Record<string, number>
}

export interface ArchiveDeps {
  /** Why the library can't be exported or switched right now (generations, edit jobs, imports, exports…). */
  busy: () => string | undefined
  /** Where progress goes; every window by default. */
  progress?: (p: ArchiveProgress) => void
}

interface Job {
  kind: ArchiveProgress['kind']
  cancelled: boolean
  /** Past the point where it can be called off: an import moving its folder into place and opening it. */
  committed: boolean
  /** Progress polling runs (polls that answer after it stopped are dropped). */
  polling: boolean
  child?: ChildProcess
  /** Partial output: removed when the job is called off, fails or the app quits. */
  partials: Set<string>
}

class Cancelled extends Error {}

let deps: ArchiveDeps = { busy: () => undefined }
let job: Job | undefined

export function configureLibraryArchive(d: ArchiveDeps): void {
  deps = d
}

/** A running export, in Swedish, for the library's busy reason: no switch or clean-up moves files under it. */
export function archiveBusyReason(): string | undefined {
  return job?.kind === 'export' ? EXPORT_RUNNING : undefined
}

function emit(p: ArchiveProgress): void {
  try {
    if (deps.progress) deps.progress(p)
    else for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('archive:progress', p)
  } catch (err) {
    console.warn('Sending the archive progress failed:', err)
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** "1,2 GB", "820 MB". */
function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** "”a”", "”a”, ”b” och 3 till". */
function someNames(names: string[]): string {
  const shown = names.slice(0, 3).map((n) => `”${basename(n)}”`)
  const more = names.length - shown.length
  return more > 0 ? `${shown.join(', ')} och ${more} till` : shown.join(', ')
}

/** A file system error as a Swedish reason; Studio's own errors pass through. */
function reason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EROFS') return 'disken är skrivskyddad'
  if (code === 'EEXIST') return 'det finns redan något med samma namn'
  if (code === 'ENOTEMPTY') return 'mappen är inte tom'
  if (code === 'EIO' || code === 'ENXIO') return 'disken gick inte att läsa (är den ansluten?)'
  return fileErrorReason(err)
}

function asSwedish(err: unknown, what: string): Error {
  if (err instanceof Cancelled) return err
  const syscall = (err as NodeJS.ErrnoException | undefined)?.syscall
  if (typeof syscall === 'string') return new Error(`${what}: ${reason(err)}.`)
  return err instanceof Error ? err : new Error(String(err))
}

function checkCancelled(j: Job): void {
  if (j.cancelled) throw new Cancelled()
}

/** Folded the way macOS volumes compare names, symlinks resolved as far as the path exists. */
function canonical(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs).normalize('NFC').toLowerCase()
  } catch {
    const parent = dirname(abs)
    const name = basename(abs).normalize('NFC').toLowerCase()
    return parent === abs ? abs.normalize('NFC').toLowerCase() : join(canonical(parent), name)
  }
}

/** child is dir itself or lies inside it. */
function isWithin(child: string, dir: string): boolean {
  const rel = relative(canonical(dir), canonical(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Free bytes on the disk dir is on; undefined when it can't be told. */
async function freeSpace(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return undefined
  }
}

async function ensureRoom(dir: string, bytes: number, what: string): Promise<void> {
  const free = await freeSpace(dir)
  if (free === undefined || free >= bytes + SPACE_MARGIN) return
  throw new Error(
    `Det får inte plats: ${what} ungefär ${sizeText(bytes)}, men det finns bara ${sizeText(free)} ledigt där. ` +
      'Välj en annan disk eller frigör utrymme.'
  )
}

/** Finder's own files and AppleDouble companions ("._name"); see ArchiveListing.incidentalFiles. */
function isIncidental(name: string): boolean {
  return IGNORABLE.has(name) || name.startsWith('._')
}

/** A zip entry's path that stays inside the folder it is unpacked into. */
function isSafeEntry(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\0')) return false
  return !name.split('/').some((segment) => segment === '..')
}

// ── Running zip, unzip and ditto ─────────────────────────────────────────────

interface ToolResult {
  code: number | null
  /** The last lines of stderr, for a failure's message. */
  stderr: string
  /** With collectStdout: everything it wrote (up to that many bytes). */
  stdout: string
}

interface ToolOptions {
  cwd?: string
  /** Lines written to its stdin (zip's -@ file list). */
  input?: readonly string[]
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  collectStdout?: number
}

function eachLine(stream: Readable | null, fn: (line: string) => void): void {
  if (!stream) return
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', fn)
}

/** Writes the lines to stdin, waiting whenever the tool falls behind; gives up quietly when it stops reading. */
async function feed(child: ChildProcess, lines: readonly string[]): Promise<void> {
  const stdin = child.stdin
  if (!stdin) return
  // The tool stopped reading (it failed or was killed): its exit says why.
  stdin.on('error', () => {})
  const BATCH = 500
  for (let i = 0; i < lines.length; i += BATCH) {
    if (stdin.destroyed) return
    const chunk = lines.slice(i, i + BATCH).join('\n') + '\n'
    if (!stdin.write(chunk)) {
      await new Promise<void>((done) => {
        const go = (): void => {
          stdin.off('drain', go)
          stdin.off('close', go)
          done()
        }
        stdin.on('drain', go)
        stdin.on('close', go)
      })
    }
  }
  stdin.end()
}

/** Runs a command line tool as the job's child (so it can be called off); resolves when it has exited. */
function runTool(j: Job | undefined, cmd: string, args: string[], opts: ToolOptions = {}): Promise<ToolResult> {
  return new Promise((resolveRun, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    if (j) j.child = child
    const tail: string[] = []
    let stdout = ''
    if (opts.collectStdout) {
      const limit = opts.collectStdout
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (s: string) => {
        if (stdout.length < limit) stdout += s
      })
    } else {
      eachLine(child.stdout, (line) => opts.onStdout?.(line))
    }
    eachLine(child.stderr, (line) => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
      opts.onStderr?.(line)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (j?.child === child) j.child = undefined
      resolveRun({ code, stderr: tail.join('\n'), stdout })
    })
    if (opts.input) void feed(child, opts.input)
  })
}

/** Polls fn every POLL_MS while the job runs; the returned function stops it. */
function poll(j: Job, fn: () => Promise<void>): () => void {
  j.polling = true
  const timer = setInterval(() => {
    if (j.polling) void fn().catch(() => {})
  }, POLL_MS)
  return () => {
    j.polling = false
    clearInterval(timer)
  }
}

/** What a zip holds, from unzip's listing. */
interface ArchiveListing {
  /** Files (not folders) apart from the manifest, and their size unpacked. */
  files: number
  bytes: number
  /**
   * Of those, Finder's own files and AppleDouble companions ("._name"): unpacking onto a disk without extended
   * attributes (exFAT) adds such companions, and Finder may drop a .DS_Store in while it runs, so the check after
   * unpacking leaves them out on both sides.
   */
  incidentalFiles: number
  incidentalBytes: number
  hasDatabase: boolean
  manifestBytes: number
  /** Entries that would land outside the folder (absolute, ..) or that are links or devices. */
  unsafe: number
}

// "-rw-r--r--  3.0 unx    12345 bx stor 26-Oct-10 12:59 Karaktärer/Anna/a.png": type, size and name.
const LISTING_ENTRY = /^([-dlbcps?])\S{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+ (.*)$/

// "Zip file size: 1267530000 bytes, number of entries: 151": how many entries the zip says it has, folders included.
const LISTING_HEADER = /^Zip file size: .*number of entries:\s*(\d+)/

async function listArchive(zip: string, j?: Job): Promise<ArchiveListing> {
  const listing: ArchiveListing = {
    files: 0,
    bytes: 0,
    incidentalFiles: 0,
    incidentalBytes: 0,
    hasDatabase: false,
    manifestBytes: 0,
    unsafe: 0
  }
  let entries = 0
  let declared: number | undefined
  const r = await runTool(j, UNZIP, ['-Z', zip], {
    onStdout: (line) => {
      const header = LISTING_HEADER.exec(line)
      if (header) declared ??= Number(header[1])
      const m = LISTING_ENTRY.exec(line)
      if (!m) return
      const [, type, size, name] = m
      entries++
      if (!isSafeEntry(name) || (type !== '-' && type !== 'd' && type !== '?')) {
        listing.unsafe++
        return
      }
      if (type === 'd') return
      if (name === ARCHIVE_MANIFEST) {
        listing.manifestBytes = Number(size)
        return
      }
      if (name === DATABASE_ENTRY) listing.hasDatabase = true
      listing.files++
      listing.bytes += Number(size)
      if (isIncidental(name.slice(name.lastIndexOf('/') + 1))) {
        listing.incidentalFiles++
        listing.incidentalBytes += Number(size)
      }
    }
  })
  if (j) checkCancelled(j)
  if (r.code !== 0 || !entries) throw new Error(NOT_STUDIO)
  // An entry the line format doesn't fit (made on another system: FAT, NTFS …) can't be checked, so it counts as
  // unsafe rather than being unpacked unseen.
  if (declared === undefined || declared > entries) listing.unsafe += Math.max(1, (declared ?? 0) - entries)
  return listing
}

/** Reads and checks studio-archive.json in a zip: refused unless it is a Studio export this version can open. */
export function readArchiveManifest(zip: string): Promise<ArchiveManifest> {
  return readManifest(zip)
}

async function readManifest(zip: string, j?: Job): Promise<ArchiveManifest> {
  const r = await runTool(j, UNZIP, ['-p', zip, ARCHIVE_MANIFEST], { collectStdout: 1024 * 1024 })
  if (j) checkCancelled(j)
  // 9: not a zip at all; 11: no manifest in it.
  if (r.code !== 0) throw new Error(NOT_STUDIO)
  let m: Partial<ArchiveManifest>
  try {
    m = JSON.parse(r.stdout) as Partial<ArchiveManifest>
  } catch {
    throw new Error(NOT_STUDIO)
  }
  const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
  if (!m || typeof m !== 'object' || m.format !== FORMAT || !count(m.formatVersion)) throw new Error(NOT_STUDIO)
  if (m.formatVersion > FORMAT_VERSION) throw new Error(NEWER_ARCHIVE)
  if (!count(m.schemaVersion) || !count(m.files) || !count(m.bytes)) throw new Error(NOT_STUDIO)
  // The same check as opening a newer Studio's library folder (db.openDb), before anything is unpacked.
  if (db.isNewerSchema(m.schemaVersion)) throw new Error(NEWER_ARCHIVE)
  const tables = m.tables && typeof m.tables === 'object' ? m.tables : {}
  if (!Object.values(tables).every(count)) throw new Error(NOT_STUDIO)
  const c = (m.counts ?? {}) as Partial<ArchiveResult['counts']>
  return {
    format: FORMAT,
    formatVersion: m.formatVersion,
    appVersion: typeof m.appVersion === 'string' ? m.appVersion : '',
    schemaVersion: m.schemaVersion,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    files: m.files,
    bytes: m.bytes,
    counts: {
      generations: count(c.generations) ? c.generations : 0,
      assets: count(c.assets) ? c.assets : 0,
      sequences: count(c.sequences) ? c.sequences : 0,
      edits: count(c.edits) ? c.edits : 0
    },
    tables
  }
}

// ── The database ─────────────────────────────────────────────────────────────

interface DatabaseInfo {
  version: number
  tables: Record<string, number>
  counts: ArchiveResult['counts']
}

/** Version, rows per table and the counts shown to the user, read from a library database file. */
function describeDatabase(conn: Database.Database): DatabaseInfo {
  const names = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[]
  const tables: Record<string, number> = {}
  for (const name of names) {
    tables[name] = conn.prepare(`SELECT count(*) FROM "${name.replace(/"/g, '""')}"`).pluck().get() as number
  }
  const completed = (): number => {
    try {
      return conn.prepare("SELECT count(*) FROM generations WHERE status = 'completed'").pluck().get() as number
    } catch {
      return 0
    }
  }
  return {
    version: conn.pragma('user_version', { simple: true }) as number,
    tables,
    counts: {
      generations: completed(),
      assets: tables.assets ?? 0,
      sequences: tables.sequences ?? 0,
      edits: tables.edits ?? 0
    }
  }
}

/**
 * The backup copy becomes one self-contained file (no WAL), and is described for the manifest. The copy was made
 * from the open connection in one pass, so it is the database as it was at one moment.
 */
function finishSnapshot(file: string): DatabaseInfo {
  const conn = new Database(file, { fileMustExist: true })
  try {
    conn.pragma('journal_mode = DELETE')
    return describeDatabase(conn)
  } finally {
    conn.close()
  }
}

/** An unpacked library's database: it opens, passes SQLite's integrity check and holds what the manifest says. */
function checkDatabase(file: string, manifest: ArchiveManifest): DatabaseInfo {
  if (!existsSync(file)) throw new Error(NOT_STUDIO)
  let conn: Database.Database | undefined
  try {
    conn = new Database(file, { fileMustExist: true })
    const version = conn.pragma('user_version', { simple: true }) as number
    if (db.isNewerSchema(version)) throw new Error(NEWER_ARCHIVE)
    const integrity = conn.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      throw new Error('Databasen i filen är skadad (SQLite:s kontroll hittade fel). Exportera biblioteket igen.')
    }
    const info = describeDatabase(conn)
    const same =
      info.version === manifest.schemaVersion &&
      Object.entries(manifest.tables).every(([table, rows]) => info.tables[table] === rows)
    if (!same) throw new Error(DAMAGED)
    return info
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code
    if (typeof code === 'string' && code.startsWith('SQLITE_')) {
      throw new Error('Databasen i filen gick inte att öppna; filen är troligen skadad. Exportera biblioteket igen.')
    }
    throw err
  } finally {
    conn?.close()
  }
}

/**
 * Cached files (frames, mostly) that something in the database points at besides a generation's own poster: a frame
 * a take was started from is in that take's settings and may be the only copy of the picture. A poster is rebuilt from
 * its video when it is missing, so its own reference doesn't keep it.
 */
function cacheFilesInUse(): string[] {
  const uses = new Map<string, number>()
  for (const p of db.listStoredPaths()) uses.set(p, (uses.get(p) ?? 0) + 1)
  const posters = db
    .getDb()
    .prepare('SELECT thumb_path FROM generations WHERE thumb_path IS NOT NULL')
    .pluck()
    .all() as string[]
  for (const p of posters) uses.set(p, (uses.get(p) ?? 0) - 1)
  return [...uses].filter(([p, n]) => n > 0 && isKeptCachePath(p)).map(([p]) => p)
}

/** A stored path into one of the caches whose used files are kept (relative, nothing climbing out). */
function isKeptCachePath(p: string): boolean {
  if (isAbsolute(p)) return false
  const parts = p.split('/')
  return (
    parts.length >= 3 &&
    parts[0] === FOLDERS.appData &&
    CACHE_KEPT_WHEN_USED.has(parts[1].normalize('NFC')) &&
    parts.every((s) => !!s && s !== '.' && s !== '..')
  )
}

// ── Export ───────────────────────────────────────────────────────────────────

interface FileList {
  /** Paths relative to the base folder, for zip's -@: files, and folders that are empty. */
  names: string[]
  files: number
  bytes: number
  /** Links and other special files (never followed out of the library), and names zip can't be given. */
  skipped: string[]
}

/** The library's own top-level folders: today's, and an earlier layout's that a conversion hasn't emptied yet. */
function libraryFolders(): string[] {
  return [...Object.values(FOLDERS), ...Object.values(LEGACY_FOLDERS)]
}

function addFile(list: FileList, rel: string, size: number): void {
  if (/[\n\r]/.test(rel)) {
    list.skipped.push(rel)
    return
  }
  list.names.push(rel)
  list.files++
  list.bytes += size
}

async function walk(j: Job, root: string, rel: string, list: FileList): Promise<void> {
  checkCancelled(j)
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch (err) {
    throw new Error(`Mappen ”${rel}” gick inte att läsa: ${reason(err)}.`)
  }
  const inAppData = rel === FOLDERS.appData
  let kept = 0
  const files: string[] = []
  for (const entry of entries) {
    const name = entry.name
    if (IGNORABLE.has(name)) continue
    if (inAppData && (LIVE_DB_FILES.has(name) || (CACHE_FOLDERS.has(name) && entry.isDirectory()))) continue
    const child = `${rel}/${name}`
    if (entry.isDirectory()) {
      if (/[\n\r]/.test(name)) {
        list.skipped.push(child)
        continue
      }
      await walk(j, root, child, list)
      kept++
    } else if (entry.isFile()) {
      files.push(child)
      kept++
    } else {
      list.skipped.push(child)
    }
  }
  const sizes = await Promise.all(files.map((f) => lstat(join(root, f)).then((s) => s.size, () => undefined)))
  files.forEach((f, i) => {
    const size = sizes[i]
    // Gone since the folder was read: nothing to pack.
    if (size !== undefined) addFile(list, f, size)
  })
  // An empty folder comes along as a folder.
  if (!kept && !/[\n\r]/.test(rel)) list.names.push(rel)
}

/** Every file to pack, relative to the base folder (the database copy is added separately). */
async function listLibraryFiles(j: Job, root: string, kept: readonly string[]): Promise<FileList> {
  const list: FileList = { names: [], files: 0, bytes: 0, skipped: [] }
  for (const top of libraryFolders()) {
    const s = await lstat(join(root, top)).catch(() => undefined)
    // A link or a file by the name of a library folder isn't the library's.
    if (s?.isDirectory()) await walk(j, root, top, list)
  }
  for (const rel of kept) {
    const s = await lstat(join(root, rel)).catch(() => undefined)
    if (s?.isFile()) addFile(list, rel, s.size)
  }
  return list
}

function zipFailure(code: number | null, stderr: string): string {
  // zip's own exit codes: 14 writing failed (a full disk), 15 the zip couldn't be created there.
  if (code === 14 || /no space/i.test(stderr)) return 'Zip-filen gick inte att skriva klart. Är disken full?'
  if (code === 15) return 'Zip-filen gick inte att skapa där. Välj en annan mapp.'
  return `Packningen avbröts (zip avslutades med kod ${code ?? 'okänd'}).`
}

/** Adds the files to the zip; resolves with those that vanished or couldn't be read meanwhile. */
async function packFiles(j: Job, root: string, part: string, list: FileList, total: number): Promise<string[]> {
  const missing: string[] = []
  if (!list.names.length) return missing
  const stop = poll(j, async () => {
    const s = await stat(part)
    if (!j.polling) return
    emit({ kind: 'export', phase: 'packing', done: Math.min(s.size, total), total, message: 'Packar filerna…' })
  })
  try {
    // -g appends to the zip in place (it only grows, so its size is the progress), -0 stores the files as they are
    // (video, pictures and sound don't shrink), -nw takes names literally ("[1]" is not a pattern).
    const r = await runTool(j, ZIP, ['-g', '-0', '-nw', part, '-@'], {
      cwd: root,
      input: list.names,
      onStdout: (line) => {
        const m = /zip warning: (?:name not matched|could not open for reading): (.*)$/.exec(line)
        if (m) missing.push(m[1])
      }
    })
    checkCancelled(j)
    // 18: some files could not be read (they are listed above); 12: nothing left to add.
    const partial = (r.code === 18 || r.code === 12) && missing.length > 0
    if (r.code !== 0 && !partial) throw new Error(zipFailure(r.code, r.stderr))
  } finally {
    stop()
  }
  return missing
}

/** What didn't come along, for the line under the result; undefined when everything did. */
function leftOutNote(missing: string[], skipped: string[]): string | undefined {
  const notes: string[] = []
  if (missing.length) {
    notes.push(
      `${missing.length === 1 ? 'En fil' : `${missing.length} filer`} togs bort, flyttades eller gick inte att läsa ` +
        `medan exporten pågick och kom inte med: ${someNames(missing)}. Exportera igen om du behöver ` +
        `${missing.length === 1 ? 'den' : 'dem'}.`
    )
  }
  if (skipped.length) {
    notes.push(
      `${skipped.length === 1 ? 'En länk' : `${skipped.length} länkar`} i biblioteksmapparna följde inte med: ` +
        `${someNames(skipped)}.`
    )
  }
  return notes.length ? notes.join(' ') : undefined
}

/** The zip's path: ends in .zip, never inside the library's own folders (the next export would pack it). */
function exportTarget(path: string, root: string): string {
  let target = resolve(path).normalize('NFC')
  if (extname(target).toLowerCase() !== '.zip') target += '.zip'
  if (libraryFolders().some((name) => isWithin(target, join(root, name)))) {
    throw new Error('Spara zip-filen utanför biblioteket, till exempel i Hämtade filer.')
  }
  if (!existsSync(dirname(target))) throw new Error(`Mappen ”${dirname(target)}” finns inte.`)
  try {
    if (statSync(target).isDirectory()) throw new Error(`”${basename(target)}” är en mapp. Välj ett filnamn.`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return target
}

/** Why an export can't start now, in Swedish. */
function exportRefusal(): string | undefined {
  if (job) return RUNNING
  if (!isLibraryReady()) return NO_LIBRARY
  return deps.busy()
}

/**
 * Packs the open library into the zip at `path` (".zip" is added when missing; an existing file there is replaced only
 * once the new zip is complete). Resolves null when it was called off.
 */
export async function exportLibraryTo(path: string): Promise<ArchiveResult | null> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Välj var zip-filen ska sparas.')
  const refusal = exportRefusal()
  if (refusal) throw new Error(refusal)
  const target = exportTarget(path, libraryRoot())
  return runJob('export', (j) => runExport(j, target))
}

async function runExport(j: Job, target: string): Promise<ArchiveResult> {
  emit({ kind: 'export', phase: 'preparing', message: 'Gör en kopia av databasen…' })
  // A clean-up or switch already under way finishes first; a new one is refused while this runs (archiveBusyReason).
  await libraryOperationSettled()
  checkCancelled(j)
  assertRootIntact()
  const root = libraryRoot()
  const busy = deps.busy()
  if (busy && busy !== EXPORT_RUNNING) throw new Error(busy)

  const staging = await mkdtemp(join(tmpdir(), 'studio-export-'))
  j.partials.add(staging)
  const snapshot = join(staging, DATABASE_ENTRY)
  await mkdir(dirname(snapshot), { recursive: true })
  try {
    await db.getDb().backup(snapshot)
  } catch (err) {
    throw new Error(`Databasen gick inte att kopiera: ${reason(err)}.`)
  }
  // Read in the same tick as the copy finished, so it matches it.
  const keptCache = cacheFilesInUse()
  const info = finishSnapshot(snapshot)
  checkCancelled(j)

  emit({ kind: 'export', phase: 'preparing', message: 'Går igenom filerna…' })
  const list = await listLibraryFiles(j, root, keptCache)
  const snapshotBytes = (await stat(snapshot)).size
  const total = list.bytes + snapshotBytes
  await ensureRoom(dirname(target), total, 'zip-filen blir')
  checkCancelled(j)

  // Written beside the target and renamed when complete, so a zip by that name is always a whole one.
  const part = `${target}.part`
  j.partials.add(part)
  await rm(part, { force: true })
  emit({ kind: 'export', phase: 'packing', done: 0, total, message: 'Packar filerna…' })
  // The database copy goes in first, from the staging folder, under the same path as in the library.
  const first = await runTool(j, ZIP, ['-q', '-nw', '-b', staging, part, '--', DATABASE_ENTRY], { cwd: staging })
  checkCancelled(j)
  if (first.code !== 0) throw new Error(zipFailure(first.code, first.stderr))
  const missing = await packFiles(j, root, part, list, total)
  if (missing.length) console.warn(`Export: ${missing.length} files vanished or were unreadable while packing.`)
  if (list.skipped.length) console.warn(`Export: skipped ${list.skipped.length} links or special files.`)

  // The manifest last: it describes what the zip really holds.
  emit({ kind: 'export', phase: 'packing', done: total, total, message: 'Gör klart…' })
  const listing = await listArchive(part, j)
  const manifest: ArchiveManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: app.getVersion(),
    schemaVersion: info.version,
    createdAt: new Date().toISOString(),
    files: listing.files,
    bytes: listing.bytes,
    counts: info.counts,
    tables: info.tables
  }
  await writeFile(join(staging, ARCHIVE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  const last = await runTool(j, ZIP, ['-q', '-g', '-nw', part, '--', ARCHIVE_MANIFEST], { cwd: staging })
  checkCancelled(j)
  if (last.code !== 0) throw new Error(zipFailure(last.code, last.stderr))

  j.committed = true
  try {
    await rename(part, target)
  } catch (err) {
    throw asSwedish(err, 'Zip-filen kunde inte sparas')
  }
  j.partials.delete(part)
  const bytes = (await stat(target)).size
  emit({ kind: 'export', phase: 'done', done: total, total, message: leftOutNote(missing, list.skipped) })
  console.info(`Exported the library: ${listing.files} files, ${bytes} bytes.`)
  return { path: target, bytes, counts: info.counts }
}

// ── Import ───────────────────────────────────────────────────────────────────

/** Why an import can't start now, in Swedish (it ends by switching libraries, which would be refused). */
function importRefusal(): string | undefined {
  if (job) return RUNNING
  return deps.busy()
}

/** The destination: a new folder, or an empty one, outside the open library and writable. */
async function checkDestination(target: string): Promise<void> {
  const file = await lstat(target).catch(() => undefined)
  if (file && !file.isDirectory()) throw new Error(`”${basename(target)}” är en fil. Välj ett namn för en ny mapp.`)
  const ins = await inspectLibraryFolder(target)
  // Elsewhere in the open library's base folder is fine (as for opening a library kept there); inside its own folders,
  // which a move carries along and a clean-up works in, it is not.
  const root = isLibraryReady() ? libraryRoot() : undefined
  if (ins.isCurrent || (root && libraryFolders().some((name) => isWithin(target, join(root, name))))) {
    throw new Error('Välj en plats utanför det bibliotek som är öppet nu.')
  }
  if (ins.hasLibrary) throw new Error('Mappen innehåller redan ett Studio-bibliotek. Välj en ny eller tom mapp.')
  if (!ins.empty) {
    throw new Error(
      `Mappen ”${basename(target)}” är inte tom. Välj en ny eller tom mapp – Studio skriver aldrig över något.`
    )
  }
  if (!ins.writable) throw new Error(`Studio kan inte skriva i ”${dirname(target)}”. Välj en annan plats.`)
}

/** A new folder next to target to unpack into, named so a leftover from a crash is recognisable in Finder. */
async function unpackFolder(target: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = `${target} (importeras${n === 1 ? '' : ` ${n}`})`
    try {
      await mkdir(dir)
      return dir
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 50) throw asSwedish(err, 'Mappen kunde inte skapas')
    }
  }
}

async function unpack(j: Job, zip: string, dir: string, total: number): Promise<void> {
  let done = 0
  let current: string | undefined
  const stop = poll(j, async () => {
    const name = current
    const partial = name ? await stat(join(dir, name)).then((s) => s.size, () => 0) : 0
    if (j.polling) {
      emit({ kind: 'import', phase: 'unpacking', done: Math.min(done + partial, total), total, message: 'Packar upp…' })
    }
  })
  try {
    // -V names each file as it starts ("copying file X ... ") and when it is done ("123 bytes for X").
    const r = await runTool(j, DITTO, ['-V', '-x', '-k', zip, dir], {
      onStderr: (line) => {
        const start = /^copying file (.*) \.\.\. ?$/.exec(line)
        if (start) {
          current = start[1]
          return
        }
        const end = /^(\d+) bytes for /.exec(line)
        if (end) {
          done += Number(end[1])
          current = undefined
        }
      }
    })
    checkCancelled(j)
    if (r.code !== 0) {
      throw new Error(
        /no space/i.test(r.stderr)
          ? 'Filen gick inte att packa upp: disken är full.'
          : 'Filen gick inte att packa upp; den är troligen skadad.'
      )
    }
  } finally {
    stop()
  }
}

/** The unpacked folder holds exactly the zip's files, and no links. */
async function checkUnpacked(j: Job, dir: string, listing: ArchiveListing): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (rel: string): Promise<void> => {
    checkCancelled(j)
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) {
        if (child === ARCHIVE_MANIFEST || isIncidental(entry.name)) continue
        files++
        bytes += (await lstat(join(dir, child))).size
      } else throw new Error(UNSAFE)
    }
  }
  await visit('')
  const expected = { files: listing.files - listing.incidentalFiles, bytes: listing.bytes - listing.incidentalBytes }
  if (files !== expected.files || bytes !== expected.bytes) throw new Error(DAMAGED)
}

/** Takes the place of an empty destination folder (Finder's own files in it go). */
async function clearEmptyFolder(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => undefined)
  if (!names) return
  if (names.some((n) => !IGNORABLE.has(n))) throw new Error(`Mappen ”${basename(dir)}” är inte tom längre.`)
  for (const n of names) await rm(join(dir, n), { force: true })
  await rmdir(dir)
}

/**
 * Unpacks a Studio export (`zip`) into `target` – a new or empty folder – checks it and opens it as the library, the
 * same way as choosing a library folder in Inställningar; the library open before stays where it is. Resolves null
 * when it was called off. A library unpacked but refused when opened (something started meanwhile) stays in target.
 */
export async function importLibraryFrom(zip: string, target: string): Promise<ArchiveResult | null> {
  if (typeof zip !== 'string' || !isAbsolute(zip)) throw new Error('Välj en zip-fil.')
  if (typeof target !== 'string' || !isAbsolute(target)) throw new Error('Välj var biblioteket ska ligga.')
  const refusal = importRefusal()
  if (refusal) throw new Error(refusal)
  return runJob('import', (j) => runImport(j, resolve(zip), resolve(target).normalize('NFC')))
}

async function runImport(j: Job, zip: string, target: string): Promise<ArchiveResult> {
  emit({ kind: 'import', phase: 'preparing', message: 'Läser filen…' })
  const manifest = await readManifest(zip, j)
  const listing = await listArchive(zip, j)
  if (listing.unsafe) throw new Error(UNSAFE)
  if (!listing.hasDatabase) throw new Error(NOT_STUDIO)
  if (listing.files !== manifest.files || listing.bytes !== manifest.bytes) throw new Error(DAMAGED)
  await checkDestination(target)
  const parent = dirname(target)
  try {
    await mkdir(parent, { recursive: true })
  } catch (err) {
    throw asSwedish(err, `Mappen ”${parent}” kunde inte skapas`)
  }
  await ensureRoom(parent, listing.bytes + listing.manifestBytes, 'biblioteket tar')
  checkCancelled(j)

  // Unpacked beside the destination (same disk, so moving it into place is a rename) and only named as the library
  // once it has been checked.
  const dir = await unpackFolder(target)
  j.partials.add(dir)
  emit({ kind: 'import', phase: 'unpacking', done: 0, total: listing.bytes, message: 'Packar upp…' })
  await unpack(j, zip, dir, listing.bytes)

  emit({ kind: 'import', phase: 'checking', message: 'Kontrollerar databasen och filerna…' })
  await checkUnpacked(j, dir, listing)
  const info = checkDatabase(join(dir, DATABASE_ENTRY), manifest)
  await rm(join(dir, ARCHIVE_MANIFEST), { force: true })
  checkCancelled(j)

  j.committed = true
  emit({ kind: 'import', phase: 'opening', message: 'Öppnar biblioteket…' })
  // Checked again: something may have been put there while the zip was unpacked.
  await checkDestination(target)
  try {
    if (existsSync(target)) await clearEmptyFolder(target)
    await rename(dir, target)
  } catch (err) {
    throw asSwedish(err, `Biblioteket kunde inte läggas i ”${basename(target)}”`)
  }
  j.partials.delete(dir)

  const wasReady = isLibraryReady()
  try {
    await setLibraryRoot(target, 'open')
  } catch (err) {
    // A failed switch that also lost the open library: the windows show the setup screen rather than a broken app.
    if (wasReady && !isLibraryReady()) reloadWindows()
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Biblioteket packades upp i ”${target}” men kunde inte öppnas: ${why} Du kan öppna det senare under ` +
        'Inställningar → Bibliotek → Byt mapp.'
    )
  }
  reloadWindows()
  const bytes = (await stat(zip)).size
  emit({ kind: 'import', phase: 'done', message: 'Biblioteket är importerat och öppnas nu.' })
  console.info(`Imported a library: ${listing.files} files, schema ${info.version}.`)
  return { path: target, bytes, counts: info.counts }
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

async function removePartials(j: Job): Promise<void> {
  for (const p of j.partials) {
    await rm(p, { recursive: true, force: true }).catch((err: unknown) => console.warn(`Could not remove ${p}:`, err))
  }
  j.partials.clear()
}

/** One export or import at a time; partial output goes whatever happens; a called-off job resolves null. */
async function runJob<T>(kind: Job['kind'], fn: (j: Job) => Promise<T>): Promise<T | null> {
  if (job) throw new Error(RUNNING)
  const j: Job = { kind, cancelled: false, committed: false, polling: false, partials: new Set() }
  job = j
  try {
    return await fn(j)
  } catch (err) {
    if (j.cancelled && !j.committed) {
      await removePartials(j)
      emit({ kind, phase: 'cancelled', message: 'Avbrutet. Inget sparades.' })
      return null
    }
    const e = asSwedish(err, kind === 'export' ? 'Exporten misslyckades' : 'Importen misslyckades')
    console.warn(`Library ${kind} failed:`, err)
    emit({ kind, phase: 'failed', message: e.message })
    throw e
  } finally {
    j.polling = false
    j.child?.kill('SIGKILL')
    await removePartials(j)
    if (job === j) job = undefined
  }
}

/** Calls off the running export or import (not once an import is opening its library); its partial files go. */
export function cancelLibraryArchive(): void {
  const j = job
  if (!j || j.committed) return
  j.cancelled = true
  j.child?.kill('SIGKILL')
}

/** While the app quits: stops the job at once and removes its partial files (the async clean-up may never run). */
export function stopLibraryArchive(): void {
  const j = job
  if (!j) return
  j.cancelled = true
  j.polling = false
  j.child?.kill('SIGKILL')
  for (const p of j.partials) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      // Best effort while quitting.
    }
  }
  j.partials.clear()
}

// ── Dialogs and IPC ──────────────────────────────────────────────────────────

/** Like switching libraries, only the user does this: an agent's call (or one without a window) is refused. */
function refuseAgent(e: IpcMainInvokeEvent): void {
  if (isAgentCall(e) || !e?.sender) throw new Error(USER_ONLY)
}

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

async function saveDialog(e: IpcMainInvokeEvent, options: SaveDialogOptions): Promise<string | undefined> {
  const win = windowOf(e)
  const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return res.canceled || !res.filePath ? undefined : res.filePath
}

/** "Studio-bibliotek 2026-10-10" for a.zip named so, made unique in dir: "… 2", "… 3". */
function freeFolderName(dir: string, zip: string): string {
  const base = basename(zip, extname(zip)).replace(/[/:]/g, '-').trim() || 'Studio-bibliotek'
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    if (!existsSync(join(dir, name)) || n > 99) return name
  }
}

export function registerArchiveIpc(d: ArchiveDeps): void {
  configureLibraryArchive(d)

  ipcMain.handle('archive:export', async (e): Promise<ArchiveResult | null> => {
    refuseAgent(e)
    // Before the dialog: no point asking where to save something that can't start.
    const refusal = exportRefusal()
    if (refusal) throw new Error(refusal)
    const target = await saveDialog(e, {
      title: 'Exportera biblioteket',
      message: 'Hela biblioteket packas i en zip-fil. API-nyckeln och agentens token följer inte med.',
      defaultPath: join(app.getPath('downloads'), `Studio-bibliotek ${dayStamp(new Date())}.zip`),
      buttonLabel: 'Exportera',
      filters: [{ name: 'Zip-arkiv', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return target ? exportLibraryTo(target) : null
  })

  ipcMain.handle('archive:import', async (e): Promise<ArchiveResult | null> => {
    refuseAgent(e)
    const refusal = importRefusal()
    if (refusal) throw new Error(refusal)
    const win = windowOf(e)
    const options = {
      title: 'Importera ett bibliotek',
      message: 'Välj en zip-fil som exporterats från Studio.',
      buttonLabel: 'Välj',
      defaultPath: app.getPath('downloads'),
      filters: [{ name: 'Studio-bibliotek', extensions: ['zip'] }],
      properties: ['openFile' as const]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const zip = picked.canceled ? undefined : picked.filePaths[0]
    if (!zip) return null
    // Checked before the destination is asked for: a zip that isn't a Studio export is refused right away.
    await readArchiveManifest(zip)
    const movies = app.getPath('videos')
    const target = await saveDialog(e, {
      title: 'Var ska biblioteket ligga?',
      message:
        'Biblioteket packas upp i en ny mapp med det här namnet och öppnas sedan. Det bibliotek du har öppet nu ' +
        'ligger kvar där det är.',
      defaultPath: join(movies, freeFolderName(movies, zip)),
      buttonLabel: 'Importera',
      nameFieldLabel: 'Mapp:',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return target ? importLibraryFrom(zip, target) : null
  })

  ipcMain.handle('archive:cancel', (e) => {
    refuseAgent(e)
    cancelLibraryArchive()
  })
}
