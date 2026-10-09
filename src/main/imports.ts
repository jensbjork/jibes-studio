// Own clips ("Egna klipp"): the user's own video files, brought into the library so they can be used like any
// generation: in the clip feed, as a clip (or a take of a clip) in a sequence that AI clips continue from, and as the
// starting point of an edit in Redigera. An import is a `generations` row with source 'import', inserted completed
// (never pending: nothing is generated) with no price, and a file of its own in Egna klipp/<day>/: an APFS clone of
// the original where the volume allows (instant, no extra space), else a copy. When the original can't be played or
// continued from as it is (HDR, more than 8 bits, larger than 1080p, a variable frame rate, rotation metadata, ProRes
// or another format Chromium can't play, a first audio track ffmpeg can't decode, pixels that aren't square, sound and
// picture that start apart), a working copy is made next to it (H.264 SDR ≤1080p, constant fps, upright, square
// pixels, both streams from 0, metadata stripped) and used everywhere instead; the original stays untouched beside it
// (originalPath). Agents import too, but only files they uploaded to Studio (staged in the library) or that the
// library already records: never a path of their own on this Mac (assertAgentFiles).

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { copyFile, realpath, rm, stat, statfs } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { DEFAULT_PARAMS } from '@shared/models'
import type {
  EditRecipe,
  Generation,
  ImportProgress,
  ImportResult,
  ImportTarget,
  VideoFileInfo
} from '@shared/types'
import * as db from './db'
import { extractThumbnail, normalizeVideo, probe, probeMedia, type MediaInfo } from './ffmpeg'
import { originalHome, toPublic, videoLocation } from './jobs'
import { isInsideRoot, libraryOperationSettled, libraryRoot, thumbsDir, tmpDir, toStoredPath } from './paths'
import { fileErrorReason, placeFile } from './references'
import type { SequenceService } from './sequences'
import * as store from './sequence-store'
import { assertAgentFiles } from './upload-paths'

const execFileAsync = promisify(execFile)

/** The file types the file dialog offers for own clips (file:pickVideos) and that drops accept. */
export const VIDEO_FILE_TYPES = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const

/** Said while an import runs (a library switch or "Städa upp" would pull the folder away under it). */
export const IMPORT_BUSY = 'Det pågår en import av egna klipp. Vänta tills den är klar och försök igen.'

/** Said for a file the import was stopped before (Avbryt). */
const CANCELLED = 'Importen avbröts.'

/** Above this a copy that can't be a clone is confirmed first (the window asks; see VideoFileInfo.cloneable). */
export const LARGE_COPY_BYTES = 2 * 1024 ** 3

/** What an import must leave free on the library's disk. */
const MIN_FREE_BYTES = 2 * 1024 ** 3

/** The working copy's longest side: 1080p. */
const MAX_LONG_SIDE = 1920

/** Shorter than this can't be trimmed, continued from or cut (the sequence keeps at least 0.2 s of a take). */
const MIN_SECONDS = 0.3

/** Sound and picture starting this far apart (or half a frame, if more) get a working copy that starts both at 0. */
const AV_OFFSET_TOLERANCE = 0.025

/** Two aspects closer than this are the same shape: cropping to it would only cost a re-encode. */
const SAME_ASPECT = 0.01

/** Video codecs Chromium (Electron) plays in an mp4/mov, and in a webm. */
const MP4_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9'])
const WEBM_CODECS = new Set(['vp8', 'vp9', 'av1'])
const MP4_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v'])

/** Rough rates for estimating the size of a working copy (H.264 at the working copy's quality), in bytes/s. */
const WORKING_COPY_RATE_1080 = 1.4e6
const WORKING_COPY_RATE_SMALL = 0.7e6

/** Rough speeds for weighing the steps of one file's progress bar. */
const COPY_BYTES_PER_SECOND = 150e6
const HASH_BYTES_PER_SECOND = 1.5e9
const NORMALIZE_REALTIME = 3

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError')
}

function abortError(): Error {
  const err = new Error(CANCELLED)
  err.name = 'AbortError'
  return err
}

// ── What a file is ───────────────────────────────────────────────────────────

/** Standard shapes, so a 1920×1080 film says "16:9" and a 1080×1350 one "4:5" rather than an exact fraction. */
const ASPECTS: readonly [number, number][] = [
  [16, 9],
  [9, 16],
  [4, 3],
  [3, 4],
  [1, 1],
  [21, 9],
  [9, 21],
  [3, 2],
  [2, 3],
  [4, 5],
  [5, 4],
  [2, 1],
  [1, 2]
]

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/**
 * "16:9" for a picture of that shape: the nearest standard aspect within 2 %, else the exact ratio reduced (or, for
 * an odd size whose reduced ratio has large numbers, "2.35:1").
 */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return DEFAULT_PARAMS.aspectRatio ?? '16:9'
  const ratio = width / height
  for (const [a, b] of ASPECTS) if (Math.abs(ratio - a / b) / (a / b) < 0.02) return `${a}:${b}`
  const w = Math.round(width)
  const h = Math.round(height)
  const d = gcd(w, h)
  if (w / d <= 64 && h / d <= 64) return `${w / d}:${h / d}`
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`
}

/** "16:9" → 1.777…; undefined for anything else ("auto", "adaptive", garbage). */
export function parseAspect(value: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? '')
  if (!m) return undefined
  const ratio = Number(m[1]) / Number(m[2])
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}

/** "4K" for a UHD frame and up, else the short side ("1440p"), for "4K → 1080p". */
function sizeLabel(width: number, height: number): string {
  const long = Math.max(width, height)
  if (long >= 3800) return `${Math.round(long / 960)}K`
  return `${Math.min(width, height)}p`
}

/** The video stream plays in Studio (Chromium) as it is, in this container. */
function playable(info: Pick<MediaInfo, 'codec' | 'pixFmt'>, ext: string): boolean {
  const codec = (info.codec || '').toLowerCase()
  // 4:2:2 and 4:4:4 (pro cameras, screen recordings) decode in ffmpeg but not in Chromium.
  if (info.pixFmt && /42[24]|444/.test(info.pixFmt)) return false
  if (MP4_EXTENSIONS.has(ext)) return MP4_CODECS.has(codec)
  if (ext === '.webm') return WEBM_CODECS.has(codec)
  return false
}

/**
 * Why the file needs a working copy (Swedish, as the import dialog lists them), or [] when it can be used as it is:
 * Studio plays it, its last frame makes a normal 8-bit picture to continue from, and the export cuts it like any take.
 */
export function workingCopyReasons(info: MediaInfo, path: string): string[] {
  const ext = extname(path).toLowerCase()
  const reasons: string[] = []
  if (info.hdr) reasons.push('HDR')
  if (info.bitDepth > 8) reasons.push(`${info.bitDepth}-bitars färg`)
  if (Math.max(info.width, info.height) > MAX_LONG_SIDE) reasons.push(`${sizeLabel(info.width, info.height)} → 1080p`)
  if (info.variableFrameRate) reasons.push('variabel bildfrekvens')
  if (info.rotation && info.rotation % 360 !== 0) reasons.push('roterad')
  if ((info.codec || '').toLowerCase() === 'prores') reasons.push('ProRes')
  else if (!playable(info, ext)) reasons.push('formatet spelas inte i Studio')
  // Newer iPhones put a spatial-audio track first, which ffmpeg can't decode; the export and the editor read the first.
  if (info.audioStreams.length && !info.audioStreams[0].decodable) reasons.push('ljudspåret kan inte läsas')
  // Anamorphic (HDV, DV, a camera's anamorphic mode): the export and a continuation frame would come out squeezed.
  if (info.sar !== undefined && info.sar > 0 && Math.abs(info.sar - 1) > 0.01) reasons.push('icke-kvadratiska bildpunkter')
  // Sound and picture that start apart (a recorder, some phones): the export and Redigera's cuts start each stream at
  // its own first frame or sample, which would put them out of sync. A single AAC frame of priming (~21 ms) is left.
  const fps = info.fps > 0 ? info.fps : 24
  if (info.audioOffset !== undefined && Math.abs(info.audioOffset) > Math.max(0.5 / fps, AV_OFFSET_TOLERANCE)) {
    reasons.push('ljud och bild börjar inte samtidigt')
  }
  return reasons
}

/** The film's size as it is shown: a pixel shape that isn't square (sar) widens it (heightens it, when sideways). */
function displayed(media: MediaInfo): MediaInfo {
  const sar = media.sar ?? 1
  if (!(sar > 0) || Math.abs(sar - 1) <= 0.01) return media
  const sideways = media.rotation === 90 || media.rotation === 270
  return sideways
    ? { ...media, height: Math.round(media.height * sar) }
    : { ...media, width: Math.round(media.width * sar) }
}

// ── Content hashes ───────────────────────────────────────────────────────────

/** SHA-256 by path, valid while the file's size and modification time are unchanged. */
const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>()
const MAX_CACHED_HASHES = 500

function rememberHash(path: string, size: number, mtimeMs: number, sha256: string): void {
  if (hashes.size >= MAX_CACHED_HASHES) hashes.clear()
  hashes.set(path, { size, mtimeMs, sha256 })
}

/** A streaming SHA-256 of the file (cached per path, size and mtime); `onProgress` gets 0–1. */
async function sha256Of(path: string, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<string> {
  const info = await stat(path)
  const known = hashes.get(path)
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.sha256
  const hash = createHash('sha256')
  let read = 0
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer)
    read += (chunk as Buffer).length
    onProgress?.(info.size ? read / info.size : 1)
  }
  const sha256 = hash.digest('hex')
  rememberHash(path, info.size, info.mtimeMs, sha256)
  return sha256
}

// ── Earlier imports ──────────────────────────────────────────────────────────

interface ImportRow {
  id: string
  recipe: string | null
  file_path: string | null
  segment_id: string | null
}

/**
 * An earlier import of exactly this file whose video is still there: the same byte size (recipe.import.bytes, a
 * cheap filter, so a file is only hashed when there is a candidate at all), then the same SHA-256. One that belongs
 * to no clip is preferred, then the newest.
 */
async function findDuplicate(
  path: string,
  bytes: number,
  signal?: AbortSignal
): Promise<db.StoredGeneration | undefined> {
  const rows = db
    .getDb()
    .prepare(
      `SELECT id, recipe, file_path, segment_id FROM generations
       WHERE source = 'import' AND status = 'completed' AND json_extract(recipe, '$.import.bytes') = ?
       ORDER BY segment_id IS NOT NULL, created_at DESC`
    )
    .all(bytes) as ImportRow[]
  if (!rows.length) return undefined
  const sha256 = await sha256Of(path, signal)
  for (const row of rows) {
    let recipe: EditRecipe | undefined
    try {
      recipe = row.recipe ? (JSON.parse(row.recipe) as EditRecipe) : undefined
    } catch {
      continue
    }
    if (recipe?.import?.sha256 !== sha256 || !row.file_path) continue
    const g = db.getGeneration(row.id)
    if (g && store.isUsable(g)) return g
  }
  return undefined
}

/**
 * The import whose own file (or untouched original) this library file is, if any: asking about an own clip's file
 * (the clip editor's info line does) needs no hashing to know it is that import.
 */
function libraryImportOf(path: string): string | undefined {
  if (!isInsideRoot(path)) return undefined
  const stored = toStoredPath(path)
  const id = db
    .getDb()
    .prepare(
      `SELECT id FROM generations WHERE source = 'import' AND status = 'completed'
         AND (file_path = @p COLLATE NOCASE OR original_path = @p COLLATE NOCASE)
       ORDER BY segment_id IS NOT NULL, created_at DESC LIMIT 1`
    )
    .pluck()
    .get({ p: stored }) as string | undefined
  return id
}

// ── Inspect ──────────────────────────────────────────────────────────────────

/** The library's volume, to tell whether a file can be cloned into it. */
/**
 * The library's volume, when its files can be APFS clones of files on the same volume: only APFS clones
 * (COPYFILE_FICLONE silently makes a full copy on exFAT, FAT or HFS+, common on external video drives), so only then
 * does a same-volume import cost no space and need no question about a large copy.
 */
async function libraryDevice(): Promise<number | undefined> {
  try {
    const root = libraryRoot()
    const dev = (await stat(root)).dev
    return (await volumeType(root)) === 'apfs' ? dev : undefined
  } catch {
    return undefined
  }
}

/** The file system of the volume a path is on ("apfs", "exfat", "msdos", "hfs"…), from `mount`; undefined if unknown. */
async function volumeType(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  try {
    const real = await realpath(path)
    const { stdout } = await execFileAsync('/sbin/mount', [], { timeout: 5000 })
    let best: { point: string; type: string } | undefined
    for (const line of stdout.split('\n')) {
      // "/dev/disk5s1 on /Volumes/Film (exfat, local, nodev, nosuid, noowners)"
      const m = /^.+? on (.+) \(([^,)]+)/.exec(line)
      if (!m) continue
      const point = m[1]
      const inside = real === point || real.startsWith(point.endsWith('/') ? point : `${point}/`)
      if (inside && (!best || point.length > best.point.length)) best = { point, type: m[2].trim().toLowerCase() }
    }
    return best?.type
  } catch {
    return undefined
  }
}

interface Inspected {
  info: VideoFileInfo
  media?: MediaInfo
}

/**
 * Everything the import dialog shows before anything is copied (free): whether the file can be imported, what it
 * is, whether a working copy will be made and why, whether it is cloned or copied, and whether it was imported
 * before. Refusals are Swedish and name the file.
 */
async function inspectOne(path: string, device: number | undefined): Promise<Inspected> {
  const name = basename(path)
  const refuse = (error: string, bytes = 0): Inspected => ({
    info: { path, name, bytes, ok: false, error: `${name}: ${error}`, workingCopy: [], cloneable: false }
  })
  let bytes: number
  let fileDevice: number
  try {
    const s = await stat(path)
    if (s.isDirectory()) return refuse('Det är en mapp, inte en videofil.')
    if (!s.isFile()) return refuse('Filen kan inte läsas.')
    bytes = s.size
    fileDevice = s.dev
  } catch (err) {
    return refuse((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Filen finns inte.' : 'Filen kan inte läsas.')
  }
  let media: MediaInfo
  try {
    // As shown: an anamorphic file's shape (and its working copy's) is its display shape.
    media = displayed(await probeMedia(path))
  } catch (err) {
    const message = errorText(err)
    return refuse(/videospår/i.test(message) ? 'Filen innehåller inget videospår.' : 'Filen kan inte läsas.', bytes)
  }
  if (!(media.width > 0 && media.height > 0)) return refuse('Filen innehåller inget videospår.', bytes)
  if (!(media.duration >= MIN_SECONDS)) return refuse('Filmen är för kort (under en halv sekund).', bytes)
  const reasons = workingCopyReasons(media, path)
  let duplicateOf: string | undefined
  try {
    duplicateOf = libraryImportOf(path) ?? (isInsideRoot(path) ? undefined : (await findDuplicate(path, bytes))?.id)
  } catch (err) {
    // Only a convenience: the file is imported again instead.
    console.warn(`Could not compare ${path} with earlier imports:`, err)
  }
  return {
    media,
    info: {
      path,
      name,
      bytes,
      ok: true,
      duration: media.duration,
      width: media.width,
      height: media.height,
      fps: media.fps,
      hasAudio: media.hasAudio,
      codec: media.codec,
      hdr: !!media.hdr,
      bitDepth: media.bitDepth,
      variableFrameRate: media.variableFrameRate,
      aspect: aspectLabel(media.width, media.height),
      workingCopy: reasons,
      cloneable: device !== undefined && device === fileDevice,
      ...(duplicateOf ? { duplicateOf } : {})
    }
  }
}

/** The files as the import dialog shows them; non-strings and repeats are left out. */
export async function inspectVideoFiles(paths: readonly unknown[]): Promise<VideoFileInfo[]> {
  const device = await libraryDevice()
  const out: VideoFileInfo[] = []
  for (const path of uniquePaths(paths)) out.push((await inspectOne(path, device)).info)
  return out
}

function uniquePaths(paths: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** File names in the order a person would sort them ("klipp 2" before "klipp 10"). */
export function byName(a: string, b: string): number {
  return basename(a).localeCompare(basename(b), 'sv', { numeric: true, sensitivity: 'base' })
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface ImportDeps {
  /** Adds the imports to sequences (new clips, takes of a clip). */
  sequences: SequenceService
  /** Sends `import:progress` to the windows. */
  progress: (p: ImportProgress) => void
  /** A new import row: the feed (and anything else listing generations) hears about it. */
  generationChanged: (g: Generation) => void
  /** A sequence changed (the sequence service announces its own changes; this is for the import's own). */
  notifySequence: (sequenceId: string) => void
}

/** "1,2 GB" (Swedish decimal comma). */
function formatGb(bytes: number): string {
  return `${(Math.max(0.1, bytes / 1024 ** 3)).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} GB`
}

/** Refuses (Swedish) when importing would leave less than MIN_FREE_BYTES on the library's disk. */
async function checkDiskSpace(needed: number): Promise<void> {
  let free: number
  try {
    const s = await statfs(libraryRoot())
    free = s.bavail * s.bsize
  } catch {
    // Can't tell: the copy itself fails cleanly (ENOSPC) if it doesn't fit.
    return
  }
  if (free - needed < MIN_FREE_BYTES) {
    throw new Error(
      `Det finns för lite ledigt utrymme på disken (behöver ~${formatGb(needed)}, och minst 2 GB ska vara kvar).`
    )
  }
}

/**
 * Copies `src` to `dest` (which must not exist), hashing it on the way: an APFS clone when `clone` (then hashed in
 * a read of its own), else a streamed copy. `onProgress` gets 0–1 over both. Resolves the SHA-256.
 */
async function copyAndHash(
  src: string,
  dest: string,
  bytes: number,
  clone: boolean,
  signal: AbortSignal,
  onProgress: (f: number) => void
): Promise<string> {
  if (clone) {
    try {
      // `clone` means same volume as the library. COPYFILE_FICLONE clones there on APFS (and copies on a volume that
      // can't clone). FICLONE_FORCE would be the strict variant, but macOS doesn't implement it (ENOSYS in Electron's
      // libuv), so it would turn every import into a full copy.
      await copyFile(src, dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      return await sha256Of(src, signal, onProgress)
    } catch (err) {
      if (isAbort(err, signal)) throw err
      await rm(dest, { force: true }).catch(() => {})
    }
  }
  const hash = createHash('sha256')
  let done = 0
  await pipeline(
    createReadStream(src),
    new Transform({
      transform(chunk: Buffer, _enc, next) {
        hash.update(chunk)
        done += chunk.length
        onProgress(bytes ? done / bytes : 1)
        next(null, chunk)
      }
    }),
    createWriteStream(dest, { flags: 'wx' }),
    { signal }
  )
  const copied = await stat(dest)
  if (copied.size !== bytes) throw new Error('kopian blev ofullständig')
  const sha256 = hash.digest('hex')
  const from = await stat(src).catch(() => undefined)
  if (from) rememberHash(src, from.size, from.mtimeMs, sha256)
  return sha256
}

/** The shape the target sequence's clips have: its first clip's take, else its defaults (else Studio's). */
async function sequenceAspect(sequenceId: string): Promise<number> {
  const rows = store.listSegmentRows(sequenceId)
  const first = rows[0] ? store.selectedTake(rows[0]) : undefined
  if (store.isUsable(first)) {
    try {
      const p = await probe(first.filePath)
      if (p.width > 0 && p.height > 0) return p.width / p.height
    } catch {
      // Its settings say the shape too.
    }
  }
  const row = store.requireSequenceRow(sequenceId)
  return (
    parseAspect(first?.params.aspectRatio) ??
    parseAspect(store.parseDefaults(row.defaults).aspectRatio) ??
    parseAspect(DEFAULT_PARAMS.aspectRatio) ??
    16 / 9
  )
}

/** One file's way into the library: the steps weighed by how long they take, for one progress bar. */
class FileProgress {
  private readonly weights: number[]
  private readonly total: number
  private step = 0
  private sent = -1

  constructor(
    private readonly emit: (fraction: number) => void,
    weights: number[]
  ) {
    this.weights = weights.map((w) => Math.max(0, w))
    this.total = this.weights.reduce((a, b) => a + b, 0) || 1
  }

  /** Moves on to step `index` (0-based) and reports how far into it the file is (0–1). */
  at(index: number, fraction: number): void {
    this.step = index
    const before = this.weights.slice(0, index).reduce((a, b) => a + b, 0)
    const f = Math.min(0.99, (before + (this.weights[index] ?? 0) * Math.min(1, Math.max(0, fraction))) / this.total)
    // Whole percents are plenty for a bar; IPC traffic stays small for a multi-GB copy.
    const percent = Math.floor(f * 100)
    if (percent === this.sent) return
    this.sent = percent
    this.emit(f)
  }

  next(): void {
    this.at(this.step + 1, 0)
  }
}

interface Placement {
  /** Crop the working copy to this aspect (fit 'crop' into a sequence of another shape). */
  cropTo?: number
}

/**
 * The import service: one import at a time (each file sequentially), cancellable with cancelImports, and counted as
 * busy while it runs so the library can't be switched, moved or tidied under it.
 */
export class ImportService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly running = new Set<AbortController>()
  /** Imports running or queued (the busy count). */
  private importing = 0
  /** Paths of files waiting or being imported (counted: the same file may be in two imports). */
  private readonly pending = new Map<string, number>()
  /** Files whose own Avbryt was pressed before they started: they are skipped. */
  private readonly skipped = new Set<string>()
  /** The file being imported right now, with the abort of that file alone. */
  private readonly current = new Map<string, AbortController>()
  /**
   * Files of the running and queued imports that haven't finished, with how far they are, by path: what the status
   * summary (work.ts) shows, also after the view that started the import is gone.
   */
  private readonly files = new Map<
    string,
    { name: string; fraction: number; target: ImportTarget; startedAt: number }
  >()

  constructor(private readonly deps: ImportDeps) {}

  /** Why the library can't be switched or tidied right now (Swedish), or undefined. */
  isBusy(): string | undefined {
    return this.importing > 0 ? IMPORT_BUSY : undefined
  }

  /**
   * Stops imports; what is half made is removed. With `path` (a file card's Avbryt) only that file: stopped where it
   * is, or skipped when it hasn't started; the other files go on. Without it (the app quitting) every running and
   * queued import.
   */
  cancel(path?: string): void {
    if (typeof path === 'string' && path) {
      if (!this.pending.has(path)) return
      this.skipped.add(path)
      this.current.get(path)?.abort()
      return
    }
    for (const c of this.running) c.abort()
  }

  private track(paths: readonly string[], delta: 1 | -1): void {
    for (const p of paths) {
      const n = (this.pending.get(p) ?? 0) + delta
      if (n > 0) this.pending.set(p, n)
      else {
        this.pending.delete(p)
        this.skipped.delete(p)
      }
    }
  }

  inspect(paths: readonly unknown[]): Promise<VideoFileInfo[]> {
    return inspectVideoFiles(paths)
  }

  /** The files being imported (or waiting for their turn) right now, in the order they were given. */
  active(): { path: string; name: string; fraction: number; target: ImportTarget; startedAt: number }[] {
    return [...this.files].map(([path, f]) => ({ path, ...f }))
  }

  /**
   * Imports the files into the library and puts them where `target` says. Every file is looked at before anything is
   * copied, and one that can't be imported never stops the others (it is reported in `errors`). Files go in name
   * order: a sequence gets one new clip per file, each after the previous; a clip gets each as a take, the last one
   * selected. A file imported before (same content, its video still there) is used again rather than copied twice.
   */
  import(paths: readonly unknown[], target: ImportTarget): Promise<ImportResult> {
    const controller = new AbortController()
    const files = uniquePaths(paths)
    this.running.add(controller)
    this.importing++
    this.track(files, 1)
    const startedAt = Date.now()
    if (target && typeof target === 'object') {
      for (const path of files) this.files.set(path, { name: basename(path), fraction: 0, target, startedAt })
    }
    const run = this.queue.then(() => this.run(files, target, controller.signal))
    this.queue = run.catch(() => {})
    return run.finally(() => {
      this.running.delete(controller)
      this.importing--
      this.track(files, -1)
      // A file this import still lists (refused before it began, say) is no longer on its way.
      for (const path of files) if (this.files.get(path)?.startedAt === startedAt) this.files.delete(path)
    })
  }

  private async run(paths: string[], target: ImportTarget, signal: AbortSignal): Promise<ImportResult> {
    const kind = target?.kind
    if (kind !== 'feed' && kind !== 'sequence' && kind !== 'segment') throw new Error('Okänt mål för importen.')
    // Checked before anything is looked at: a target that is gone (or a storyboard) takes no files.
    const sequenceId =
      kind === 'sequence'
        ? store.requirePlainSequence(target.sequenceId).id
        : kind === 'segment'
          ? store.requirePlainSegment(target.segmentId).sequence_id
          : undefined
    const segmentId = kind === 'segment' ? store.requireSegmentRow(target.segmentId).id : undefined
    const fit = kind !== 'feed' && target.fit === 'crop' ? 'crop' : 'pad'
    // Not while "Städa upp" or a library switch moves folders.
    await libraryOperationSettled()

    const result: ImportResult = { generationIds: [], errors: [], ...(sequenceId ? { sequenceId } : {}) }
    if (kind !== 'feed') result.segmentIds = []
    const idByPath = new Map<string, string>()
    const report = (p: Omit<ImportProgress, 'sequenceId' | 'segmentId'>): void => {
      // Before the event goes out: the summary read on it shows the file's state as the event says.
      const file = this.files.get(p.path)
      if (p.done) this.files.delete(p.path)
      else if (file) file.fraction = p.fraction
      try {
        this.deps.progress({ ...p, ...(sequenceId ? { sequenceId } : {}), ...(segmentId ? { segmentId } : {}) })
      } catch (err) {
        console.warn('Import progress could not be sent:', err)
      }
    }

    // Every file is looked at first; one that can't be imported is reported and the rest go ahead.
    const device = await libraryDevice()
    const ok: Inspected[] = []
    for (const path of paths) {
      if (signal.aborted) break
      const inspected = await inspectOne(path, device)
      if (inspected.info.ok && inspected.media) ok.push(inspected)
      else {
        const message = inspected.info.error ?? `${basename(path)}: Filen kan inte läsas.`
        result.errors.push({ path, message })
        report({ path, fraction: 0, done: true, error: message })
      }
    }
    ok.sort((a, b) => byName(a.info.path, b.info.path))
    for (const f of ok) report({ path: f.info.path, fraction: 0 })

    const cropTo = fit === 'crop' && sequenceId ? await sequenceAspect(sequenceId) : undefined
    let after = kind === 'sequence' ? target.afterSegmentId : undefined
    for (const [i, file] of ok.entries()) {
      const path = file.info.path
      if (signal.aborted) {
        // The files not started yet are simply not imported; their cards go.
        for (const rest of ok.slice(i)) report({ path: rest.info.path, fraction: 0, done: true, error: CANCELLED })
        break
      }
      // This file's own Avbryt, pressed before it started: skipped, the others go on.
      if (this.skipped.has(path)) {
        this.skipped.delete(path)
        report({ path, fraction: 0, done: true, error: CANCELLED })
        continue
      }
      // One file can be stopped on its own (its card's Avbryt), or with the whole import.
      const one = new AbortController()
      const stopOne = (): void => one.abort()
      signal.addEventListener('abort', stopOne, { once: true })
      this.current.set(path, one)
      try {
        const g = await this.importFile(file, { cropTo }, one.signal, (fraction) => report({ path, fraction }))
        idByPath.set(path, g.id)
        let clipId: string | undefined
        if (kind === 'sequence' && sequenceId) {
          // One clip per file, each after the one before; it doesn't continue from the previous clip.
          const added = await this.deps.sequences.insertSegment(sequenceId, {
            fromGenerationId: g.id,
            afterSegmentId: after,
            continueFromPrevious: false
          })
          clipId = added.segmentId
          after = clipId
        } else if (kind === 'segment' && segmentId) {
          const added = await this.deps.sequences.addTakeFrom(segmentId, g.id, { select: true })
          clipId = added.segmentId
          // An earlier import that is another clip's take was copied for this clip: the copy is the take added.
          idByPath.set(path, added.generationId)
        }
        if (clipId) result.segmentIds?.push(clipId)
        report({ path, fraction: 1, done: true, generationId: idByPath.get(path) ?? g.id })
      } catch (err) {
        if (signal.aborted) {
          for (const rest of ok.slice(i)) report({ path: rest.info.path, fraction: 0, done: true, error: CANCELLED })
          break
        }
        if (isAbort(err, one.signal)) {
          this.skipped.delete(path)
          report({ path, fraction: 0, done: true, error: CANCELLED })
          continue
        }
        const message = errorText(err)
        const named = message.startsWith(`${file.info.name}:`) ? message : `${file.info.name}: ${message}`
        result.errors.push({ path, message: named })
        report({ path, fraction: 0, done: true, error: named })
      } finally {
        signal.removeEventListener('abort', stopOne)
        this.current.delete(path)
      }
    }
    // In the order the files were given.
    result.generationIds = paths.flatMap((p) => {
      const id = idByPath.get(p)
      return id ? [id] : []
    })
    if (sequenceId && kind === 'sequence' && result.segmentIds?.length) this.deps.notifySequence(sequenceId)
    return result
  }

  /**
   * One file into Egna klipp/<today>/: clone or copy (hashing it on the way), a working copy when needed (or when
   * cropping), a poster, the row. Everything is made in the library's scratch folder first and only moved into the
   * visible folder once complete, so Avbryt (or a crash) never leaves half a film in Finder: the scratch folder is
   * the app's own and is cleared when the library is opened. Resolves the row (an earlier import when reused).
   */
  private async importFile(
    file: Inspected,
    placement: Placement,
    signal: AbortSignal,
    onProgress: (fraction: number) => void
  ): Promise<db.StoredGeneration> {
    const { info } = file
    const media = file.media!
    const fileAspect = media.width / media.height
    const crop =
      placement.cropTo !== undefined && Math.abs(fileAspect - placement.cropTo) > SAME_ASPECT
        ? placement.cropTo
        : undefined

    // Imported before: used again (unless it is to be cropped and the earlier one isn't cropped to this shape).
    const earlier = await findDuplicate(info.path, info.bytes, signal).catch((err: unknown) => {
      if (isAbort(err, signal)) throw err
      return undefined
    })
    if (earlier && (await this.reusable(earlier, crop))) return earlier

    const reasons = [...info.workingCopy]
    const working = reasons.length > 0 || crop !== undefined
    if (crop !== undefined) reasons.push(`beskuren till ${aspectLabel(crop * 1000, 1000)}`)
    const longSide = Math.min(MAX_LONG_SIDE, Math.max(media.width, media.height))
    const workingBytes = working
      ? media.duration * (longSide > 1280 ? WORKING_COPY_RATE_1080 : WORKING_COPY_RATE_SMALL)
      : 0
    await checkDiskSpace((info.cloneable ? 0 : info.bytes) + workingBytes)

    const progress = new FileProgress(onProgress, [
      info.cloneable ? info.bytes / HASH_BYTES_PER_SECOND : info.bytes / COPY_BYTES_PER_SECOND,
      working ? Math.max(1, media.duration / NORMALIZE_REALTIME) : 0,
      0.5
    ])

    const id = randomUUID()
    const now = Date.now()
    const name = info.name
    const ext = extname(name).toLowerCase() || '.mp4'
    const title = basename(name, extname(name)).trim() || 'Eget klipp'
    const scratchOriginal = join(tmpDir(), `import-${id}${ext}`)
    const scratchWorking = join(tmpDir(), `import-${id}-arbetskopia.mp4`)
    const poster = join(thumbsDir(), `${id}.jpg`)
    const placed: string[] = []
    let inserted = false
    try {
      progress.at(0, 0)
      const sha256 = await copyAndHash(info.path, scratchOriginal, info.bytes, info.cloneable, signal, (f) =>
        progress.at(0, f)
      ).catch((err: unknown) => {
        if (isAbort(err, signal)) throw abortError()
        throw new Error(`Filen kunde inte kopieras till biblioteket: ${fileErrorReason(err)}.`)
      })
      if (signal.aborted) throw abortError()

      if (working) {
        progress.at(1, 0)
        const audio = media.audioStreams.find((a) => a.decodable)
        await normalizeVideo(scratchOriginal, scratchWorking, {
          hdr: media.hdr,
          maxLongSide: MAX_LONG_SIDE,
          ...(audio ? { audioStream: audio.index } : {}),
          ...(crop !== undefined ? { crop: { aspect: crop } } : {}),
          signal,
          onProgress: (f: number) => progress.at(1, f)
        }).catch((err: unknown) => {
          if (isAbort(err, signal)) throw abortError()
          throw new Error(`Arbetskopian kunde inte göras: ${errorText(err)}`)
        })
      }
      if (signal.aborted) throw abortError()

      // What is played, cut and continued from: the working copy when there is one.
      progress.at(2, 0)
      const playable = working ? scratchWorking : scratchOriginal
      const measured = await probe(playable)
      const thumb = await extractThumbnail(playable, poster).catch((err: unknown) => {
        // The backfill makes it at the next library open.
        console.warn(`Could not make a poster for the import of ${name}:`, err)
        return undefined
      })
      if (signal.aborted) throw abortError()

      // Into Egna klipp/<today>/, by the home rule (the same names "Städa upp" would give them): with a working copy,
      // the working copy is "<title> (arbetskopia).mp4" and the original "<title><ext>" beside it. The scratch path
      // only stands for "has an original" here; the row records where the original lands.
      const located = {
        createdAt: now,
        prompt: '',
        source: 'import' as const,
        title,
        segmentId: undefined,
        originalPath: working ? scratchOriginal : undefined
      }
      const home = videoLocation(located)
      const originalPlace = originalHome(located) ?? home
      const original = await placeFile(scratchOriginal, originalPlace.dir, originalPlace.base, ext)
      placed.push(original)
      const workingCopy = working ? await placeFile(scratchWorking, home.dir, home.base, '.mp4') : undefined
      if (workingCopy) placed.push(workingCopy)

      const duration = measured.duration > 0 ? measured.duration : media.duration
      const short = Math.min(measured.width, measured.height) || Math.min(media.width, media.height)
      const g: db.StoredGeneration = {
        id,
        createdAt: now,
        source: 'import',
        title,
        model: '',
        prompt: '',
        params: {
          model: '',
          prompt: '',
          duration: `${Math.max(1, Math.round(duration))}s`,
          resolution: `${short}p`,
          aspectRatio: aspectLabel(measured.width || media.width, measured.height || media.height)
        },
        status: 'completed',
        filePath: workingCopy ?? original,
        ...(workingCopy ? { originalPath: original } : {}),
        thumbPath: thumb,
        videoDuration: duration,
        completedAt: now,
        recipe: {
          op: 'import',
          label: 'Importerad',
          timing: 'same',
          mix: { bed: { source: { kind: 'generation', id }, gains: [] }, layers: [] },
          import: { name, bytes: info.bytes, sha256, workingCopy: reasons, fit: crop !== undefined ? 'crop' : 'pad' }
        },
        reviewCount: 0,
        agentReviewCount: 0
      }
      db.getDb().transaction(() => db.insertGeneration(g))()
      inserted = true
      try {
        this.deps.generationChanged(toPublic(g))
      } catch (err) {
        console.warn('Could not announce an imported clip:', err)
      }
      return db.getGeneration(id) ?? g
    } finally {
      // Gone already when they were placed; what is left is half made (or was never recorded).
      await rm(scratchOriginal, { force: true }).catch(() => {})
      await rm(scratchWorking, { force: true }).catch(() => {})
      if (!inserted) {
        for (const file of placed) await rm(file, { force: true }).catch(() => {})
        await rm(poster, { force: true }).catch(() => {})
      }
    }
  }

  /** An earlier import can stand in for this one: no crop wanted, or it was cropped to the same shape. */
  private async reusable(earlier: db.StoredGeneration, crop: number | undefined): Promise<boolean> {
    if (crop === undefined) return earlier.recipe?.import?.fit !== 'crop'
    if (earlier.recipe?.import?.fit !== 'crop' || !earlier.filePath) return false
    try {
      const p = await probe(earlier.filePath)
      return Math.abs(p.width / p.height - crop) <= SAME_ASPECT
    } catch {
      return false
    }
  }
}

/**
 * Registers imports:inspect, imports:import and imports:cancel. An agent's call may only name files it uploaded to
 * Studio or that the library records (assertAgentFiles): inspecting reads a file as much as importing does. Returns
 * what index.ts needs: whether an import is running (the library switch's busy check), a stop for quitting, and the
 * service (its active files for the status summary).
 */
export function registerImportIpc(deps: ImportDeps): {
  isBusy(): string | undefined
  stop(): void
  service: ImportService
} {
  const service = new ImportService(deps)
  ipcMain.handle('imports:inspect', (e, paths: unknown) => {
    const files = Array.isArray(paths) ? paths : []
    assertAgentFiles(e, files)
    return service.inspect(files)
  })
  ipcMain.handle('imports:import', (e, paths: unknown, target: ImportTarget) => {
    const files = Array.isArray(paths) ? paths : []
    assertAgentFiles(e, files)
    return service.import(files, target)
  })
  // A file card's Avbryt names its file; without a path every import stops.
  ipcMain.handle('imports:cancel', (_e, path?: unknown) => service.cancel(typeof path === 'string' ? path : undefined))
  return {
    isBusy: () => service.isBusy(),
    stop: () => service.cancel(),
    service
  }
}
