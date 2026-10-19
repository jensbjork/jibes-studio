// Where a take of a song clip sings (TakeSongSync), and the cut that follows from it. A clip that hears the song's
// vocals is made a little longer than its place (SONG_HEADROOM_SECONDS), and the model may start singing a moment
// late: when the take finishes, its sung voice (separated on this Mac, free, else its whole sound) is laid against the
// song's vocals over the place the take was made for, by their loudness envelopes, and the lag where they match best
// says where in the take that place begins. The cut then starts the take there and keeps exactly the clip's place
// (shared/song-trims.ts), also when the place moves later or the user nudges it. Measurements and what was done to each
// clip's trims are kept in the library's .studio/song-sync.json (song-sync-store.ts).

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { sanitizeSongWindow } from '@shared/song'
import { MAX_SONG_WINDOW_SECONDS, windowLength } from '@shared/song-window'
import { songCut, songTrimBase } from '@shared/song-trims'
import type { Generation, SequenceSong, SongWindow, TakeSongSync } from '@shared/types'
import * as db from './db'
import { decodeSamples, extractAudio, MIX_RATE } from './ffmpeg'
import type { JobManager } from './jobs'
import { tmpDir } from './paths'
import * as store from './sequence-store'
import type { SequenceService } from './sequences'
import { clipCut, setClipCuts, setTakeSync, takeSync, type ClipCut } from './song-sync-store'
import { separateStems, separationStatus } from './voice-separation'

/** Envelopes are made at 16 kHz mono: plenty for loudness every 5 ms. */
const RATE = 16_000
/** 5 ms per envelope step; the best lag is refined between steps, so the offset is good to a millisecond or two. */
const HOP = 80
/** Singing may start this much before the take does (its first syllable cut off): the offset is then 0. */
const EARLY_SECONDS = 0.25
/** Quieter than this many dB under its loudest moment, an envelope is floored: noise and silence weigh the same. */
const FLOOR_DB = 40
/** A sound whose loudest 5 ms stay under this (about −80 dBFS) has no singing at all. */
const SILENT_RMS = 1e-4
/** The take and the place must overlap at least this share of the place for a lag to count. */
const MIN_OVERLAP = 0.6
/**
 * The correlation (Pearson, of the log envelopes) a take's voice must reach with the song's vocals to count as singing
 * them. Tuned on the phase-23 fixtures (a synthetic 40 s song with four spoken lines), separation on: the vocals
 * themselves, however late and also through the reference MP3, score 0.99–1.00 (offset within 1 ms), the whole mix
 * sung over 0.86–0.89 (within 10 ms), the same words in another voice and pace 0.77–0.97; the drums alone 0.10–0.13,
 * noise 0.32, a steady tone 0.37, a line sung later than the take leaves room for 0.28, silence 0. It measures timing,
 * not words: another line sung with the same rhythm matches too.
 */
export const SYNC_THRESHOLD = 0.5

/** What a clip that doesn't sing (or a take without sound) gets: no offset, nothing measured. */
const NOTHING: TakeSongSync = { offset: 0, score: 0, matched: false, measured: 'none' }

const ms = (t: number): number => Math.round(t * 1000) / 1000

/** log10 RMS of each HOP block, floored FLOOR_DB under the loudest one; undefined for a silent sound. */
function envelope(x: Float32Array): Float64Array | undefined {
  const n = Math.floor(x.length / HOP)
  const rms = new Float64Array(n)
  let peak = 0
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let i = k * HOP, end = i + HOP; i < end; i++) sum += x[i] * x[i]
    rms[k] = Math.sqrt(sum / HOP)
    if (rms[k] > peak) peak = rms[k]
  }
  if (peak < SILENT_RMS) return undefined
  const floor = peak * 10 ** (-FLOOR_DB / 20)
  for (let k = 0; k < n; k++) rms[k] = Math.log10(Math.max(rms[k], floor))
  return rms
}

/** Pearson correlation of a[i] and b[i + lag] over where both exist; NaN without enough overlap or variation. */
function correlation(a: Float64Array, b: Float64Array, lag: number, minOverlap: number): number {
  const from = Math.max(0, -lag)
  const to = Math.min(a.length, b.length - lag)
  const n = to - from
  if (n < minOverlap) return Number.NaN
  let sa = 0
  let sb = 0
  let saa = 0
  let sbb = 0
  let sab = 0
  for (let i = from; i < to; i++) {
    const x = a[i]
    const y = b[i + lag]
    sa += x
    sb += y
    saa += x * x
    sbb += y * y
    sab += x * y
  }
  const va = saa - (sa * sa) / n
  const vb = sbb - (sb * sb) / n
  if (!(va > 1e-9) || !(vb > 1e-9)) return Number.NaN
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb)
}

/**
 * Where the take's voice (`take`, samples at RATE) best matches the song's vocals over its place (`reference`): the lag
 * in seconds (+: the take sings late) within [−EARLY_SECONDS, `headroom`], and the correlation there.
 */
export function bestLag(
  reference: Float32Array,
  take: Float32Array,
  headroom: number
): { lag: number; score: number } | undefined {
  const a = envelope(reference)
  const b = envelope(take)
  if (!a || !b) return undefined
  const step = HOP / RATE
  const minLag = -Math.round(EARLY_SECONDS / step)
  const maxLag = Math.max(0, Math.round(Math.max(0, headroom) / step))
  const minOverlap = Math.max(4, Math.floor(a.length * MIN_OVERLAP))
  const scores = new Map<number, number>()
  let best: number | undefined
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = correlation(a, b, lag, minOverlap)
    scores.set(lag, r)
    if (Number.isFinite(r) && (best === undefined || r > scores.get(best)!)) best = lag
  }
  if (best === undefined) return undefined
  // Between steps: the top of a parabola through the best lag and its neighbours.
  const r0 = scores.get(best)!
  const before = scores.get(best - 1)
  const after = scores.get(best + 1)
  let fine = best
  if (before !== undefined && after !== undefined && Number.isFinite(before) && Number.isFinite(after)) {
    const curve = before - 2 * r0 + after
    if (curve < 0) fine = best + Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / curve))
  }
  return { lag: fine * step, score: Math.max(0, Math.min(1, r0)) }
}

/**
 * The take's sound to measure, on the take's own time line (a sound that starts late is padded, as the cut shows it):
 * its voice separated from the rest when this Mac can (free, local), else all of it; undefined when it has no sound.
 */
async function takeVoice(file: string): Promise<Float32Array | undefined> {
  const dir = join(tmpDir(), `song-sync-${randomUUID().slice(0, 8)}`)
  try {
    const sound = join(dir, 'sound.wav')
    try {
      await extractAudio(file, sound, { rate: MIX_RATE })
    } catch (err) {
      if (err instanceof Error && err.message === 'The file has no sound.') return undefined
      throw err
    }
    const status = await separationStatus().catch(() => undefined)
    if (status?.available) {
      try {
        const voice = join(dir, 'voice.wav')
        await separateStems(sound, { voice, background: join(dir, 'background.wav') })
        return await decodeSamples(voice, { rate: RATE })
      } catch (err) {
        console.warn("Separating a take's voice failed; its whole sound is measured instead:", err)
      }
    }
    return await decodeSamples(sound, { rate: RATE })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Where the take's singing sits against the song's vocals (the mix when the song has none) over `place`, the place the
 * take was made for: at most the 15 s that were sent, looked for from EARLY_SECONDS before the take starts to as late
 * as the take leaves room for (its length minus the place's).
 */
export async function measureSinging(file: string, place: SongWindow, song: SequenceSong): Promise<TakeSongSync> {
  const length = Math.min(windowLength(place), MAX_SONG_WINDOW_SECONDS)
  const vocals = song.vocalsPath && existsSync(song.vocalsPath) ? song.vocalsPath : song.path
  const [reference, voice] = await Promise.all([
    decodeSamples(vocals, { rate: RATE, start: place.start, maxSeconds: length }),
    takeVoice(file)
  ])
  if (!voice) return NOTHING
  const match = bestLag(reference, voice, voice.length / RATE - length)
  if (!match) return { offset: 0, score: 0, matched: false, measured: 'vocals' }
  const score = Math.round(match.score * 100) / 100
  const matched = score >= SYNC_THRESHOLD
  return { offset: matched ? ms(Math.max(0, match.lag)) : 0, score, matched, measured: 'vocals' }
}

// ── The cut ──────────────────────────────────────────────────────────────────

/**
 * Brings the trims of a song sequence's clips in line with where their selected takes sing: each clip with a place in
 * the song and a finished selected take starts it at songTrimBase (the measured offset, moved on by however far the
 * clip's place has moved since the take was made) plus the take's nudge here, and keeps exactly the place's length
 * (songCut). A start trim changed since this last set it is a nudge and is kept, also when the place moves; a take
 * selected again gets back its own nudge. Synchronous (the database and the sync file), cheap for a sequence without
 * a song; never throws. Returns whether a trim changed.
 */
export function reconcileSongTrims(sequenceId: string): boolean {
  try {
    if (!store.sequenceSong(sequenceId)) return false
    const write = db.getDb().prepare('UPDATE segments SET trim_start = ?, trim_end = ? WHERE id = ?')
    const cuts = new Map<string, ClipCut>()
    let changed = false
    for (const row of store.listSegmentRows(sequenceId)) {
      const place = store.parseParams(row.params).song
      const take = place ? store.selectedTake(row) : undefined
      const length = take?.status === 'completed' ? store.takeLength(take) : undefined
      if (!place || !take || !length) continue
      const state = clipCut(row.id)
      const takePlace = sanitizeSongWindow(take.params.song)
      const base = songTrimBase(takeSync(take.id)?.offset ?? 0, place, takePlace)
      const known = state?.nudges[take.id]
      // A take made without a place (an own clip, one from before the song) keeps the start trim it came with.
      let nudge = known ?? (takePlace ? 0 : row.trim_start - base)
      if (state?.take === take.id && Math.abs(row.trim_start - state.trimStart) > 0.0005) {
        nudge += row.trim_start - state.trimStart
      }
      nudge = ms(nudge)
      const cut = songCut(length, base + nudge, place)
      if (Math.abs(cut.trimStart - row.trim_start) > 0.0005 || Math.abs(cut.trimEnd - row.trim_end) > 0.0005) {
        write.run(cut.trimStart, cut.trimEnd, row.id)
        changed = true
      }
      if (state?.take !== take.id || state.trimStart !== cut.trimStart || known !== nudge) {
        cuts.set(row.id, { take: take.id, trimStart: cut.trimStart, nudges: { ...state?.nudges, [take.id]: nudge } })
      }
    }
    setClipCuts(cuts)
    return changed
  } catch (err) {
    console.warn(`Could not cut the clips of sequence ${sequenceId} to its song:`, err)
    return false
  }
}

// ── Measuring finished takes ─────────────────────────────────────────────────

interface Deps {
  jobs: JobManager
  sequences: SequenceService
  /** The sequence changed (its clips' trims, a take's measurement). */
  notify: (sequenceId: string) => void
}

/** One measurement at a time: four variants finishing together don't separate four voices at once. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Measures the take against its place in the song and records it, then cuts its clip again (a selected take's trims
 * follow). Resolves with its sequence, or undefined when the take isn't a take of a song clip any more.
 */
function measure(deps: Deps, generationId: string): Promise<string | undefined> {
  const run = queue.then(async () => {
    // The take's file may be on its way into the sequence's Tagningar.
    await deps.sequences.whenFilesSettled()
    const take = db.getGeneration(generationId)
    const row = take?.segmentId ? store.getSegmentRow(take.segmentId) : undefined
    const song = row ? store.sequenceSong(row.sequence_id) : undefined
    const place = take ? sanitizeSongWindow(take.params.song) : undefined
    if (!take || !row || !song || !place || !store.isUsable(take)) return undefined
    const sync = place.part === 'vocals' ? await measureSinging(take.filePath, place, song) : NOTHING
    // Still the same take of the same library: a switch meanwhile leaves the other library's file alone.
    if (!db.isDbOpen() || !db.getGeneration(take.id)) return undefined
    setTakeSync(take.id, { ...sync, start: place.start, end: place.end, at: Date.now() })
    reconcileSongTrims(row.sequence_id)
    return row.sequence_id
  })
  queue = run.catch(() => undefined)
  return run
}

/** A take finished: a song clip's take is cut at once (if it was selected) and measured; never throws. */
function takeSettled(deps: Deps, settled: Pick<Generation, 'id' | 'status' | 'segmentId'>): void {
  try {
    if (settled.status !== 'completed' || !settled.segmentId) return
    const row = store.getSegmentRow(settled.segmentId)
    if (!row || !store.sequenceSong(row.sequence_id)) return
    if (!store.parseParams(row.params).song) return
    if (reconcileSongTrims(row.sequence_id)) deps.notify(row.sequence_id)
    measure(deps, settled.id).then(
      (sequenceId) => {
        if (sequenceId) deps.notify(sequenceId)
      },
      (err: unknown) => console.warn(`Could not measure where take ${settled.id} sings:`, err)
    )
  } catch (err) {
    console.warn('Could not look at a finished take of a song clip:', err)
  }
}

/**
 * Measures finished takes of song clips (after the sequence service has selected them) and registers
 * 'songs:syncTake', which measures a take again.
 */
export function registerSongSyncIpc(deps: Deps): void {
  deps.jobs.on('settled', (g: db.StoredGeneration) => takeSettled(deps, g))
  ipcMain.handle('songs:syncTake', async (_e, generationId: unknown) => {
    const take = typeof generationId === 'string' ? db.getGeneration(generationId) : undefined
    if (!take) throw new Error('The take no longer exists.')
    const row = take.segmentId ? store.getSegmentRow(take.segmentId) : undefined
    if (!row) throw new Error('The take belongs to no clip.')
    store.requirePlainSequence(row.sequence_id)
    if (!store.sequenceSong(row.sequence_id)) throw new Error("The take's sequence has no song.")
    if (!store.isUsable(take)) throw new Error('The take has no finished video to measure.')
    if (!sanitizeSongWindow(take.params.song)) {
      throw new Error('The take was made without a place in the song, so there is nothing to measure it against.')
    }
    const sequenceId = (await measure(deps, take.id)) ?? row.sequence_id
    deps.notify(sequenceId)
    return deps.sequences.get(sequenceId)
  })
}
