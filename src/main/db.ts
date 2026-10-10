import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import type {
  EditRecipe,
  Generation,
  GenerationParams,
  GenerationSource,
  GenerationStatus,
  SegmentImageSlot
} from '@shared/types'
import {
  fromStoredParams,
  fromStoredPath,
  isInsideRoot,
  isLibraryRelative,
  LIBRARY_NOT_READY,
  toStoredParams,
  toStoredPath,
  withoutLocalPaths
} from './paths'

let db: Database.Database | undefined

// Each entry runs once, in order; append new migrations to the end.
const migrations: string[] = [
  `CREATE TABLE generations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL,
    queue_id TEXT,
    download_url TEXT,
    file_path TEXT,
    error TEXT,
    quote REAL,
    average_execution_time INTEGER,
    execution_duration INTEGER,
    completed_at INTEGER
  )`,

  `CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE character_images (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX character_images_by_character ON character_images(character_id, position);`,

  `CREATE TABLE prompts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    negative_prompt TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,

  `CREATE TABLE sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    defaults TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    params TEXT NOT NULL,
    continue_from_previous INTEGER NOT NULL DEFAULT 0,
    selected_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    trim_start REAL NOT NULL DEFAULT 0,
    trim_end REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX segments_by_sequence ON segments(sequence_id, position);
  ALTER TABLE generations ADD COLUMN segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL;
  ALTER TABLE generations ADD COLUMN thumb_path TEXT;
  ALTER TABLE generations ADD COLUMN video_duration REAL;
  CREATE INDEX generations_by_segment ON generations(segment_id);`,

  // Phase 3: human-readable folders per character and sequence, and finished exports tracked so they can
  // follow folder renames. Paths are stored relative to the base folder from here on (see paths.ts).
  `ALTER TABLE characters ADD COLUMN folder TEXT;
  ALTER TABLE sequences ADD COLUMN folder TEXT;
  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    sequence_id TEXT REFERENCES sequences(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX exports_by_sequence ON exports(sequence_id);`,

  // Phase 4: characters become one kind of asset, next to environments (Miljöer) and outfits (Kläder). Existing
  // rows are characters; the renames carry their rows, images and foreign keys over unchanged.
  `ALTER TABLE characters RENAME TO assets;
  ALTER TABLE character_images RENAME TO asset_images;
  ALTER TABLE asset_images RENAME COLUMN character_id TO asset_id;
  DROP INDEX IF EXISTS character_images_by_character;
  CREATE INDEX asset_images_by_asset ON asset_images(asset_id, position);
  ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'character';
  ALTER TABLE assets ADD COLUMN default_outfit_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
  CREATE INDEX assets_by_kind ON assets(kind);`,

  // Phase 6: audio clips on assets (a character's voice, an environment's soundscape), the user's and agents'
  // reviews of generations, and the learnings agents distil from them. Poses are a new asset kind, which needs
  // no schema change (assets.kind is free text) but owns the Poser folder from this version on.
  `CREATE TABLE asset_audio (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    duration REAL NOT NULL,
    clip_start REAL NOT NULL DEFAULT 0,
    clip_length REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX asset_audio_by_asset ON asset_audio(asset_id, position);
  CREATE TABLE generation_reviews (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX generation_reviews_by_generation ON generation_reviews(generation_id);
  CREATE UNIQUE INDEX generation_reviews_user ON generation_reviews(generation_id) WHERE author = 'user';
  CREATE TABLE learnings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    insight TEXT NOT NULL,
    model TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '[]',
    author TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,

  // Phase 7: storyboards. A clip can take its end image from the next clip (end_from_next, mirroring
  // continue_from_previous) and has free-text notes; stills are the images of a sequence's storyboard
  // (generated, uploaded or saved frames), kept in Sekvenser/<sequence>/Storyboard/. A still outlives its
  // sequence (sequence_id set to NULL) when clips or generations elsewhere still use it.
  `ALTER TABLE segments ADD COLUMN end_from_next INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE segments ADD COLUMN notes TEXT NOT NULL DEFAULT '';
  CREATE TABLE stills (
    id TEXT PRIMARY KEY,
    sequence_id TEXT REFERENCES sequences(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    source TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    model TEXT,
    params TEXT NOT NULL DEFAULT '{}',
    cost REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX stills_by_sequence ON stills(sequence_id, created_at);`,

  // Phase 8: the descriptions of the referenced assets are appended to the prompt as a References legend when it
  // is sent. sent_prompt is the prompt exactly as Venice got it; prompt (and params.prompt) stay the user's text,
  // which "Använd igen" puts back. NULL for generations from before.
  `ALTER TABLE generations ADD COLUMN sent_prompt TEXT;`,

  // Phase 9: storyboards as a workflow of their own. A storyboard is a row of `sequences` of kind 'storyboard' (so
  // takes, folders, export and approvals work as for sequences) with an aspect ratio and ordered boards, one image
  // each; its segments are the transitions between adjacent boards, tied to them by from_board_id / to_board_id.
  // image_path is a stored path like every other (relative inside the library) and follows renames and moves.
  `ALTER TABLE sequences ADD COLUMN kind TEXT NOT NULL DEFAULT 'sequence';
  ALTER TABLE sequences ADD COLUMN aspect_ratio TEXT;
  CREATE TABLE storyboard_boards (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    image_path TEXT,
    still_id TEXT REFERENCES stills(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX storyboard_boards_by_sequence ON storyboard_boards(sequence_id, position);
  ALTER TABLE segments ADD COLUMN from_board_id TEXT REFERENCES storyboard_boards(id) ON DELETE SET NULL;
  ALTER TABLE segments ADD COLUMN to_board_id TEXT REFERENCES storyboard_boards(id) ON DELETE SET NULL;`,

  // Phase 10: Redigera and own clips. A generations row is no longer only a Venice generation: `source` tells a
  // Venice generation ('generated') from the user's own imported film ('import') and a version made in Redigera
  // ('edit'). Imports and versions are always inserted completed (never pending). An edit is one film being worked
  // on: its versions and AI takes point at it with edit_id, a version at its base with parent_id. edit_media holds
  // an edit's paid or added audio (Redigeringar/<namn>/Ljud/), media_jobs and media_job_steps the bookkeeping of
  // multi-step paid work, so a job interrupted by quitting can be fetched or resumed without sending anything twice.
  // original_path and edit_media.file_path are stored paths like every other; recipe, details, request and
  // segments are JSON with ids only, never paths. exports.cuts records where the clips meet in an exported film,
  // sequences.export_height its "Exportformat" (NULL = Automatiskt).
  `CREATE TABLE edits (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT,
    origin_kind TEXT NOT NULL,
    origin_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    origin_export_id TEXT REFERENCES exports(id) ON DELETE SET NULL,
    current_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE generations ADD COLUMN source TEXT NOT NULL DEFAULT 'generated';
  ALTER TABLE generations ADD COLUMN title TEXT;
  ALTER TABLE generations ADD COLUMN parent_id TEXT REFERENCES generations(id) ON DELETE SET NULL;
  ALTER TABLE generations ADD COLUMN edit_id TEXT REFERENCES edits(id) ON DELETE SET NULL;
  ALTER TABLE generations ADD COLUMN recipe TEXT;
  ALTER TABLE generations ADD COLUMN original_path TEXT;
  CREATE INDEX generations_by_parent ON generations(parent_id);
  CREATE INDEX generations_by_edit ON generations(edit_id);
  CREATE TABLE edit_media (
    id TEXT PRIMARY KEY,
    edit_id TEXT NOT NULL REFERENCES edits(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    model TEXT,
    cost REAL,
    duration REAL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX edit_media_by_edit ON edit_media(edit_id, created_at);
  CREATE TABLE media_jobs (
    id TEXT PRIMARY KEY,
    edit_id TEXT REFERENCES edits(id) ON DELETE CASCADE,
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    base_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    op TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    quote REAL,
    cost REAL NOT NULL DEFAULT 0,
    take_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    result_generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX media_jobs_by_edit ON media_jobs(edit_id, created_at);
  CREATE TABLE media_job_steps (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    request TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    queue_id TEXT,
    quote REAL,
    error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX media_job_steps_by_job ON media_job_steps(job_id, position);
  CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    model TEXT,
    language TEXT,
    segments TEXT NOT NULL,
    source TEXT NOT NULL,
    cost REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX transcripts_by_generation ON transcripts(generation_id);
  CREATE TABLE voice_clones (
    id TEXT PRIMARY KEY,
    audio_id TEXT NOT NULL REFERENCES asset_audio(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    handle TEXT NOT NULL,
    window_start REAL NOT NULL,
    window_length REAL NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE asset_audio ADD COLUMN clone_consent_at INTEGER;
  ALTER TABLE exports ADD COLUMN cuts TEXT;
  ALTER TABLE sequences ADD COLUMN export_height INTEGER;`,

  // Phase 11. Products are a new asset kind (assets.kind = 'product', free text) that owns the Produkter folder from
  // this version on. unseen: finished work the user hasn't looked at yet (ids only, never paths); a row refers to at
  // most one item, so deleting the item removes the row with it, and an error-only row (a picture that wasn't made,
  // a failed export or run) names its owner in `context`. take_trims: the trims each take of a clip last had, so
  // switching takes never erodes them. origin: which agent added a photo or a sound clip, and from which host
  // (JSON; NULL = the user). storyboard_boards_by_still: the status summary finds a picture's first board by its still.
  `CREATE TABLE unseen (
    id TEXT PRIMARY KEY,
    generation_id TEXT REFERENCES generations(id) ON DELETE CASCADE,
    still_id TEXT REFERENCES stills(id) ON DELETE CASCADE,
    export_id TEXT REFERENCES exports(id) ON DELETE CASCADE,
    audio_id TEXT REFERENCES asset_audio(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES media_jobs(id) ON DELETE CASCADE,
    error TEXT,
    label TEXT,
    context TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX unseen_generation ON unseen(generation_id) WHERE generation_id IS NOT NULL;
  CREATE UNIQUE INDEX unseen_still ON unseen(still_id) WHERE still_id IS NOT NULL;
  CREATE UNIQUE INDEX unseen_export ON unseen(export_id) WHERE export_id IS NOT NULL;
  CREATE UNIQUE INDEX unseen_audio ON unseen(audio_id) WHERE audio_id IS NOT NULL;
  CREATE UNIQUE INDEX unseen_job ON unseen(job_id) WHERE job_id IS NOT NULL;
  CREATE TABLE take_trims (
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    trim_start REAL NOT NULL,
    trim_end REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (segment_id, generation_id)
  );
  CREATE INDEX take_trims_by_generation ON take_trims(generation_id);
  CREATE INDEX storyboard_boards_by_still ON storyboard_boards(still_id);
  ALTER TABLE asset_images ADD COLUMN origin TEXT;
  ALTER TABLE asset_audio ADD COLUMN origin TEXT;`,

  // Phase 12. Grades: a rating (the user's or an agent's) is tumme ner (-1) or one to three stars, no longer one to
  // five. SQLite can't change a CHECK, so generation_reviews is rebuilt (same columns, the same two indexes) with the
  // old stars mapped: 1–2 → -1, 3 → 1, 4 → 2, 5 → 3 (by range, so nothing can land outside the new CHECK). Foreign
  // keys stay on: the table is only a child (nothing references it), so dropping it cascades nothing, and the copy
  // leaves out reviews of generations that no longer exist (possible only in a database edited with foreign keys
  // off), which would otherwise fail the whole migration. segments.continue_mode: how a clip that continues from the
  // previous one starts on its last frame ('references': in reference mode, the frame as one more reference;
  // 'exact': image-to-video from the frame, as before).
  `CREATE TABLE generation_reviews_v13 (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    rating INTEGER CHECK (rating IN (-1, 1, 2, 3)),
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO generation_reviews_v13 (id, generation_id, author, rating, tags, note, created_at, updated_at)
    SELECT id, generation_id, author,
      CASE
        WHEN rating IS NULL THEN NULL
        WHEN rating < 3 THEN -1
        WHEN rating < 4 THEN 1
        WHEN rating < 5 THEN 2
        ELSE 3
      END,
      tags, note, created_at, updated_at
    FROM generation_reviews
    WHERE generation_id IN (SELECT id FROM generations);
  DROP TABLE generation_reviews;
  ALTER TABLE generation_reviews_v13 RENAME TO generation_reviews;
  CREATE INDEX generation_reviews_by_generation ON generation_reviews(generation_id);
  CREATE UNIQUE INDEX generation_reviews_user ON generation_reviews(generation_id) WHERE author = 'user';
  ALTER TABLE segments ADD COLUMN continue_mode TEXT NOT NULL DEFAULT 'references'
    CHECK (continue_mode IN ('references', 'exact'));`
]


/**
 * The user_version from which a library has assets (the migration above): from then on Miljöer and Kläder in
 * the base folder are the library's own folders.
 */
export const ASSETS_SCHEMA_VERSION = 6

/** The user_version from which a library has poses (and asset audio): from then on Poser is its own folder. */
export const POSES_SCHEMA_VERSION = 7

/** The user_version from which a library has storyboards of their own: from then on Storyboards is its own folder. */
export const STORYBOARDS_SCHEMA_VERSION = 10

/**
 * The user_version from which a library has edits and own clips: from then on Egna klipp and Redigeringar are its
 * own folders.
 */
export const EDITS_SCHEMA_VERSION = 11

/**
 * The user_version from which a library has products (and the unseen, take_trims and origin bookkeeping): from then
 * on Produkter is its own folder.
 */
export const PRODUCTS_SCHEMA_VERSION = 12

/**
 * Why this build doesn't open a library whose database a newer Studio has migrated: it doesn't know the newer
 * tables, and its own upkeep (renaming or moving asset folders, deleting assets) would leave their paths behind or
 * trash files they still use.
 */
export const NEWER_LIBRARY_MESSAGE =
  'Biblioteket har sparats av en nyare version av Studio. Uppdatera appen för att öppna det.'

/** Whether a database at this schema version comes from a newer Studio than this build. */
export function isNewerSchema(version: number): boolean {
  return version > migrations.length
}

/** The schema version of a library database, read without migrating it. */
export function schemaVersion(file: string): number {
  const conn = new Database(file, { fileMustExist: true })
  try {
    return conn.pragma('user_version', { simple: true }) as number
  } finally {
    conn.close()
  }
}

/** For modules that keep their own tables (assets, prompts, sequences). Throws while no library is open. */
export function getDb(): Database.Database {
  if (!db) throw new Error(LIBRARY_NOT_READY)
  return db
}

export function isDbOpen(): boolean {
  return db !== undefined
}

/** How paths are compared: the way macOS volumes compare names (letter case and Unicode form ignored). */
const fold = (s: string): string => s.normalize('NFC').toLowerCase()

/**
 * Opens and migrates the library database; closes any database already open. A missing database file is
 * only created when `create` is set (a new library): a library folder that has lost its database (renamed
 * away and recreated, .studio deleted) must not silently turn into an empty library.
 */
export function openDb(file: string, opts: { create?: boolean } = {}): void {
  closeDb()
  const conn = new Database(file, { fileMustExist: !opts.create })
  try {
    conn.function('studio_fold', { deterministic: true }, (v: unknown) => (typeof v === 'string' ? fold(v) : v))
    conn.pragma('journal_mode = WAL')
    conn.pragma('foreign_keys = ON')
    const version = conn.pragma('user_version', { simple: true }) as number
    if (isNewerSchema(version)) throw new Error(NEWER_LIBRARY_MESSAGE)
    for (let i = version; i < migrations.length; i++) {
      conn.transaction(() => {
        conn.exec(migrations[i])
        conn.pragma(`user_version = ${i + 1}`)
      })()
    }
  } catch (err) {
    conn.close()
    throw err
  }
  db = conn
}

/** Closing the last connection folds the WAL back into studio.db, so the folder can be moved as is. */
export function closeDb(): void {
  const conn = db
  db = undefined
  try {
    if (conn?.open) conn.close()
  } catch (err) {
    // E.g. the disk it was on is gone; the connection is dropped either way.
    console.warn('Closing the library database failed:', err)
  }
}

export interface GenerationRow {
  id: string
  created_at: number
  model: string
  prompt: string
  /** JSON; image paths in stored form (relative inside the library). */
  params: string
  status: GenerationStatus
  queue_id: string | null
  download_url: string | null
  /** Stored form: relative inside the library, absolute outside it. */
  file_path: string | null
  error: string | null
  quote: number | null
  average_execution_time: number | null
  execution_duration: number | null
  completed_at: number | null
  segment_id: string | null
  /** Stored form, like file_path. */
  thumb_path: string | null
  video_duration: number | null
  /** The prompt as sent (the user's with the References legend); NULL for generations from before it was kept. */
  sent_prompt: string | null
  /** 'generated' | 'import' | 'edit' (schema 11; rows from before are 'generated'). */
  source: string | null
  title: string | null
  parent_id: string | null
  edit_id: string | null
  /** JSON EditRecipe (ids only). */
  recipe: string | null
  /** Stored form, like file_path. */
  original_path: string | null
}

/** A generation with absolute paths (the conversion to and from the stored form happens here). */
export interface StoredGeneration extends Generation {
  downloadUrl?: string
}

const SOURCES: ReadonlySet<string> = new Set<GenerationSource>(['generated', 'import', 'edit'])

/** The row's source; a value this version doesn't know (a newer Studio's) is treated as a Venice generation. */
function sourceOf(value: string | null | undefined): GenerationSource {
  return typeof value === 'string' && SOURCES.has(value) ? (value as GenerationSource) : 'generated'
}

/** A recipe column parsed; a missing or broken one gives undefined (it is only ever informative). */
function parseRecipe(json: string | null | undefined): EditRecipe | undefined {
  if (typeof json !== 'string' || !json) return undefined
  try {
    const recipe = JSON.parse(json) as unknown
    return recipe && typeof recipe === 'object' && !Array.isArray(recipe) ? (recipe as EditRecipe) : undefined
  } catch {
    return undefined
  }
}

export function generationFromRow(r: GenerationRow): StoredGeneration {
  const recipe = parseRecipe(r.recipe)
  return {
    id: r.id,
    createdAt: r.created_at,
    source: sourceOf(r.source),
    ...(typeof r.title === 'string' && r.title ? { title: r.title } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.edit_id ? { editId: r.edit_id } : {}),
    ...(recipe ? { recipe } : {}),
    ...(r.original_path ? { originalPath: fromStoredPath(r.original_path) } : {}),
    model: r.model,
    prompt: r.prompt,
    ...(typeof r.sent_prompt === 'string' ? { sentPrompt: r.sent_prompt } : {}),
    params: fromStoredParams(JSON.parse(r.params) as GenerationParams),
    status: r.status,
    queueId: r.queue_id ?? undefined,
    downloadUrl: r.download_url ?? undefined,
    filePath: r.file_path ? fromStoredPath(r.file_path) : undefined,
    error: r.error ?? undefined,
    quote: r.quote ?? undefined,
    averageExecutionTime: r.average_execution_time ?? undefined,
    executionDuration: r.execution_duration ?? undefined,
    completedAt: r.completed_at ?? undefined,
    segmentId: r.segment_id ?? undefined,
    thumbPath: r.thumb_path ? fromStoredPath(r.thumb_path) : undefined,
    videoDuration: r.video_duration ?? undefined,
    // Filled in by reviews.attachReviewSummary where the feed needs them (generations:list, updates).
    reviewCount: 0,
    agentReviewCount: 0
  }
}

const storedPathOrNull = (p: string | undefined | null): string | null => (p ? toStoredPath(p) : null)

const recipeOrNull = (r: EditRecipe | undefined | null): string | null => (r ? JSON.stringify(r) : null)

/**
 * A new row. `source` undefined is written as 'generated' (callers from before own clips existed). An import or
 * version must be inserted completed: only Venice generations are ever pending (listPendingGenerations).
 */
export function insertGeneration(g: Omit<StoredGeneration, 'source'> & { source?: GenerationSource }): void {
  getDb()
    .prepare(
      `INSERT INTO generations (id, created_at, model, prompt, params, status, queue_id, download_url, file_path,
         error, quote, average_execution_time, execution_duration, completed_at, segment_id, thumb_path,
         video_duration, sent_prompt, source, title, parent_id, edit_id, recipe, original_path)
       VALUES (@id, @createdAt, @model, @prompt, @params, @status, @queueId, @downloadUrl, @filePath, @error,
         @quote, @averageExecutionTime, @executionDuration, @completedAt, @segmentId, @thumbPath, @videoDuration,
         @sentPrompt, @source, @title, @parentId, @editId, @recipe, @originalPath)`
    )
    .run({
      id: g.id,
      createdAt: g.createdAt,
      model: g.model,
      prompt: g.prompt,
      params: JSON.stringify(toStoredParams(g.params)),
      status: g.status,
      queueId: g.queueId ?? null,
      downloadUrl: g.downloadUrl ?? null,
      filePath: storedPathOrNull(g.filePath),
      error: g.error ?? null,
      quote: g.quote ?? null,
      averageExecutionTime: g.averageExecutionTime ?? null,
      executionDuration: g.executionDuration ?? null,
      completedAt: g.completedAt ?? null,
      segmentId: g.segmentId ?? null,
      thumbPath: storedPathOrNull(g.thumbPath),
      videoDuration: g.videoDuration ?? null,
      sentPrompt: typeof g.sentPrompt === 'string' ? g.sentPrompt : null,
      source: sourceOf(g.source),
      title: typeof g.title === 'string' && g.title ? g.title : null,
      parentId: g.parentId ?? null,
      editId: g.editId ?? null,
      recipe: recipeOrNull(g.recipe),
      originalPath: storedPathOrNull(g.originalPath)
    })
}

/**
 * Patchable fields → column, and how a value is written. `required`: a NOT NULL column, which a patch can change
 * but never clear (undefined or null there leaves it as it is).
 */
const columns: Record<string, { column: string; store?: (v: unknown) => unknown; required?: boolean }> = {
  status: { column: 'status' },
  queueId: { column: 'queue_id' },
  downloadUrl: { column: 'download_url' },
  filePath: { column: 'file_path', store: (v) => storedPathOrNull(v as string | undefined) },
  error: { column: 'error' },
  averageExecutionTime: { column: 'average_execution_time' },
  executionDuration: { column: 'execution_duration' },
  completedAt: { column: 'completed_at' },
  segmentId: { column: 'segment_id' },
  thumbPath: { column: 'thumb_path', store: (v) => storedPathOrNull(v as string | undefined) },
  videoDuration: { column: 'video_duration' },
  params: { column: 'params', store: (v) => JSON.stringify(toStoredParams(v as GenerationParams)) },
  source: { column: 'source', store: (v) => sourceOf(v as string), required: true },
  title: { column: 'title' },
  parentId: { column: 'parent_id' },
  editId: { column: 'edit_id' },
  recipe: { column: 'recipe', store: (v) => recipeOrNull(v as EditRecipe) },
  originalPath: { column: 'original_path', store: (v) => storedPathOrNull(v as string | undefined) }
}

/** Callers pass absolute paths; they are stored relative to the library when inside it. */
export function updateGeneration(id: string, patch: Partial<StoredGeneration>): StoredGeneration {
  const entries = Object.entries(patch).filter(
    ([k, v]) => k in columns && !((k === 'params' || columns[k].required) && v == null)
  )
  if (entries.length) {
    const sets = entries.map(([k]) => `${columns[k].column} = @${k}`).join(', ')
    getDb()
      .prepare(`UPDATE generations SET ${sets} WHERE id = @id`)
      .run({
        id,
        ...Object.fromEntries(
          entries.map(([k, v]) => {
            const store = columns[k].store
            return [k, v == null ? null : store ? store(v) : v]
          })
        )
      })
  }
  return getGeneration(id)!
}

export function getGeneration(id: string): StoredGeneration | undefined {
  const row = getDb().prepare('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow | undefined
  return row && generationFromRow(row)
}

export function listGenerations(): StoredGeneration[] {
  return (getDb().prepare('SELECT * FROM generations ORDER BY created_at DESC').all() as GenerationRow[]).map(
    generationFromRow
  )
}

/**
 * Venice generations still on their way. Only `source = 'generated'` rows: imports and versions are inserted
 * completed, so a row of another source in a pending state (a newer Studio's, or a crash mid-insert) is never
 * polled at Venice.
 */
export function listPendingGenerations(): StoredGeneration[] {
  return (
    getDb()
      .prepare(`SELECT * FROM generations WHERE status IN ('queued', 'processing') AND source = 'generated'`)
      .all() as GenerationRow[]
  ).map(generationFromRow)
}

export function deleteGeneration(id: string): void {
  getDb().prepare('DELETE FROM generations WHERE id = ?').run(id)
}

/** Takes for the given segments, newest first. */
export function listGenerationsForSegments(segmentIds: string[]): StoredGeneration[] {
  if (!segmentIds.length) return []
  const placeholders = segmentIds.map(() => '?').join(', ')
  return (
    getDb()
      .prepare(`SELECT * FROM generations WHERE segment_id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...segmentIds) as GenerationRow[]
  ).map(generationFromRow)
}

// ── Unseen work (Pågår och klart) ────────────────────────────────────────────

/**
 * What an unseen row is about beyond its one item: ids only, never paths (the table isn't part of the stored-path
 * upkeep). An error-only row always has `failureOf`, and names its owner (sequenceId, assetId or editId) so the
 * status summary can drop it once that owner is deleted.
 */
export interface UnseenContext {
  sequenceId?: string
  storyboardId?: string
  boardId?: string
  segmentId?: string
  slot?: SegmentImageSlot
  assetId?: string
  editId?: string
  failureOf?: 'still' | 'export' | 'run'
  /** A picture's dialog key (StillParams.workToken), so the open dialog can find its own failure. */
  workToken?: string
}

/** A row to add: exactly one item id, or none and then `error` and `label` (a failure with no row of its own). */
export interface UnseenInput {
  generationId?: string
  stillId?: string
  exportId?: string
  audioId?: string
  jobId?: string
  /** Swedish. */
  error?: string
  /** Swedish, the label at the time it failed. */
  label?: string
  context?: UnseenContext
  /** When it finished (epoch ms); default now. */
  at?: number
}

const UNSEEN_ITEM_COLUMNS = [
  ['generationId', 'generation_id'],
  ['stillId', 'still_id'],
  ['exportId', 'export_id'],
  ['audioId', 'audio_id'],
  ['jobId', 'job_id']
] as const satisfies readonly (readonly [keyof UnseenInput, string])[]

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The context as stored: known fields with usable values only. */
function unseenContextJson(context: UnseenContext | undefined): string {
  if (!context || typeof context !== 'object') return '{}'
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(context)) {
    if (nonEmpty(value)) out[key] = value
  }
  return JSON.stringify(out)
}

/**
 * Records finished work the user hasn't looked at yet (a row of `unseen`). An item that already has a row keeps it
 * (INSERT OR IGNORE: a video settling twice is announced once). Bookkeeping must never break the work it announces,
 * so nothing is thrown: a malformed input, an item that is already gone (the foreign key) or no open library is only
 * logged.
 */
export function addUnseen(input: UnseenInput): void {
  try {
    if (!db) return
    if (!input || typeof input !== 'object') throw new Error('no input')
    const items = UNSEEN_ITEM_COLUMNS.filter(([key]) => nonEmpty(input[key]))
    if (items.length > 1) throw new Error('more than one item')
    if (!items.length && !(nonEmpty(input.error) && nonEmpty(input.label))) {
      throw new Error('an error-only row needs an error and a label')
    }
    const values: Record<string, string | number | null> = {
      id: randomUUID(),
      generation_id: null,
      still_id: null,
      export_id: null,
      audio_id: null,
      job_id: null,
      // Ids only, never paths (an error may quote ffmpeg, which names files by their full paths).
      error: nonEmpty(input.error) ? withoutLocalPaths(input.error) : null,
      label: nonEmpty(input.label) ? input.label : null,
      context: unseenContextJson(input.context),
      created_at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now()
    }
    for (const [key, column] of items) values[column] = input[key] as string
    db.prepare(
      `INSERT OR IGNORE INTO unseen (id, generation_id, still_id, export_id, audio_id, job_id, error, label, context,
         created_at)
       VALUES (@id, @generation_id, @still_id, @export_id, @audio_id, @job_id, @error, @label, @context, @created_at)`
    ).run(values)
  } catch (err) {
    console.warn('Could not record unseen work:', err)
  }
}

// ── Stored path maintenance ──────────────────────────────────────────────────

/** The reference audio paths of params (entries that aren't { path } objects give undefined). */
function audioPaths(p: Partial<GenerationParams>): unknown[] {
  if (!Array.isArray(p.referenceAudios)) return []
  return p.referenceAudios.map((a: unknown) => (a && typeof a === 'object' ? (a as { path?: unknown }).path : a))
}

/**
 * The start/end/reference image paths, reference audio paths and source/reference video paths in a params JSON
 * string: generation and segment params, and a still's params (whose reference images are the only paths in it).
 */
function paramFilePaths(json: string): string[] {
  try {
    const p = JSON.parse(json) as Partial<GenerationParams> | null
    if (!p || typeof p !== 'object') return []
    const refs = Array.isArray(p.referenceImages) ? p.referenceImages : []
    const videos = Array.isArray(p.referenceVideos) ? p.referenceVideos : []
    return [p.startImage, p.endImage, ...refs, ...audioPaths(p), p.sourceVideo, ...videos].filter(
      (v): v is string => typeof v === 'string' && v !== ''
    )
  } catch {
    return []
  }
}

/**
 * Whether a row records this stored path (letter case ignored, like the disk): a generation's file or original
 * (an import's untouched copy), an export, asset image, asset audio, edit media or still file, a storyboard
 * board's image, or an image, audio clip or video in generation, segment or still params. A row
 * whose file was deleted in Finder still claims its name: a new file given that name would otherwise be taken
 * for the old row's file — deleting that row would take the new file with it, and an old generation or clip
 * whose picture was removed would silently use somebody else's picture on "Använd igen" or a regenerated take.
 * `ignoreStillId`: that still's own row doesn't count (is anything else using the still's file?).
 */
export function isStoredPathRecorded(stored: string, opts: { ignoreStillId?: string } = {}): boolean {
  if (!db || !stored) return false
  const ignore = opts.ignoreStillId ?? null
  const recorded = db
    .prepare(
      `SELECT 1 FROM generations WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM generations WHERE original_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM exports WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM asset_images WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM asset_audio WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM edit_media WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM stills WHERE file_path = @p COLLATE NOCASE AND (@i IS NULL OR id != @i)
       UNION ALL SELECT 1 FROM storyboard_boards WHERE image_path = @p COLLATE NOCASE
       LIMIT 1`
    )
    .get({ p: stored, i: ignore })
  if (recorded) return true
  // Params are JSON: find candidate rows by the path as it is written there, then compare exactly.
  const key = fold(stored)
  const needle = fold(JSON.stringify(stored).slice(1, -1))
  const candidates = db
    .prepare(
      `SELECT params FROM generations WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM segments WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM stills WHERE instr(studio_fold(params), @n) > 0 AND (@i IS NULL OR id != @i)`
    )
    .pluck()
    .all({ n: needle, i: ignore }) as string[]
  return candidates.some((json) => paramFilePaths(json).some((p) => fold(p) === key))
}

/**
 * Whether a row records a stored path inside this folder (letter case ignored, like the disk); see
 * isStoredPathRecorded. A folder that is gone (a deleted asset's folder in the Trash) still claims its name
 * while a generation or clip records a path in it: an asset folder renamed or created under that name would
 * otherwise hand those rows its own photos of the same names, and "Använd igen" or a regenerated clip would
 * silently send the wrong picture.
 */
export function isStoredPrefixRecorded(folder: string): boolean {
  const clean = typeof folder === 'string' ? folder.replace(/\/+$/, '') : ''
  if (!db || !clean) return false
  const prefix = `${fold(clean)}/`
  const recorded = db
    .prepare(
      `SELECT 1 FROM generations WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM generations WHERE instr(studio_fold(original_path), @p) = 1
       UNION ALL SELECT 1 FROM exports WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM asset_images WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM asset_audio WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM edit_media WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM stills WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM storyboard_boards WHERE instr(studio_fold(image_path), @p) = 1
       LIMIT 1`
    )
    .get({ p: prefix })
  if (recorded) return true
  const needle = fold(JSON.stringify(prefix).slice(1, -1))
  const candidates = db
    .prepare(
      `SELECT params FROM generations WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM segments WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM stills WHERE instr(studio_fold(params), @n) > 0`
    )
    .pluck()
    .all({ n: needle }) as string[]
  return candidates.some((json) => paramFilePaths(json).some((p) => fold(p).startsWith(prefix)))
}

/**
 * Every stored path in the library database (files, originals, posters, params images, audio and videos, asset
 * files, edit media, stills, board images, exports).
 */
export function listStoredPaths(): string[] {
  const paths: string[] = []
  mapStoredPaths((p) => {
    paths.push(p)
    return p
  })
  return paths
}

/**
 * Applies map to the image, audio and video paths in a params JSON string (generation, segment or still params);
 * returns undefined when nothing changed.
 */
function mapParamsJson(json: string, map: (stored: string) => string): string | undefined {
  let p: GenerationParams
  try {
    p = JSON.parse(json) as GenerationParams
  } catch {
    return undefined
  }
  if (!p || typeof p !== 'object') return undefined
  let changed = false
  const one = (v: unknown): unknown => {
    if (typeof v !== 'string' || !v) return v
    const next = map(v)
    if (next !== v) changed = true
    return next
  }
  const out = { ...p }
  if ('startImage' in out) out.startImage = one(out.startImage) as string | undefined
  if ('endImage' in out) out.endImage = one(out.endImage) as string | undefined
  if (Array.isArray(out.referenceImages)) out.referenceImages = out.referenceImages.map(one) as string[]
  if (Array.isArray(out.referenceAudios)) {
    out.referenceAudios = out.referenceAudios.map((a: unknown) => {
      if (!a || typeof a !== 'object') return a
      const path = (a as { path?: unknown }).path
      const next = one(path)
      return next === path ? a : { ...a, path: next }
    }) as GenerationParams['referenceAudios']
  }
  if ('sourceVideo' in out) out.sourceVideo = one(out.sourceVideo) as string | undefined
  if (Array.isArray(out.referenceVideos)) out.referenceVideos = out.referenceVideos.map(one) as string[]
  return changed ? JSON.stringify(out) : undefined
}

/**
 * Runs map over every stored path in the library database (generation files, originals, posters and params,
 * segment params, asset images and audio, edit media, stills and the reference images in their params, storyboard
 * board images, exports) in one transaction and writes back what changed. `contains`, when given, skips rows that can't hold a
 * matching path. `onGeneration` hears the id of every generation changed. Returns the number of rows changed.
 */
export function mapStoredPaths(
  map: (stored: string) => string,
  contains?: string,
  onGeneration?: (id: string) => void
): number {
  const conn = getDb()
  const like = contains === undefined ? undefined : JSON.stringify(contains).slice(1, -1)
  const hit = (v: string | null): boolean => !!v && (like === undefined || v.includes(contains!) || v.includes(like))
  const mapPath = (v: string | null): string | null => (v ? map(v) : v)
  let changed = 0

  conn.transaction(() => {
    const generations = conn
      .prepare('SELECT id, file_path, thumb_path, params, original_path FROM generations')
      .all() as Pick<GenerationRow, 'id' | 'file_path' | 'thumb_path' | 'params' | 'original_path'>[]
    const updateGeneration = conn.prepare(
      'UPDATE generations SET file_path = ?, thumb_path = ?, params = ?, original_path = ? WHERE id = ?'
    )
    for (const r of generations) {
      if (!hit(r.file_path) && !hit(r.thumb_path) && !hit(r.params) && !hit(r.original_path)) continue
      const file = mapPath(r.file_path)
      const thumb = mapPath(r.thumb_path)
      const original = mapPath(r.original_path)
      const params = hit(r.params) ? mapParamsJson(r.params, map) : undefined
      if (file === r.file_path && thumb === r.thumb_path && original === r.original_path && params === undefined) {
        continue
      }
      updateGeneration.run(file, thumb, params ?? r.params, original, r.id)
      onGeneration?.(r.id)
      changed++
    }

    const segments = conn.prepare('SELECT id, params FROM segments').all() as { id: string; params: string }[]
    const updateSegment = conn.prepare('UPDATE segments SET params = ? WHERE id = ?')
    for (const r of segments) {
      if (!hit(r.params)) continue
      const params = mapParamsJson(r.params, map)
      if (params === undefined) continue
      updateSegment.run(params, r.id)
      changed++
    }

    for (const table of ['asset_images', 'asset_audio', 'exports', 'edit_media']) {
      const rows = conn.prepare(`SELECT id, file_path FROM ${table}`).all() as { id: string; file_path: string }[]
      const update = conn.prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`)
      for (const r of rows) {
        if (!hit(r.file_path)) continue
        const file = map(r.file_path)
        if (file === r.file_path) continue
        update.run(file, r.id)
        changed++
      }
    }

    // A still's own file, and the reference images it was made from (its "Skapa igen" sends them again).
    const stills = conn.prepare('SELECT id, file_path, params FROM stills').all() as {
      id: string
      file_path: string
      params: string
    }[]
    const updateStill = conn.prepare('UPDATE stills SET file_path = ?, params = ? WHERE id = ?')
    for (const r of stills) {
      if (!hit(r.file_path) && !hit(r.params)) continue
      const file = hit(r.file_path) ? map(r.file_path) : r.file_path
      const params = hit(r.params) ? mapParamsJson(r.params, map) : undefined
      if (file === r.file_path && params === undefined) continue
      updateStill.run(file, params ?? r.params, r.id)
      rewrittenStills = true
      changed++
    }

    // A board's image: a still or a library photo used where it is, which must follow it when it moves (its
    // transitions' params, which hold the same path, are rewritten above).
    const boards = conn
      .prepare('SELECT id, image_path FROM storyboard_boards WHERE image_path IS NOT NULL')
      .all() as { id: string; image_path: string }[]
    const updateBoard = conn.prepare('UPDATE storyboard_boards SET image_path = ? WHERE id = ?')
    for (const r of boards) {
      if (!hit(r.image_path)) continue
      const file = map(r.image_path)
      if (file === r.image_path) continue
      updateBoard.run(file, r.id)
      changed++
    }
  })()
  return changed
}

/** Set when a rewrite has changed a still's paths since takeRewrittenStills was last called. */
let rewrittenStills = false

/**
 * Whether prefix rewrites (or "Städa upp", relativizing on open) have changed stills' paths since the last call:
 * the storyboard's stills strip holds their old paths until it is told to fetch them again.
 */
export function takeRewrittenStills(): boolean {
  const changed = rewrittenStills
  rewrittenStills = false
  return changed
}

function cleanRelative(p: string): string {
  return p.normalize('NFC').replace(/^\.\/+/, '').replace(/\/+$/, '')
}

/** stored under `to` instead of `from` when it is from or lies below it (relative paths only). */
function rebasePrefix(stored: string, from: string, to: string): string {
  if (isAbsolute(stored)) return stored
  const p = stored.normalize('NFC')
  if (p === from) return to
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
  return stored
}

/** Recent prefix rewrites, numbered; see followRewrites. */
const rewriteLog: { seq: number; from: string; to: string }[] = []
let rewriteSeq = 0
const REWRITE_LOG_SIZE = 500

/** Generations whose stored paths a prefix rewrite changed and that the windows haven't been sent again. */
const rewrittenGenerations = new Set<string>()

/**
 * The generations prefix rewrites have changed since the last call (their file, poster, or the image and audio
 * paths in their params), for the windows to be sent again: an asset renamed by an agent while the clip feed is
 * open would otherwise leave the feed filtering by, showing and reusing the old paths. An id whose rewrite was
 * rolled back is harmless: the row is merely sent as it is.
 */
export function takeRewrittenGenerations(): string[] {
  const ids = [...rewrittenGenerations]
  rewrittenGenerations.clear()
  return ids
}

/**
 * Rewrites every stored relative path equal to or under oldRel to the same place under newRel: generations
 * (file_path, thumb_path, original_path, params incl. reference audio and source/reference videos),
 * segments.params, asset_images.file_path, asset_audio.file_path, edit_media.file_path, stills (file_path, the
 * reference images in params), storyboard_boards.image_path, exports.file_path.
 */
export function rewriteStoredPrefix(oldRel: string, newRel: string): number {
  const from = cleanRelative(oldRel)
  const to = cleanRelative(newRel)
  if (!from || !to || isAbsolute(from) || isAbsolute(to)) throw new Error('Ogiltig sökväg i biblioteket.')
  if (from === to) return 0
  const changed = mapStoredPaths(
    (stored) => rebasePrefix(stored, from, to),
    from,
    (id) => rewrittenGenerations.add(id)
  )
  rewriteLog.push({ seq: ++rewriteSeq, from, to })
  if (rewriteLog.length > REWRITE_LOG_SIZE) rewriteLog.shift()
  return changed
}

/** Marks the rewrites so far; pass it to followRewrites later. */
export function rewriteMark(): number {
  return rewriteSeq
}

/**
 * Params held in memory across a long await (a submit uploading its pictures) miss the rewrites done
 * meanwhile, e.g. an asset renamed and its folder with it. Image, audio and video paths whose file is gone are
 * carried along the rewrites made since `mark`, when that leads to an existing file; anything else stays as
 * it is.
 */
export function followRewrites(params: GenerationParams, mark: number): GenerationParams {
  const since = rewriteLog.filter((r) => r.seq > mark)
  if (!since.length) return params
  const follow = (path: string | undefined): string | undefined => {
    if (!path || !isAbsolute(path) || existsSync(path)) return path
    const stored = toStoredPath(path)
    if (isAbsolute(stored)) return path
    const moved = since.reduce((p, r) => rebasePrefix(p, r.from, r.to), stored)
    if (moved === stored) return path
    const next = fromStoredPath(moved)
    return existsSync(next) ? next : path
  }
  const result: GenerationParams = {
    ...params,
    startImage: follow(params.startImage),
    endImage: follow(params.endImage),
    referenceImages: params.referenceImages?.map((r) => follow(r) ?? r)
  }
  if (Array.isArray(params.referenceAudios)) {
    result.referenceAudios = params.referenceAudios.map((a) =>
      a && typeof a === 'object' && typeof a.path === 'string' ? { ...a, path: follow(a.path) ?? a.path } : a
    )
  }
  // An edit's proxy in Underlag/ follows its folder when the edit is renamed while the take is being sent.
  if (typeof params.sourceVideo === 'string') result.sourceVideo = follow(params.sourceVideo)
  if (Array.isArray(params.referenceVideos)) {
    result.referenceVideos = params.referenceVideos.map((v) => (typeof v === 'string' ? (follow(v) ?? v) : v))
  }
  return result
}

/**
 * Brings stored paths into the form for the open library: absolute paths inside its folders become
 * relative (libraries from before relative paths stored absolute ones), and relative paths outside its
 * folders become absolute again (an earlier build made anything under the base folder relative, which a
 * move would break, since only the library's folders move). Cheap and idempotent; runs on every open.
 */
export function relativizeStoredPaths(): number {
  return mapStoredPaths((stored) => {
    if (isAbsolute(stored)) return isInsideRoot(stored) ? toStoredPath(stored) : stored
    return isLibraryRelative(stored) ? stored : fromStoredPath(stored)
  })
}
