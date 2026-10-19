import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { generationTitle } from '@shared/generation-label'
import { pathKey } from '@shared/generation-filter'
import type { ExportSummary, Generation } from '@shared/types'
import { ipcErrorMessage } from '../../lib/hooks'
import type { VideoFacts } from './videoRefs'

// What the window knows about the video files a form uses as references: how long each lasts (for the window
// editor and the limits) and what it is (a clip from Media, a take, an exported film, a file from disk), for the
// labels. One store for the whole window, filled by the pickers when a video is added (they know both) and, for
// videos that come from saved params ("Use again", a clip, an agent), from the library's records and – for anything
// else – by measuring the file once (probeReferenceVideo: ffprobe in main, free).

const facts = new Map<string, VideoFacts>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What a picker knows about a video it adds; merged with what is known already. */
export function rememberVideoFacts(path: string, known: VideoFacts): void {
  const was = facts.get(path)
  const next = { ...was, ...Object.fromEntries(Object.entries(known).filter(([, v]) => v !== undefined)) }
  if (was && JSON.stringify(was) === JSON.stringify(next)) return
  facts.set(path, next)
  emit()
}

/** A generation as a video's facts: a take (named by its clip when `takeName` is given), else a clip from Media. */
export function generationVideoFacts(g: Generation, takeName?: string): VideoFacts {
  return {
    duration: g.videoDuration,
    origin: g.segmentId ? 'take' : 'clip',
    name: takeName ?? generationTitle(g, 60),
    thumbPath: g.thumbPath
  }
}

/** An exported film as a video's facts. */
export function exportVideoFacts(e: ExportSummary): VideoFacts {
  return { duration: e.duration, origin: 'film', name: e.sequenceName ? `“${e.sequenceName}”` : 'Exported film' }
}

// ── Looking up what isn't known ──────────────────────────────────────────────

/** The library's records by path: read once, again when a path wasn't found and a while has passed. */
let records: Promise<Map<string, VideoFacts>> | undefined
let recordsAt = 0
const RECORDS_MAX_AGE_MS = 30_000

function libraryRecords(fresh: boolean): Promise<Map<string, VideoFacts>> {
  if (!records || (fresh && Date.now() - recordsAt > RECORDS_MAX_AGE_MS)) {
    recordsAt = Date.now()
    records = Promise.all([
      window.studio.listGenerations().catch(() => [] as Generation[]),
      window.studio.listExports().catch(() => [] as ExportSummary[])
    ]).then(([generations, exports]) => {
      const map = new Map<string, VideoFacts>()
      for (const g of generations) {
        if (g.filePath && g.status === 'completed') map.set(pathKey(g.filePath), generationVideoFacts(g))
      }
      for (const e of exports) map.set(pathKey(e.path), exportVideoFacts(e))
      return map
    })
  }
  return records
}

/** Paths being looked up, so a path is measured once however many forms show it. */
const pending = new Set<string>()

/** Fills in the facts of paths that have none (or no duration): the library's records, then a measurement. */
async function lookUp(paths: readonly string[]): Promise<void> {
  const wanted = paths.filter((p) => !pending.has(p) && facts.get(p)?.duration === undefined && !facts.get(p)?.error)
  if (!wanted.length) return
  for (const p of wanted) pending.add(p)
  try {
    let found = await libraryRecords(false)
    if (wanted.some((p) => !found.has(pathKey(p)))) found = await libraryRecords(true)
    const unmeasured: string[] = []
    for (const p of wanted) {
      const hit = found.get(pathKey(p))
      // What a picker said about it wins; the records fill in the rest.
      if (hit) rememberVideoFacts(p, { ...hit, ...facts.get(p) })
      if (facts.get(p)?.duration === undefined) unmeasured.push(p)
    }
    if (!unmeasured.length) return
    await Promise.all(unmeasured.map((p) => measureOne(p)))
  } finally {
    for (const p of wanted) pending.delete(p)
  }
}

/** Measures one file (main's probe: ffprobe, free) and remembers its length, or why it can't be used. */
async function measureOne(path: string): Promise<VideoFacts> {
  try {
    const info = await window.studio.probeReferenceVideo(path)
    // Readable now (a file put back in place): an earlier refusal no longer stands.
    const was = facts.get(path)
    if (was?.error) {
      const { error: _, ...rest } = was
      facts.set(path, rest)
    }
    rememberVideoFacts(path, { duration: info.duration, ...(facts.get(path)?.origin ? {} : { origin: 'file' }) })
  } catch (e) {
    rememberVideoFacts(path, { error: ipcErrorMessage(e) })
  }
  return facts.get(path) ?? {}
}

/**
 * Measures files picked from disk before they are added: their length (and whether they are videos Studio can read).
 * The answer is remembered, so the form shows it at once.
 */
export async function measureVideos(paths: readonly string[]): Promise<Map<string, VideoFacts>> {
  const out = new Map<string, VideoFacts>()
  for (const p of paths) out.set(p, await measureOne(p))
  return out
}

/** The facts of these paths, kept current; what isn't known yet is looked up once. */
export function useVideoFacts(paths: readonly string[]): ReadonlyMap<string, VideoFacts> {
  const v = useSyncExternalStore(subscribe, () => version, () => version)
  const key = paths.join('\n')
  useEffect(() => {
    if (paths.length) void lookUp(paths)
  }, [key])
  return useMemo(() => new Map(paths.flatMap((p) => (facts.has(p) ? [[p, facts.get(p)!] as const] : []))), [key, v])
}

/** The facts known now (no lookup), for code outside React. */
export function videoFactsNow(): ReadonlyMap<string, VideoFacts> {
  return facts
}
