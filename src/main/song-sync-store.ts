// Where the takes of song clips sing, as song-sync.ts measured them: the library's `.studio/song-sync.json`. Per take
// (generation id) its TakeSongSync and the place in the song it was measured against; per clip (segment id) the take
// whose trims song-sync last set, the start trim it set and the nudge each take has had there, so a trim the user
// changed since (a nudge) is told apart from a place that moved. A file of the library rather than columns of its
// database: no schema change, it goes along with the library, and a lost file only means measuring again. Written whole
// through a temp file; takes and clips that no longer exist are left out at every write.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Segment, TakeSongSync } from '@shared/types'
import * as db from './db'
import { FOLDERS, isLibraryReady, libraryRoot } from './paths'

const SYNC_FILE = 'song-sync.json'

/** A take's measurement, with the place in the song (seconds) it was measured against and when. */
export interface MeasuredSync extends TakeSongSync {
  start: number
  end: number
  at: number
}

/** What song-sync last did to a clip's trims (see song-sync.ts reconcile). */
export interface ClipCut {
  /** The take selected then. */
  take: string
  /** The start trim it set. */
  trimStart: number
  /** Seconds each take of the clip has been nudged from where its singing was measured (by take id). */
  nudges: Record<string, number>
}

interface SyncFile {
  version: 1
  takes: Record<string, MeasuredSync>
  clips: Record<string, ClipCut>
}

let cache: { root: string; data: SyncFile } | undefined

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A measurement as stored, or undefined when it isn't one. */
function cleanSync(v: unknown): MeasuredSync | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Partial<MeasuredSync>
  if (!finite(s.offset) || !finite(s.score) || !finite(s.start) || !finite(s.end)) return undefined
  return {
    offset: Math.max(0, s.offset),
    score: Math.min(1, Math.max(0, s.score)),
    matched: s.matched === true,
    measured: s.measured === 'vocals' ? 'vocals' : 'none',
    start: s.start,
    end: s.end,
    at: finite(s.at) ? s.at : 0
  }
}

function cleanCut(v: unknown): ClipCut | undefined {
  if (!v || typeof v !== 'object') return undefined
  const c = v as Partial<ClipCut>
  if (typeof c.take !== 'string' || !c.take || !finite(c.trimStart)) return undefined
  const nudges: Record<string, number> = {}
  for (const [id, n] of Object.entries(c.nudges ?? {})) if (finite(n)) nudges[id] = n
  return { take: c.take, trimStart: c.trimStart, nudges }
}

/** The open library's file, read once per library (an unreadable one counts as empty: measuring again restores it). */
function load(): SyncFile | undefined {
  if (!isLibraryReady()) return undefined
  const root = libraryRoot()
  if (cache?.root === root) return cache.data
  const data: SyncFile = { version: 1, takes: {}, clips: {} }
  const file = join(root, FOLDERS.appData, SYNC_FILE)
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncFile>
      for (const [id, s] of Object.entries(parsed.takes ?? {})) {
        const clean = cleanSync(s)
        if (clean) data.takes[id] = clean
      }
      for (const [id, c] of Object.entries(parsed.clips ?? {})) {
        const clean = cleanCut(c)
        if (clean) data.clips[id] = clean
      }
    } catch (err) {
      console.warn('The song sync file could not be read; takes are measured again when needed:', err)
    }
  }
  cache = { root, data }
  return data
}

/** The ids among `ids` that `table` still has. */
function existing(table: 'generations' | 'segments', ids: string[]): Set<string> {
  const found = new Set<string>()
  const conn = db.getDb()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = conn
      .prepare(`SELECT id FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .pluck()
      .all(...chunk) as string[]
    for (const id of rows) found.add(id)
  }
  return found
}

/** Written to a temp file and renamed, so a crash mid-write can't leave half a file; gone takes and clips left out. */
function save(data: SyncFile): void {
  const clips = existing('segments', Object.keys(data.clips))
  for (const id of Object.keys(data.clips)) if (!clips.has(id)) delete data.clips[id]
  const nudged = Object.values(data.clips).flatMap((c) => Object.keys(c.nudges))
  const takes = existing('generations', [...new Set([...Object.keys(data.takes), ...nudged])])
  for (const id of Object.keys(data.takes)) if (!takes.has(id)) delete data.takes[id]
  for (const cut of Object.values(data.clips)) {
    for (const id of Object.keys(cut.nudges)) if (!takes.has(id)) delete cut.nudges[id]
  }
  const file = join(libraryRoot(), FOLDERS.appData, SYNC_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/** The take's measurement, if it has been measured. */
export function takeSync(generationId: string): MeasuredSync | undefined {
  return load()?.takes[generationId]
}

/** Records a take's measurement. Bookkeeping: a failure is logged, never thrown into the work it follows. */
export function setTakeSync(generationId: string, sync: MeasuredSync): void {
  try {
    const data = load()
    if (!data) return
    data.takes[generationId] = sync
    save(data)
  } catch (err) {
    console.warn(`Could not record where take ${generationId} sings:`, err)
  }
}

/** What song-sync last did to the clip's trims. */
export function clipCut(segmentId: string): ClipCut | undefined {
  return load()?.clips[segmentId]
}

/** Records what song-sync did to these clips' trims (see clipCut); never throws. */
export function setClipCuts(cuts: ReadonlyMap<string, ClipCut>): void {
  if (!cuts.size) return
  try {
    const data = load()
    if (!data) return
    for (const [id, cut] of cuts) data.clips[id] = cut
    save(data)
  } catch (err) {
    console.warn('Could not record the trims of song clips:', err)
  }
}

/** Segment.songSyncs: each measured take of the segments, as the window and the agents read it. Never throws. */
export function attachSongSyncs(segments: Segment[]): void {
  let data: SyncFile | undefined
  try {
    data = load()
  } catch {
    return
  }
  if (!data || !Object.keys(data.takes).length) return
  for (const segment of segments) {
    const syncs: Record<string, TakeSongSync> = {}
    for (const take of segment.takes) {
      const s = data.takes[take.id]
      if (s) syncs[take.id] = { offset: s.offset, score: s.score, matched: s.matched, measured: s.measured }
    }
    if (Object.keys(syncs).length) segment.songSyncs = syncs
  }
}
