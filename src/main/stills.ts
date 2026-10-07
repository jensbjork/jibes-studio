// Stills: the pictures storyboards and keyframes are built from — images generated with Venice's image models
// ("Skapa bild…"), pictures the user dropped onto a board or a slot, and frames saved from takes. Each still is a row
// in `stills` and a file of its own: in its sequence's folder (Sekvenser/<sequence>/Storyboard/), its storyboard's
// (Storyboards/<storyboard>/Bilder/) or, without either, in Referensbilder/<day>/. Clips and boards use a still by
// its path, like any other picture, so a still that clips, boards or generations still use is never trashed:
// deleting it moves the file to Referensbilder and the rows that use it follow.

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync } from 'node:fs'
import { copyFile, link, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import type { GenerationParams, ImageModel, SequenceKind, Still, StillParams } from '@shared/types'
import * as db from './db'
import { extractFrame } from './ffmpeg'
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_IMAGE_MODEL,
  closestAspectRatio,
  effectiveQuality,
  effectiveResolution,
  imageModelCatalog,
  listImageModels,
  priceImage,
  publicImageModel,
  requestImage,
  toPng,
  type ImageModelInfo
} from './images'
import {
  assertRootIntact,
  FOLDERS,
  fromStoredPath,
  isInsideRoot,
  KIND_FOLDERS,
  libraryOperationSettled,
  libraryRoot,
  movePath,
  promptExcerpt,
  referencesDayDir,
  removeDayFolderIfEmpty,
  safeName,
  sequenceDir,
  sequenceKindOf,
  timeStamp,
  tmpDir,
  toStoredPath,
  uniqueName
} from './paths'
import { fileErrorReason, importExternalReferences, placeFile } from './references'
import { parseDefaults, removeDirIfEmpty, type StillRow } from './sequence-store'

/** The aspect ratio of a still when neither the request nor its sequence says (Studio's video default). */
const DEFAULT_ASPECT_RATIO = '16:9'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const SOURCES = new Set<Still['source']>(['generated', 'upload', 'frame'])

const GONE = 'Bilden finns inte längre.'
const SEQUENCE_GONE = 'Sekvensen finns inte längre.'

/** Attempts at placing a file when its folder is renamed or its name taken between the check and the move. */
const PLACE_ATTEMPTS = 6
/**
 * A sequence folder missing from disk is waited for this many times this long (a rename moves it on disk and
 * then updates the database) before it is taken as removed in Finder and created again.
 */
const RENAME_WAITS = 3
const RENAME_WAIT_MS = 150
const SETTLE_STEP_MS = 50
const SETTLE_STEPS = 100

/** stills.params (JSON): the settings it was made with (reference paths in stored form), and a frame's origin. */
interface StoredStillParams {
  negativePrompt?: string
  referenceImages?: string[]
  aspectRatio?: string
  resolution?: string
  quality?: string
  /** Frames: the take and the moment (ms), so saving the same frame again reuses the still. */
  frame?: { generationId: string; time: number }
}

let notifyChange: (sequenceId?: string) => void = () => {}
/** Files the rows of other tables point at moved (a used still kept in Referensbilder when deleted). */
let notifyFilesMoved: () => void = () => {}

// ── Busy ─────────────────────────────────────────────────────────────────────

let tasks = 0

/**
 * Still work: generating (a paid request that can take minutes), saving a frame, importing or deleting. Waits for
 * a library switch or "Städa upp" to finish first and counts as busy while it runs, so neither starts under it:
 * the picture Venice was paid for would otherwise be saved into the wrong library, or into a folder that is being
 * moved.
 */
async function stillTask<T>(task: () => Promise<T>): Promise<T> {
  await libraryOperationSettled()
  tasks++
  try {
    return await task()
  } finally {
    tasks--
  }
}

/** Why the library can't be switched or tidied right now (Swedish), or undefined when no still work runs. */
export function stillWorkBusy(): string | undefined {
  return tasks > 0 ? 'En bild till en storyboard skapas eller sparas just nu.' : undefined
}

// ── Input ────────────────────────────────────────────────────────────────────

/** Ids arrive over IPC; reject anything that isn't one before it reaches a query. */
function safeId(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error(`Ogiltigt ${what}.`)
  return id
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const optionalText = (v: unknown): string | undefined => text(v) || undefined

/** StillParams from IPC or an agent, with every field of the right type (nothing checked against a model yet). */
export function readStillParams(input: unknown): StillParams {
  if (!input || typeof input !== 'object') throw new Error('Inga inställningar för bilden.')
  const p = input as Record<string, unknown>
  const refs = Array.isArray(p.referenceImages)
    ? [...new Set(p.referenceImages.filter((r): r is string => typeof r === 'string' && r !== ''))]
    : []
  const params: StillParams = { prompt: text(p.prompt), model: text(p.model) }
  if (p.sequenceId !== undefined && p.sequenceId !== null && p.sequenceId !== '') {
    params.sequenceId = safeId(p.sequenceId, 'sekvens-id')
  }
  const negative = optionalText(p.negativePrompt)
  if (negative) params.negativePrompt = negative
  if (refs.length) params.referenceImages = refs
  for (const key of ['aspectRatio', 'resolution', 'quality'] as const) {
    const value = optionalText(p[key])
    if (value) params[key] = value
  }
  return params
}

// ── Rows ─────────────────────────────────────────────────────────────────────

const conn = (): ReturnType<typeof db.getDb> => db.getDb()

function parseStoredParams(json: string): StoredStillParams {
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' ? (value as StoredStillParams) : {}
  } catch {
    return {}
  }
}

function stillFromRow(r: StillRow): Still {
  const stored = parseStoredParams(r.params)
  const params: Still['params'] = {}
  if (typeof stored.negativePrompt === 'string' && stored.negativePrompt) params.negativePrompt = stored.negativePrompt
  if (Array.isArray(stored.referenceImages)) {
    const refs = stored.referenceImages.filter((p): p is string => typeof p === 'string' && p !== '')
    if (refs.length) params.referenceImages = refs.map(fromStoredPath)
  }
  for (const key of ['aspectRatio', 'resolution', 'quality'] as const) {
    if (typeof stored[key] === 'string' && stored[key]) params[key] = stored[key]
  }
  return {
    id: r.id,
    sequenceId: r.sequence_id ?? undefined,
    path: fromStoredPath(r.file_path),
    source: SOURCES.has(r.source as Still['source']) ? (r.source as Still['source']) : 'upload',
    prompt: r.prompt,
    model: r.model ?? undefined,
    params,
    costUsd: r.cost ?? undefined,
    createdAt: r.created_at
  }
}

function getRow(id: string): StillRow | undefined {
  return conn().prepare('SELECT * FROM stills WHERE id = ?').get(id) as StillRow | undefined
}

/** The still, or undefined when there is none with that id. */
export function findStill(id: string): Still | undefined {
  const row = typeof id === 'string' ? getRow(id) : undefined
  return row && stillFromRow(row)
}

/** The still; rejects with a Swedish message when it is gone. */
export function getStill(id: unknown): Still {
  const row = getRow(safeId(id))
  if (!row) throw new Error(GONE)
  return stillFromRow(row)
}

/** The stills of a sequence, or every still when no sequence is given; newest first. */
export function listStills(sequenceId?: unknown): Still[] {
  const rows =
    sequenceId === undefined || sequenceId === null || sequenceId === ''
      ? conn().prepare('SELECT * FROM stills ORDER BY created_at DESC, rowid DESC').all()
      : conn()
          .prepare('SELECT * FROM stills WHERE sequence_id = ? ORDER BY created_at DESC, rowid DESC')
          .all(safeId(sequenceId, 'sekvens-id'))
  return (rows as StillRow[]).map(stillFromRow)
}

interface NewStill {
  path: string
  sequenceId?: string
  source: Still['source']
  prompt: string
  model?: string
  /** Absolute reference paths; stored relative. */
  params: StoredStillParams
  cost?: number
  createdAt: number
}

function insertStill(s: NewStill): Still {
  const id = randomUUID()
  const params: StoredStillParams = { ...s.params }
  if (params.referenceImages) params.referenceImages = params.referenceImages.map(toStoredPath)
  conn()
    .prepare(
      `INSERT INTO stills (id, sequence_id, file_path, source, prompt, model, params, cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      s.sequenceId ?? null,
      toStoredPath(s.path),
      s.source,
      s.prompt,
      s.model ?? null,
      JSON.stringify(params),
      s.cost ?? null,
      s.createdAt
    )
  return getStill(id)
}

// ── Sequences and storyboards ────────────────────────────────────────────────

/**
 * The sequence's (or storyboard's) folder name, null when it has none yet (from before folders), undefined when it
 * is gone.
 */
function sequenceFolder(sequenceId: string): string | null | undefined {
  const row = conn().prepare('SELECT folder FROM sequences WHERE id = ?').get(sequenceId) as
    | { folder: string | null }
    | undefined
  if (!row) return undefined
  const folder = row.folder
  // A folder name from the database is only trusted as one plain path segment.
  return folder && !/[/\\\0]/.test(folder) && folder !== '.' && folder !== '..' ? folder : null
}

/** Whether the row is a sequence or a storyboard (a gone row counts as a sequence; callers check it first). */
function sequenceKind(sequenceId: string): SequenceKind {
  return sequenceKindOf(conn().prepare('SELECT kind FROM sequences WHERE id = ?').pluck().get(sequenceId))
}

function requireSequence(sequenceId: string): void {
  if (sequenceFolder(sequenceId) === undefined) throw new Error(SEQUENCE_GONE)
}

/** The format a sequence's stills get by default: a storyboard's aspect ratio, else the sequence's for its clips. */
function sequenceAspectRatio(sequenceId: string | undefined): string | undefined {
  if (!sequenceId) return undefined
  const row = conn().prepare('SELECT defaults, aspect_ratio FROM sequences WHERE id = ?').get(sequenceId) as
    | { defaults: string; aspect_ratio: string | null }
    | undefined
  if (!row) return undefined
  return row.aspect_ratio || parseDefaults(row.defaults).aspectRatio
}

/** The sequence a take belongs to, if it is one. */
function sequenceOfGeneration(generationId: string): string | undefined {
  return (
    (conn()
      .prepare('SELECT s.sequence_id FROM generations g JOIN segments s ON s.id = g.segment_id WHERE g.id = ?')
      .pluck()
      .get(generationId) as string | undefined) ?? undefined
  )
}

// ── Files ────────────────────────────────────────────────────────────────────

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/**
 * Puts tmp at dest without creating any folder and without overwriting: a hard link (atomic, so Finder never
 * shows half a picture), or a copy on volumes without hard links (exFAT). Fails with ENOENT when dest's
 * folder is gone and EEXIST when the name was taken meanwhile.
 */
async function linkInto(tmp: string, dest: string): Promise<void> {
  try {
    await link(tmp, dest)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'EEXIST' || code === 'ENOENT') throw err
    try {
      await copyFile(tmp, dest, constants.COPYFILE_EXCL)
    } catch (copyErr) {
      // Only remove what this call created: EEXIST means the name belongs to somebody else.
      if (errorCode(copyErr) !== 'EEXIST') await rm(dest, { force: true }).catch(() => {})
      throw copyErr
    }
  }
  await rm(tmp, { force: true }).catch(() => {})
}

/** Records the still for this final path (and sequence, which is gone when undefined); runs synchronously. */
type RecordStill = (path: string, sequenceId: string | undefined) => void

/**
 * Moves a finished picture from the scratch folder to where its still belongs, and records it in the same
 * tick as the last look at where that is: Sekvenser/<sequence>/Storyboard/ for a sequence's still,
 * Storyboards/<storyboard>/Bilder/ for a storyboard's.
 *
 * A sequence's folder can be renamed at any moment (its name changed): sequences.ts moves the folder on disk
 * and then rewrites every stored path below it in one transaction. So the picture is linked into the folder
 * without ever creating that folder (a folder renamed away just now is not brought back under its old name), and
 * the row is written once the file is seen where the database says the folder is: before the rewrite (which
 * then rewrites the row too) or after it (the file moved with the folder). Without a sequence, for a sequence
 * that has no folder yet, or one deleted meanwhile, the picture goes to Referensbilder/<day>/.
 */
async function placeStill(
  tmp: string,
  sequenceId: string | undefined,
  base: string,
  ext: string,
  record: RecordStill
): Promise<string> {
  for (let attempt = 1; attempt <= PLACE_ATTEMPTS; attempt++) {
    const folder = sequenceId ? sequenceFolder(sequenceId) : undefined
    if (!folder) {
      const path = await placeFile(tmp, referencesDayDir(new Date()), base, ext)
      // Same tick as the record: a sequence deleted during the move no longer takes the still.
      record(path, sequenceId && sequenceFolder(sequenceId) !== undefined ? sequenceId : undefined)
      return path
    }
    const kind = sequenceKind(sequenceId!)
    const layout = KIND_FOLDERS[kind]
    const parent = join(libraryRoot(), layout.parent, folder)
    if (!existsSync(parent)) {
      // Being renamed right now (the database follows the move), or removed in Finder: give a rename a moment,
      // then bring the folder back like any other sequence folder removed in Finder.
      if (attempt <= RENAME_WAITS) {
        await delay(RENAME_WAIT_MS)
        continue
      }
      sequenceDir(folder, kind)
    }
    assertRootIntact()
    const dir = join(parent, layout.stills)
    try {
      await mkdir(dir)
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        if (errorCode(err) === 'ENOENT' && attempt < PLACE_ATTEMPTS) continue
        throw err
      }
    }
    const dest = join(dir, uniqueName(dir, base, ext))
    try {
      await linkInto(tmp, dest)
    } catch (err) {
      const code = errorCode(err)
      if ((code === 'EEXIST' || code === 'ENOENT') && attempt < PLACE_ATTEMPTS && existsSync(tmp)) continue
      throw err
    }
    return settle(dest, folder, sequenceId!, base, ext, record)
  }
  throw new Error('Bilden kunde inte läggas i sekvensens eller storyboardens mapp. Försök igen.')
}

/** Records a picture just linked into the sequence's folder once it is where the database says (see placeStill). */
async function settle(
  dest: string,
  folder: string,
  sequenceId: string,
  base: string,
  ext: string,
  record: RecordStill
): Promise<string> {
  const name = basename(dest)
  for (let step = 0; step < SETTLE_STEPS; step++) {
    const now = sequenceFolder(sequenceId)
    if (now === undefined) {
      // The sequence was deleted meanwhile: the picture becomes a still of no sequence, in Referensbilder.
      if (!existsSync(dest)) break
      const path = await placeFile(dest, referencesDayDir(new Date()), base, ext)
      record(path, undefined)
      return path
    }
    const layout = KIND_FOLDERS[sequenceKind(sequenceId)]
    const expected = !now || now === folder ? dest : join(libraryRoot(), layout.parent, now, layout.stills, name)
    if (existsSync(expected)) {
      record(expected, sequenceId)
      return expected
    }
    // Moved on disk and not yet in the database (or the other way round): the rename is half done.
    await delay(SETTLE_STEP_MS)
  }
  if (existsSync(dest)) {
    record(dest, sequenceFolder(sequenceId) === undefined ? undefined : sequenceId)
    return dest
  }
  throw new Error('Bilden kom bort när mappen den skulle läggas i flyttades. Försök igen.')
}

/**
 * Places a finished picture for a new still (see placeStill) and records it. A picture that can't go to its
 * sequence's folder is saved in Referensbilder instead (it may have been paid for), and only when even that
 * fails does this reject.
 */
async function saveNewStill(
  tmp: string,
  base: string,
  ext: string,
  fields: Omit<NewStill, 'path' | 'sequenceId' | 'createdAt'> & { sequenceId?: string }
): Promise<Still> {
  let still: Still | undefined
  const record: RecordStill = (path, sequenceId) => {
    still = insertStill({ ...fields, path, sequenceId, createdAt: Date.now() })
  }
  try {
    await placeStill(tmp, fields.sequenceId, base, ext, record)
  } catch (err) {
    if (still || !fields.sequenceId || !existsSync(tmp)) throw err
    console.warn('Could not place a still in its sequence folder; keeping it in Referensbilder:', err)
    const owner = fields.sequenceId
    await placeStill(tmp, undefined, base, ext, (path) =>
      record(path, sequenceFolder(owner) === undefined ? undefined : owner)
    )
  }
  if (!still) throw new Error('Bilden kunde inte sparas.')
  notifyChange(still.sequenceId)
  return still
}

/** A scratch file for a picture on its way into the library; removed by the caller once placed (or failed). */
function scratchPath(ext: string): string {
  return join(tmpDir(), `${randomUUID()}${ext}`)
}

/** Moves a library file to the Trash (deleting it without one); files outside the library are never touched. */
async function trashFile(path: string): Promise<void> {
  if (!isInsideRoot(path) || !existsSync(path)) return
  try {
    await shell.trashItem(path)
  } catch {
    await rm(path, { force: true }).catch((err: unknown) => console.warn(`Could not remove ${path}:`, err))
  }
}

/**
 * A deleted still's file that generations, clips or other stills still use (as a start, end or reference
 * image) is kept: it moves to Referensbilder/<today>/ (unless it is in Referensbilder already) and every row
 * that uses it follows, so "Använd igen" and the clips keep their picture. Call once the still's row is gone,
 * so only other rows count. 'moved' when the rows were rewritten, 'kept' when it stays where it is, false
 * when nothing uses it.
 */
async function keepUsedFile(path: string): Promise<'moved' | 'kept' | false> {
  const stored = toStoredPath(path)
  if (isAbsolute(stored) || !existsSync(path) || !db.isStoredPathRecorded(stored)) return false
  if (stored.startsWith(`${FOLDERS.references}/`)) return 'kept'
  const ext = extname(path)
  try {
    const dest = await placeFile(
      path,
      referencesDayDir(new Date()),
      safeName(basename(path, ext), { fallback: 'Bild' }),
      ext.toLowerCase()
    )
    try {
      conn().transaction(() => db.rewriteStoredPrefix(stored, toStoredPath(dest)))()
    } catch (err) {
      // Put the file back so every stored path still points at it.
      await movePath(dest, path).catch((e: unknown) => console.warn(`Could not move ${dest} back to ${path}:`, e))
      throw err
    }
    return 'moved'
  } catch (err) {
    console.warn(`Could not keep ${path} for the rows that use it:`, err)
    // Rather left where it is than trashed while something uses it.
    return 'kept'
  }
}

/**
 * Removes a sequence's Storyboard folder, a storyboard's Bilder folder (or a Referensbilder day) that a delete has
 * just emptied.
 */
async function removeFolderIfEmptied(dir: string): Promise<void> {
  const stored = toStoredPath(dir).split('/')
  const stillsFolder = Object.values(KIND_FOLDERS).some(
    (layout) => stored.length === 3 && stored[0] === layout.parent && stored[2] === layout.stills
  )
  if (stillsFolder) await removeDirIfEmpty(dir)
  else await removeDayFolderIfEmpty(dir)
}

function sha1(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

// ── Generating ───────────────────────────────────────────────────────────────

/** What a still will be made with, checked against the model, and its price. */
export interface StillPlan {
  /** As it will be sent and recorded: the model, aspect ratio, resolution and quality filled in. */
  params: StillParams
  model: ImageModel
  /** USD, from the model list's pricing; undefined when the list has no price for it. */
  priceUsd?: number
  /** What was adjusted on the way (Swedish), e.g. an aspect ratio the model doesn't have. */
  notes: string[]
}

/** The model a request names, or the default for it (references: an edit model; none: a text-to-image model). */
function pickModel(models: ImageModelInfo[], requested: string, edit: boolean): ImageModelInfo | undefined {
  if (requested) return models.find((m) => m.id === requested)
  const preferred = edit ? DEFAULT_EDIT_MODEL : DEFAULT_IMAGE_MODEL
  return (
    models.find((m) => m.id === preferred && !m.offline) ??
    models.find((m) => m.edit === edit && !m.offline) ??
    models.find((m) => m.id === preferred)
  )
}

const listOf = (values: readonly string[]): string => values.filter((v) => v !== 'auto').join(', ')

function fileName(path: string): string {
  return basename(path) || path
}

/**
 * Checks a still request against the model before anything is paid for (Swedish errors), fills in what was
 * left out — the default model for it, the sequence's aspect ratio (or the nearest one the model has), 1K and the
 * model's default quality — and prices it. The window's dialog and the agents' approval show exactly this.
 */
export async function planStill(input: unknown): Promise<StillPlan> {
  return (await plan(input)).plan
}

async function plan(input: unknown): Promise<{ plan: StillPlan; model: ImageModelInfo }> {
  const params = readStillParams(input)
  const notes: string[] = []
  if (!params.prompt) throw new Error('Skriv en prompt för bilden.')
  if (params.sequenceId) requireSequence(params.sequenceId)
  const refs = params.referenceImages ?? []

  const models = await imageModelCatalog()
  const model = pickModel(models, params.model, refs.length > 0)
  if (!model) {
    throw new Error(
      params.model
        ? `Venice har ingen bildmodell som heter ${params.model}. Välj en annan modell.`
        : 'Venice har ingen bildmodell att skapa bilden med just nu.'
    )
  }
  if (model.offline) throw new Error(`${model.name} är inte tillgänglig hos Venice just nu. Välj en annan modell.`)
  if (refs.length && !model.edit) {
    throw new Error(
      `${model.name} skapar bilder från text och kan inte använda referensbilder. Välj en modell som kombinerar bilder, eller ta bort referenserna.`
    )
  }
  if (!refs.length && model.edit) {
    throw new Error(
      `${model.name} utgår från referensbilder. Lägg till minst en, eller välj en modell som skapar bilder från text.`
    )
  }
  if (refs.length > model.maxInputImages) {
    const extra = refs.length - model.maxInputImages
    throw new Error(
      `${model.name} tar högst ${model.maxInputImages} referensbilder – ta bort ${extra === 1 ? 'en' : extra}.`
    )
  }
  for (const ref of refs) {
    if (!isAbsolute(ref)) throw new Error(`Referensbilden ${fileName(ref)} har ingen fullständig sökväg.`)
    if (!IMAGE_EXTENSIONS.has(extname(ref).toLowerCase())) {
      throw new Error(`${fileName(ref)} är ingen bild i JPG, PNG eller WebP.`)
    }
    if (!existsSync(ref)) {
      throw new Error(`Referensbilden ${fileName(ref)} finns inte längre. Ta bort den och välj en ny.`)
    }
  }

  const limit = model.promptCharacterLimit
  if (limit && params.prompt.length > limit) {
    throw new Error(`Prompten är för lång för ${model.name}: högst ${limit} tecken (nu ${params.prompt.length}).`)
  }
  let negativePrompt = params.negativePrompt
  if (negativePrompt && model.edit) {
    notes.push('Modeller som kombinerar bilder tar ingen negativ prompt, så den skickas inte.')
    negativePrompt = undefined
  }
  if (limit && negativePrompt && negativePrompt.length > limit) {
    throw new Error(`Den negativa prompten är för lång för ${model.name}: högst ${limit} tecken.`)
  }

  let aspectRatio: string | undefined
  if (params.aspectRatio) {
    if (model.aspectRatios.length && !model.aspectRatios.includes(params.aspectRatio)) {
      throw new Error(
        `${model.name} har inte bildformatet ${params.aspectRatio}. Välj ett av: ${listOf(model.aspectRatios)}.`
      )
    }
    aspectRatio = model.aspectRatios.length ? params.aspectRatio : undefined
  } else if (model.aspectRatios.length) {
    const wanted = sequenceAspectRatio(params.sequenceId) ?? DEFAULT_ASPECT_RATIO
    aspectRatio = closestAspectRatio(wanted, model.aspectRatios)
    if (aspectRatio && aspectRatio !== wanted) {
      notes.push(
        aspectRatio === 'auto'
          ? `${model.name} har inte bildformatet ${wanted}; bilden får samma format som den första referensbilden.`
          : `${model.name} har inte bildformatet ${wanted}; ${aspectRatio} används i stället.`
      )
    }
  }

  if (params.resolution && model.resolutions.length && !model.resolutions.includes(params.resolution)) {
    throw new Error(
      `${model.name} har inte upplösningen ${params.resolution}. Välj ett av: ${listOf(model.resolutions)}.`
    )
  }
  if (params.quality && model.qualities.length && !model.qualities.includes(params.quality)) {
    throw new Error(`${model.name} har inte kvaliteten ${params.quality}. Välj en av: ${listOf(model.qualities)}.`)
  }
  const resolution = effectiveResolution(model, params.resolution)
  const quality = effectiveQuality(model, params.quality)

  const resolved: StillParams = { prompt: params.prompt, model: model.id }
  if (params.sequenceId) resolved.sequenceId = params.sequenceId
  if (negativePrompt) resolved.negativePrompt = negativePrompt
  if (refs.length) resolved.referenceImages = refs
  if (aspectRatio) resolved.aspectRatio = aspectRatio
  if (resolution) resolved.resolution = resolution
  if (quality) resolved.quality = quality
  return {
    plan: {
      params: resolved,
      model: publicImageModel(model),
      priceUsd: priceImage(model, { resolution, quality, inputImages: refs.length }),
      notes
    },
    model
  }
}

/**
 * The price of a still in USD, for the dialog's button while the user is still choosing: lenient (no file
 * checks, the defaults filled in as planStill would). Undefined when the model or its price is unknown.
 */
export async function quoteStill(input: unknown): Promise<number | undefined> {
  let params: StillParams
  try {
    params = readStillParams(input)
  } catch {
    return undefined
  }
  const refs = params.referenceImages?.length ?? 0
  const model = pickModel(await imageModelCatalog(), params.model, refs > 0)
  if (!model) return undefined
  return priceImage(model, {
    resolution: params.resolution,
    quality: params.quality,
    inputImages: Math.min(refs, model.maxInputImages || refs)
  })
}

/**
 * Generates a still with Venice (paid; the window confirms with the price, an agent's request needs the user's
 * approval) and saves it as a still of its sequence: Sekvenser/<sequence>/Storyboard/<HH.MM> <prompt>.png (a
 * storyboard's in Storyboards/<storyboard>/Bilder/), or Referensbilder/<day>/ without one. Reference pictures from
 * outside the library are copied into Referensbilder first, so "Skapa igen" keeps working when the originals go.
 */
export async function generateStill(input: unknown): Promise<Still> {
  return stillTask(async () => {
    // Renames from here on (a sequence folder renamed while Venice works) are followed when the still is recorded.
    const mark = db.rewriteMark()
    const { plan: checked, model } = await plan(input)
    const params = checked.params
    let refs = params.referenceImages ?? []
    if (refs.length) {
      // importExternalReferences works on generation params; only the reference images matter here.
      const copied = await importExternalReferences({
        model: model.id,
        prompt: '',
        duration: '',
        referenceImages: refs
      } satisfies GenerationParams)
      refs = copied.referenceImages ?? refs
    }

    const result = await requestImage({
      model,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      referenceImages: refs,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      quality: params.quality
    })

    // Paid for from here on: whatever happens, the picture should end up somewhere the user can find it.
    const base = `${timeStamp(new Date())} ${promptExcerpt(params.prompt)}`
    let data = result.data
    let ext = result.format === 'jpeg' ? '.jpg' : `.${result.format}`
    let tmp: string | undefined
    try {
      const png = toPng(result)
      if (png) {
        data = png
        ext = '.png'
      }
      tmp = scratchPath(ext)
      await writeFile(tmp, data)
      // Its "Skapa igen" sends these again: where the files are now, not where they were before the request.
      if (refs.length) {
        const followed = db.followRewrites({ model: model.id, prompt: '', duration: '', referenceImages: refs }, mark)
        refs = followed.referenceImages ?? refs
      }
      return await saveNewStill(tmp, base, ext, {
        sequenceId: params.sequenceId,
        source: 'generated',
        prompt: params.prompt,
        model: model.id,
        params: {
          negativePrompt: params.negativePrompt,
          referenceImages: refs.length ? refs : undefined,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          quality: params.quality
        },
        cost: checked.priceUsd
      })
    } catch (err) {
      // The scratch file is no place to leave it: the folder is hidden and emptied when the library opens next.
      const rescued = await rescuePicture(data, base, ext)
      throw new Error(
        `Bilden skapades men kunde inte sparas i biblioteket: ${fileErrorReason(err).replace(/\.$/, '')}.` +
          (rescued ? ` Den har sparats i Hämtade filer i stället: ${basename(rescued)}.` : ''),
        { cause: err }
      )
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => {})
    }
  })
}

/**
 * A paid picture that couldn't be saved in the library (its folders can't be written to, or the library went away
 * while Venice worked) is written to the user's Downloads folder instead, so what was paid for isn't lost. Never
 * overwrites a file there. Resolves its path, or undefined when even that failed.
 */
async function rescuePicture(data: Buffer, base: string, ext: string): Promise<string | undefined> {
  try {
    const dir = app.getPath('downloads')
    await mkdir(dir, { recursive: true })
    const stem = safeName(`Studio ${base}`, { fallback: 'Studio-bild' })
    for (let n = 1; n <= 100; n++) {
      const path = join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`)
      try {
        await writeFile(path, data, { flag: 'wx' })
        return path
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw err
      }
    }
  } catch (err) {
    console.warn('Could not keep a paid picture in Downloads either:', err)
  }
  return undefined
}

// ── Frames and files ─────────────────────────────────────────────────────────

/** "7,5 s" */
function secondsLabel(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1).replace('.', ',')} s`
}

/** An earlier still of exactly this frame for this sequence (or none), whose file is still there. */
function findFrameStill(generationId: string, ms: number, sequenceId: string | undefined): Still | undefined {
  const row = conn()
    .prepare(
      `SELECT * FROM stills WHERE source = 'frame' AND sequence_id IS ?
         AND json_extract(params, '$.frame.generationId') = ? AND json_extract(params, '$.frame.time') = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sequenceId ?? null, generationId, ms) as StillRow | undefined
  const still = row && stillFromRow(row)
  return still && existsSync(still.path) ? still : undefined
}

/**
 * Saves the frame a take shows at `time` seconds as a still ('frame'): of the given sequence, else of the
 * take's own sequence, else of none. The frame is the one a player paused at that moment shows (the last one
 * that starts at or before it). Saving the same frame again for the same sequence returns the earlier still.
 */
export async function saveFrameAsStill(generationId: unknown, time: unknown, sequenceId?: unknown): Promise<Still> {
  const id = safeId(generationId)
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new Error('Ogiltig tidpunkt i klippet.')
  const requested =
    sequenceId === undefined || sequenceId === null || sequenceId === '' ? undefined : safeId(sequenceId, 'sekvens-id')
  return stillTask(async () => {
    const g = db.getGeneration(id)
    if (!g) throw new Error('Tagningen finns inte längre.')
    if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
      throw new Error('Tagningen har ingen färdig video att ta en bildruta ur.')
    }
    if (requested) requireSequence(requested)
    const owner = requested ?? sequenceOfGeneration(id)
    const length = g.videoDuration
    const ms = Math.round((length !== undefined && length > 0 ? Math.min(time, length) : time) * 1000)
    const earlier = findFrameStill(id, ms, owner)
    if (earlier) return earlier

    const tmp = scratchPath('.png')
    try {
      // extractFrame keeps the last frame that starts before the time it is given; a millisecond more makes a
      // frame that starts exactly at `time` count, as it does in a paused player. 0 is the very first frame.
      await extractFrame(g.filePath, tmp, ms === 0 ? 0 : ms / 1000 + 0.001)
      const base = `${timeStamp(new Date())} Bildruta ${secondsLabel(ms)} ${promptExcerpt(g.prompt, 40)}`
      return await saveNewStill(tmp, base, '.png', {
        sequenceId: owner,
        source: 'frame',
        prompt: '',
        params: { frame: { generationId: id, time: ms } }
      })
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  })
}

/** An upload still of this sequence (or of none) with exactly the content of src, whose file is still there. */
async function findUploadDuplicate(src: string, sequenceId: string | undefined): Promise<Still | undefined> {
  const size = (await stat(src)).size
  const candidates = (
    conn()
      .prepare(`SELECT * FROM stills WHERE source = 'upload' AND sequence_id IS ? ORDER BY created_at DESC`)
      .all(sequenceId ?? null) as StillRow[]
  ).map(stillFromRow)
  let hash: string | undefined
  for (const still of candidates) {
    const info = await stat(still.path).catch(() => undefined)
    if (!info?.isFile() || info.size !== size) continue
    hash ??= await sha1(src)
    if ((await sha1(still.path).catch(() => '')) === hash) return still
  }
  return undefined
}

/**
 * Copies a picture file into the library as a still ('upload') of the sequence or storyboard — the 'file' source of
 * a keyframe slot or a board, a picture dropped onto one — under its own name in its Storyboard (Bilder) folder.
 * A still's own file gives that still, and the same picture dropped again into the same sequence gives the
 * still it became the first time.
 */
export async function importStillFile(src: unknown, sequenceId?: unknown): Promise<Still> {
  if (typeof src !== 'string' || !isAbsolute(src)) throw new Error('Ogiltig sökväg till bilden.')
  const ext = extname(src).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error('Bara bilder i JPG, PNG eller WebP kan användas.')
  const owner =
    sequenceId === undefined || sequenceId === null || sequenceId === '' ? undefined : safeId(sequenceId, 'sekvens-id')
  return stillTask(async () => {
    if (owner) requireSequence(owner)
    const info = await stat(src).catch(() => undefined)
    if (!info?.isFile()) throw new Error(`Bilden ${fileName(src)} finns inte.`)
    const stored = toStoredPath(src)
    if (!isAbsolute(stored)) {
      const own = conn().prepare('SELECT * FROM stills WHERE file_path = ? COLLATE NOCASE').get(stored) as
        | StillRow
        | undefined
      if (own) return stillFromRow(own)
    }
    const duplicate = await findUploadDuplicate(src, owner)
    if (duplicate) return duplicate

    const tmp = scratchPath(ext)
    try {
      await copyFile(src, tmp, constants.COPYFILE_EXCL)
      if ((await stat(tmp)).size !== info.size) throw new Error('kopian blev ofullständig')
      return await saveNewStill(tmp, safeName(basename(src, extname(src)), { fallback: 'Bild' }), ext, {
        sequenceId: owner,
        source: 'upload',
        prompt: '',
        params: {}
      })
    } catch (err) {
      throw new Error(`Kunde inte kopiera ${fileName(src)} till biblioteket: ${fileErrorReason(err)}.`, { cause: err })
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  })
}

// ── Deleting ─────────────────────────────────────────────────────────────────

/**
 * Deletes the still. Its file goes to the Trash, unless clips, generations or other stills still use it: then it
 * is kept in Referensbilder and those rows follow it there.
 */
export async function deleteStill(id: unknown): Promise<void> {
  const stillId = safeId(id)
  await stillTask(async () => {
    const row = getRow(stillId)
    if (!row) return
    conn().prepare('DELETE FROM stills WHERE id = ?').run(stillId)
    const path = fromStoredPath(row.file_path)
    const kept = await keepUsedFile(path)
    if (kept === 'moved') notifyFilesMoved()
    if (!kept) {
      await trashFile(path)
      await removeFolderIfEmptied(dirname(path))
    }
    notifyChange(row.sequence_id ?? undefined)
  })
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/**
 * The image and still handlers ('images:*', 'stills:*'). `changed` fires with the
 * sequence id (undefined for a still without one) after every still that is added or deleted; `filesMoved`
 * after a deleted still's file was kept in Referensbilder, which rewrote the paths clips and generations use.
 * 'stills:get' isn't part of StudioApi; agents use it.
 */
export function registerStillsIpc(
  changed: (sequenceId?: string) => void,
  filesMoved: () => void = () => {}
): void {
  notifyChange = changed
  notifyFilesMoved = filesMoved
  ipcMain.handle('images:models', (_e, force?: unknown) => listImageModels(force === true))
  ipcMain.handle('images:quote', (_e, params: unknown) => quoteStill(params))
  ipcMain.handle('images:generate', (_e, params: unknown) => generateStill(params))
  ipcMain.handle('stills:list', (_e, sequenceId?: unknown) => listStills(sequenceId))
  ipcMain.handle('stills:get', (_e, id: unknown) => getStill(id))
  ipcMain.handle('stills:delete', (_e, id: unknown) => deleteStill(id))
  ipcMain.handle('stills:saveFrame', (_e, generationId: unknown, time: unknown, sequenceId?: unknown) =>
    saveFrameAsStill(generationId, time, sequenceId)
  )
}
