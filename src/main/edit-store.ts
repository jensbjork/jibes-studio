// Persistence for Redigera: edits, their versions (completed generations rows with source 'edit'), the audio an
// edit owns (edit_media), multi-step paid jobs and their steps (media_jobs, media_job_steps), transcripts and
// voice clone handles. Everything here is synchronous SQLite; files are the services' business (edits.ts,
// edit-ops.ts). JSON columns (recipe, details, request, segments) hold ids only, never file paths: paths live in
// stored-path columns that follow folder renames and library moves.

import { randomUUID } from 'node:crypto'
import type {
  EditOperation,
  EditOrigin,
  Generation,
  Transcript,
  TranscriptSegment,
  VoiceDesignRequest
} from '@shared/types'
import * as db from './db'
import { fromStoredPath, toStoredPath } from './paths'

const conn = (): ReturnType<typeof db.getDb> => db.getDb()

/** Ids arrive over IPC and from agents; anything that isn't one is refused before it reaches a query. */
export function safeId(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error(`Ogiltigt ${what}.`)
  return id
}

function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (typeof json !== 'string' || !json) return fallback
  try {
    const value = JSON.parse(json) as unknown
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

// ── Edits ────────────────────────────────────────────────────────────────────

export type OriginKind = 'generation' | 'export' | 'import'

export interface EditRow {
  id: string
  name: string
  /** Folder name under Redigeringar/. */
  folder: string | null
  origin_kind: OriginKind
  origin_generation_id: string | null
  origin_export_id: string | null
  current_generation_id: string | null
  created_at: number
  updated_at: number
}

export function getEditRow(id: string): EditRow | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return conn().prepare('SELECT * FROM edits WHERE id = ?').get(id) as EditRow | undefined
}

export function requireEditRow(id: unknown): EditRow {
  const row = getEditRow(safeId(id))
  if (!row) throw new Error('Redigeringen finns inte längre.')
  return row
}

/** Newest change first. */
export function listEditRows(): EditRow[] {
  return conn().prepare('SELECT * FROM edits ORDER BY updated_at DESC, created_at DESC').all() as EditRow[]
}

export function insertEditRow(row: EditRow): void {
  conn()
    .prepare(
      `INSERT INTO edits (id, name, folder, origin_kind, origin_generation_id, origin_export_id,
         current_generation_id, created_at, updated_at)
       VALUES (@id, @name, @folder, @origin_kind, @origin_generation_id, @origin_export_id, @current_generation_id,
         @created_at, @updated_at)`
    )
    .run(row)
}

export function setEditName(id: string, name: string, folder: string | null): void {
  conn().prepare('UPDATE edits SET name = ?, folder = ?, updated_at = ? WHERE id = ?').run(name, folder, Date.now(), id)
}

export function setEditCurrent(id: string, generationId: string | null): void {
  conn()
    .prepare('UPDATE edits SET current_generation_id = ?, updated_at = ? WHERE id = ?')
    .run(generationId, Date.now(), id)
}

export function touchEdit(id: string): void {
  conn().prepare('UPDATE edits SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteEditRow(id: string): void {
  conn().prepare('DELETE FROM edits WHERE id = ?').run(id)
}

/** Edits started from this generation (it is their v1), other than `except`. */
export function editsStartedFrom(generationId: string, except?: string): EditRow[] {
  return (
    conn()
      .prepare('SELECT * FROM edits WHERE origin_generation_id = ? ORDER BY created_at')
      .all(generationId) as EditRow[]
  ).filter((e) => e.id !== except)
}

/** Edits whose current version is this generation. */
export function editsWithCurrent(generationId: string): EditRow[] {
  return conn().prepare('SELECT * FROM edits WHERE current_generation_id = ?').all(generationId) as EditRow[]
}

/** Folder names in use under Redigeringar/ (compared the way the disk does by the caller). */
export function editFolders(): { id: string; folder: string }[] {
  return conn().prepare('SELECT id, folder FROM edits WHERE folder IS NOT NULL').all() as {
    id: string
    folder: string
  }[]
}

// ── Versions and takes (generations rows) ────────────────────────────────────

/**
 * The edit's versions, v1 first: the origin generation (used where it is; for an export, its clone in the edit
 * folder) and every `source = 'edit'` row of the edit, in creation order.
 */
export function listVersions(edit: EditRow): db.StoredGeneration[] {
  const rows = conn()
    .prepare(`SELECT * FROM generations WHERE edit_id = ? AND source = 'edit' ORDER BY created_at, id`)
    .all(edit.id) as db.GenerationRow[]
  const versions = rows.map(db.generationFromRow)
  const origin = edit.origin_generation_id ? db.getGeneration(edit.origin_generation_id) : undefined
  return origin ? [origin, ...versions.filter((v) => v.id !== origin.id)] : versions
}

/** The AI takes made for the edit's picture operations (newest first). */
export function listTakes(editId: string): db.StoredGeneration[] {
  return (
    conn()
      .prepare(`SELECT * FROM generations WHERE edit_id = ? AND source = 'generated' ORDER BY created_at DESC`)
      .all(editId) as db.GenerationRow[]
  ).map(db.generationFromRow)
}

/** "vN": a version's number, v1 for the origin (and anything without one recorded). */
export function versionNumber(g: Pick<Generation, 'recipe'>, isOrigin: boolean): number {
  if (isOrigin) return 1
  const n = g.recipe?.number
  return typeof n === 'number' && Number.isInteger(n) && n > 1 ? n : 1
}

/** 1 + the highest N among the edit's versions, so deleting a middle version never renumbers anything. */
export function nextVersionNumber(edit: EditRow): number {
  let max = 1
  for (const v of listVersions(edit)) max = Math.max(max, versionNumber(v, v.id === edit.origin_generation_id))
  return max + 1
}

/** The edit a generation is a version of: its edit_id, or an edit started from it (its v1). */
export function editOfVersion(g: Pick<Generation, 'id' | 'editId' | 'source'>): EditRow | undefined {
  if (g.editId && g.source !== 'generated') return getEditRow(g.editId)
  return editsStartedFrom(g.id)[0]
}

/**
 * Flags the generations Redigera keeps (editOfVersion finds their edit: a version, or the film an edit started from)
 * with `keptByEdit`, as EditService.keeps decides it. A take list shows "Ta bort" for them, and generations:delete only
 * takes them off the clip.
 */
export function attachKeptByEdit<T extends Pick<Generation, 'id' | 'editId' | 'source' | 'keptByEdit'>>(gens: T[]): T[] {
  if (!gens.length || !db.isDbOpen()) return gens
  try {
    for (const g of gens) {
      if (editOfVersion(g)) g.keptByEdit = true
      else delete g.keptByEdit
    }
  } catch (err) {
    console.warn('Reading which takes Redigera keeps failed:', err)
  }
  return gens
}

/** Sequence clips that use the generation: as their selected take, or as one of their takes (segment_id). */
export function usedBy(
  generationId: string
): { sequenceId: string; sequenceName: string; segmentId: string; clipNumber: number; kind: string }[] {
  return conn()
    .prepare(
      `SELECT seg.id AS segment_id, seg.position AS position, seq.id AS sequence_id, seq.name AS name, seq.kind AS kind
       FROM segments seg JOIN sequences seq ON seq.id = seg.sequence_id
       WHERE seg.selected_generation_id = @id
          OR seg.id = (SELECT segment_id FROM generations WHERE id = @id)
       ORDER BY seq.name, seg.position`
    )
    .all({ id: generationId })
    .map((r) => {
      const row = r as { segment_id: string; position: number; sequence_id: string; name: string; kind: string }
      return {
        sequenceId: row.sequence_id,
        sequenceName: row.name,
        segmentId: row.segment_id,
        clipNumber: row.position + 1,
        kind: row.kind
      }
    })
}

/** Children of a version (any edit). */
export function childrenOf(generationId: string): string[] {
  return conn().prepare('SELECT id FROM generations WHERE parent_id = ?').pluck().all(generationId) as string[]
}

export function reparentChildren(generationId: string, newParent: string | null): void {
  conn().prepare('UPDATE generations SET parent_id = ? WHERE parent_id = ?').run(newParent, generationId)
}

/** Where an edit started, for the list's badge. */
export function originOf(edit: EditRow): EditOrigin {
  if (edit.origin_kind === 'export') {
    const exp = edit.origin_export_id
      ? (conn()
          .prepare(
            `SELECT e.id, e.sequence_id, s.name AS name FROM exports e LEFT JOIN sequences s ON s.id = e.sequence_id
             WHERE e.id = ?`
          )
          .get(edit.origin_export_id) as { id: string; sequence_id: string | null; name: string | null } | undefined)
      : undefined
    const v1 = edit.origin_generation_id ? db.getGeneration(edit.origin_generation_id) : undefined
    return {
      kind: 'export',
      exportId: edit.origin_export_id ?? v1?.recipe?.export?.exportId,
      generationId: edit.origin_generation_id ?? undefined,
      sequenceId: exp?.sequence_id ?? undefined,
      sequenceName: exp?.name ?? v1?.recipe?.export?.sequenceName,
      ...(v1 ? {} : { missing: true })
    }
  }
  const g = edit.origin_generation_id ? db.getGeneration(edit.origin_generation_id) : undefined
  if (!g) return { kind: edit.origin_kind === 'import' ? 'import' : 'generation', missing: true }
  if (g.source === 'import' && edit.origin_kind === 'import') return { kind: 'import', generationId: g.id }
  if (g.segmentId) {
    const seg = conn()
      .prepare(
        `SELECT seg.position AS position, seq.id AS sequence_id, seq.name AS name FROM segments seg
         JOIN sequences seq ON seq.id = seg.sequence_id WHERE seg.id = ?`
      )
      .get(g.segmentId) as { position: number; sequence_id: string; name: string } | undefined
    if (seg) {
      return {
        kind: 'take',
        generationId: g.id,
        segmentId: g.segmentId,
        sequenceId: seg.sequence_id,
        sequenceName: seg.name,
        clipNumber: seg.position + 1
      }
    }
  }
  return { kind: g.source === 'import' ? 'import' : 'generation', generationId: g.id }
}

// ── Edit media (Ljud/) ───────────────────────────────────────────────────────

export type MediaKind = 'voice' | 'speech' | 'music' | 'effect' | 'audio' | 'bake'

export interface MediaRow {
  id: string
  edit_id: string
  kind: MediaKind
  /** Stored form. */
  file_path: string
  label: string
  model: string | null
  cost: number | null
  duration: number | null
  /** JSON: prompt / text / voice; no paths. */
  details: string
  created_at: number
}

export interface StoredMedia {
  id: string
  editId: string
  kind: MediaKind
  /** Absolute. */
  path: string
  label: string
  model?: string
  cost?: number
  duration?: number
  details: Record<string, unknown>
  createdAt: number
}

function mediaFromRow(r: MediaRow): StoredMedia {
  return {
    id: r.id,
    editId: r.edit_id,
    kind: r.kind,
    path: fromStoredPath(r.file_path),
    label: r.label,
    model: r.model ?? undefined,
    cost: r.cost ?? undefined,
    duration: r.duration ?? undefined,
    details: parseJson<Record<string, unknown>>(r.details, {}),
    createdAt: r.created_at
  }
}

export function getMedia(id: string): StoredMedia | undefined {
  if (typeof id !== 'string' || !id) return undefined
  const row = conn().prepare('SELECT * FROM edit_media WHERE id = ?').get(id) as MediaRow | undefined
  return row && mediaFromRow(row)
}

/** Oldest first. */
export function listMedia(editId: string): StoredMedia[] {
  return (
    conn().prepare('SELECT * FROM edit_media WHERE edit_id = ? ORDER BY created_at, id').all(editId) as MediaRow[]
  ).map(mediaFromRow)
}

export function insertMedia(
  m: Omit<StoredMedia, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
): StoredMedia {
  const id = m.id ?? randomUUID()
  conn()
    .prepare(
      `INSERT INTO edit_media (id, edit_id, kind, file_path, label, model, cost, duration, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      m.editId,
      m.kind,
      toStoredPath(m.path),
      m.label,
      m.model ?? null,
      m.cost ?? null,
      m.duration ?? null,
      JSON.stringify(m.details ?? {}),
      m.createdAt ?? Date.now()
    )
  return getMedia(id)!
}

// ── Jobs and steps ───────────────────────────────────────────────────────────

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'sending' | 'queued' | 'completed' | 'failed' | 'cancelled'
export type StepEndpoint = 'voice-changer' | 'audio-queue' | 'speech' | 'transcription' | 'voice-clone'

/** What a job was asked to do (media_jobs.request). Ids, times and texts only. */
export interface JobRequest {
  /** Picture and audio jobs of an edit. */
  operation?: EditOperation
  /** Voice design (Karaktärer → Röst). */
  voiceDesign?: VoiceDesignRequest
  /** Swedish label, e.g. "Bytte röst → Aria". */
  label: string
  /** What the finish needs that the plan worked out (scopes, line slots, placement); see edit-ops.ts. */
  finish?: Record<string, unknown>
  /** A picture job whose finish failed for a reason another try can't change: no free "Fortsätt" for it. */
  noRefinish?: boolean
}

export interface JobRow {
  id: string
  edit_id: string | null
  asset_id: string | null
  base_generation_id: string | null
  op: string
  request: string
  status: JobStatus
  quote: number | null
  cost: number
  take_generation_id: string | null
  result_generation_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface StoredJob {
  id: string
  editId?: string
  assetId?: string
  baseId?: string
  op: string
  request: JobRequest
  status: JobStatus
  quote?: number
  cost: number
  takeId?: string
  resultId?: string
  error?: string
  createdAt: number
  updatedAt: number
}

function jobFromRow(r: JobRow): StoredJob {
  return {
    id: r.id,
    editId: r.edit_id ?? undefined,
    assetId: r.asset_id ?? undefined,
    baseId: r.base_generation_id ?? undefined,
    op: r.op,
    request: parseJson<JobRequest>(r.request, { label: r.op }),
    status: r.status,
    quote: r.quote ?? undefined,
    cost: r.cost ?? 0,
    takeId: r.take_generation_id ?? undefined,
    resultId: r.result_generation_id ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function getJob(id: string): StoredJob | undefined {
  if (typeof id !== 'string' || !id) return undefined
  const row = conn().prepare('SELECT * FROM media_jobs WHERE id = ?').get(id) as JobRow | undefined
  return row && jobFromRow(row)
}

export function requireJob(id: unknown): StoredJob {
  const job = getJob(safeId(id))
  if (!job) throw new Error('Jobbet finns inte längre.')
  return job
}

/** Newest first. */
export function listJobs(editId: string): StoredJob[] {
  return (
    conn().prepare('SELECT * FROM media_jobs WHERE edit_id = ? ORDER BY created_at DESC, id').all(editId) as JobRow[]
  ).map(jobFromRow)
}

export function listJobsWithStatus(status: JobStatus): StoredJob[] {
  return (
    conn().prepare('SELECT * FROM media_jobs WHERE status = ? ORDER BY created_at').all(status) as JobRow[]
  ).map(jobFromRow)
}

export function jobForTake(takeId: string): StoredJob | undefined {
  const row = conn().prepare('SELECT * FROM media_jobs WHERE take_generation_id = ?').get(takeId) as
    | JobRow
    | undefined
  return row && jobFromRow(row)
}

/** Every job that builds on this version (any status). */
export function jobsOnBase(generationId: string): StoredJob[] {
  return (
    conn()
      .prepare('SELECT * FROM media_jobs WHERE base_generation_id = ? ORDER BY created_at DESC')
      .all(generationId) as JobRow[]
  ).map(jobFromRow)
}

/** Running jobs that build on this version (their finish reads its file). */
export function runningJobsOnBase(generationId: string): StoredJob[] {
  return (
    conn()
      .prepare(`SELECT * FROM media_jobs WHERE base_generation_id = ? AND status = 'running'`)
      .all(generationId) as JobRow[]
  ).map(jobFromRow)
}

export function insertJob(job: {
  id?: string
  editId?: string
  assetId?: string
  baseId?: string
  op: string
  request: JobRequest
  quote?: number
  takeId?: string
}): StoredJob {
  const id = job.id ?? randomUUID()
  const now = Date.now()
  conn()
    .prepare(
      `INSERT INTO media_jobs (id, edit_id, asset_id, base_generation_id, op, request, status, quote, cost,
         take_generation_id, result_generation_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, NULL, NULL, ?, ?)`
    )
    .run(
      id,
      job.editId ?? null,
      job.assetId ?? null,
      job.baseId ?? null,
      job.op,
      JSON.stringify(job.request),
      job.quote ?? null,
      job.takeId ?? null,
      now,
      now
    )
  return getJob(id)!
}

export function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus
    error: string | null
    takeId: string | null
    resultId: string | null
    quote: number | null
    request: JobRequest
  }>
): void {
  const sets: string[] = ['updated_at = @now']
  const values: Record<string, unknown> = { id, now: Date.now() }
  if (patch.status !== undefined) {
    sets.push('status = @status')
    values.status = patch.status
  }
  if (patch.error !== undefined) {
    sets.push('error = @error')
    values.error = patch.error
  }
  if (patch.takeId !== undefined) {
    sets.push('take_generation_id = @takeId')
    values.takeId = patch.takeId
  }
  if (patch.resultId !== undefined) {
    sets.push('result_generation_id = @resultId')
    values.resultId = patch.resultId
  }
  if (patch.quote !== undefined) {
    sets.push('quote = @quote')
    values.quote = patch.quote
  }
  if (patch.request !== undefined) {
    sets.push('request = @request')
    values.request = JSON.stringify(patch.request)
  }
  conn().prepare(`UPDATE media_jobs SET ${sets.join(', ')} WHERE id = @id`).run(values)
}

/** Money Venice charged for a step that was sent: what the version or transcript cost. */
export function addJobCost(id: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return
  conn().prepare('UPDATE media_jobs SET cost = cost + ?, updated_at = ? WHERE id = ?').run(usd, Date.now(), id)
}

export function deleteJob(id: string): void {
  conn().prepare('DELETE FROM media_jobs WHERE id = ?').run(id)
}

export interface StepRow {
  id: string
  job_id: string
  position: number
  endpoint: StepEndpoint
  model: string
  request: string
  status: StepStatus
  queue_id: string | null
  quote: number | null
  error: string | null
  created_at: number
  completed_at: number | null
}

export interface StoredStep {
  id: string
  jobId: string
  position: number
  endpoint: StepEndpoint
  model: string
  request: Record<string, unknown>
  status: StepStatus
  queueId?: string
  quote?: number
  error?: string
  createdAt: number
  completedAt?: number
}

function stepFromRow(r: StepRow): StoredStep {
  return {
    id: r.id,
    jobId: r.job_id,
    position: r.position,
    endpoint: r.endpoint,
    model: r.model,
    request: parseJson<Record<string, unknown>>(r.request, {}),
    status: r.status,
    queueId: r.queue_id ?? undefined,
    quote: r.quote ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined
  }
}

export function listSteps(jobId: string): StoredStep[] {
  return (
    conn().prepare('SELECT * FROM media_job_steps WHERE job_id = ? ORDER BY position').all(jobId) as StepRow[]
  ).map(stepFromRow)
}

export function getStep(id: string): StoredStep | undefined {
  const row = conn().prepare('SELECT * FROM media_job_steps WHERE id = ?').get(id) as StepRow | undefined
  return row && stepFromRow(row)
}

export function insertSteps(
  jobId: string,
  steps: { endpoint: StepEndpoint; model: string; request: Record<string, unknown>; quote?: number }[]
): void {
  const now = Date.now()
  const insert = conn().prepare(
    `INSERT INTO media_job_steps (id, job_id, position, endpoint, model, request, status, queue_id, quote, error,
       created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, NULL)`
  )
  steps.forEach((s, position) =>
    insert.run(randomUUID(), jobId, position, s.endpoint, s.model, JSON.stringify(s.request), s.quote ?? null, now)
  )
}

/** One more step at the end of a job (positions stay unique: answers in the job's scratch folder are named by them). */
export function appendStep(
  jobId: string,
  step: { endpoint: StepEndpoint; model: string; request: Record<string, unknown>; quote?: number }
): void {
  const last = conn().prepare('SELECT max(position) FROM media_job_steps WHERE job_id = ?').pluck().get(jobId) as
    | number
    | null
  conn()
    .prepare(
      `INSERT INTO media_job_steps (id, job_id, position, endpoint, model, request, status, queue_id, quote, error,
         created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, NULL)`
    )
    .run(
      randomUUID(),
      jobId,
      (last ?? -1) + 1,
      step.endpoint,
      step.model,
      JSON.stringify(step.request),
      step.quote ?? null,
      Date.now()
    )
}

export function updateStep(
  id: string,
  patch: Partial<{
    status: StepStatus
    queueId: string | null
    quote: number | null
    error: string | null
    request: Record<string, unknown>
  }>
): void {
  const sets: string[] = []
  const values: Record<string, unknown> = { id }
  if (patch.status !== undefined) {
    sets.push('status = @status')
    values.status = patch.status
    sets.push('completed_at = @completedAt')
    values.completedAt = patch.status === 'completed' ? Date.now() : null
  }
  if (patch.queueId !== undefined) {
    sets.push('queue_id = @queueId')
    values.queueId = patch.queueId
  }
  if (patch.quote !== undefined) {
    sets.push('quote = @quote')
    values.quote = patch.quote
  }
  if (patch.error !== undefined) {
    sets.push('error = @error')
    values.error = patch.error
  }
  if (patch.request !== undefined) {
    sets.push('request = @request')
    values.request = JSON.stringify(patch.request)
  }
  if (!sets.length) return
  conn().prepare(`UPDATE media_job_steps SET ${sets.join(', ')} WHERE id = @id`).run(values)
}

/** Unsent steps of a job become cancelled (Avbryt). */
export function cancelPendingSteps(jobId: string): number {
  return conn()
    .prepare(`UPDATE media_job_steps SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'`)
    .run(jobId).changes
}

// ── Transcripts ──────────────────────────────────────────────────────────────

interface TranscriptRow {
  id: string
  generation_id: string
  model: string | null
  language: string | null
  segments: string
  source: 'venice' | 'remapped' | 'edited'
  cost: number | null
  created_at: number
  updated_at: number
}

export interface StoredTranscript extends Transcript {
  source: 'venice' | 'remapped' | 'edited'
}

function transcriptFromRow(r: TranscriptRow): StoredTranscript {
  const segments = parseJson<TranscriptSegment[]>(r.segments, [])
  return {
    generationId: r.generation_id,
    language: r.language ?? undefined,
    model: r.model ?? undefined,
    segments: Array.isArray(segments) ? segments : [],
    costUsd: r.cost ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: r.source
  }
}

/** The transcript stored for exactly this generation (not inherited). */
export function storedTranscript(generationId: string): StoredTranscript | undefined {
  const row = conn().prepare('SELECT * FROM transcripts WHERE generation_id = ?').get(generationId) as
    | TranscriptRow
    | undefined
  return row && transcriptFromRow(row)
}

/** Writes (or replaces) the generation's own transcript. */
export function saveTranscript(t: {
  generationId: string
  segments: TranscriptSegment[]
  source: 'venice' | 'remapped' | 'edited'
  model?: string
  language?: string
  cost?: number
  createdAt?: number
}): StoredTranscript {
  const now = Date.now()
  const existing = storedTranscript(t.generationId)
  if (existing) {
    conn()
      .prepare(
        `UPDATE transcripts SET model = ?, language = ?, segments = ?, source = ?, cost = ?, updated_at = ?
         WHERE generation_id = ?`
      )
      .run(
        t.model ?? null,
        t.language ?? null,
        JSON.stringify(t.segments),
        t.source,
        t.cost ?? null,
        now,
        t.generationId
      )
  } else {
    conn()
      .prepare(
        `INSERT INTO transcripts (id, generation_id, model, language, segments, source, cost, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        t.generationId,
        t.model ?? null,
        t.language ?? null,
        JSON.stringify(t.segments),
        t.source,
        t.cost ?? null,
        t.createdAt ?? now,
        now
      )
  }
  return storedTranscript(t.generationId)!
}

// ── Voice clones ─────────────────────────────────────────────────────────────

export interface CloneRow {
  id: string
  audio_id: string
  model: string
  handle: string
  window_start: number
  window_length: number
  created_at: number
  expires_at: number
}

/** A handle for the clip and model still valid for at least `marginMs` (default an hour). */
export function validClone(audioId: string, model: string, marginMs = 3600_000): CloneRow | undefined {
  return conn()
    .prepare(
      `SELECT * FROM voice_clones WHERE audio_id = ? AND model = ? AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`
    )
    .get(audioId, model, Date.now() + marginMs) as CloneRow | undefined
}

/** The clone handles of a Röst clip go (its consent was withdrawn): a new line needs a new clone, and so consent. */
export function forgetClones(audioId: string): void {
  conn().prepare('DELETE FROM voice_clones WHERE audio_id = ?').run(audioId)
}

export function insertClone(c: Omit<CloneRow, 'id' | 'created_at'>): void {
  conn()
    .prepare(
      `INSERT INTO voice_clones (id, audio_id, model, handle, window_start, window_length, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), c.audio_id, c.model, c.handle, c.window_start, c.window_length, Date.now(), c.expires_at)
}

// ── Library rows the edit service reads ──────────────────────────────────────

export interface AudioClipRow {
  id: string
  asset_id: string
  file_path: string
  duration: number
  clip_start: number
  clip_length: number | null
  clone_consent_at: number | null
  asset_name: string
  asset_kind: string
}

/** A character's or environment's audio clip with its asset's name. */
export function audioClipRow(audioId: string): AudioClipRow | undefined {
  if (typeof audioId !== 'string' || !audioId) return undefined
  return conn()
    .prepare(
      `SELECT c.id, c.asset_id, c.file_path, c.duration, c.clip_start, c.clip_length, c.clone_consent_at,
         a.name AS asset_name, a.kind AS asset_kind
       FROM asset_audio c JOIN assets a ON a.id = c.asset_id WHERE c.id = ?`
    )
    .get(audioId) as AudioClipRow | undefined
}

/** Absolute path of an asset photo (for prompt-edit reference images). */
export function assetImagePath(imageId: string): string | undefined {
  if (typeof imageId !== 'string' || !imageId) return undefined
  const stored = conn().prepare('SELECT file_path FROM asset_images WHERE id = ?').pluck().get(imageId) as
    | string
    | undefined
  return stored ? fromStoredPath(stored) : undefined
}

export interface ExportRow {
  id: string
  sequence_id: string | null
  file_path: string
  created_at: number
  cuts: string | null
  sequence_name: string | null
  kind: string | null
}

export function exportRow(id: string): ExportRow | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return conn()
    .prepare(
      `SELECT e.id, e.sequence_id, e.file_path, e.created_at, e.cuts, s.name AS sequence_name, s.kind AS kind
       FROM exports e LEFT JOIN sequences s ON s.id = e.sequence_id WHERE e.id = ?`
    )
    .get(id) as ExportRow | undefined
}

export function exportCuts(row: Pick<ExportRow, 'cuts'>): number[] | undefined {
  const cuts = parseJson<unknown>(row.cuts, undefined)
  return Array.isArray(cuts) ? cuts.filter((c): c is number => typeof c === 'number' && Number.isFinite(c)) : undefined
}
