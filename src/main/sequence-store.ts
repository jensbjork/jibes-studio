// Database access and assembly for sequences and their segments, and where their files live on disk.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm, rmdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DEFAULT_PARAMS, durationSeconds, sanitizeReferenceAudios } from '@shared/models'
import { sanitizeDescriptionFlags } from '@shared/prompt-compose'
import { isExtractedFirstFrame, isExtractedFrame } from '@shared/seams'
import type { Generation, GenerationParams, Segment, Sequence, SequenceSummary } from '@shared/types'
import * as db from './db'
import { toPublic } from './jobs'
import { attachReviewSummary } from './reviews'
import {
  dayStamp,
  FOLDERS,
  fromStoredParams,
  fromStoredPath,
  libraryRoot,
  promptExcerpt,
  safeName,
  STORYBOARD_FOLDER,
  TAKES_FOLDER,
  timeStamp,
  toStoredParams,
  toStoredPath
} from './paths'

/** Shortest piece of a take that trimming may leave, in seconds. */
export const MIN_REMAINING_SECONDS = 0.2

export const UNTITLED_SEQUENCE = 'Namnlös sekvens'

export interface SequenceRow {
  id: string
  name: string
  defaults: string
  /** Name of the sequence's folder in Sekvenser/; null for rows from before folders existed. */
  folder: string | null
  created_at: number
  updated_at: number
}

export interface SegmentRow {
  id: string
  sequence_id: string
  position: number
  params: string
  continue_from_previous: number
  /** 1: the clip's end image is the next clip's first frame (never on the last clip). */
  end_from_next: number
  notes: string
  selected_generation_id: string | null
  trim_start: number
  trim_end: number
  created_at: number
}

/** A row of the stills table (paths in stored form). */
export interface StillRow {
  id: string
  sequence_id: string | null
  file_path: string
  source: string
  prompt: string
  model: string | null
  params: string
  cost: number | null
  created_at: number
}

/** In-memory "generate all" state that is merged into the sequence on read. */
export interface RunInfo {
  running: boolean
  error?: string
}

const conn = (): ReturnType<typeof db.getDb> => db.getDb()

export function getSequenceRow(id: string): SequenceRow | undefined {
  return conn().prepare('SELECT * FROM sequences WHERE id = ?').get(id) as SequenceRow | undefined
}

export function requireSequenceRow(id: string): SequenceRow {
  const row = typeof id === 'string' ? getSequenceRow(id) : undefined
  if (!row) throw new Error('Sekvensen finns inte längre.')
  return row
}

export function getSegmentRow(id: string): SegmentRow | undefined {
  return conn().prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined
}

export function requireSegmentRow(id: string): SegmentRow {
  const row = typeof id === 'string' ? getSegmentRow(id) : undefined
  if (!row) throw new Error('Klippet finns inte längre.')
  return row
}

/** Segments in cut order. */
export function listSegmentRows(sequenceId: string): SegmentRow[] {
  return conn()
    .prepare('SELECT * FROM segments WHERE sequence_id = ? ORDER BY position, created_at')
    .all(sequenceId) as SegmentRow[]
}

/** Ids of every generation stored as a take of the given segments. */
export function takeIdsForSegments(segmentIds: string[]): string[] {
  return db.listGenerationsForSegments(segmentIds).map((g) => g.id)
}

export function touchSequence(id: string): void {
  conn().prepare('UPDATE sequences SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

/**
 * Writes positions 0..n-1 in the given order. The first segment has nothing to continue from and the last
 * one nothing to take its end image from, so those flags are always cleared there (after a move, a delete or
 * an insert at the end).
 */
export function renumberSegments(orderedIds: string[]): void {
  const setPosition = conn().prepare('UPDATE segments SET position = ? WHERE id = ?')
  const clearContinue = conn().prepare('UPDATE segments SET continue_from_previous = 0 WHERE id = ?')
  const clearEndFromNext = conn().prepare('UPDATE segments SET end_from_next = 0 WHERE id = ?')
  orderedIds.forEach((id, i) => setPosition.run(i, id))
  if (!orderedIds.length) return
  clearContinue.run(orderedIds[0])
  clearEndFromNext.run(orderedIds[orderedIds.length - 1])
}

/** Notes as stored: any string (the user's text, kept exactly as typed); anything else is none. */
export function cleanNotes(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ── Params ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Normalises params coming from the renderer, an agent or JSON, dropping anything malformed. Reference audio
 * clips keep their windows; whether the model can use them is decided when a take is sent (paramsForSubmit).
 * The description switches (includeDescriptions, excludedDescriptionAssetIds) are kept: they decide what a take
 * appends to its prompt, and "Använd igen" on a take brings them back.
 */
export function sanitizeParams(input: Partial<GenerationParams> | undefined): GenerationParams {
  const p = input ?? {}
  const refs = Array.isArray(p.referenceImages)
    ? p.referenceImages.filter((r): r is string => typeof r === 'string' && !!r)
    : undefined
  return {
    model: str(p.model) ?? DEFAULT_PARAMS.model,
    prompt: typeof p.prompt === 'string' ? p.prompt : '',
    negativePrompt: str(p.negativePrompt),
    duration: str(p.duration) ?? DEFAULT_PARAMS.duration,
    resolution: str(p.resolution),
    aspectRatio: str(p.aspectRatio),
    audio: typeof p.audio === 'boolean' ? p.audio : undefined,
    startImage: str(p.startImage),
    endImage: str(p.endImage),
    referenceImages: refs?.length ? refs : undefined,
    referenceAudios: sanitizeReferenceAudios(p.referenceAudios),
    ...sanitizeDescriptionFlags(p)
  }
}

/** Segment params as stored (image paths inside the library relative), turned back into absolute paths. */
export function parseParams(json: string): GenerationParams {
  let params: GenerationParams
  try {
    params = sanitizeParams(JSON.parse(json) as Partial<GenerationParams>)
  } catch {
    return sanitizeParams(DEFAULT_PARAMS)
  }
  return fromStoredParams(params)
}

/** The stored form of segment params: image paths inside the library become relative, so it can move. */
export function serializeParams(params: GenerationParams): string {
  return JSON.stringify(toStoredParams(params))
}

/** Only the output settings are kept as sequence defaults; prompts and images belong to segments. */
export function pickDefaults(input: Partial<GenerationParams> | undefined): Partial<GenerationParams> {
  const p = input ?? {}
  const out: Partial<GenerationParams> = {}
  if (str(p.model)) out.model = p.model
  if (str(p.duration)) out.duration = p.duration
  if (str(p.resolution)) out.resolution = p.resolution
  if (str(p.aspectRatio)) out.aspectRatio = p.aspectRatio
  if (typeof p.audio === 'boolean') out.audio = p.audio
  return out
}

export function parseDefaults(json: string): Partial<GenerationParams> {
  try {
    return pickDefaults(JSON.parse(json) as Partial<GenerationParams>)
  } catch {
    return {}
  }
}

export function cleanSequenceName(name: unknown): string {
  return (typeof name === 'string' ? name.trim() : '') || UNTITLED_SEQUENCE
}

// ── Takes ────────────────────────────────────────────────────────────────────

export function selectedTake(row: SegmentRow): db.StoredGeneration | undefined {
  return row.selected_generation_id ? db.getGeneration(row.selected_generation_id) : undefined
}

export function isPending(g: Generation | undefined): boolean {
  return g?.status === 'queued' || g?.status === 'processing'
}

/** A completed take whose video is still on disk, i.e. something that can be cut or continued from. */
export function isUsable(g: Generation | undefined): g is Generation & { filePath: string } {
  return g?.status === 'completed' && !!g.filePath && existsSync(g.filePath)
}

/** Length of a take in seconds: measured when known, otherwise what was requested. */
export function takeLength(g: Generation): number | undefined {
  const length = g.videoDuration ?? durationSeconds(g.params.duration)
  return length > 0 ? length : undefined
}

const round = (v: number): number => Math.round(v * 1000) / 1000

/**
 * Keeps trims non-negative and leaves at least MIN_REMAINING_SECONDS of the take.
 * `yieldFirst` is the trim that gives way first, normally the one the user just changed.
 */
export function clampTrims(
  trimStart: number,
  trimEnd: number,
  length: number | undefined,
  yieldFirst: 'start' | 'end'
): { trimStart: number; trimEnd: number } {
  const clean = (v: number): number => (Number.isFinite(v) && v > 0 ? round(v) : 0)
  let start = clean(trimStart)
  let end = clean(trimEnd)
  if (length === undefined) return { trimStart: start, trimEnd: end }
  const room = Math.max(0, length - MIN_REMAINING_SECONDS)
  if (start + end > room) {
    if (yieldFirst === 'start') {
      start = Math.max(0, room - end)
      end = Math.min(end, room - start)
    } else {
      end = Math.max(0, room - start)
      start = Math.min(start, room - end)
    }
  }
  return { trimStart: round(start), trimEnd: round(end) }
}

/**
 * The trims a segment keeps when `take` becomes its selected take. Trims belong to the segment and carry over to
 * another take, except at a side the take was made to meet exactly: a start made from the previous clip's last
 * frame (the clip continues from it), or from a frame of one of the segment's own takes (where "Gör om mellan
 * grannarna" lets the first clip keep its opening); an end made from the next clip's first frame (the clip ends on
 * it). A trim there was meant for another take, and would cut away the very frame this one was generated from, and
 * with it the seamless cut it was paid for. `row` carries the link flags the segment has (or is about to have).
 */
export function seamTrims(row: SegmentRow, take: Generation): { trimStart: number; trimEnd: number } {
  const start = take.params.startImage
  const end = take.params.endImage
  const startMet = row.continue_from_previous ? isExtractedFrame(start) : !!start && isOwnFrameStill(row.id, start)
  const endMet = !!row.end_from_next && isExtractedFirstFrame(end)
  return { trimStart: startMet ? 0 : row.trim_start, trimEnd: endMet ? 0 : row.trim_end }
}

/** The picture is a still saved from a frame of one of the segment's own takes. */
function isOwnFrameStill(segmentId: string, path: string): boolean {
  const stored = toStoredPath(path)
  return !!conn()
    .prepare(
      `SELECT 1 FROM stills s JOIN generations g ON g.id = json_extract(s.params, '$.frame.generationId')
       WHERE s.file_path = ? COLLATE NOCASE AND s.source = 'frame' AND g.segment_id = ? LIMIT 1`
    )
    .get(stored, segmentId)
}

/**
 * Points a segment at a take, re-clamping the trims to that take's length (and starting a side the take was made
 * to meet exactly untrimmed, see seamTrims).
 */
export function setSelectedTake(row: SegmentRow, take: Generation | undefined): void {
  const kept = take && take.id !== row.selected_generation_id ? seamTrims(row, take) : undefined
  const { trimStart, trimEnd } = clampTrims(
    kept?.trimStart ?? row.trim_start,
    kept?.trimEnd ?? row.trim_end,
    take && takeLength(take),
    'end'
  )
  conn()
    .prepare('UPDATE segments SET selected_generation_id = ?, trim_start = ?, trim_end = ? WHERE id = ?')
    .run(take?.id ?? null, trimStart, trimEnd, row.id)
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Public take, flagged when its video is gone, so the renderer counts clips to generate the way runs do. */
function toTake(g: db.StoredGeneration): Generation {
  const take = toPublic(g)
  return g.status === 'completed' && g.filePath && !existsSync(g.filePath) ? { ...take, fileMissing: true } : take
}

function insertNewestFirst(takes: Generation[], g: Generation): void {
  const i = takes.findIndex((t) => t.createdAt < g.createdAt)
  if (i < 0) takes.push(g)
  else takes.splice(i, 0, g)
}

function toSegment(row: SegmentRow, takes: Generation[]): Segment {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    position: row.position,
    params: parseParams(row.params),
    continueFromPrevious: !!row.continue_from_previous,
    endFromNext: !!row.end_from_next,
    notes: row.notes ?? '',
    selectedGenerationId: row.selected_generation_id ?? undefined,
    trimStart: row.trim_start,
    trimEnd: row.trim_end,
    takes,
    createdAt: row.created_at
  }
}

export function loadSequence(id: string, run: RunInfo): Sequence {
  const row = requireSequenceRow(id)
  const segmentRows = listSegmentRows(id)

  const takesBySegment = new Map<string, Generation[]>()
  for (const g of db.listGenerationsForSegments(segmentRows.map((s) => s.id))) {
    if (!g.segmentId) continue
    const list = takesBySegment.get(g.segmentId) ?? []
    list.push(toTake(g))
    takesBySegment.set(g.segmentId, list)
  }

  const segments = segmentRows.map((r) => {
    const takes = takesBySegment.get(r.id) ?? []
    const selectedId = r.selected_generation_id
    // A generation picked from the feed may belong to another segment (or none); show it here too.
    if (selectedId && !takes.some((t) => t.id === selectedId)) {
      const g = db.getGeneration(selectedId)
      if (g) insertNewestFirst(takes, toTake(g))
    }
    return toSegment(r, takes)
  })
  // The user's stars and the review count, like the feed shows them (one query for every take).
  attachReviewSummary(segments.flatMap((s) => s.takes))

  return {
    id: row.id,
    name: row.name,
    defaults: parseDefaults(row.defaults),
    segments,
    running: run.running,
    runError: run.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

interface SummaryJoinRow {
  sequence_id: string
  trim_start: number
  trim_end: number
  status: string | null
  take_params: string | null
  video_duration: number | null
  thumb_path: string | null
}

export function listSequenceSummaries(): SequenceSummary[] {
  const sequences = conn().prepare('SELECT * FROM sequences ORDER BY updated_at DESC').all() as SequenceRow[]
  const rows = conn()
    .prepare(
      `SELECT s.sequence_id, s.trim_start, s.trim_end,
              g.status, g.params AS take_params, g.video_duration, g.thumb_path
       FROM segments s LEFT JOIN generations g ON g.id = s.selected_generation_id
       ORDER BY s.sequence_id, s.position, s.created_at`
    )
    .all() as SummaryJoinRow[]

  const bySequence = new Map<string, SummaryJoinRow[]>()
  for (const r of rows) {
    const list = bySequence.get(r.sequence_id) ?? []
    list.push(r)
    bySequence.set(r.sequence_id, list)
  }

  return sequences.map((s) => {
    const segments = bySequence.get(s.id) ?? []
    let totalDuration = 0
    for (const r of segments) {
      if (r.status !== 'completed') continue
      const length = r.video_duration ?? durationSeconds(parseParams(r.take_params ?? '{}').duration)
      totalDuration += Math.max(0, length - r.trim_start - r.trim_end)
    }
    // Prefer the opening shot; fall back to the first clip that has a poster at all.
    const thumb = segments[0]?.thumb_path ?? segments.find((r) => r.thumb_path)?.thumb_path ?? undefined
    return {
      id: s.id,
      name: s.name,
      segmentCount: segments.length,
      totalDuration: round(totalDuration),
      // Read straight from the table, so still in its stored (possibly relative) form.
      thumbPath: thumb ? fromStoredPath(thumb) : undefined,
      updatedAt: s.updated_at
    }
  })
}

// ── Folders and file names ───────────────────────────────────────────────────

/** The sequence that a segment belongs to. */
export function sequenceOfSegment(segmentId: string): SequenceRow | undefined {
  return conn()
    .prepare('SELECT s.* FROM segments seg JOIN sequences s ON s.id = seg.sequence_id WHERE seg.id = ?')
    .get(segmentId) as SequenceRow | undefined
}

/** Some take of the sequence is still rendering or being saved (its video may be on its way into Tagningar/). */
export function hasPendingTakes(sequenceId: string): boolean {
  return !!conn()
    .prepare(
      `SELECT 1 FROM generations g JOIN segments s ON s.id = g.segment_id
       WHERE s.sequence_id = ? AND g.status IN ('queued', 'processing') LIMIT 1`
    )
    .get(sequenceId)
}

export function setSequenceFolder(id: string, folder: string): void {
  conn().prepare('UPDATE sequences SET folder = ? WHERE id = ?').run(folder, id)
}

/** Remembers a finished export, so moving or tidying the library carries it along. */
export function recordExport(sequenceId: string, path: string): void {
  conn()
    .prepare('INSERT INTO exports (id, sequence_id, file_path, created_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), sequenceId, toStoredPath(path), Date.now())
}

/** Sekvenser/ (not created here). */
export function sequencesRoot(): string {
  return join(libraryRoot(), FOLDERS.sequences)
}

/** Sekvenser/<folder> without creating it (paths.sequenceDir creates it). */
export function folderPath(folder: string): string {
  return join(sequencesRoot(), folder)
}

/** Sekvenser/<folder>/Tagningar without creating it (paths.sequenceTakesDir creates it). */
export function takesPath(folder: string): string {
  return join(folderPath(folder), TAKES_FOLDER)
}

/** Sekvenser/<folder>/Storyboard without creating it (stills.ts puts the sequence's stills there). */
export function storyboardPath(folder: string): string {
  return join(folderPath(folder), STORYBOARD_FOLDER)
}

/** What a sequence's folder is called before de-duplication. */
export function folderBaseName(sequenceName: string): string {
  return safeName(sequenceName, { fallback: UNTITLED_SEQUENCE })
}

// macOS volumes are normally case-insensitive and may hand back decomposed å/ä/ö.
const fold = (s: string): string => s.normalize('NFC').toLowerCase()
const foldPath = (p: string): string => fold(resolve(p))

/** True when the folder already fits the name: its safe form, or that with a " (n)" from de-duplication. */
export function folderMatchesName(folder: string, sequenceName: string): boolean {
  const f = fold(folder)
  const base = fold(folderBaseName(sequenceName))
  return f === base || (f.startsWith(base) && /^ \(\d+\)$/.test(f.slice(base.length)))
}

export function samePath(a: string, b: string): boolean {
  return foldPath(a) === foldPath(b)
}

/** True when path lies somewhere below dir. */
export function isUnder(path: string, dir: string): boolean {
  const d = foldPath(dir)
  return foldPath(path).startsWith(d.endsWith(sep) ? d : d + sep)
}

/** For a path below Sekvenser/, the name of the sequence folder it is in. */
export function sequenceFolderOfPath(path: string): string | undefined {
  const root = sequencesRoot()
  if (!isUnder(path, root)) return undefined
  return relative(root, path).split(sep)[0] || undefined
}

/** Some sequence uses this folder name (compared the way the disk does). */
export function folderInUse(folder: string): boolean {
  const target = fold(folder)
  const folders = conn().prepare('SELECT folder FROM sequences WHERE folder IS NOT NULL').pluck().all() as string[]
  return folders.some((f) => fold(f) === target)
}

/** "base", "base (2)", "base (3)" … : the first one `taken` says no to. */
export function firstFreeName(base: string, ext: string, taken: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`
    if (!taken(name)) return name
  }
}

/** A folder name in Sekvenser/ that is neither on disk nor recorded for a sequence whose folder is gone. */
export function availableFolderName(base: string): string {
  return firstFreeName(base, '', (name) => existsSync(folderPath(name)) || folderInUse(name))
}

/**
 * The file exists, or a generation or export still records it. A row whose video was deleted in Finder
 * must not end up pointing at somebody else's file that later got the same name.
 */
export function pathTaken(path: string): boolean {
  if (existsSync(path)) return true
  const stored = toStoredPath(path)
  return !!conn()
    .prepare(
      `SELECT 1 FROM generations WHERE file_path = ? COLLATE NOCASE
       UNION ALL SELECT 1 FROM exports WHERE file_path = ? COLLATE NOCASE LIMIT 1`
    )
    .get(stored, stored)
}

/** A free file name in dir for base + ext (see pathTaken). */
export function availableFileName(dir: string, base: string, ext: string): string {
  return firstFreeName(base, ext, (name) => pathTaken(join(dir, name)))
}

/** "<YYYY-MM-DD HH.MM> <prompt>": a take in Tagningar/, dated when it was submitted. */
export function takeFileBase(g: Pick<Generation, 'createdAt' | 'prompt'>): string {
  const created = new Date(g.createdAt)
  return `${dayStamp(created)} ${timeStamp(created)} ${promptExcerpt(g.prompt)}`
}

/** "<HH.MM> <prompt>": a generation in Genereringar/<day>/. */
export function freeFileBase(g: Pick<Generation, 'createdAt' | 'prompt'>): string {
  return `${timeStamp(new Date(g.createdAt))} ${promptExcerpt(g.prompt)}`
}

/**
 * Removes dir if nothing is in it but Finder's .DS_Store. rmdir refuses a folder that isn't empty, so a
 * file that appears meanwhile is never lost. Resolves whether the folder is gone.
 */
export async function removeDirIfEmpty(dir: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return !existsSync(dir)
  }
  if (names.some((n) => n !== '.DS_Store')) return false
  try {
    if (names.length) await rm(join(dir, '.DS_Store'), { force: true })
    await rmdir(dir)
    return true
  } catch {
    return false
  }
}

/** Removes a sequence folder's Tagningar/ and Storyboard/ and then the folder itself, each only when empty. */
export async function removeFolderIfEmpty(folder: string): Promise<void> {
  const takesGone = await removeDirIfEmpty(takesPath(folder))
  const storyboardGone = await removeDirIfEmpty(storyboardPath(folder))
  if (takesGone && storyboardGone) await removeDirIfEmpty(folderPath(folder))
}

// ── Stills ───────────────────────────────────────────────────────────────────

export function getStillRow(id: string): StillRow | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return conn().prepare('SELECT * FROM stills WHERE id = ?').get(id) as StillRow | undefined
}

/** The sequence's stills, oldest first. */
export function listStillRows(sequenceId: string): StillRow[] {
  return conn()
    .prepare('SELECT * FROM stills WHERE sequence_id = ? ORDER BY created_at, id')
    .all(sequenceId) as StillRow[]
}
