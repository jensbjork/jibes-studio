// Database access and assembly for sequences and their segments, and where their files live on disk.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm, rmdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { continueModeOf, isContinueMode, type ChainClip } from '@shared/continuation'
import { DEFAULT_PARAMS, durationSeconds, sanitizeReferenceAudios } from '@shared/models'
import { sanitizeOutfitWearers } from '@shared/outfits'
import { sanitizeDescriptionFlags } from '@shared/prompt-compose'
import { generationSource, isVeniceGeneration } from '@shared/generation-label'
import { continuationFrameOf, isExtractedFirstFrame } from '@shared/seams'
import type {
  ContinueMode,
  Generation,
  GenerationParams,
  Segment,
  Sequence,
  SequenceKind,
  SequenceSummary
} from '@shared/types'
import * as db from './db'
import { toPublic } from './jobs'
import { attachKeptByEdit } from './edit-store'
import { attachReviewSummary } from './reviews'
import {
  dayStamp,
  fromStoredParams,
  fromStoredPath,
  KIND_FOLDERS,
  libraryRoot,
  promptExcerpt,
  safeName,
  sequenceKindOf,
  timeStamp,
  toStoredParams,
  toStoredPath
} from './paths'

/** Shortest piece of a take that trimming may leave, in seconds. */
export const MIN_REMAINING_SECONDS = 0.2

export const UNTITLED_SEQUENCE = 'Untitled sequence'
export const UNTITLED_STORYBOARD = 'Untitled storyboard'
/** Folder-name fallbacks for a name that leaves nothing: they name folders on disk, so they stay as they were. */
const UNTITLED_SEQUENCE_FOLDER = 'Namnlös sekvens'
const UNTITLED_STORYBOARD_FOLDER = 'Namnlös storyboard'

export interface SequenceRow {
  id: string
  name: string
  defaults: string
  /** Name of the folder in Sekvenser/ (Storyboards/ for a storyboard); null for rows from before folders existed. */
  folder: string | null
  /** 'sequence' or 'storyboard' (see kindOf). */
  kind: string
  /** A storyboard's aspect ratio; null for sequences. */
  aspect_ratio: string | null
  /** "Exportformat": the exported film's height (480, 720, 1080); null (or absent before schema 11) = Automatiskt. */
  export_height?: number | null
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
  /**
   * How a continuing clip starts on the previous clip's last frame: 'references' (the default) or 'exact' (see
   * Segment.continueMode). Absent before schema 13 (read as 'references').
   */
  continue_mode?: string | null
  notes: string
  selected_generation_id: string | null
  trim_start: number
  trim_end: number
  created_at: number
  /** A storyboard's transition: the boards it goes from and to (null for sequence clips). */
  from_board_id?: string | null
  to_board_id?: string | null
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
  if (!row) throw new Error('The sequence no longer exists.')
  return row
}

/** Whether the row is a sequence or a storyboard. */
export function kindOf(row: Pick<SequenceRow, 'kind'>): SequenceKind {
  return sequenceKindOf(row.kind)
}

/** Said when a storyboard's id reaches something that only works on sequences. */
export const IS_STORYBOARD = 'This is a storyboard, not a sequence. It is under Storyboards.'
/** Said when one of a storyboard's transitions reaches something that only works on sequence clips. */
export const IS_TRANSITION =
  'This is a transition in a storyboard, not a clip in a sequence. Change it under Storyboards.'
/** Said when a sequence's id reaches something that only works on storyboards. */
export const IS_SEQUENCE = 'This is a sequence, not a storyboard. It is under Sequences.'

/** A sequence (not a storyboard): for the handlers and tools of Sequences. */
export function requirePlainSequence(id: string): SequenceRow {
  const row = requireSequenceRow(id)
  if (kindOf(row) !== 'sequence') throw new Error(IS_STORYBOARD)
  return row
}

/** A clip of a sequence (not a storyboard's transition): for the clip handlers and tools of Sequences. */
export function requirePlainSegment(id: string): SegmentRow {
  const row = requireSegmentRow(id)
  const sequence = getSequenceRow(row.sequence_id)
  if (sequence && kindOf(sequence) !== 'sequence') throw new Error(IS_TRANSITION)
  return row
}

export function getSegmentRow(id: string): SegmentRow | undefined {
  return conn().prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined
}

export function requireSegmentRow(id: string): SegmentRow {
  const row = typeof id === 'string' ? getSegmentRow(id) : undefined
  if (!row) throw new Error('The clip no longer exists.')
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

/**
 * A clip nothing has been put in yet (the empty Klipp 1 of a new sequence), as isUntouchedClip in the renderer: no takes
 * (of any status) or selected take, no prompt, pictures or sounds, no frame links and no notes.
 */
export function isUntouchedSegment(row: SegmentRow): boolean {
  const p = parseParams(row.params)
  return (
    !row.selected_generation_id &&
    !takeIdsForSegments([row.id]).length &&
    !p.prompt?.trim() &&
    !p.startImage &&
    !p.endImage &&
    !p.referenceImages?.length &&
    !p.referenceAudios?.length &&
    !row.continue_from_previous &&
    !row.end_from_next &&
    !(row.notes ?? '').trim()
  )
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

/** The row's continue mode (see Segment.continueMode); 'references' unless it says 'exact'. */
export function continueModeOfRow(row: Pick<SegmentRow, 'continue_mode'>): ContinueMode {
  return continueModeOf(row.continue_mode)
}

/** A continue mode from the window or an agent, or a refusal; undefined stays undefined (no change). */
export function cleanContinueMode(value: unknown): ContinueMode | undefined {
  if (value === undefined) return undefined
  if (isContinueMode(value)) return value
  throw new Error('Unknown way to continue: choose “With references” (references) or “Exact start frame” (exact).')
}

/** A segment row as the shared continuation rules read it (continuation.ts). */
export function chainClip(row: SegmentRow): ChainClip {
  return {
    params: parseParams(row.params),
    continueFromPrevious: !!row.continue_from_previous,
    endFromNext: !!row.end_from_next,
    continueMode: continueModeOfRow(row)
  }
}

// ── Params ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Normalises params coming from the renderer, an agent or JSON, dropping anything malformed. Reference audio
 * clips keep their windows; whether the model can use them is decided when a take is sent (paramsForSubmit).
 * The description switches (includeDescriptions, excludedDescriptionAssetIds) and who wears each outfit
 * (outfitWearers) are kept: they decide what a take appends to its prompt, and "Use again" on a take brings them
 * back.
 */
export function sanitizeParams(input: Partial<GenerationParams> | undefined): GenerationParams {
  const p = input ?? {}
  const refs = Array.isArray(p.referenceImages)
    ? p.referenceImages.filter((r): r is string => typeof r === 'string' && !!r)
    : undefined
  const wearers = sanitizeOutfitWearers(p.outfitWearers)
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
    ...sanitizeDescriptionFlags(p),
    ...(wearers ? { outfitWearers: wearers } : {})
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

export function cleanSequenceName(name: unknown, kind: SequenceKind = 'sequence'): string {
  const clean = typeof name === 'string' ? name.trim() : ''
  return clean || (kind === 'storyboard' ? UNTITLED_STORYBOARD : UNTITLED_SEQUENCE)
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

/**
 * A storyboard transition's take was made from other pictures than its boards hold now (the row's start and end
 * image, which syncTransitions keeps equal to the boards'). Never for a sequence clip: it has no boards.
 */
export function madeFromEarlierBoards(row: SegmentRow, take: Generation): boolean {
  if (!row.from_board_id || !row.to_board_id) return false
  const now = parseParams(row.params)
  const same = (a: string | undefined, b: string | undefined): boolean => (a && b ? samePath(a, b) : !a && !b)
  return !same(take.params.startImage, now.startImage) || !same(take.params.endImage, now.endImage)
}

/**
 * A storyboard transition left without a selected take (the one it had was deleted) gets its newest finished take
 * made from the pictures its boards hold now, else its newest finished one: while it has a take to use, it isn't
 * shown as not generated or paid for again by "Generate missing". Sequence clips are left as they are. True when
 * one was selected.
 */
export function reselectTransitionTake(segmentId: string): boolean {
  const row = getSegmentRow(segmentId)
  if (!row?.from_board_id || !row.to_board_id || row.selected_generation_id) return false
  const takes = db.listGenerationsForSegments([row.id]).filter((g) => isUsable(g))
  const take = takes.find((g) => !madeFromEarlierBoards(row, g)) ?? takes[0]
  if (!take) return false
  setSelectedTake(row, take)
  touchSequence(row.sequence_id)
  return true
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
 * frame (the clip continues from it), or from a frame of one of the segment's own takes (where "Redo between
 * neighbours" lets the first clip keep its opening); an end made from the next clip's first frame (the clip ends on
 * it). A trim there was meant for another take, and would cut away the very frame this one was generated from, and
 * with it the seamless cut it was paid for. `row` carries the link flags the segment has (or is about to have).
 */
export function seamTrims(row: SegmentRow, take: Generation): { trimStart: number; trimEnd: number } {
  const start = take.params.startImage
  const end = take.params.endImage
  // A take made from the previous clip's last frame, sent either way (its start image, or in reference mode its last
  // reference image: it starts close to that frame).
  const startMet = row.continue_from_previous
    ? !!continuationFrameOf(take.params)
    : !!start && isOwnFrameStill(row.id, start)
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
 * Remembers the trims the segment's selected take has right now (take_trims), so that switching to another take and
 * back gives this one exactly the trims the user left it with: the segment's own trims follow the new take (and are
 * clamped to its length), which would otherwise erode them. Called right before a selection changes. Storyboard
 * transitions are never trimmed, so they write nothing. Bookkeeping only: a failure is logged, never thrown into the
 * selection it precedes.
 */
export function rememberTrims(row: SegmentRow): void {
  if (!row.selected_generation_id || row.from_board_id) return
  try {
    conn()
      .prepare(
        `INSERT INTO take_trims (segment_id, generation_id, trim_start, trim_end, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (segment_id, generation_id) DO UPDATE
           SET trim_start = excluded.trim_start, trim_end = excluded.trim_end, updated_at = excluded.updated_at`
      )
      .run(row.id, row.selected_generation_id, row.trim_start ?? 0, row.trim_end ?? 0, Date.now())
  } catch (err) {
    console.warn(`Could not remember the trims of take ${row.selected_generation_id}:`, err)
  }
}

/**
 * The trims `take` gets when it becomes the segment's selected take: the ones it last had in this segment
 * (rememberTrims) when it was selected there before, else today's rule (seamTrims: the segment's trims carry over,
 * except at a side the take was made to meet exactly). The caller clamps them to the take's length (clampTrims).
 * `row` carries the link flags the segment has (or is about to have).
 */
export function trimsFor(row: SegmentRow, take: Generation): { trimStart: number; trimEnd: number } {
  if (!row.from_board_id) {
    const kept = conn()
      .prepare('SELECT trim_start, trim_end FROM take_trims WHERE segment_id = ? AND generation_id = ?')
      .get(row.id, take.id) as { trim_start: number; trim_end: number } | undefined
    if (kept) return { trimStart: kept.trim_start, trimEnd: kept.trim_end }
  }
  return seamTrims(row, take)
}

/** Forgets the trims a take had in a segment (the take was taken off it). */
export function forgetTrims(segmentId: string, generationId: string): void {
  conn().prepare('DELETE FROM take_trims WHERE segment_id = ? AND generation_id = ?').run(segmentId, generationId)
}

/**
 * Points a segment at a take, re-clamping the trims to that take's length. A take selected here before gets back the
 * trims it had then (see trimsFor), and the take that was selected keeps its own for later (rememberTrims).
 */
export function setSelectedTake(row: SegmentRow, take: Generation | undefined): void {
  const switching = (take?.id ?? null) !== row.selected_generation_id
  if (switching) rememberTrims(row)
  const kept = take && take.id !== row.selected_generation_id ? trimsFor(row, take) : undefined
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
    continueMode: continueModeOfRow(row),
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
  // The user's grade and the review count, like the feed shows them (one query for every take).
  attachReviewSummary(segments.flatMap((s) => s.takes))
  // Which takes the Editor keeps, so the take list offers "Remove" (off the clip) rather than "Delete" for them.
  attachKeptByEdit(segments.flatMap((s) => s.takes))

  return {
    id: row.id,
    name: row.name,
    defaults: parseDefaults(row.defaults),
    segments,
    exportHeight: exportHeightOf(row),
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

/** Sequences only: storyboards have their own list (storyboards.ts). */
export function listSequenceSummaries(): SequenceSummary[] {
  const sequences = conn()
    .prepare(`SELECT * FROM sequences WHERE kind = 'sequence' ORDER BY updated_at DESC`)
    .all() as SequenceRow[]
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

/**
 * Remembers a finished export, so moving or tidying the library carries it along. `cuts`: where its clips meet in
 * the film (seconds, the start of every clip after the first), so the Editor knows the film's cut markers exactly.
 * Returns the export's id.
 */
export function recordExport(sequenceId: string, path: string, cuts?: readonly number[]): string {
  const clean = (cuts ?? []).filter((t) => Number.isFinite(t) && t > 0).map((t) => Math.round(t * 1000) / 1000)
  const id = randomUUID()
  conn()
    .prepare('INSERT INTO exports (id, sequence_id, file_path, created_at, cuts) VALUES (?, ?, ?, ?, ?)')
    .run(id, sequenceId, toStoredPath(path), Date.now(), cuts ? JSON.stringify(clean) : null)
  return id
}

// ── Export format ────────────────────────────────────────────────────────────

/** The heights "Export format" offers besides Automatic (the first clip's own size). */
export const EXPORT_HEIGHTS: readonly number[] = [480, 720, 1080]

/** The sequence's export format as stored: one of EXPORT_HEIGHTS, or null (Automatic; also anything unknown). */
export function exportHeightOf(row: Pick<SequenceRow, 'export_height'>): number | null {
  const h = row.export_height
  return typeof h === 'number' && EXPORT_HEIGHTS.includes(h) ? h : null
}

/** A height from the window as it may be stored, or a refusal. null (and undefined) is Automatic. */
export function cleanExportHeight(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && EXPORT_HEIGHTS.includes(value)) return value
  throw new Error('The export format can be Automatic, 480p, 720p or 1080p.')
}

export function setExportHeight(sequenceId: string, height: number | null): void {
  conn().prepare('UPDATE sequences SET export_height = ? WHERE id = ?').run(height, sequenceId)
}

/** Sekvenser/, or Storyboards/ for storyboards (not created here). */
export function sequencesRoot(kind: SequenceKind = 'sequence'): string {
  return join(libraryRoot(), KIND_FOLDERS[kind].parent)
}

/** Sekvenser/<folder> (Storyboards/<folder>) without creating it (paths.sequenceDir creates it). */
export function folderPath(folder: string, kind: SequenceKind = 'sequence'): string {
  return join(sequencesRoot(kind), folder)
}

/** Sekvenser/<folder>/Tagningar (Storyboards/<folder>/Övergångar) without creating it (see paths.sequenceTakesDir). */
export function takesPath(folder: string, kind: SequenceKind = 'sequence'): string {
  return join(folderPath(folder, kind), KIND_FOLDERS[kind].takes)
}

/** Sekvenser/<folder>/Storyboard (Storyboards/<folder>/Bilder) without creating it: where stills.ts puts stills. */
export function stillsPath(folder: string, kind: SequenceKind = 'sequence'): string {
  return join(folderPath(folder, kind), KIND_FOLDERS[kind].stills)
}

/** What a sequence's (or storyboard's) folder is called before de-duplication. */
export function folderBaseName(sequenceName: string, kind: SequenceKind = 'sequence'): string {
  return safeName(sequenceName, { fallback: kind === 'storyboard' ? UNTITLED_STORYBOARD_FOLDER : UNTITLED_SEQUENCE_FOLDER })
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

/** For a path below Sekvenser/ (or Storyboards/), the folder of the sequence (or storyboard) it is in. */
export function sequenceFolderOfPath(path: string): { folder: string; kind: SequenceKind } | undefined {
  for (const kind of ['sequence', 'storyboard'] as const) {
    const root = sequencesRoot(kind)
    if (!isUnder(path, root)) continue
    const folder = relative(root, path).split(sep)[0]
    return folder ? { folder, kind } : undefined
  }
  return undefined
}

/** Some sequence (or storyboard, by kind) uses this folder name (compared the way the disk does). */
export function folderInUse(folder: string, kind: SequenceKind = 'sequence'): boolean {
  const target = fold(folder)
  const folders = conn()
    .prepare('SELECT folder, kind FROM sequences WHERE folder IS NOT NULL')
    .all() as { folder: string; kind: string }[]
  // Sequences and storyboards have folders in different parents, so only those of the same kind collide.
  return folders.some((f) => sequenceKindOf(f.kind) === kind && fold(f.folder) === target)
}

/** "base", "base (2)", "base (3)" … : the first one `taken` says no to. */
export function firstFreeName(base: string, ext: string, taken: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`
    if (!taken(name)) return name
  }
}

/**
 * A folder name in Sekvenser/ (Storyboards/) that is neither on disk nor recorded for a sequence (storyboard) whose
 * folder is gone.
 */
export function availableFolderName(base: string, kind: SequenceKind = 'sequence'): string {
  return firstFreeName(base, '', (name) => existsSync(folderPath(name, kind)) || folderInUse(name, kind))
}

/**
 * The file exists, or a row still records it (a generation's video or an import's original, an export …; see
 * db.isStoredPathRecorded). A row whose video was deleted in Finder must not end up pointing at somebody else's file
 * that later got the same name.
 */
export function pathTaken(path: string): boolean {
  if (existsSync(path)) return true
  return db.isStoredPathRecorded(toStoredPath(path))
}

/** A free file name in dir for base + ext (see pathTaken). */
export function availableFileName(dir: string, base: string, ext: string): string {
  return firstFreeName(base, ext, (name) => pathTaken(join(dir, name)))
}

/**
 * What a generation's file names say about it: its title (an import's file name, a version's "<redigering> v3"),
 * else its prompt's first line, so an own clip or a version is never named "Utan prompt".
 */
function nameExcerpt(g: Pick<Generation, 'prompt' | 'title'>): string {
  // The title as it is (not generationTitle's display form), so a Venice generation keeps exactly the name it has
  // always had and "Tidy up" never renames it.
  return promptExcerpt(g.title?.trim() ? g.title : g.prompt)
}

/** "<YYYY-MM-DD HH.MM> <prompt>": a take in Tagningar/, dated when it was submitted. */
export function takeFileBase(g: Pick<Generation, 'createdAt' | 'prompt' | 'title'>): string {
  const created = new Date(g.createdAt)
  return `${dayStamp(created)} ${timeStamp(created)} ${nameExcerpt(g)}`
}

/** "<HH.MM> <prompt>": a generation in Genereringar/<day>/. */
export function freeFileBase(g: Pick<Generation, 'createdAt' | 'prompt' | 'title'>): string {
  return `${timeStamp(new Date(g.createdAt))} ${nameExcerpt(g)}`
}

/**
 * The row's file has a home of its own that sequence moves never change (the home rule, jobs.videoLocation): an
 * import (Egna klipp/<day>/, or an edit's folder for an export cloned in as an edit's v1), and anything the Editor
 * made for an edit (Redigeringar/<name>/). Such a file is never moved into Tagningar nor renamed after a prompt.
 * An orphaned version (its edit deleted) follows today's rule like a Venice generation.
 */
export function keepsOwnHome(g: Partial<Pick<Generation, 'source' | 'editId'>>): boolean {
  return generationSource(g) === 'import' || !!g.editId
}

/** Not a Venice generation: the user's own film or a version made in the Editor (an "own clip" in a sequence). */
export function isOwnClip(g: Partial<Pick<Generation, 'source'>> | undefined): boolean {
  return !!g && !isVeniceGeneration(g)
}

/**
 * The clip's selected take is an own clip whose file is gone (moved or deleted in Finder): what "Generate missing"
 * and the clip editor say instead of asking for a prompt.
 */
export function ownClipMissing(row: SegmentRow): boolean {
  const take = selectedTake(row)
  return isOwnClip(take) && !isUsable(take)
}

/** Said for clip `number` whose own film is gone (see ownClipMissing). */
export function ownClipMissingMessage(number: number): string {
  return `Clip ${number}'s own video is missing (moved or deleted in Finder). Add the file again or generate an AI take.`
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

/**
 * Removes a sequence folder's Tagningar/ and Storyboard/ (a storyboard's Övergångar/ and Bilder/) and then the folder
 * itself, each only when empty.
 */
export async function removeFolderIfEmpty(folder: string, kind: SequenceKind = 'sequence'): Promise<void> {
  const takesGone = await removeDirIfEmpty(takesPath(folder, kind))
  const stillsGone = await removeDirIfEmpty(stillsPath(folder, kind))
  if (takesGone && stillsGone) await removeDirIfEmpty(folderPath(folder, kind))
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
