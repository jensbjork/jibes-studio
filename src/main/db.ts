import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import type { Generation, GenerationParams, GenerationStatus } from '@shared/types'
import {
  fromStoredParams,
  fromStoredPath,
  isInsideRoot,
  isLibraryRelative,
  LIBRARY_NOT_READY,
  toStoredParams,
  toStoredPath
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
  CREATE INDEX assets_by_kind ON assets(kind);`
]


/**
 * The user_version from which a library has assets (the migration above): from then on Miljöer and Kläder in
 * the base folder are the library's own folders.
 */
export const ASSETS_SCHEMA_VERSION = 6

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
}

/** A generation with absolute paths (the conversion to and from the stored form happens here). */
export interface StoredGeneration extends Generation {
  downloadUrl?: string
}

export function generationFromRow(r: GenerationRow): StoredGeneration {
  return {
    id: r.id,
    createdAt: r.created_at,
    model: r.model,
    prompt: r.prompt,
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
    videoDuration: r.video_duration ?? undefined
  }
}

const storedPathOrNull = (p: string | undefined | null): string | null => (p ? toStoredPath(p) : null)

export function insertGeneration(g: StoredGeneration): void {
  getDb()
    .prepare(
      `INSERT INTO generations (id, created_at, model, prompt, params, status, queue_id, download_url, file_path,
         error, quote, average_execution_time, execution_duration, completed_at, segment_id, thumb_path,
         video_duration)
       VALUES (@id, @createdAt, @model, @prompt, @params, @status, @queueId, @downloadUrl, @filePath, @error,
         @quote, @averageExecutionTime, @executionDuration, @completedAt, @segmentId, @thumbPath, @videoDuration)`
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
      videoDuration: g.videoDuration ?? null
    })
}

/** Patchable fields → column, and how a value is written. */
const columns: Record<string, { column: string; store?: (v: unknown) => unknown }> = {
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
  params: { column: 'params', store: (v) => JSON.stringify(toStoredParams(v as GenerationParams)) }
}

/** Callers pass absolute paths; they are stored relative to the library when inside it. */
export function updateGeneration(id: string, patch: Partial<StoredGeneration>): StoredGeneration {
  const entries = Object.entries(patch).filter(([k, v]) => k in columns && !(k === 'params' && v == null))
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

export function listPendingGenerations(): StoredGeneration[] {
  return (
    getDb().prepare(`SELECT * FROM generations WHERE status IN ('queued', 'processing')`).all() as GenerationRow[]
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

// ── Stored path maintenance ──────────────────────────────────────────────────

/** The start/end/reference image paths in a params JSON string. */
function paramImagePaths(json: string): string[] {
  try {
    const p = JSON.parse(json) as Partial<GenerationParams> | null
    if (!p || typeof p !== 'object') return []
    const refs = Array.isArray(p.referenceImages) ? p.referenceImages : []
    return [p.startImage, p.endImage, ...refs].filter((v): v is string => typeof v === 'string' && v !== '')
  } catch {
    return []
  }
}

/**
 * Whether a row records this stored path (letter case ignored, like the disk): a generation, export or
 * asset image file, or an image in generation or segment params. A row whose file was deleted in Finder
 * still claims its name: a new file given that name would otherwise be taken for the old row's file —
 * deleting that row would take the new file with it, and an old generation or clip whose picture was
 * removed would silently use somebody else's picture on "Använd igen" or a regenerated take.
 */
export function isStoredPathRecorded(stored: string): boolean {
  if (!db || !stored) return false
  const recorded = db
    .prepare(
      `SELECT 1 FROM generations WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM exports WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM asset_images WHERE file_path = @p COLLATE NOCASE
       LIMIT 1`
    )
    .get({ p: stored })
  if (recorded) return true
  // Params are JSON: find candidate rows by the path as it is written there, then compare exactly.
  const key = fold(stored)
  const needle = fold(JSON.stringify(stored).slice(1, -1))
  const candidates = db
    .prepare(
      `SELECT params FROM generations WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM segments WHERE instr(studio_fold(params), @n) > 0`
    )
    .pluck()
    .all({ n: needle }) as string[]
  return candidates.some((json) => paramImagePaths(json).some((p) => fold(p) === key))
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
       UNION ALL SELECT 1 FROM exports WHERE instr(studio_fold(file_path), @p) = 1
       UNION ALL SELECT 1 FROM asset_images WHERE instr(studio_fold(file_path), @p) = 1
       LIMIT 1`
    )
    .get({ p: prefix })
  if (recorded) return true
  const needle = fold(JSON.stringify(prefix).slice(1, -1))
  const candidates = db
    .prepare(
      `SELECT params FROM generations WHERE instr(studio_fold(params), @n) > 0
       UNION ALL SELECT params FROM segments WHERE instr(studio_fold(params), @n) > 0`
    )
    .pluck()
    .all({ n: needle }) as string[]
  return candidates.some((json) => paramImagePaths(json).some((p) => fold(p).startsWith(prefix)))
}

/** Every stored path in the library database (files, posters, params images, asset images, exports). */
export function listStoredPaths(): string[] {
  const paths: string[] = []
  mapStoredPaths((p) => {
    paths.push(p)
    return p
  })
  return paths
}

/** Applies map to the image paths in a params JSON string; returns undefined when nothing changed. */
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
  return changed ? JSON.stringify(out) : undefined
}

/**
 * Runs map over every stored path in the library database (generation files, posters and params, segment
 * params, asset images, exports) in one transaction and writes back what changed. `contains`, when
 * given, skips rows that can't hold a matching path. Returns the number of rows changed.
 */
export function mapStoredPaths(map: (stored: string) => string, contains?: string): number {
  const conn = getDb()
  const like = contains === undefined ? undefined : JSON.stringify(contains).slice(1, -1)
  const hit = (v: string | null): boolean => !!v && (like === undefined || v.includes(contains!) || v.includes(like))
  const mapPath = (v: string | null): string | null => (v ? map(v) : v)
  let changed = 0

  conn.transaction(() => {
    const generations = conn.prepare('SELECT id, file_path, thumb_path, params FROM generations').all() as Pick<
      GenerationRow,
      'id' | 'file_path' | 'thumb_path' | 'params'
    >[]
    const updateGeneration = conn.prepare(
      'UPDATE generations SET file_path = ?, thumb_path = ?, params = ? WHERE id = ?'
    )
    for (const r of generations) {
      if (!hit(r.file_path) && !hit(r.thumb_path) && !hit(r.params)) continue
      const file = mapPath(r.file_path)
      const thumb = mapPath(r.thumb_path)
      const params = hit(r.params) ? mapParamsJson(r.params, map) : undefined
      if (file === r.file_path && thumb === r.thumb_path && params === undefined) continue
      updateGeneration.run(file, thumb, params ?? r.params, r.id)
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

    for (const table of ['asset_images', 'exports']) {
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
  })()
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

/**
 * Rewrites every stored relative path equal to or under oldRel to the same place under newRel: generations
 * (file_path, thumb_path, params), segments.params, asset_images.file_path, exports.file_path.
 */
export function rewriteStoredPrefix(oldRel: string, newRel: string): number {
  const from = cleanRelative(oldRel)
  const to = cleanRelative(newRel)
  if (!from || !to || isAbsolute(from) || isAbsolute(to)) throw new Error('Ogiltig sökväg i biblioteket.')
  if (from === to) return 0
  const changed = mapStoredPaths((stored) => rebasePrefix(stored, from, to), from)
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
 * meanwhile, e.g. an asset renamed and its folder with it. Image paths whose file is gone are carried
 * along the rewrites made since `mark`, when that leads to an existing file; anything else stays as it is.
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
  return {
    ...params,
    startImage: follow(params.startImage),
    endImage: follow(params.endImage),
    referenceImages: params.referenceImages?.map((r) => follow(r) ?? r)
  }
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
