import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import type { Asset, AssetImage, AssetInput, AssetKind } from '@shared/types'
import { getDb, isStoredPathRecorded, rewriteStoredPrefix } from './db'
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
import { copyInto, fileErrorReason, placeFile, serialized } from './references'

// Assets: characters (Karaktärer), environments (Miljöer) and outfits (Kläder) — each a name, a description and
// reference photos. Every asset has a folder <kind folder>/<name>/ with copies of its photos (under their
// original names) and Beskrivning.txt, so an asset keeps working when the originals are moved or deleted, and
// the folder reads well in Finder. The database is the source of truth; the folder follows renames and deletes.
// A character may have a default outfit (assets.default_outfit_id, cleared by the FK when the outfit goes).

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const DESCRIPTION_FILE = 'Beskrivning.txt'
/**
 * Folder name for a name with nothing usable in it (e.g. "..."). The same for every kind, and the same as
 * "Städa upp" uses, so the two never disagree about which folder an asset should have.
 */
const UNNAMED = 'Namnlös'
const GONE = 'Den finns inte längre i biblioteket.'
const nameCollator = new Intl.Collator('sv')

/** The asset in definite form, for messages ("Miljön behöver ett namn."). */
const THE: Record<AssetKind, string> = {
  character: 'Karaktären',
  environment: 'Miljön',
  outfit: 'Klädseln'
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
    // Not while "Städa upp" or a switch moves files: they read the folder names once and move files by them.
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

/** Why the library can't be switched or tidied right now (Swedish), or undefined when no asset work runs. */
export function assetWorkBusy(): string | undefined {
  return assetTasks > 0 ? 'Bilderna till en karaktär, miljö eller klädsel sparas just nu.' : undefined
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** IPC input is untyped at runtime; treat anything that isn't a string as empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Ids arrive over IPC; reject anything that isn't one before it reaches a query. */
function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Ogiltigt id.')
  return id
}

function requireKind(value: unknown): AssetKind {
  if (!isAssetKind(value)) throw new Error('Okänd sorts bibliotekspost.')
  return value
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

/** Mirrors the description into Beskrivning.txt for Finder; removed when empty. Best effort. */
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
  // top-level folders are left to "Städa upp".
  const oldDir = toStoredPath(dirname(src))
  if (!isAbsolute(oldDir) && oldDir.includes('/')) await removeIfEmpty(dirname(src))
}

/**
 * The asset's folder name, (re)created on disk if missing. A character from before folders gets one now and
 * its images move into it. The folder is recorded first and each image's path right after its move, so an
 * interruption leaves every row pointing at an existing file ("Städa upp" moves the rest).
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
 * A photo that generations or sequence clips still use (as start, end or reference image) isn't trashed with
 * its asset: it moves to Referensbilder/<today>/, where submitted pictures from outside the library go, and
 * those rows follow, so "Använd igen" and "Generera alla" keep the picture and the prompt's @ImageN numbers.
 * Call once the photo's asset_images row is gone, so only other rows count. True when it was kept.
 */
async function keepUsedPhoto(path: string): Promise<boolean> {
  const stored = toStoredPath(path)
  if (isAbsolute(stored) || !existsSync(path) || !isStoredPathRecorded(stored)) return false
  const ext = extname(path)
  try {
    const dest = await placeFile(
      path,
      referencesDayDir(new Date()),
      safeName(basename(path, ext), { fallback: 'Referensbild' }),
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
async function trashAssetFolder(dir: string, images: AssetImageRow[]): Promise<void> {
  if (!existsSync(dir)) return
  try {
    await shell.trashItem(dir)
    return
  } catch (err) {
    console.warn(`Could not move ${dir} to the Trash:`, err)
  }
  // Anything the user added to the folder themselves stays, and with it the folder.
  for (const image of images) {
    const path = fromStoredPath(image.file_path)
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

function groupImages(rows: AssetImageRow[]): Map<string, AssetImage[]> {
  const byAsset = new Map<string, AssetImage[]>()
  for (const r of rows) {
    const images = byAsset.get(r.asset_id) ?? []
    images.push({ id: r.id, path: fromStoredPath(r.file_path) })
    byAsset.set(r.asset_id, images)
  }
  return byAsset
}

function assetFromRow(r: AssetRow, images: AssetImage[]): Asset {
  const asset: Asset = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    images,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
  if (r.kind === 'character' && r.default_outfit_id) asset.defaultOutfitId = r.default_outfit_id
  return asset
}

/** A row of a kind this version knows; anything else (written by a newer Studio) is left alone. */
function findAssetRow(id: string): AssetRow | undefined {
  const row = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined
  return row && isAssetKind(row.kind) ? row : undefined
}

/** The row, or a Swedish error; `kind` (when the caller knows it) names what is gone. */
function requireAssetRow(id: unknown, kind?: unknown): AssetRow {
  const row = findAssetRow(safeId(id))
  if (!row) throw new Error(isAssetKind(kind) ? `${THE[kind]} finns inte längre.` : GONE)
  return row
}

function getAsset(id: string): Asset {
  const row = requireAssetRow(id)
  return assetFromRow(row, groupImages(imageRows(id)).get(id) ?? [])
}

function orderedImageIds(assetId: string): string[] {
  return imageRows(assetId).map((r) => r.id)
}

function writeImagePositions(imageIds: string[]): void {
  const stmt = getDb().prepare('UPDATE asset_images SET position = ? WHERE id = ?')
  imageIds.forEach((id, position) => stmt.run(position, id))
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
  if (kind !== 'character') throw new Error('Bara karaktärer kan ha en standardklädsel.')
  const outfit = findAssetRow(safeId(value))
  if (!outfit) throw new Error('Den valda klädseln finns inte längre.')
  if (outfit.kind !== 'outfit') throw new Error('Standardklädseln måste vara en klädsel.')
  return outfit.id
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Sorted by name (Swedish order), then by age; every kind when kind is omitted. */
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
  return rows
    .filter((r) => isAssetKind(r.kind))
    .map((r) => assetFromRow(r, images.get(r.id) ?? []))
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.createdAt - b.createdAt)
}

async function createAsset(
  kind: AssetKind,
  name: string,
  description: string,
  defaultOutfitId: string | null
): Promise<Asset> {
  const id = randomUUID()
  const now = Date.now()
  const folder = freeFolderName(kind, name)
  const dir = assetsDir(kind, folder)
  try {
    getDb()
      .prepare(
        `INSERT INTO assets (id, kind, name, description, folder, default_outfit_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, kind, name, description, folder, defaultOutfitId, now, now)
  } catch (err) {
    await removeIfEmpty(dir)
    throw err
  }
  await writeDescription(dir, description)
  notifyChange()
  return getAsset(id)
}

async function save(input: AssetInput): Promise<Asset> {
  const name = text(input?.name).trim()
  const description = text(input?.description).trim()
  if (!input?.id) {
    const kind = requireKind(input?.kind)
    if (!name) throw new Error(`${THE[kind]} behöver ett namn.`)
    return createAsset(kind, name, description, defaultOutfitFor(kind, input.defaultOutfitId))
  }

  // The kind is fixed once created; the one sent along only names what is missing.
  const row = requireAssetRow(input.id, input.kind)
  if (!name) throw new Error(`${THE[row.kind]} behöver ett namn.`)
  // Checked before anything moves on disk, so a refused outfit leaves the folder as it was.
  const outfitId =
    input.defaultOutfitId === undefined ? row.default_outfit_id : defaultOutfitFor(row.kind, input.defaultOutfitId)
  const hadFolder = isPlainName(row.folder)
  let folder = await ensureFolder(row)
  // Autosave sends the same values repeatedly (debounce + blur); don't bump or broadcast for those.
  if (row.name === name && row.description === description && row.default_outfit_id === outfitId) {
    // ...unless the images of a character from before folders just moved into its new folder.
    if (!hadFolder) notifyChange()
    return getAsset(row.id)
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
  const db = getDb()
  // Image rows go with it (ON DELETE CASCADE); characters wearing a deleted outfit by default lose that
  // default (ON DELETE SET NULL). Those characters changed too: their updatedAt says so, so a view holding
  // an older copy of one takes the list's version (without the outfit) as the newer.
  db.transaction(() => {
    if (row.kind === 'outfit') {
      db.prepare('UPDATE assets SET updated_at = ? WHERE default_outfit_id = ?').run(Date.now(), row.id)
    }
    db.prepare('DELETE FROM assets WHERE id = ?').run(row.id)
  })()
  const dir = isPlainName(row.folder) ? join(assetsDir(row.kind), row.folder) : undefined
  // Photos still in use move out first; images outside the folder (a character from before folders, or a
  // move that failed) go one by one.
  let kept = false
  for (const image of images) {
    const path = fromStoredPath(image.file_path)
    if (await keepUsedPhoto(path)) kept = true
    else if (!dir || dirname(path) !== dir) await trashFile(path)
  }
  if (dir) await trashAssetFolder(dir, images)
  if (kept) notifyFilesMoved()
  notifyChange()
}

async function addImages(assetId: unknown, paths: unknown): Promise<Asset> {
  const row = requireAssetRow(assetId)
  const sources = [
    ...new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''))
  ]
  const images = sources.filter((p) => IMAGE_EXTENSIONS.has(extname(p).toLowerCase()))
  if (!images.length) {
    if (sources.length) throw new Error('Bara bilder i JPG, PNG eller WebP kan läggas till.')
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
      throw new Error(`Kunde inte kopiera ${basename(src)}: ${fileErrorReason(err)}.`)
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
      const insert = db.prepare(
        'INSERT INTO asset_images (id, asset_id, file_path, position, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const c of copied) insert.run(c.id, row.id, toStoredPath(c.dest), position++, now)
      touchAsset(row.id, now)
      return true
    })()
  } catch (err) {
    await discardCopies()
    throw err
  }
  if (!inserted) {
    await discardCopies()
    throw new Error(`${THE[row.kind]} finns inte längre.`)
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
  if (!found) throw new Error('Bilden finns inte längre.')
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
  if (await keepUsedPhoto(path)) notifyFilesMoved()
  else await trashFile(path)

  notifyChange()
  return getAsset(row.asset_id)
}

function reorderImages(assetId: unknown, imageIds: unknown): Asset {
  const db = getDb()
  const row = requireAssetRow(assetId)
  const changed = db.transaction((): boolean => {
    const current = orderedImageIds(row.id)
    const known = new Set(current)
    // Given ids first (ignoring strangers and repeats), then the rest in their existing order.
    const given = Array.isArray(imageIds) ? imageIds : []
    const leading = [...new Set(given.filter((id): id is string => typeof id === 'string' && known.has(id)))]
    const placed = new Set(leading)
    const order = [...leading, ...current.filter((id) => !placed.has(id))]
    if (order.every((id, i) => id === current[i])) return false
    writeImagePositions(order)
    touchAsset(row.id)
    return true
  })()

  if (changed) notifyChange()
  return getAsset(row.id)
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

/** Copies JPG/PNG/WebP files into the asset's folder (under their own names) and appends them in order. */
export function addAssetImages(assetId: string, paths: string[]): Promise<Asset> {
  return assetTask(() => addImages(assetId, paths))
}

/** Removes the image (its copy goes to the Trash); the remaining images close up. */
export function removeAssetImage(imageId: string): Promise<Asset> {
  return assetTask(() => removeImage(imageId))
}

/** The given images first, in that order (unknown ids ignored); the rest keep their order after them. */
export function reorderAssetImages(assetId: string, imageIds: string[]): Promise<Asset> {
  return assetTask(async () => reorderImages(assetId, imageIds))
}

/**
 * Absolute path of the asset's folder, created if missing (and filled, for a character from before
 * folders). For "Öppna mapp".
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
