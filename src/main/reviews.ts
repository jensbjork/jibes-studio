// The review loop: what the user and their agents thought of generations, the learnings distilled from that, and
// the exported films agents review like clips.
//
// The user has at most one review per generation (stars, note and tags, edited in place; removed once empty).
// Agents add as many as they like, each under its own name, and can never write as the user. Learnings are short
// insights about prompting with the generations they rest on as evidence; agents read them before writing new
// prompts. Every change is broadcast ('review:change' with the generation id, 'learnings:change'), also when an
// agent made it, so open views refetch.

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { titleFromBody } from '@shared/prompts'
import type { ExportSummary, GenerationReview, Learning, LearningInput } from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import { getDb, isDbOpen } from './db'
import { probe } from './ffmpeg'
import { fromStoredPath } from './paths'

/** The author of the user's own review, and of learnings written in Studio. */
export const USER_AUTHOR = 'user'

const MAX_NOTE_LENGTH = 10_000
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 60
const MAX_TITLE_LENGTH = 200
const MAX_INSIGHT_LENGTH = 4_000
const MAX_MODEL_LENGTH = 120
const MAX_EVIDENCE = 50
const MAX_AUTHOR_LENGTH = 80
const MAX_LIST_LIMIT = 1_000

// ── Change notifications ─────────────────────────────────────────────────────

type Broadcast = (channel: string, payload?: unknown) => void

let broadcast: Broadcast = () => {}

/** The change is already saved: a window that can't be told must not turn it into an error for the caller. */
function emit(channel: string, payload?: unknown): void {
  try {
    broadcast(channel, payload)
  } catch (err) {
    console.warn(`Broadcasting ${channel} failed:`, err)
  }
}

const reviewChanged = (generationId: string): void => emit('review:change', generationId)
const learningsChanged = (): void => emit('learnings:change')

// ── Input cleaning (IPC and tool input is untyped at runtime) ────────────────

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Whitespace collapsed to single spaces, trimmed, NFC (macOS may hand over decomposed å ä ö). */
function oneLine(value: unknown): string {
  return text(value).normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Letter case and Unicode form ignored, like db.ts's studio_fold, which the queries below compare with. */
const fold = (s: string): string => s.normalize('NFC').toLowerCase()

function sameAuthor(a: string, b: string): boolean {
  return fold(a) === fold(b)
}

/**
 * The name an agent's reviews and learnings carry: its client name on one line, never the user's own 'user'
 * (which would make its review the user's), 'Agent' when it gave none.
 */
export function agentAuthor(name: unknown): string {
  const clean = oneLine(name).slice(0, MAX_AUTHOR_LENGTH).trim() || 'Agent'
  return sameAuthor(clean, USER_AUTHOR) ? `${clean} (agent)` : clean
}

/** A JSON list of strings from a column; anything else reads as empty. */
function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Trimmed, one line each, without empties, de-duplicated ignoring letter case (the first spelling wins). */
function cleanTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) throw new Error('Taggarna ska vara en lista med ord.')
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = oneLine(raw)
    if (!tag || seen.has(fold(tag))) continue
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`Taggen ”${tag.slice(0, 30)}…” är för lång (högst ${MAX_TAG_LENGTH} tecken).`)
    }
    seen.add(fold(tag))
    result.push(tag)
  }
  if (result.length > MAX_TAGS) throw new Error(`Högst ${MAX_TAGS} taggar.`)
  return result
}

/** undefined: leave as it is. null: clear it. Otherwise a whole number of stars, 1–5. */
function parseRating(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) return value
  throw new Error('Betyget ska vara ett heltal från 1 till 5.')
}

/** Line breaks are kept: a note can be a few paragraphs. */
function cleanNote(value: unknown): string {
  const note = text(value).normalize('NFC').trim()
  if (note.length > MAX_NOTE_LENGTH) throw new Error(`Anteckningen är för lång (högst ${MAX_NOTE_LENGTH} tecken).`)
  return note
}

/** Distinct, non-empty ids in order. */
function cleanIds(ids: unknown): string[] {
  if (ids === undefined || ids === null) return []
  if (!Array.isArray(ids)) throw new Error('Underlaget ska vara en lista med klippens id.')
  return [...new Set(ids.map((id) => oneLine(id)).filter(Boolean))]
}

function requireId(value: unknown, what: string): string {
  const id = oneLine(value)
  if (!id) throw new Error(`Ogiltigt id för ${what}.`)
  return id
}

function clampLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)))
}

/** The ids among these that are generations in the library, in one query however many there are. */
function existingGenerationIds(ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set()
  return new Set(
    getDb()
      .prepare('SELECT id FROM generations WHERE id IN (SELECT value FROM json_each(?))')
      .pluck()
      .all(JSON.stringify(ids)) as string[]
  )
}

function requireGeneration(generationId: unknown): string {
  const id = requireId(generationId, 'klippet')
  if (!getDb().prepare('SELECT 1 FROM generations WHERE id = ?').get(id)) {
    throw new Error('Klippet finns inte – det kan ha raderats.')
  }
  return id
}

// ── Reviews ──────────────────────────────────────────────────────────────────

interface ReviewRow {
  id: string
  generation_id: string
  author: string
  rating: number | null
  tags: string
  note: string
  created_at: number
  updated_at: number
}

function reviewFromRow(r: ReviewRow): GenerationReview {
  return {
    id: r.id,
    generationId: r.generation_id,
    author: r.author,
    rating: r.rating ?? undefined,
    tags: parseList(r.tags),
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function findReviewRow(id: string): ReviewRow | undefined {
  return getDb().prepare('SELECT * FROM generation_reviews WHERE id = ?').get(id) as ReviewRow | undefined
}

export interface ReviewQuery {
  /** One generation's reviews: the user's first, then agents' newest first. Without it: all, latest change first. */
  generationId?: string
  /** 'user' or an agent's name (letter case ignored). */
  author?: string
  limit?: number
}

export function listReviews(query: ReviewQuery = {}): GenerationReview[] {
  const generationId = oneLine(query?.generationId)
  const author = fold(oneLine(query?.author))
  const limit = clampLimit(query?.limit)
  const where: string[] = []
  if (generationId) where.push('generation_id = @generationId')
  if (author) where.push('studio_fold(author) = @author')
  const order = generationId ? `(author = '${USER_AUTHOR}') DESC, created_at DESC, id` : 'updated_at DESC, id'
  const sql =
    `SELECT * FROM generation_reviews ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}` +
    (limit ? ` LIMIT ${limit}` : '')
  return (getDb().prepare(sql).all({ generationId, author }) as ReviewRow[]).map(reviewFromRow)
}

/** The user's own review of a generation, if they have one. */
export function getUserReview(generationId: string): GenerationReview | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM generation_reviews WHERE generation_id = ? AND author = '${USER_AUTHOR}'`)
    .get(generationId) as ReviewRow | undefined
  return row && reviewFromRow(row)
}

export interface UserReviewInput {
  /** null clears the stars; left out keeps them. */
  rating?: number | null
  /** '' clears it; left out keeps it. */
  note?: string
  /** [] clears them; left out keeps them. */
  tags?: string[]
}

/**
 * Sets the user's own review of a generation: the fields given replace the current ones, the others stay. When
 * nothing is left (no stars, note or tags) the review is removed and null comes back.
 */
export function setUserReview(generationId: string, input: UserReviewInput): GenerationReview | null {
  const id = requireGeneration(generationId)
  const patch: UserReviewInput = input && typeof input === 'object' ? input : {}
  const rating = parseRating(patch.rating)
  const note = patch.note === undefined ? undefined : cleanNote(patch.note)
  const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags)

  const conn = getDb()
  let result: GenerationReview | null = null
  let changed = false
  conn.transaction(() => {
    const existing = conn
      .prepare(`SELECT * FROM generation_reviews WHERE generation_id = ? AND author = '${USER_AUTHOR}'`)
      .get(id) as ReviewRow | undefined
    const nextRating = rating === undefined ? (existing?.rating ?? null) : rating
    const nextNote = note ?? existing?.note ?? ''
    const nextTags = JSON.stringify(tags ?? (existing ? parseList(existing.tags) : []))

    if (nextRating === null && !nextNote && nextTags === '[]') {
      if (existing) {
        conn.prepare('DELETE FROM generation_reviews WHERE id = ?').run(existing.id)
        changed = true
      }
      return
    }
    if (existing && existing.rating === nextRating && existing.note === nextNote && existing.tags === nextTags) {
      result = reviewFromRow(existing)
      return
    }
    const now = Date.now()
    const reviewId = existing?.id ?? randomUUID()
    if (existing) {
      conn
        .prepare('UPDATE generation_reviews SET rating = ?, note = ?, tags = ?, updated_at = ? WHERE id = ?')
        .run(nextRating, nextNote, nextTags, now, reviewId)
    } else {
      conn
        .prepare(
          `INSERT INTO generation_reviews (id, generation_id, author, rating, tags, note, created_at, updated_at)
           VALUES (?, ?, '${USER_AUTHOR}', ?, ?, ?, ?, ?)`
        )
        .run(reviewId, id, nextRating, nextTags, nextNote, now, now)
    }
    changed = true
    result = reviewFromRow(findReviewRow(reviewId)!)
  })()
  if (changed) reviewChanged(id)
  return result
}

export interface AgentReviewInput {
  rating?: number | null
  tags?: string[]
  note?: string
}

/** Adds a review by an agent, under its client name (see agentAuthor). It needs stars, tags or a note. */
export function addReview(generationId: string, agent: string, input: AgentReviewInput): GenerationReview {
  const id = requireGeneration(generationId)
  const fields: AgentReviewInput = input && typeof input === 'object' ? input : {}
  const rating = parseRating(fields.rating) ?? null
  const note = cleanNote(fields.note)
  const tags = cleanTags(fields.tags)
  if (rating === null && !note && !tags.length) {
    throw new Error('Ett omdöme behöver ett betyg, taggar eller en anteckning.')
  }
  const reviewId = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO generation_reviews (id, generation_id, author, rating, tags, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(reviewId, id, agentAuthor(agent), rating, JSON.stringify(tags), note, now, now)
  reviewChanged(id)
  return reviewFromRow(findReviewRow(reviewId)!)
}

/**
 * Removes a review; one that is already gone is no error. The user may remove any review; an agent (its client
 * name in `agent`) only its own.
 */
export function deleteReview(reviewId: string, opts: { agent?: string } = {}): void {
  const row = findReviewRow(oneLine(reviewId))
  if (!row) return
  if (opts.agent !== undefined && !sameAuthor(row.author, agentAuthor(opts.agent))) {
    throw new Error('Du kan bara ta bort omdömen du själv har skrivit.')
  }
  getDb().prepare('DELETE FROM generation_reviews WHERE id = ?').run(row.id)
  reviewChanged(row.generation_id)
}

/**
 * Fills in `rating` (the user's stars), `reviewCount` (the user's review plus agents') and `agentReviewCount` (the
 * agents' alone) on generations, in place, with one query however many there are; returns the same array.
 * Generations without reviews get 0 and no rating. The agents' count is separate because the user's own review
 * may be only a note or tags (no stars), so the count can't be told apart from the rating.
 * Never throws: without a library, or if the query fails, the counts stay as they were (0 from the database row).
 */
export function attachReviewSummary<
  T extends { id: string; rating?: number; reviewCount?: number; agentReviewCount?: number }
>(gens: T[]): T[] {
  for (const g of gens) {
    const target = g as { reviewCount?: number; agentReviewCount?: number }
    if (typeof target.reviewCount !== 'number') target.reviewCount = 0
    if (typeof target.agentReviewCount !== 'number') target.agentReviewCount = 0
  }
  if (!gens.length || !isDbOpen()) return gens
  let rows: { generation_id: string; reviews: number; agent_reviews: number; rating: number | null }[]
  try {
    rows = getDb()
      .prepare(
        `SELECT generation_id, COUNT(*) AS reviews,
           SUM(CASE WHEN author = '${USER_AUTHOR}' THEN 0 ELSE 1 END) AS agent_reviews,
           MAX(CASE WHEN author = '${USER_AUTHOR}' THEN rating END) AS rating
         FROM generation_reviews
         WHERE generation_id IN (SELECT value FROM json_each(?))
         GROUP BY generation_id`
      )
      .all(JSON.stringify(gens.map((g) => g.id))) as typeof rows
  } catch (err) {
    console.warn('Reading review summaries failed:', err)
    return gens
  }
  const byId = new Map(rows.map((r) => [r.generation_id, r]))
  for (const g of gens) {
    const target = g as { rating?: number; reviewCount?: number; agentReviewCount?: number }
    const summary = byId.get(g.id)
    target.reviewCount = summary?.reviews ?? 0
    target.agentReviewCount = summary?.agent_reviews ?? 0
    if (summary?.rating != null) target.rating = summary.rating
    else delete target.rating
  }
  return gens
}

// ── Learnings ────────────────────────────────────────────────────────────────

interface LearningRow {
  id: string
  title: string
  insight: string
  model: string | null
  tags: string
  evidence: string
  author: string
  pinned: number
  created_at: number
  updated_at: number
}

/** `existing`: the generations still in the library; evidence of deleted ones is left out. */
function learningFromRow(r: LearningRow, existing: Set<string>): Learning {
  return {
    id: r.id,
    title: r.title,
    insight: r.insight,
    model: r.model ?? undefined,
    tags: parseList(r.tags),
    evidence: parseList(r.evidence).filter((id) => existing.has(id)),
    author: r.author,
    pinned: r.pinned !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function learningsFromRows(rows: LearningRow[]): Learning[] {
  const existing = existingGenerationIds([...new Set(rows.flatMap((r) => parseList(r.evidence)))])
  return rows.map((r) => learningFromRow(r, existing))
}

function findLearningRow(id: string): LearningRow | undefined {
  return getDb().prepare('SELECT * FROM learnings WHERE id = ?').get(id) as LearningRow | undefined
}

export function getLearning(id: string): Learning | undefined {
  const row = findLearningRow(oneLine(id))
  return row && learningsFromRows([row])[0]
}

export interface LearningQuery {
  /** Words that must all appear in the title, insight, model or tags (letter case ignored). */
  query?: string
  /** Learnings for this model, plus those for every model. */
  model?: string
  /** Has this tag (letter case ignored). */
  tag?: string
  /** 'user' or an agent's name (letter case ignored). */
  author?: string
  pinned?: boolean
  limit?: number
}

/** Pinned first, then the most recently changed. */
export function listLearnings(query: LearningQuery = {}): Learning[] {
  const q: LearningQuery = query && typeof query === 'object' ? query : {}
  const words = fold(oneLine(q.query)).split(' ').filter(Boolean)
  const model = fold(oneLine(q.model))
  const tag = fold(oneLine(q.tag))
  const author = oneLine(q.author)
  const all = getDb()
    .prepare('SELECT * FROM learnings ORDER BY pinned DESC, updated_at DESC, created_at DESC, id')
    .all() as LearningRow[]
  const rows = all.filter((r) => {
    if (typeof q.pinned === 'boolean' && (r.pinned !== 0) !== q.pinned) return false
    if (author && !sameAuthor(r.author, author)) return false
    if (model && r.model && fold(r.model) !== model) return false
    const tags = parseList(r.tags)
    if (tag && !tags.some((t) => fold(t) === tag)) return false
    if (words.length) {
      const haystack = fold([r.title, r.insight, r.model ?? '', ...tags].join('\n'))
      if (!words.every((w) => haystack.includes(w))) return false
    }
    return true
  })
  const limit = clampLimit(q.limit)
  return learningsFromRows(limit ? rows.slice(0, limit) : rows)
}

/** Throws (naming them) unless every id is a generation in the library. */
function requireGenerations(ids: readonly string[]): void {
  const existing = existingGenerationIds(ids)
  const unknown = ids.filter((id) => !existing.has(id))
  if (!unknown.length) return
  throw new Error(
    unknown.length === 1
      ? `Det finns inget klipp med id ${unknown[0]}.`
      : `Det finns inga klipp med id ${unknown.join(', ')}.`
  )
}

/** Why an agent may not change or delete a learning the user has pinned (pinning is the user's endorsement). */
const PINNED_BY_USER =
  'Användaren har fäst lärdomen, så den kan inte ändras eller tas bort av agenter. Spara en ny lärdom om resultaten säger något annat.'

/**
 * Creates (no id) or updates a learning. A new one is the user's, or with `agent` (its client name) that agent's;
 * an update leaves the fields not given (model, tags, evidence, pinned) as they are. An agent may only update its
 * own, and not once the user has pinned it. An update keeps its author, except that the user changing an agent's
 * learning (anything but the pin) makes it the user's: the agent can then no longer rewrite or delete what the user
 * wrote. A missing title is made from the insight. Newly added evidence must be generations in the library;
 * evidence already recorded stays even if that generation has been deleted since.
 */
export function saveLearning(input: LearningInput, opts: { agent?: string } = {}): Learning {
  if (!input || typeof input !== 'object') throw new Error('Ogiltig lärdom.')
  const insight = text(input.insight).normalize('NFC').trim()
  if (!insight) throw new Error('Skriv vad lärdomen går ut på.')
  if (insight.length > MAX_INSIGHT_LENGTH) {
    throw new Error(`Lärdomen är för lång (högst ${MAX_INSIGHT_LENGTH} tecken). Korta ner den till det viktigaste.`)
  }
  const title = oneLine(input.title) || titleFromBody(insight)
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`Rubriken är för lång (högst ${MAX_TITLE_LENGTH} tecken).`)
  const model = input.model === undefined ? undefined : oneLine(input.model) || null
  if (model && model.length > MAX_MODEL_LENGTH) throw new Error('Modellnamnet är för långt.')
  const tags = input.tags === undefined ? undefined : cleanTags(input.tags)
  const evidence = input.evidence === undefined ? undefined : cleanIds(input.evidence)
  if (evidence && evidence.length > MAX_EVIDENCE) throw new Error(`Högst ${MAX_EVIDENCE} klipp som underlag.`)
  const pinned = input.pinned === undefined ? undefined : input.pinned === true

  const author = opts.agent === undefined ? USER_AUTHOR : agentAuthor(opts.agent)
  const conn = getDb()
  const now = Date.now()
  const id = oneLine(input.id)
  if (id) {
    const existing = findLearningRow(id)
    if (!existing) throw new Error('Lärdomen finns inte längre.')
    if (opts.agent !== undefined && !sameAuthor(existing.author, author)) {
      throw new Error('Du kan bara ändra lärdomar du själv har sparat.')
    }
    if (opts.agent !== undefined && existing.pinned) throw new Error(PINNED_BY_USER)
    const recorded = parseList(existing.evidence)
    if (evidence) requireGenerations(evidence.filter((e) => !recorded.includes(e)))
    const next = {
      title,
      insight,
      model: model === undefined ? existing.model : model,
      tags: tags === undefined ? existing.tags : JSON.stringify(tags),
      evidence: evidence === undefined ? existing.evidence : JSON.stringify(evidence),
      pinned: pinned === undefined ? existing.pinned : pinned ? 1 : 0
    }
    const sameContent =
      existing.title === next.title &&
      existing.insight === next.insight &&
      existing.model === next.model &&
      existing.tags === next.tags &&
      existing.evidence === next.evidence
    if (sameContent && existing.pinned === next.pinned) return learningsFromRows([existing])[0]
    const nextAuthor = opts.agent === undefined && !sameContent ? USER_AUTHOR : existing.author
    conn
      .prepare(
        `UPDATE learnings SET title = ?, insight = ?, model = ?, tags = ?, evidence = ?, pinned = ?, author = ?,
           updated_at = ?
         WHERE id = ?`
      )
      .run(next.title, next.insight, next.model, next.tags, next.evidence, next.pinned, nextAuthor, now, existing.id)
    learningsChanged()
    return getLearning(existing.id)!
  }

  if (evidence) requireGenerations(evidence)
  const newId = randomUUID()
  conn
    .prepare(
      `INSERT INTO learnings (id, title, insight, model, tags, evidence, author, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      title,
      insight,
      model ?? null,
      JSON.stringify(tags ?? []),
      JSON.stringify(evidence ?? []),
      author,
      pinned ? 1 : 0,
      now,
      now
    )
  learningsChanged()
  return getLearning(newId)!
}

/**
 * Removes a learning; one that is already gone is no error. The user may remove any learning; an agent (its client
 * name in `agent`) only its own, and not one the user has pinned.
 */
export function deleteLearning(id: string, opts: { agent?: string } = {}): void {
  const row = findLearningRow(oneLine(id))
  if (!row) return
  if (opts.agent !== undefined && !sameAuthor(row.author, agentAuthor(opts.agent))) {
    throw new Error('Du kan bara ta bort lärdomar du själv har sparat.')
  }
  if (opts.agent !== undefined && row.pinned) throw new Error(PINNED_BY_USER)
  getDb().prepare('DELETE FROM learnings WHERE id = ?').run(row.id)
  learningsChanged()
}

// ── Exports ──────────────────────────────────────────────────────────────────

interface ExportRow {
  id: string
  sequence_id: string | null
  sequence_name: string | null
  file_path: string
  created_at: number
}

/** Films are probed a few at a time; the list can hold every export ever made. */
const PROBE_CONCURRENCY = 4
/** A file that couldn't be probed is tried again after this long (ffmpeg may have been installed meanwhile). */
const FAILED_PROBE_RETRY_MS = 60_000

/** Durations by path, valid while the file's size and modification time are unchanged. */
const durationCache = new Map<string, { size: number; mtimeMs: number; duration?: number; at: number }>()

async function exportFile(path: string): Promise<{ exists: boolean; duration?: number }> {
  let size: number
  let mtimeMs: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return { exists: false }
    ;({ size, mtimeMs } = info)
  } catch {
    return { exists: false }
  }
  const cached = durationCache.get(path)
  const fresh = cached && cached.size === size && cached.mtimeMs === mtimeMs
  if (fresh && (cached.duration !== undefined || Date.now() - cached.at < FAILED_PROBE_RETRY_MS)) {
    return { exists: true, duration: cached.duration }
  }
  let duration: number | undefined
  try {
    duration = (await probe(path)).duration
  } catch (err) {
    console.warn(`Probing the export ${path} failed:`, err instanceof Error ? err.message : err)
  }
  durationCache.set(path, { size, mtimeMs, duration, at: Date.now() })
  return { exists: true, duration }
}

async function summarizeExports(rows: ExportRow[]): Promise<ExportSummary[]> {
  // Paths are resolved right away, while the library that answered the query is surely still open.
  const items = rows.map((r) => ({ row: r, path: fromStoredPath(r.file_path) }))
  const files = new Array<{ exists: boolean; duration?: number }>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      files[i] = await exportFile(items[i].path)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, items.length) }, worker))
  return items.map(({ row, path }, i) => ({
    id: row.id,
    sequenceId: row.sequence_id ?? undefined,
    sequenceName: row.sequence_name ?? undefined,
    path,
    createdAt: row.created_at,
    duration: files[i].duration,
    exists: files[i].exists
  }))
}

const EXPORT_COLUMNS = `SELECT e.id, e.sequence_id, e.file_path, e.created_at, s.name AS sequence_name
  FROM exports e LEFT JOIN sequences s ON s.id = e.sequence_id`

/** Exported films, newest first: whether the file is still there, and its length when it could be probed. */
export async function listExports(): Promise<ExportSummary[]> {
  const rows = getDb().prepare(`${EXPORT_COLUMNS} ORDER BY e.created_at DESC, e.id`).all() as ExportRow[]
  return summarizeExports(rows)
}

export async function getExport(id: string): Promise<ExportSummary | undefined> {
  const row = getDb().prepare(`${EXPORT_COLUMNS} WHERE e.id = ?`).get(oneLine(id)) as ExportRow | undefined
  return row ? (await summarizeExports([row]))[0] : undefined
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** Who is calling: nobody in particular from a window (the user), else the agent by the name its tool passed. */
function caller(event: IpcMainInvokeEvent, name: unknown): { agent?: string } {
  return isAgentCall(event) ? { agent: text(name) } : {}
}

/**
 * Registers the reviews:*, learnings:* and exports:list handlers; `notify` broadcasts 'review:change' (with the
 * generation id) and 'learnings:change' to the windows. The handlers serve the agent connection too (through
 * callService): an agent passes its name as the last argument where it writes, can't set the user's own review,
 * and may change or remove only what it wrote itself. 'reviews:add' is for agents only (not in StudioApi).
 */
export function registerReviewIpc(notify: Broadcast): void {
  broadcast = notify

  ipcMain.handle('reviews:list', (_e, generationId?: unknown, query?: unknown) => {
    const q = query && typeof query === 'object' ? (query as ReviewQuery) : {}
    return listReviews({ ...q, generationId: oneLine(generationId) || undefined })
  })
  ipcMain.handle('reviews:setUser', (e, generationId: unknown, input: unknown) => {
    if (isAgentCall(e)) {
      throw new Error('Användarens eget betyg sätts bara i Studio. Lägg till ett eget omdöme i stället.')
    }
    return setUserReview(requireId(generationId, 'klippet'), input as UserReviewInput)
  })
  ipcMain.handle('reviews:add', (e, generationId: unknown, input: unknown, author?: unknown) => {
    if (!isAgentCall(e)) throw new Error('Ditt eget omdöme sparas med betyget och anteckningen på klippet.')
    return addReview(requireId(generationId, 'klippet'), text(author), input as AgentReviewInput)
  })
  ipcMain.handle('reviews:delete', (e, reviewId: unknown, author?: unknown) =>
    deleteReview(requireId(reviewId, 'omdömet'), caller(e, author))
  )

  ipcMain.handle('learnings:list', (_e, query?: unknown) =>
    listLearnings(query && typeof query === 'object' ? (query as LearningQuery) : {})
  )
  ipcMain.handle('learnings:save', (e, input: unknown, author?: unknown) =>
    saveLearning(input as LearningInput, caller(e, author))
  )
  ipcMain.handle('learnings:delete', (e, id: unknown, author?: unknown) =>
    deleteLearning(requireId(id, 'lärdomen'), caller(e, author))
  )

  ipcMain.handle('exports:list', () => listExports())
}
