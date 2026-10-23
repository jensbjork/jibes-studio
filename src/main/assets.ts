import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import { directorPreset, sanitizeDirection } from '@shared/direction'
import { DIRECTOR_PRESETS } from '@shared/directors'
import { pathKey } from '@shared/generation-filter'
import {
  DEFAULT_AUDIO_CLIP_SECONDS,
  MAX_AUDIO_CLIP_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  MIN_VIDEO_CLIP_SECONDS,
  referenceVideoWindow
} from '@shared/models'
import type {
  Asset,
  AssetAudio,
  AssetFileOrigin,
  AssetImage,
  AssetInput,
  AssetKind,
  DescribedAsset,
  Direction,
  GenerationParams,
  ReferenceVideo
} from '@shared/types'
import { addUnseen, getDb, isStoredPathRecorded, rewriteStoredPrefix } from './db'
import { probeAudio } from './ffmpeg'
import {
  assetsDir,
  folderRecordedInDb,
  fromStoredPath,
  isAssetKind,
  isInsideRoot,
  libraryOperationSettled,
  movePath,
  referencesDayDir,
  renameLibraryFolder,
  safeName,
  toStoredPath,
  tmpDir,
  uniqueName
} from './paths'
import { videoDuration } from './reference-videos'
import { copyInto, fileErrorReason, placeFile, serialized } from './references'

// Assets: characters, environments, products, outfits and poses (each in its folder: Characters, Environments …)
// — each a name, a description and reference photos. Characters and environments can also have audio
// clips: a voice ("Voice") or a soundscape ("Soundscape"), of which a window of 2–15 s is sent to Venice as
// reference audio. Every asset has a folder <kind folder>/<name>/ with copies of its photos and audio (under their
// original names) and Description.txt, so an asset keeps working when the originals are moved or deleted, and the
// folder reads well in Finder. The database is the source of truth; the folder follows renames and deletes. A
// character may have a default outfit (assets.default_outfit_id, cleared by the FK when the outfit goes). A photo or
// clip an agent added records which agent (and the host a fetched file came from) in its `origin` column.
// Directors are assets too, but never references: a director's photos are its style frames, and its
// way of making a film (assets.direction, schema 14) holds its style videos, copied into its folder like the photos
// (stored relative, so renames and "Tidy up" carry them along with every other stored path).

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
/** The video formats a director's style videos may be (the import dialog's). */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv'])
/** The audio formats an asset accepts (also the file dialog's filter). */
export const AUDIO_FILE_TYPES: readonly string[] = ['mp3', 'wav', 'm4a', 'aac', 'aiff', 'aif', 'flac', 'ogg']
const AUDIO_EXTENSIONS = new Set(AUDIO_FILE_TYPES.map((type) => `.${type}`))
/** The kinds that can have audio clips: a character's voice, an environment's soundscape. */
const AUDIO_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['character', 'environment'])
/**
 * Shorter files are refused on import: nothing usable as a voice or a soundscape fits in them. Long files are
 * accepted (the reference window picks the part that is sent); the library view points out ones over a minute.
 */
const MIN_AUDIO_FILE_SECONDS = 1
const DESCRIPTION_FILE = 'Description.txt'
/**
 * Folder name for a name with nothing usable in it (e.g. "..."). The same for every kind, and the same as
 * "Tidy up" uses, so the two never disagree about which folder an asset should have.
 */
const UNNAMED = 'Untitled'
const GONE = 'It no longer exists in the library.'
const AUDIO_GONE = 'The audio no longer exists.'
const nameCollator = new Intl.Collator('en')

/** The asset in definite form, for messages ("The environment needs a name."). */
const THE: Record<AssetKind, string> = {
  character: 'The character',
  environment: 'The environment',
  product: 'The product',
  outfit: 'The outfit',
  pose: 'The pose',
  director: 'The director'
}

let notifyChange: () => void = () => {}
/** Image files moved (a renamed asset folder, or a character from before folders given one). */
let notifyFilesMoved: () => void = () => {}

/** Called by registerLibraryIpc: changed fires after every asset change, filesMoved after images moved. */
export function setAssetListeners(listeners: { changed: () => void; filesMoved: () => void }): void {
  notifyChange = listeners.changed
  notifyFilesMoved = listeners.filesMoved
}

/** Asset changes create, move and rename files; one at a time keeps folder names and disk in step. */
const assetQueue = serialized()
let assetTasks = 0

function assetTask<T>(task: () => Promise<T>): Promise<T> {
  return assetQueue(async () => {
    // Not while "Tidy up" or a switch moves files: they read the folder names once and move files by them.
    // Counted as busy only once it runs, so a task waiting here doesn't make that switch refuse itself.
    await libraryOperationSettled()
    assetTasks++
    try {
      return await task()
    } finally {
      assetTasks--
    }
  })
}

/** Why the library can't be switched or tidied right now, or undefined when no asset work runs. */
export function assetWorkBusy(): string | undefined {
  return assetTasks > 0
    ? 'Images, audio or videos for a character, environment, product, outfit, pose or director are being saved right now.'
    : undefined
}

interface AssetRow {
  id: string
  kind: AssetKind
  name: string
  description: string
  /** Folder name under the kind's folder; NULL for characters from before folders (given one when first touched). */
  folder: string | null
  /** Characters only: an asset of kind 'outfit'. */
  default_outfit_id: string | null
  /** Directors only: JSON Direction, style video paths in stored form (schema 14); NULL for every other kind. */
  direction?: string | null
  created_at: number
  updated_at: number
}

interface AssetImageRow {
  id: string
  asset_id: string
  /** Stored form: relative to the library root (absolute only for a file outside it). */
  file_path: string
  position: number
  created_at: number
  /** JSON AssetFileOrigin when an agent added it; NULL for the user (schema 12). */
  origin?: string | null
}

interface AssetAudioRow {
  id: string
  asset_id: string
  /** Stored form, like asset_images.file_path. */
  file_path: string
  position: number
  /** Seconds, the whole file (probed on import). */
  duration: number
  clip_start: number
  /** NULL: the default window, min(duration, 10). */
  clip_length: number | null
  created_at: number
  /**
   * When the user confirmed they may use this voice ("May be cloned for new lines"), so the Editor may clone it for new
   * lines; NULL: not confirmed. Set only by the user in Studio (schema 11).
   */
  clone_consent_at?: number | null
  /** JSON AssetFileOrigin when an agent added it; NULL for the user and for Studio's own clips (schema 12). */
  origin?: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** IPC input is untyped at runtime; treat anything that isn't a string as empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Ids arrive over IPC; reject anything that isn't one before it reaches a query. */
function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Invalid ID.')
  return id
}

function requireKind(value: unknown): AssetKind {
  if (!isAssetKind(value)) throw new Error('Unknown kind of library item.')
  return value
}

/** Longest agent name kept in an origin (a client's name is free text). */
const MAX_ORIGIN_AGENT = 60
/** The name recorded when an agent's call names no agent. */
const UNNAMED_AGENT = 'an agent'
/** A host name or an IP address, nothing more: an origin must never carry a URL (it may hold tokens). */
const HOST_PATTERN = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[?[0-9a-f:.]+\]?$/i

/**
 * What an agent's call says about who added a file, as it is stored: the agent's name (one line, at most 60
 * characters) and the host a fetched file came from (only a host name or an address; anything else is dropped).
 * `at` is now. undefined: the user added it (the handler passes an origin only for an agent's call).
 */
function originFrom(value: unknown, at: number): AssetFileOrigin | undefined {
  if (value === undefined || value === null) return undefined
  const v = (typeof value === 'object' ? value : {}) as { agent?: unknown; host?: unknown }
  const name = text(v.agent).replace(/[\p{Cc}\s]+/gu, ' ').trim()
  const agent = Array.from(name).slice(0, MAX_ORIGIN_AGENT).join('').trim()
  const host = text(v.host).trim().toLowerCase()
  return {
    agent: agent || UNNAMED_AGENT,
    ...(host && host.length <= 253 && HOST_PATTERN.test(host) ? { host } : {}),
    at
  }
}

/** An origin column read back; anything malformed counts as the user's (it is only ever informative). */
function parseOrigin(json: string | null | undefined): AssetFileOrigin | undefined {
  if (typeof json !== 'string' || !json) return undefined
  try {
    const value = JSON.parse(json) as { agent?: unknown; host?: unknown; at?: unknown } | null
    if (!value || typeof value !== 'object' || typeof value.agent !== 'string' || !value.agent) return undefined
    return {
      agent: value.agent,
      ...(typeof value.host === 'string' && value.host ? { host: value.host } : {}),
      at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0
    }
  } catch {
    return undefined
  }
}

/** To the millisecond, rounded down so a window never ends past the file it was clamped into. */
function toMs(seconds: number): number {
  return Math.floor(seconds * 1000 + 1e-6) / 1000
}

/**
 * The reference window of an audio clip: `length` seconds (default min(duration, 10)) clamped to the 2–15 s
 * Venice accepts and to the file, starting at `start` moved inside the file so the whole window fits. A file
 * shorter than 2 s gets all of it: the prompt check then explains that it is too short to send.
 */
export function resolveAudioWindow(
  duration: number,
  start?: number | null,
  length?: number | null
): { clipStart: number; clipLength: number } {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  const wanted =
    typeof length === 'number' && Number.isFinite(length) ? length : Math.min(total, DEFAULT_AUDIO_CLIP_SECONDS)
  const clipLength = toMs(Math.min(Math.max(wanted, MIN_AUDIO_CLIP_SECONDS), MAX_AUDIO_CLIP_SECONDS, total))
  const from = typeof start === 'number' && Number.isFinite(start) ? start : 0
  const clipStart = toMs(Math.min(Math.max(from, 0), Math.max(0, total - clipLength)))
  return { clipStart, clipLength }
}

/** A reason from elsewhere as the end of a sentence: "…: ffmpeg was not found." */
function reasonText(err: unknown): string {
  const text = fileErrorReason(err)
    .replace(/^Could not read the audio file:\s*/u, '')
    .replace(/[.\s]+$/u, '')
  return text.charAt(0).toLocaleLowerCase('en') + text.slice(1)
}

/** Folder names compare the way macOS file systems do: ignoring case and Unicode normalization. */
function folderKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('sv')
}

/** A folder name from the database is only trusted as one plain path segment. */
function isPlainName(name: string | null): name is string {
  return !!name && !/[/\\\0]/.test(name) && name !== '.' && name !== '..'
}

/** Removes a folder if nothing but Finder's .DS_Store is left in it; never removes anything else. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const names = await readdir(dir)
    if (names.some((n) => n !== '.DS_Store')) return
    await rm(join(dir, '.DS_Store'), { force: true })
    await rmdir(dir)
  } catch {
    // Already gone, or something appeared meanwhile: leave it.
  }
}

/**
 * Moves a library file to the Trash so a mistake can be undone; deletes it if there is no Trash.
 * Files outside the library are never touched.
 */
async function trashFile(path: string): Promise<void> {
  if (!isInsideRoot(path) || !existsSync(path)) return
  try {
    await shell.trashItem(path)
  } catch {
    await rm(path, { force: true }).catch((err: unknown) => console.warn(`Could not remove ${path}:`, err))
  }
}

// ── Asset folders ────────────────────────────────────────────────────────────

/**
 * A folder name under the kind's folder for an asset called `name`: "Anna", or "Anna (2)" … when that is
 * taken on disk, claimed by another asset of the kind (whose folder may be missing, e.g. removed in
 * Finder), or still recorded in generations or clips (a deleted asset's photos they used): a folder moved
 * or created there would put its own same-named photos at those paths. The asset's own current folder counts
 * as free for itself (also under another letter case).
 */
function freeFolderName(kind: AssetKind, name: string, own?: { id: string; folder: string | null }): string {
  const parent = assetsDir(kind)
  const base = safeName(name, { fallback: UNNAMED })
  const ownKey = isPlainName(own?.folder ?? null) ? folderKey(own!.folder!) : undefined
  const claimed = new Set(
    (
      getDb()
        .prepare('SELECT folder FROM assets WHERE kind = ? AND folder IS NOT NULL AND id IS NOT ?')
        .pluck()
        .all(kind, own?.id ?? null) as string[]
    ).map(folderKey)
  )
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`
    const key = folderKey(candidate)
    if (key === ownKey) return candidate
    const path = join(parent, candidate)
    if (!claimed.has(key) && !existsSync(path) && !folderRecordedInDb(path)) return candidate
  }
}

/** Mirrors the description into Description.txt for Finder; removed when empty. Best effort. */
async function writeDescription(dir: string, description: string): Promise<void> {
  const file = join(dir, DESCRIPTION_FILE)
  try {
    if (!description) {
      await rm(file, { force: true })
      return
    }
    const content = `${description}\n`
    // Written in the scratch folder and renamed over the old file, so it is never seen half-written.
    const tmp = join(tmpDir(), `${randomUUID()}.txt`)
    try {
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, file)
    } catch {
      await rm(tmp, { force: true }).catch(() => {})
      await writeFile(file, content, 'utf8')
    }
  } catch (err) {
    console.warn(`Could not update ${file}:`, err)
  }
}

/**
 * Brings one image file into the asset's folder: moved when it is elsewhere in the library (stored paths
 * that point at it follow, e.g. reference images in generation params), copied when it lies outside the
 * library, so the user's own files are never taken from where they keep them.
 */
async function moveImageInto(image: AssetImageRow, dir: string, base: string): Promise<void> {
  const src = fromStoredPath(image.file_path)
  if (dirname(src) === dir || !existsSync(src)) return
  const ext = extname(src).toLowerCase()
  const db = getDb()
  if (!isInsideRoot(src)) {
    const copy = await copyInto(src, dir, base, ext)
    try {
      db.prepare('UPDATE asset_images SET file_path = ? WHERE id = ?').run(toStoredPath(copy), image.id)
    } catch (err) {
      await rm(copy, { force: true }).catch(() => {})
      throw err
    }
    return
  }
  const dest = await placeFile(src, dir, base, ext)
  try {
    db.transaction(() => rewriteStoredPrefix(toStoredPath(src), toStoredPath(dest)))()
  } catch (err) {
    // Put the file back so every stored path still points at it.
    await movePath(dest, src).catch((e: unknown) => console.warn(`Could not move ${dest} back to ${src}:`, e))
    throw err
  }
  // The old per-character folder (e.g. characters/<id>/) goes once it's empty; the base folder and its
  // top-level folders are left to "Tidy up".
  const oldDir = toStoredPath(dirname(src))
  if (!isAbsolute(oldDir) && oldDir.includes('/')) await removeIfEmpty(dirname(src))
}

/**
 * The asset's folder name, (re)created on disk if missing. A character from before folders gets one now and
 * its images move into it. The folder is recorded first and each image's path right after its move, so an
 * interruption leaves every row pointing at an existing file ("Tidy up" moves the rest).
 */
async function ensureFolder(row: AssetRow): Promise<string> {
  if (isPlainName(row.folder)) {
    assetsDir(row.kind, row.folder)
    return row.folder
  }
  const folder = freeFolderName(row.kind, row.name)
  const dir = assetsDir(row.kind, folder)
  try {
    getDb().prepare('UPDATE assets SET folder = ? WHERE id = ?').run(folder, row.id)
  } catch (err) {
    await removeIfEmpty(dir)
    throw err
  }
  row.folder = folder
  const label = safeName(row.name, { fallback: UNNAMED })
  const images = imageRows(row.id)
  for (const [index, image] of images.entries()) {
    try {
      await moveImageInto(image, dir, `${label} ${index + 1}`)
    } catch (err) {
      console.warn(`Could not move image ${image.id} into ${dir}:`, err)
    }
  }
  await writeDescription(dir, row.description)
  if (images.length) notifyFilesMoved()
  return folder
}

/**
 * Gives the folder the asset's new name; stored paths under it follow, and the new folder name is recorded
 * in the same transaction (renameLibraryFolder). Skipped when the name maps to the same folder name. If the
 * folder can't be renamed (e.g. a file in it is open elsewhere), the asset keeps its old folder and the
 * rename itself still goes through.
 */
async function renameFolder(row: AssetRow, folder: string, newName: string): Promise<string> {
  if (safeName(newName, { fallback: UNNAMED }) === safeName(row.name, { fallback: UNNAMED })) return folder
  const next = freeFolderName(row.kind, newName, { id: row.id, folder })
  if (next === folder) return folder
  const from = join(assetsDir(row.kind), folder)
  const to = join(assetsDir(row.kind), next)
  try {
    await renameLibraryFolder(from, to, () => {
      getDb().prepare('UPDATE assets SET folder = ? WHERE id = ?').run(next, row.id)
    })
  } catch (err) {
    console.warn(`Could not rename ${from} to ${to}:`, err)
    return folder
  }
  await renameNamedImages(row.id, to, row.name, newName).catch((err: unknown) =>
    console.warn(`Could not rename the photos in ${to}:`, err)
  )
  notifyFilesMoved()
  return next
}

/**
 * Photos named after the asset ("Anna 1.jpg" — how photos from a converted library are named) follow a
 * rename, so the folder doesn't end up full of the old name. Photos under their own original names stay as
 * they are.
 */
async function renameNamedImages(assetId: string, dir: string, oldName: string, newName: string): Promise<void> {
  const oldLabel = safeName(oldName, { fallback: UNNAMED })
  const newLabel = safeName(newName, { fallback: UNNAMED })
  if (oldLabel === newLabel) return
  const escaped = oldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(`^${escaped} (\\d+)$`)
  for (const image of imageRows(assetId)) {
    const src = fromStoredPath(image.file_path)
    const ext = extname(src)
    const match = named.exec(basename(src, ext).normalize('NFC'))
    if (!match || dirname(src) !== dir || !existsSync(src)) continue
    const wanted = `${newLabel} ${match[1]}${ext.toLowerCase()}`
    // "anna 1.jpg" → "Anna 1.jpg" is the same name to the disk (and to the row recording it), which
    // uniqueName would count as taken; it is a rename in place (movePath allows the same entry).
    const dest =
      folderKey(wanted) === folderKey(basename(src))
        ? join(dir, wanted)
        : join(dir, uniqueName(dir, `${newLabel} ${match[1]}`, ext.toLowerCase()))
    if (dest === src) continue
    await movePath(src, dest)
    try {
      getDb().transaction(() => rewriteStoredPrefix(toStoredPath(src), toStoredPath(dest)))()
    } catch (err) {
      // Put the file back so every stored path still points at it.
      await movePath(dest, src).catch((e: unknown) => console.warn(`Could not move ${dest} back to ${src}:`, e))
      throw err
    }
  }
}

/**
 * A photo or audio clip that generations or sequence clips still use (as start, end or reference image, or
 * as reference audio) isn't trashed with its asset: it moves to Reference images/<today>/, where submitted
 * pictures from outside the library go, and those rows follow, so "Use again" and "Generate missing" keep the
 * file and the prompt's @ImageN / @AudioN numbers. Call once the file's asset row is gone, so only other rows
 * count. True when it was kept.
 */
async function keepUsedFile(path: string, fallback: string): Promise<boolean> {
  const stored = toStoredPath(path)
  if (isAbsolute(stored) || !existsSync(path) || !isStoredPathRecorded(stored)) return false
  const ext = extname(path)
  try {
    const dest = await placeFile(
      path,
      referencesDayDir(new Date()),
      safeName(basename(path, ext), { fallback }),
      ext.toLowerCase()
    )
    try {
      getDb().transaction(() => rewriteStoredPrefix(stored, toStoredPath(dest)))()
    } catch (err) {
      // Put the file back so every stored path still points at it.
      await movePath(dest, path).catch((e: unknown) => console.warn(`Could not move ${dest} back to ${path}:`, e))
      throw err
    }
    return true
  } catch (err) {
    console.warn(`Could not keep ${path} for the generations that use it:`, err)
    return false
  }
}

/** Removes a deleted asset's folder: to the Trash, or (without a Trash) only the files the app put there. */
async function trashAssetFolder(dir: string, files: { file_path: string }[]): Promise<void> {
  if (!existsSync(dir)) return
  try {
    await shell.trashItem(dir)
    return
  } catch (err) {
    console.warn(`Could not move ${dir} to the Trash:`, err)
  }
  // Anything the user added to the folder themselves stays, and with it the folder.
  for (const file of files) {
    const path = fromStoredPath(file.file_path)
    if (dirname(path) === dir) await rm(path, { force: true }).catch(() => {})
  }
  await rm(join(dir, DESCRIPTION_FILE), { force: true }).catch(() => {})
  await removeIfEmpty(dir)
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function imageRows(assetId: string): AssetImageRow[] {
  return getDb()
    .prepare('SELECT * FROM asset_images WHERE asset_id = ? ORDER BY position, created_at')
    .all(assetId) as AssetImageRow[]
}

function audioRows(assetId: string): AssetAudioRow[] {
  return getDb()
    .prepare('SELECT * FROM asset_audio WHERE asset_id = ? ORDER BY position, created_at')
    .all(assetId) as AssetAudioRow[]
}

function findAudioRow(id: string): AssetAudioRow | undefined {
  return getDb().prepare('SELECT * FROM asset_audio WHERE id = ?').get(id) as AssetAudioRow | undefined
}

function groupImages(rows: AssetImageRow[]): Map<string, AssetImage[]> {
  const byAsset = new Map<string, AssetImage[]>()
  for (const r of rows) {
    const images = byAsset.get(r.asset_id) ?? []
    const origin = parseOrigin(r.origin)
    images.push({ id: r.id, path: fromStoredPath(r.file_path), ...(origin ? { origin } : {}) })
    byAsset.set(r.asset_id, images)
  }
  return byAsset
}

function audioFromRow(r: AssetAudioRow): AssetAudio {
  const origin = parseOrigin(r.origin)
  return {
    id: r.id,
    path: fromStoredPath(r.file_path),
    duration: r.duration,
    ...resolveAudioWindow(r.duration, r.clip_start, r.clip_length),
    cloneConsent: typeof r.clone_consent_at === 'number',
    ...(origin ? { origin } : {})
  }
}

function groupAudio(rows: AssetAudioRow[]): Map<string, AssetAudio[]> {
  const byAsset = new Map<string, AssetAudio[]>()
  for (const r of rows) {
    const clips = byAsset.get(r.asset_id) ?? []
    clips.push(audioFromRow(r))
    byAsset.set(r.asset_id, clips)
  }
  return byAsset
}

function assetFromRow(r: AssetRow, images: AssetImage[], audio: AssetAudio[]): Asset {
  const asset: Asset = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    images,
    audio,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
  if (r.kind === 'character' && r.default_outfit_id) asset.defaultOutfitId = r.default_outfit_id
  if (r.kind === 'director') asset.direction = parseDirection(r.direction)
  return asset
}

// ── Directors' directions ────────────────────────────────────────────────────

/** A director's direction as stored (assets.direction), style video paths absolute; {} when there is none. */
function parseDirection(json: string | null | undefined): Direction {
  if (typeof json !== 'string' || !json) return {}
  try {
    const direction = sanitizeDirection(JSON.parse(json))
    if (direction.videos) direction.videos = direction.videos.map((v) => ({ ...v, path: fromStoredPath(v.path) }))
    return direction
  } catch {
    return {}
  }
}

/** The stored form of a direction: sanitized, style video paths relative inside the library; NULL when empty. */
function serializeDirection(direction: Direction): string | null {
  const clean = sanitizeDirection(direction)
  if (clean.videos) clean.videos = clean.videos.map((v) => ({ ...v, path: toStoredPath(v.path) }))
  return Object.keys(clean).length ? JSON.stringify(clean) : null
}

/** The style video paths of a stored direction (absolute). */
function styleVideoPaths(json: string | null | undefined): string[] {
  return (parseDirection(json).videos ?? []).map((v) => v.path)
}

/** A row of a kind this version knows; anything else (written by a newer Studio) is left alone. */
function findAssetRow(id: string): AssetRow | undefined {
  const row = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined
  return row && isAssetKind(row.kind) ? row : undefined
}

/** The row, or a plain error; `kind` (when the caller knows it) names what is gone. */
function requireAssetRow(id: unknown, kind?: unknown): AssetRow {
  const row = findAssetRow(safeId(id))
  if (!row) throw new Error(isAssetKind(kind) ? `${THE[kind]} no longer exists.` : GONE)
  return row
}

function getAsset(id: string): Asset {
  const row = requireAssetRow(id)
  return assetFromRow(row, groupImages(imageRows(id)).get(id) ?? [], audioRows(id).map(audioFromRow))
}

function orderedImageIds(assetId: string): string[] {
  return imageRows(assetId).map((r) => r.id)
}

function writeImagePositions(imageIds: string[]): void {
  const stmt = getDb().prepare('UPDATE asset_images SET position = ? WHERE id = ?')
  imageIds.forEach((id, position) => stmt.run(position, id))
}

function orderedAudioIds(assetId: string): string[] {
  return audioRows(assetId).map((r) => r.id)
}

function writeAudioPositions(audioIds: string[]): void {
  const stmt = getDb().prepare('UPDATE asset_audio SET position = ? WHERE id = ?')
  audioIds.forEach((id, position) => stmt.run(position, id))
}

/** The given ids first (ignoring strangers and repeats), then the rest in their current order. */
function reordered(current: string[], given: unknown): string[] {
  const known = new Set(current)
  const ids = Array.isArray(given) ? given : []
  const leading = [...new Set(ids.filter((id): id is string => typeof id === 'string' && known.has(id)))]
  const placed = new Set(leading)
  return [...leading, ...current.filter((id) => !placed.has(id))]
}

function touchAsset(id: string, now = Date.now()): void {
  getDb().prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(now, id)
}

/**
 * The default outfit to record for an asset of this kind: null for none. Only characters wear one, and it
 * has to be an outfit in the library.
 */
function defaultOutfitFor(kind: AssetKind, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (kind !== 'character') throw new Error('Only characters can have a default outfit.')
  const outfit = findAssetRow(safeId(value))
  if (!outfit) throw new Error('The chosen outfit no longer exists.')
  if (outfit.kind !== 'outfit') throw new Error('The default outfit must be an outfit.')
  return outfit.id
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Sorted by name, then by age; every kind when kind is omitted. */
export function listAssets(kind?: unknown): Asset[] {
  const only = kind === undefined || kind === null ? undefined : requireKind(kind)
  const db = getDb()
  const rows = (
    only
      ? db.prepare('SELECT * FROM assets WHERE kind = ?').all(only)
      : db.prepare('SELECT * FROM assets').all()
  ) as AssetRow[]
  const images = groupImages(
    (only
      ? db
          .prepare(
            `SELECT i.* FROM asset_images i JOIN assets a ON a.id = i.asset_id WHERE a.kind = ?
             ORDER BY i.asset_id, i.position, i.created_at`
          )
          .all(only)
      : db.prepare('SELECT * FROM asset_images ORDER BY asset_id, position, created_at').all()) as AssetImageRow[]
  )
  const audio = groupAudio(
    (only
      ? db
          .prepare(
            `SELECT c.* FROM asset_audio c JOIN assets a ON a.id = c.asset_id WHERE a.kind = ?
             ORDER BY c.asset_id, c.position, c.created_at`
          )
          .all(only)
      : db.prepare('SELECT * FROM asset_audio ORDER BY asset_id, position, created_at').all()) as AssetAudioRow[]
  )
  return rows
    .filter((r) => isAssetKind(r.kind))
    .map((r) => assetFromRow(r, images.get(r.id) ?? [], audio.get(r.id) ?? []))
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.createdAt - b.createdAt)
}

/**
 * The assets with a description (not blank) – and the characters and outfits, whose legend line says who wears what
 * (shared/outfits.ts) with or without one – that one of the params' reference images or audio clips belongs to, as
 * the prompt composer reads them (composePrompt in src/shared/prompt-compose.ts), with all their photo and clip
 * paths (absolute) and a character's default outfit. Read from the database at the moment of the call: a submission
 * appends the descriptions as they are when it is sent, so one edited in the library a moment ago already counts.
 * Files are matched as the library compares paths (pathKey). Which of the references are actually sent is
 * composePrompt's decision.
 */
export function describedAssetsFor(
  params: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'>
): DescribedAsset[] {
  const wanted = new Set<string>()
  for (const path of Array.isArray(params?.referenceImages) ? params.referenceImages : []) {
    if (typeof path === 'string' && path) wanted.add(pathKey(path))
  }
  for (const clip of Array.isArray(params?.referenceAudios) ? params.referenceAudios : []) {
    if (clip && typeof clip.path === 'string' && clip.path) wanted.add(pathKey(clip.path))
  }
  if (!wanted.size) return []
  const db = getDb()
  // Descriptions are saved trimmed; the check in SQL only spares reading the files of assets the legend can't name.
  // A director's photos are its style frames, never a reference the legend describes (prompt-compose.ts).
  const legendIds = `SELECT id FROM assets WHERE kind != 'director' AND (trim(description) != '' OR kind IN ('character', 'outfit'))`
  const rows = (db.prepare(`SELECT * FROM assets WHERE id IN (${legendIds})`).all() as AssetRow[]).filter((r) =>
    isAssetKind(r.kind)
  )
  if (!rows.length) return []
  const images = groupImages(
    db
      .prepare(`SELECT * FROM asset_images WHERE asset_id IN (${legendIds}) ORDER BY asset_id, position, created_at`)
      .all() as AssetImageRow[]
  )
  const audio = groupAudio(
    db
      .prepare(`SELECT * FROM asset_audio WHERE asset_id IN (${legendIds}) ORDER BY asset_id, position, created_at`)
      .all() as AssetAudioRow[]
  )
  return rows.flatMap((r) => {
    const imagePaths = (images.get(r.id) ?? []).map((img) => img.path)
    const audioPaths = (audio.get(r.id) ?? []).map((clip) => clip.path)
    if (![...imagePaths, ...audioPaths].some((p) => wanted.has(pathKey(p)))) return []
    return [
      {
        id: r.id,
        kind: r.kind,
        name: r.name,
        description: r.description,
        imagePaths,
        audioPaths,
        ...(r.kind === 'character' && r.default_outfit_id ? { defaultOutfitId: r.default_outfit_id } : {})
      }
    ]
  })
}

async function createAsset(
  kind: AssetKind,
  name: string,
  description: string,
  defaultOutfitId: string | null,
  direction?: Direction
): Promise<Asset> {
  const id = randomUUID()
  const now = Date.now()
  const folder = freeFolderName(kind, name)
  const dir = assetsDir(kind, folder)
  // A director's style videos are copied in before its row exists: a file that can't be read refuses the whole save.
  const prepared = kind === 'director' && direction ? await prepareDirection(dir, {}, direction) : undefined
  try {
    getDb()
      .prepare(
        `INSERT INTO assets (id, kind, name, description, folder, default_outfit_id, direction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, kind, name, description, folder, defaultOutfitId, prepared?.json ?? null, now, now)
  } catch (err) {
    await discardFiles(prepared?.copies ?? [])
    await removeIfEmpty(dir)
    throw err
  }
  await writeDescription(dir, description)
  notifyChange()
  return getAsset(id)
}

/** Removes files copied for a save that didn't go through. */
async function discardFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})))
}

/** "@Video"-free, short name of a video file for messages. */
const fileName = (path: string): string => basename(path)

/**
 * A style video's window fitted to its file (`duration` seconds): the start inside the file, the length the one asked
 * for (default 5 s) within 2–15 s – what Seedance 2.0, the stricter family, takes per video – and the rest of the file.
 */
function fitStyleWindow(video: ReferenceVideo, duration: number): { start: number; length: number } {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  const wanted = referenceVideoWindow({ path: video.path, ...(video.length !== undefined ? { length: video.length } : {}) })
  const length = Math.min(Math.max(wanted.length, MIN_VIDEO_CLIP_SECONDS), MAX_STYLE_VIDEO_SECONDS, total)
  const start = Math.min(Math.max(video.start ?? 0, 0), Math.max(0, total - length))
  return { start: toMs(start), length: toMs(length) }
}

/** The longest window a style video keeps: Seedance 2.0's per-video limit, so it fits both families. */
const MAX_STYLE_VIDEO_SECONDS = 15

/**
 * A style video file measured before it is copied or kept: refused when it is no video Studio can read, or shorter
 * than the 2 s Venice takes.
 */
async function styleVideoDuration(path: string): Promise<number> {
  if (!VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error(`${fileName(path)} is not a video. Choose an MP4, MOV, M4V, WebM or MKV file.`)
  }
  let duration: number
  try {
    duration = await videoDuration(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    throw new Error(
      code === 'ENOENT'
        ? `${fileName(path)} no longer exists.`
        : `Could not read the video ${fileName(path)}: ${reasonText(err)}.`
    )
  }
  if (!(duration >= MIN_VIDEO_CLIP_SECONDS - 0.005)) {
    throw new Error(`${fileName(path)} is shorter than ${MIN_VIDEO_CLIP_SECONDS} seconds. Choose a longer video.`)
  }
  return duration
}

/**
 * A direction as it is saved for a director whose folder is `dir`: sanitized, every style video outside the folder
 * measured and copied in (under its own name), each window fitted to its file; videos already in the folder keep their
 * file (their window is fitted again when the file can be read). `before` is the direction saved so far: the style
 * videos it had that the new one leaves out are `removed` (absolute), for the caller to keep or trash once saved.
 * `copies` are the files copied, for the caller to discard if the save fails.
 */
async function prepareDirection(
  dir: string,
  before: Direction,
  input: unknown
): Promise<{ json: string | null; copies: string[]; removed: string[] }> {
  const next = sanitizeDirection(input)
  const copies: string[] = []
  const videos: ReferenceVideo[] = []
  try {
    for (const video of next.videos ?? []) {
      const inFolder = dirname(video.path) === dir || pathKey(dirname(video.path)) === pathKey(dir)
      if (inFolder) {
        // Its own file: kept as it is when it can't be measured (moved away in Finder), so the rest still saves.
        const duration = await styleVideoDuration(video.path).catch(() => undefined)
        videos.push(duration === undefined ? video : { path: video.path, ...fitStyleWindow(video, duration) })
        continue
      }
      const duration = await styleVideoDuration(video.path)
      const ext = extname(video.path)
      let dest: string
      try {
        dest = await copyInto(video.path, dir, safeName(basename(video.path, ext), { fallback: 'Video' }), ext.toLowerCase())
      } catch (err) {
        throw new Error(`Could not copy ${fileName(video.path)}: ${fileErrorReason(err)}.`)
      }
      copies.push(dest)
      videos.push({ path: dest, ...fitStyleWindow(video, duration) })
    }
  } catch (err) {
    await discardFiles(copies)
    throw err
  }
  const kept = new Set(videos.map((v) => pathKey(v.path)))
  const removed = (before.videos ?? []).map((v) => v.path).filter((p) => !kept.has(pathKey(p)))
  const direction: Direction = { ...next }
  if (videos.length) direction.videos = videos
  else delete direction.videos
  return { json: serializeDirection(direction), copies, removed }
}

/**
 * Style videos a director no longer has: a file generations or clips still send is kept for them (keepUsedFile, moved
 * to Reference images); any other goes to the Trash. Call once the director's row no longer records them. True when a
 * file was kept (stored paths moved).
 */
async function releaseStyleVideos(paths: readonly string[]): Promise<boolean> {
  let kept = false
  for (const path of paths) {
    if (await keepUsedFile(path, 'Video')) kept = true
    else await trashFile(path)
  }
  return kept
}

async function save(input: AssetInput): Promise<Asset> {
  const name = text(input?.name).trim()
  const description = text(input?.description).trim()
  if (!input?.id) {
    const kind = requireKind(input?.kind)
    if (!name) throw new Error(`${THE[kind]} needs a name.`)
    refuseDirection(kind, input.direction)
    return createAsset(kind, name, description, defaultOutfitFor(kind, input.defaultOutfitId), input.direction)
  }

  // The kind is fixed once created; the one sent along only names what is missing.
  const row = requireAssetRow(input.id, input.kind)
  if (!name) throw new Error(`${THE[row.kind]} needs a name.`)
  refuseDirection(row.kind, input.direction)
  // Checked before anything moves on disk, so a refused outfit leaves the folder as it was.
  const outfitId =
    input.defaultOutfitId === undefined ? row.default_outfit_id : defaultOutfitFor(row.kind, input.defaultOutfitId)
  const hadFolder = isPlainName(row.folder)
  let folder = await ensureFolder(row)
  // A director's direction: its new style videos copied in first (a file that can't be read refuses the save).
  const before = row.direction ?? null
  const prepared =
    row.kind === 'director' && input.direction !== undefined
      ? await prepareDirection(assetsDir(row.kind, folder), parseDirection(before), input.direction)
      : undefined
  const directionChanged = !!prepared && prepared.json !== before
  // Autosave sends the same values repeatedly (debounce + blur); don't bump or broadcast for those.
  if (row.name === name && row.description === description && row.default_outfit_id === outfitId && !directionChanged) {
    // ...unless the images of a character from before folders just moved into its new folder.
    if (!hadFolder) notifyChange()
    return getAsset(row.id)
  }
  if (prepared && directionChanged) {
    // Written before a rename, which then carries the style videos' stored paths along with the folder.
    try {
      getDb()
        .prepare('UPDATE assets SET direction = ?, updated_at = ? WHERE id = ?')
        .run(prepared.json, Date.now(), row.id)
    } catch (err) {
      await discardFiles(prepared.copies)
      throw err
    }
    if (await releaseStyleVideos(prepared.removed)) notifyFilesMoved()
  }
  if (row.name !== name) folder = await renameFolder(row, folder, name)
  getDb()
    .prepare('UPDATE assets SET name = ?, description = ?, default_outfit_id = ?, updated_at = ? WHERE id = ?')
    .run(name, description, outfitId, Date.now(), row.id)
  await writeDescription(assetsDir(row.kind, folder), description)
  notifyChange()
  return getAsset(row.id)
}

async function remove(id: unknown): Promise<void> {
  const row = findAssetRow(safeId(id))
  if (!row) return
  const images = imageRows(row.id)
  const audio = audioRows(row.id)
  const videos = row.kind === 'director' ? styleVideoPaths(row.direction) : []
  const db = getDb()
  // Image and audio rows go with it (ON DELETE CASCADE); characters wearing a deleted outfit by default lose
  // that default (ON DELETE SET NULL). Those characters changed too: their updatedAt says so, so a view holding
  // an older copy of one takes the list's version (without the outfit) as the newer. Sequences and storyboards a
  // deleted director directed have none from now on, and so do clips that chose it (their director becomes null:
  // "None", not the sequence's).
  let undirected = 0
  db.transaction(() => {
    if (row.kind === 'outfit') {
      db.prepare('UPDATE assets SET updated_at = ? WHERE default_outfit_id = ?').run(Date.now(), row.id)
    }
    if (row.kind === 'director') undirected = forgetDirector(row.id)
    db.prepare('DELETE FROM assets WHERE id = ?').run(row.id)
  })()
  const dir = isPlainName(row.folder) ? join(assetsDir(row.kind), row.folder) : undefined
  // Photos and audio still in use move out first; files outside the folder (a character from before folders,
  // or a move that failed) go one by one.
  let kept = false
  const files = [
    ...images.map((r) => ({ file_path: r.file_path, fallback: 'Referensbild' })),
    ...audio.map((r) => ({ file_path: r.file_path, fallback: 'Audio' })),
    ...videos.map((path) => ({ file_path: toStoredPath(path), fallback: 'Video' }))
  ]
  for (const file of files) {
    const path = fromStoredPath(file.file_path)
    if (await keepUsedFile(path, file.fallback)) kept = true
    else if (!dir || dirname(path) !== dir) await trashFile(path)
  }
  if (dir) await trashAssetFolder(dir, files)
  // The sequences' views reread: their director (or a clip's) is gone.
  if (kept || undirected) notifyFilesMoved()
  notifyChange()
}

/**
 * Takes a director out of everything that names it (inside the caller's transaction): sequences' and storyboards'
 * defaults lose their `director`, and clips that chose it get null (none). Generations keep the id they were made with
 * (what was sent). Returns how many sequences, storyboards and clips changed.
 */
function forgetDirector(id: string): number {
  const db = getDb()
  const sequences = db
    .prepare(
      `UPDATE sequences SET defaults = json_remove(defaults, '$.director')
       WHERE json_valid(defaults) AND json_extract(defaults, '$.director') = ?`
    )
    .run(id).changes
  const clips = db
    .prepare(
      `UPDATE segments SET params = json_set(params, '$.director', json('null'))
       WHERE json_valid(params) AND json_extract(params, '$.director') = ?`
    )
    .run(id).changes
  return sequences + clips
}

/** Only directors have a direction; one given for another kind (not empty) is refused rather than dropped. */
function refuseDirection(kind: AssetKind, direction: unknown): void {
  if (kind === 'director' || direction === undefined || direction === null) return
  if (typeof direction === 'object' && !Object.keys(direction as object).length) return
  throw new Error('Only directors have a direction (editing, look, camera …).')
}

// ── Directors ────────────────────────────────────────────────────────────────

/**
 * A director's name neither another director nor a ready-made one has (a copy must never read like the ready-made
 * one in a picker): "Noir (copy)", else "Noir (copy) 2" … – numbered as the window numbers a new one.
 */
function freeDirectorName(name: string): string {
  const key = (n: string) => n.normalize('NFC').toLocaleLowerCase('en')
  const own = getDb().prepare("SELECT name FROM assets WHERE kind = 'director'").pluck().all() as string[]
  const taken = new Set([...own, ...DIRECTOR_PRESETS.map((p) => p.name)].map(key))
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`
    if (!taken.has(key(candidate))) return candidate
  }
}

/** A ready-made director as one of the user's own, to change: "Noir (copy)". */
async function copyPreset(presetId: unknown): Promise<Asset> {
  const preset = directorPreset(presetId)
  if (!preset) throw new Error('There is no such ready-made director.')
  return createAsset('director', freeDirectorName(`${preset.name} (copy)`), preset.description, null, preset.direction)
}

async function addVideos(assetId: unknown, paths: unknown): Promise<Asset> {
  const row = requireAssetRow(assetId)
  if (row.kind !== 'director') throw new Error('Only directors have style videos.')
  const sources = [
    ...new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''))
  ]
  if (!sources.length) return getAsset(row.id)
  const dir = assetsDir(row.kind, await ensureFolder(row))
  const before = parseDirection(row.direction)
  const prepared = await prepareDirection(dir, before, {
    ...before,
    videos: [...(before.videos ?? []), ...sources.map((path) => ({ path }))]
  })
  try {
    const changed = getDb()
      .prepare('UPDATE assets SET direction = ?, updated_at = ? WHERE id = ?')
      .run(prepared.json, Date.now(), row.id).changes
    if (!changed) throw new Error(`${THE[row.kind]} no longer exists.`)
  } catch (err) {
    await discardFiles(prepared.copies)
    throw err
  }
  notifyChange()
  return getAsset(row.id)
}

async function addImages(assetId: unknown, paths: unknown, from?: unknown): Promise<Asset> {
  const row = requireAssetRow(assetId)
  const sources = [
    ...new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''))
  ]
  const images = sources.filter((p) => IMAGE_EXTENSIONS.has(extname(p).toLowerCase()))
  if (!images.length) {
    if (sources.length) throw new Error('Only JPG, PNG or WebP images can be added.')
    return getAsset(row.id)
  }

  // Copy first (under the original names), then insert all rows in one transaction, so a failed copy leaves
  // nothing half-added.
  const dir = assetsDir(row.kind, await ensureFolder(row))
  const copied: { id: string; dest: string }[] = []
  const discardCopies = (): Promise<unknown> =>
    Promise.all(copied.map((c) => rm(c.dest, { force: true }).catch(() => {})))
  for (const src of images) {
    const ext = extname(src)
    try {
      const dest = await copyInto(src, dir, safeName(basename(src, ext), { fallback: 'Bild' }), ext.toLowerCase())
      copied.push({ id: randomUUID(), dest })
    } catch (err) {
      await discardCopies()
      throw new Error(`Could not copy ${basename(src)}: ${fileErrorReason(err)}.`)
    }
  }

  const db = getDb()
  let inserted: boolean
  try {
    inserted = db.transaction((): boolean => {
      if (!findAssetRow(row.id)) return false
      const last = db
        .prepare('SELECT MAX(position) FROM asset_images WHERE asset_id = ?')
        .pluck()
        .get(row.id) as number | null
      let position = (last ?? -1) + 1
      const now = Date.now()
      const origin = originFrom(from, now)
      const insert = db.prepare(
        'INSERT INTO asset_images (id, asset_id, file_path, position, created_at, origin) VALUES (?, ?, ?, ?, ?, ?)'
      )
      const stored = origin ? JSON.stringify(origin) : null
      for (const c of copied) insert.run(c.id, row.id, toStoredPath(c.dest), position++, now, stored)
      touchAsset(row.id, now)
      return true
    })()
  } catch (err) {
    await discardCopies()
    throw err
  }
  if (!inserted) {
    await discardCopies()
    throw new Error(`${THE[row.kind]} no longer exists.`)
  }

  notifyChange()
  return getAsset(row.id)
}

async function removeImage(imageId: unknown): Promise<Asset> {
  const db = getDb()
  const id = safeId(imageId)
  const findImage = (): AssetImageRow | undefined =>
    db.prepare('SELECT * FROM asset_images WHERE id = ?').get(id) as AssetImageRow | undefined
  const found = findImage()
  if (!found) throw new Error('The image no longer exists.')
  const asset = findAssetRow(found.asset_id)
  // A character from before folders gets its folder now; the image may have moved with the others.
  if (asset) await ensureFolder(asset)
  const row = findImage() ?? found

  db.transaction(() => {
    db.prepare('DELETE FROM asset_images WHERE id = ?').run(row.id)
    writeImagePositions(orderedImageIds(row.asset_id))
    touchAsset(row.asset_id)
  })()
  const path = fromStoredPath(row.file_path)
  if (await keepUsedFile(path, 'Referensbild')) notifyFilesMoved()
  else await trashFile(path)

  notifyChange()
  return getAsset(row.asset_id)
}

function reorderImages(assetId: unknown, imageIds: unknown): Asset {
  const db = getDb()
  const row = requireAssetRow(assetId)
  const changed = db.transaction((): boolean => {
    const current = orderedImageIds(row.id)
    const order = reordered(current, imageIds)
    if (order.every((id, i) => id === current[i])) return false
    writeImagePositions(order)
    touchAsset(row.id)
    return true
  })()

  if (changed) notifyChange()
  return getAsset(row.id)
}

// ── Audio ────────────────────────────────────────────────────────────────────

/** Why this asset can't have audio, or undefined when it can. */
function noAudioReason(kind: AssetKind): string | undefined {
  return AUDIO_KINDS.has(kind) ? undefined : 'Only characters (voice) and environments (soundscape) can have audio.'
}

/** The length of the sound in an audio file, or an error naming the file. */
async function audioDuration(src: string): Promise<number> {
  const name = basename(src)
  try {
    if (!(await stat(src)).isFile()) throw Object.assign(new Error('it is a folder'), { code: 'EISDIR' })
  } catch (err) {
    throw new Error(`Could not read ${name}: ${reasonText(err)}.`)
  }
  let duration: number
  try {
    ;({ duration } = await probeAudio(src))
  } catch (err) {
    const reason = reasonText(err)
    if (/no sound/u.test(reason)) throw new Error(`There is no sound in ${name}.`)
    throw new Error(`Could not read the audio in ${name}: ${reason}.`)
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`There is no sound in ${name}.`)
  if (duration < MIN_AUDIO_FILE_SECONDS) throw new Error(`${name} is shorter than a second. Choose a longer sound.`)
  return duration
}

async function addAudio(assetId: unknown, paths: unknown, from?: unknown): Promise<Asset> {
  const row = requireAssetRow(assetId)
  const refused = noAudioReason(row.kind)
  if (refused) throw new Error(refused)
  const sources = [
    ...new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''))
  ]
  const files = sources.filter((p) => AUDIO_EXTENSIONS.has(extname(p).toLowerCase()))
  if (!files.length) {
    if (sources.length) throw new Error('Only audio files in MP3, WAV, M4A, AAC, AIFF, FLAC or OGG can be added.')
    return getAsset(row.id)
  }

  // Every file is probed before anything is copied: one without sound, or too short, refuses the whole
  // batch with its name, like a failed copy does.
  const probed: { src: string; duration: number }[] = []
  for (const src of files) probed.push({ src, duration: await audioDuration(src) })

  // Copy first (under the original names), then insert all rows in one transaction, so a failed copy leaves
  // nothing half-added.
  const dir = assetsDir(row.kind, await ensureFolder(row))
  const copied: { id: string; dest: string; duration: number }[] = []
  const discardCopies = (): Promise<unknown> =>
    Promise.all(copied.map((c) => rm(c.dest, { force: true }).catch(() => {})))
  for (const { src, duration } of probed) {
    const ext = extname(src)
    try {
      const dest = await copyInto(src, dir, safeName(basename(src, ext), { fallback: 'Audio' }), ext.toLowerCase())
      copied.push({ id: randomUUID(), dest, duration })
    } catch (err) {
      await discardCopies()
      throw new Error(`Could not copy ${basename(src)}: ${fileErrorReason(err)}.`)
    }
  }

  const db = getDb()
  let inserted: boolean
  try {
    inserted = db.transaction((): boolean => {
      if (!findAssetRow(row.id)) return false
      const last = db
        .prepare('SELECT MAX(position) FROM asset_audio WHERE asset_id = ?')
        .pluck()
        .get(row.id) as number | null
      let position = (last ?? -1) + 1
      const now = Date.now()
      const origin = originFrom(from, now)
      const stored = origin ? JSON.stringify(origin) : null
      // clip_length NULL: the default window, which follows the file's length.
      const insert = db.prepare(
        `INSERT INTO asset_audio (id, asset_id, file_path, position, duration, clip_start, clip_length, created_at,
           origin)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      )
      for (const c of copied) insert.run(c.id, row.id, toStoredPath(c.dest), position++, c.duration, now, stored)
      touchAsset(row.id, now)
      return true
    })()
  } catch (err) {
    await discardCopies()
    throw err
  }
  if (!inserted) {
    await discardCopies()
    throw new Error(`${THE[row.kind]} no longer exists.`)
  }

  notifyChange()
  return getAsset(row.id)
}

async function removeAudio(audioId: unknown): Promise<Asset> {
  const db = getDb()
  const row = findAudioRow(safeId(audioId))
  if (!row) throw new Error(AUDIO_GONE)
  db.transaction(() => {
    db.prepare('DELETE FROM asset_audio WHERE id = ?').run(row.id)
    writeAudioPositions(orderedAudioIds(row.asset_id))
    touchAsset(row.asset_id)
  })()
  // A clip that generations or clips still send as reference audio is kept for them (see keepUsedFile).
  const path = fromStoredPath(row.file_path)
  if (await keepUsedFile(path, 'Audio')) notifyFilesMoved()
  else await trashFile(path)

  notifyChange()
  return getAsset(row.asset_id)
}

/** A time in seconds from IPC: a finite number, or a plain error. */
function seconds(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${what}.`)
  return value
}

function updateAudio(audioId: unknown, patch: unknown): Asset {
  const db = getDb()
  const row = findAudioRow(safeId(audioId))
  if (!row) throw new Error(AUDIO_GONE)
  const p = (patch && typeof patch === 'object' ? patch : {}) as { clipStart?: unknown; clipLength?: unknown }
  const start = p.clipStart === undefined ? row.clip_start : seconds(p.clipStart, 'start time')
  // null goes back to the default window (which follows the file's length).
  const length =
    p.clipLength === undefined ? row.clip_length : p.clipLength === null ? null : seconds(p.clipLength, 'length')
  // Stored clamped, so what the library shows is exactly what is sent. A longer window that would run past
  // the end of the file moves its start back.
  const window = resolveAudioWindow(row.duration, start, length)
  const storedLength = length === null ? null : window.clipLength
  if (window.clipStart === row.clip_start && storedLength === row.clip_length) return getAsset(row.asset_id)
  db.transaction(() => {
    db.prepare('UPDATE asset_audio SET clip_start = ?, clip_length = ? WHERE id = ?').run(
      window.clipStart,
      storedLength,
      row.id
    )
    touchAsset(row.asset_id)
  })()
  notifyChange()
  return getAsset(row.asset_id)
}

function reorderAudio(assetId: unknown, audioIds: unknown): Asset {
  const db = getDb()
  const row = requireAssetRow(assetId)
  const changed = db.transaction((): boolean => {
    const current = orderedAudioIds(row.id)
    const order = reordered(current, audioIds)
    if (order.every((id, i) => id === current[i])) return false
    writeAudioPositions(order)
    touchAsset(row.id)
    return true
  })()

  if (changed) notifyChange()
  return getAsset(row.id)
}

/**
 * A clip made for the asset rather than picked by the user (a voice designed in the Editor): copied from `file` into
 * the asset's folder as "<baseName>.<ext>" (made unique), appended after its clips with the default window.
 */
async function addGenerated(assetId: unknown, file: unknown, baseName: unknown): Promise<Asset> {
  const row = requireAssetRow(assetId)
  const refused = noAudioReason(row.kind)
  if (refused) throw new Error(refused)
  if (typeof file !== 'string' || !file) throw new Error(AUDIO_GONE)
  const duration = await audioDuration(file)
  const dir = assetsDir(row.kind, await ensureFolder(row))
  const ext = extname(file).toLowerCase() || '.mp3'
  let dest: string
  try {
    dest = await copyInto(file, dir, safeName(text(baseName), { fallback: 'Audio' }), ext)
  } catch (err) {
    throw new Error(`Could not save the audio: ${fileErrorReason(err)}.`)
  }
  const db = getDb()
  const audioId = randomUUID()
  let inserted: boolean
  try {
    inserted = db.transaction((): boolean => {
      if (!findAssetRow(row.id)) return false
      const last = db.prepare('SELECT MAX(position) FROM asset_audio WHERE asset_id = ?').pluck().get(row.id) as
        | number
        | null
      const now = Date.now()
      db.prepare(
        `INSERT INTO asset_audio (id, asset_id, file_path, position, duration, clip_start, clip_length, created_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`
      ).run(audioId, row.id, toStoredPath(dest), (last ?? -1) + 1, duration, now)
      touchAsset(row.id, now)
      return true
    })()
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {})
    throw err
  }
  if (!inserted) {
    await rm(dest, { force: true }).catch(() => {})
    throw new Error(`${THE[row.kind]} no longer exists.`)
  }
  // A designed voice is news (Activity): announced with the change that shows it, in the same tick.
  addUnseen({ audioId, context: { assetId: row.id } })
  notifyChange()
  return getAsset(row.id)
}

/** "May be cloned for new lines": records (or withdraws) the user's confirmation that they may use this voice. */
function setCloneConsent(audioId: unknown, consent: unknown): Asset {
  const db = getDb()
  const row = findAudioRow(safeId(audioId))
  if (!row) throw new Error(AUDIO_GONE)
  const value = consent === true ? Date.now() : null
  const had = typeof row.clone_consent_at === 'number'
  if (had === (consent === true)) return getAsset(row.asset_id)
  db.transaction(() => {
    db.prepare('UPDATE asset_audio SET clone_consent_at = ? WHERE id = ?').run(value, row.id)
    touchAsset(row.asset_id)
  })()
  notifyChange()
  return getAsset(row.asset_id)
}

// ── Queued entry points ──────────────────────────────────────────────────────

/**
 * Creates (no id) or updates an asset: name and description trimmed, an empty name refused; the kind can't
 * change; a character's default outfit is kept when defaultOutfitId is omitted and cleared with null.
 */
export function saveAsset(input: AssetInput): Promise<Asset> {
  return assetTask(() => save(input))
}

/** Deletes the asset and moves its folder to the Trash. */
export function deleteAsset(id: string): Promise<void> {
  return assetTask(() => remove(id))
}

/**
 * A ready-made director (shared/directors.ts) copied into the library as a director of its own: "Noir (copy)", or
 * "Noir (copy) 2" when that is taken.
 */
export function copyDirectorPreset(presetId: string): Promise<Asset> {
  return assetTask(() => copyPreset(presetId))
}

/**
 * Copies video files into a director's folder and appends them to its style videos, each with a window of 2–15 s
 * (5 s unless the file is shorter): refused, with the file's name and the reason, when one isn't a video Studio can
 * read or is shorter than 2 s; nothing is added then. Directors only.
 */
export function addDirectorVideos(assetId: string, paths: string[]): Promise<Asset> {
  return assetTask(() => addVideos(assetId, paths))
}

/** The director with this id from the library (kind 'director'); undefined for none. Needs an open library. */
export function findDirectorAsset(id: string): Asset | undefined {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return undefined
  const row = findAssetRow(id)
  return row?.kind === 'director' ? assetFromRow(row, groupImages(imageRows(id)).get(id) ?? [], []) : undefined
}

/**
 * Copies JPG/PNG/WebP files into the asset's folder (under their own names) and appends them in order. `origin`:
 * the agent that added them (only for an agent's call; the IPC handler decides), recorded with each photo.
 */
export function addAssetImages(
  assetId: string,
  paths: string[],
  origin?: { agent?: string; host?: string }
): Promise<Asset> {
  return assetTask(() => addImages(assetId, paths, origin))
}

/**
 * Removes the image (its copy goes to the Trash, or to Reference images if generations used it); the remaining
 * images close up.
 */
export function removeAssetImage(imageId: string): Promise<Asset> {
  return assetTask(() => removeImage(imageId))
}

/** The given images first, in that order (unknown ids ignored); the rest keep their order after them. */
export function reorderAssetImages(assetId: string, imageIds: string[]): Promise<Asset> {
  return assetTask(async () => reorderImages(assetId, imageIds))
}

/**
 * Copies audio files (MP3, WAV, M4A, AAC, AIFF, FLAC, OGG) into the asset's folder under their own names and
 * appends them in order, each with the default reference window. Characters and environments only; files
 * without sound or shorter than a second are refused. `origin` as for addAssetImages.
 */
export function addAssetAudio(
  assetId: string,
  paths: string[],
  origin?: { agent?: string; host?: string }
): Promise<Asset> {
  return assetTask(() => addAudio(assetId, paths, origin))
}

/** Removes the clip: its copy goes to the Trash, or to Reference images/<today>/ while generations still use it. */
export function removeAssetAudio(audioId: string): Promise<Asset> {
  return assetTask(() => removeAudio(audioId))
}

/** Moves or resizes the clip's reference window (clamped to 2–15 s inside the file). */
export function updateAssetAudio(audioId: string, patch: { clipStart?: number; clipLength?: number }): Promise<Asset> {
  return assetTask(async () => updateAudio(audioId, patch))
}

/** The given clips first, in that order (unknown ids ignored); the rest keep their order after them. */
export function reorderAssetAudio(assetId: string, audioIds: string[]): Promise<Asset> {
  return assetTask(async () => reorderAudio(assetId, audioIds))
}

/**
 * Adds a clip made for the asset (a voice designed with AI in the Editor) under `baseName`, e.g. "Skapad röst
 * 2026-10-07": copied into the asset's folder after its clips, with the default reference window, and announced as
 * new in Activity (an unseen row). Characters and environments only.
 */
export function addGeneratedAudio(assetId: string, file: string, baseName: string): Promise<Asset> {
  return assetTask(() => addGenerated(assetId, file, baseName))
}

/**
 * Records whether the user may let the Editor clone this voice for new lines (D6). The user's own decision: the IPC
 * handler refuses agents.
 */
export function setVoiceCloneConsent(audioId: string, consent: boolean): Promise<Asset> {
  return assetTask(async () => setCloneConsent(audioId, consent))
}

/**
 * Absolute path of the asset's folder, created if missing (and filled, for a character from before
 * folders). For "Open folder".
 */
export function assetFolderPath(assetId: string): Promise<string> {
  return assetTask(async () => {
    const row = requireAssetRow(assetId)
    const hadFolder = isPlainName(row.folder)
    const folder = await ensureFolder(row)
    if (!hadFolder) notifyChange()
    return assetsDir(row.kind, folder)
  })
}
