// The sound of an edit's versions as layers, not mixdowns. A version records how its sound was built (AudioMix in
// its recipe): a bed (v1's own sound or a rendered "bake" in Ljud/, optionally split into a voice and a background
// stem), gain envelopes on each, and layers of edit media (new lines, converted voices, music, effects, added
// files) placed on the film's time line. Every audio operation copies the base's mix, changes it and renders it
// again from the sources, so a later volume change or a removed music layer never stacks on an earlier mixdown and
// a voice operation reads the original speech, not speech with music mixed into it.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioLayer, AudioMix, AudioSourceRef, EditRange, GainSpan, Generation } from '@shared/types'
import * as db from './db'
import * as store from './edit-store'
import { probe, type ResolvedMix } from './ffmpeg'
import { APP_DATA, appDataDir, toStoredPath } from './paths'
import { separateStems } from './voice-separation'

/** Ramp length of a gain change (and of a layer's edges at a replaced line), seconds. */
export const GAIN_FADE = 0.02
/** "Sänk originalljudet där rösten byts": the original under a replaced voice. */
export const DUCK_DB = -18
/** Stem cache size (.studio/stammar): the least recently used stems go first above it. */
export const STEM_CACHE_BYTES = 4 * 1024 ** 3

export const MISSING_SOURCE_NOTE = 'Ljudlagren kunde inte byggas om; versionens ljud används som det är.'

const round = (n: number, step = 1000): number => Math.round(n * step) / step

/** The mix every edit's v1 has: its own sound, untouched. */
export function defaultMix(v1Id: string): AudioMix {
  return { bed: { source: { kind: 'generation', id: v1Id }, gains: [] }, layers: [] }
}

/** A mix whose bed is one of the edit's own recordings (a rendered "bake"), with nothing on it. */
export function defaultMixFromMedia(mediaId: string): AudioMix {
  return { bed: { source: { kind: 'media', id: mediaId }, gains: [] }, layers: [] }
}

/** A deep copy that can be changed without touching the base's recipe. */
export function cloneMix(mix: AudioMix): AudioMix {
  return JSON.parse(JSON.stringify(mix)) as AudioMix
}

/**
 * The base's mix: its recipe's, or for the edit's v1 (and anything without a recipe) its own sound. An import row
 * carries a default mix of its own, which is the same thing.
 */
export function mixOf(version: Pick<Generation, 'id' | 'recipe'>, isOrigin: boolean): AudioMix {
  const mix = version.recipe?.mix
  if (isOrigin || !mix || typeof mix !== 'object' || !mix.bed) return defaultMix(version.id)
  return cloneMix({
    ...mix,
    bed: { source: mix.bed.source ?? null, gains: mix.bed.gains ?? [], stems: mix.bed.stems },
    layers: Array.isArray(mix.layers) ? mix.layers : []
  })
}

// ── Changing a mix ───────────────────────────────────────────────────────────

/** Splits the bed into a voice and a background stem (separated from the bed's source) unless it is already. */
export function ensureStems(mix: AudioMix): AudioMix {
  if (!mix.bed.stems) {
    mix.bed.stems = { voice: 'separated', voiceGains: [], background: 'separated', backgroundGains: [] }
  }
  return mix
}

/** A gain change on the whole bed, the voice stem or the background stem. */
export function addGain(mix: AudioMix, target: 'all' | 'voice' | 'background', span: GainSpan): AudioMix {
  const clean: GainSpan = { start: round(Math.max(0, span.start)), end: round(span.end) }
  if (span.mute) clean.mute = true
  else clean.gainDb = round(span.gainDb ?? 0, 100)
  clean.fade = round(span.fade ?? GAIN_FADE)
  if (clean.end <= clean.start) return mix
  if (target === 'all') {
    mix.bed.gains.push(clean)
    return mix
  }
  ensureStems(mix)
  if (target === 'voice') mix.bed.stems!.voiceGains.push(clean)
  else mix.bed.stems!.backgroundGains.push(clean)
  return mix
}

export function addLayer(mix: AudioMix, layer: AudioLayer): AudioMix {
  mix.layers.push(layer)
  return mix
}

/** Every source the mix plays, so a missing one can be told before anything is rendered. */
export function mixSources(mix: AudioMix): AudioSourceRef[] {
  const refs: AudioSourceRef[] = []
  if (mix.bed.source) refs.push(mix.bed.source)
  const voice = mix.bed.stems?.voice
  if (voice && voice !== 'separated') refs.push(voice)
  for (const l of mix.layers) if (l.mediaId) refs.push({ kind: 'media', id: l.mediaId })
  return refs
}

/** Whether the stems of the bed's source have to be separated to play the mix. */
export function needsSeparation(mix: AudioMix): boolean {
  const stems = mix.bed.stems
  return !!stems && (stems.voice === 'separated' || stems.background === 'separated')
}

/** The file a source points at, or undefined when its row or file is gone. */
export function sourcePath(ref: AudioSourceRef | null | undefined): string | undefined {
  if (!ref) return undefined
  const path = ref.kind === 'generation' ? db.getGeneration(ref.id)?.filePath : store.getMedia(ref.id)?.path
  return path && existsSync(path) ? path : undefined
}

/** Whether every source of the mix is still there. */
export function mixIsComplete(mix: AudioMix): boolean {
  return mixSources(mix).every((ref) => sourcePath(ref) !== undefined)
}

// ── What the timeline shows ──────────────────────────────────────────────────

export function layerBars(
  mix: AudioMix
): { id: string; kind: AudioLayer['kind']; label: string; start: number; end: number; gainDb: number }[] {
  return mix.layers.map((l) => ({
    id: l.id,
    kind: l.kind,
    label: l.label,
    start: l.at,
    end: round(l.at + l.length),
    gainDb: l.gainDb
  }))
}

export function mutedSpans(
  mix: AudioMix,
  duration: number
): { start: number; end: number; target: 'all' | 'voice' | 'background' }[] {
  const spans: { start: number; end: number; target: 'all' | 'voice' | 'background' }[] = []
  const muted = (gains: GainSpan[], target: 'all' | 'voice' | 'background'): void => {
    for (const g of gains) if (g.mute) spans.push({ start: g.start, end: Math.min(g.end, duration), target })
  }
  if (!mix.bed.source) spans.push({ start: 0, end: duration, target: 'all' })
  muted(mix.bed.gains, 'all')
  const stems = mix.bed.stems
  if (stems) {
    if (stems.voice === null) spans.push({ start: 0, end: duration, target: 'voice' })
    if (stems.background === null) spans.push({ start: 0, end: duration, target: 'background' })
    muted(stems.voiceGains, 'voice')
    muted(stems.backgroundGains, 'background')
  }
  return spans.sort((a, b) => a.start - b.start)
}

// ── Timing changes ───────────────────────────────────────────────────────────

/** Spans of a timing-changing operation: base [from, to) appears at `at` in the result. */
export type TimeSpan = { from: number; to: number; at: number }

/**
 * Layers that put the parts of one recording back together along the spans (a cut film's sound), with a short
 * crossfade at each join so no click is heard: a part is extended by half the fade into the material it was cut
 * from, where there is any, and faded over the whole width.
 */
export function spanLayers(
  path: string,
  spans: readonly TimeSpan[],
  sourceDuration: number,
  crossfade = 0.01
): ResolvedMix['layers'] {
  const half = crossfade / 2
  return spans.map((s, i) => {
    const joinsBefore = i > 0
    const joinsAfter = i < spans.length - 1
    const lead = joinsBefore ? Math.min(half, s.from) : 0
    const tail = joinsAfter ? Math.min(half, Math.max(0, sourceDuration - s.to)) : 0
    return {
      id: `span-${i}`,
      kind: 'audio' as const,
      label: '',
      path,
      at: round(Math.max(0, s.at - lead), 1e6),
      offset: round(s.from - lead, 1e6),
      length: round(s.to - s.from + lead + tail, 1e6),
      gainDb: 0,
      fadeIn: joinsBefore ? crossfade : 0,
      fadeOut: joinsAfter ? crossfade : 0,
      duck: false,
      loop: false
    }
  })
}

/**
 * Times of the base after a timing change: a time inside a kept span moves with it, a time in a removed part is
 * dropped. The joins themselves become cut markers (Klippgränser), where the picture jumps.
 */
export function remapTimes(times: readonly number[], spans: readonly TimeSpan[], joins = true): number[] {
  const out: number[] = []
  for (const t of times) {
    const span = spans.find((s) => t >= s.from && t < s.to)
    if (span) out.push(round(span.at + (t - span.from)))
  }
  if (joins) for (const s of spans.slice(1)) out.push(round(s.at))
  return [...new Set(out)].filter((t) => t > 0).sort((a, b) => a - b)
}

/** A range inside the film, clamped. */
export function clampRange(r: EditRange, duration: number): EditRange {
  const start = Math.min(Math.max(0, r.start), duration)
  return { start, end: Math.min(Math.max(start, r.end), duration) }
}

// ── Resolving a mix into files ───────────────────────────────────────────────

const audioCache = new Map<string, { mtimeMs: number; size: number; hasAudio: boolean }>()

/** Whether the file has a sound track (cached per file version). */
export async function hasAudio(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    const cached = audioCache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.hasAudio
    let has: boolean
    try {
      has = (await probe(path)).hasAudio
    } catch {
      // An audio-only file (edit media) has no video track for probe(); it is sound.
      has = !/\.(mp4|mov|m4v|webm|mkv)$/i.test(path)
    }
    audioCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, hasAudio: has })
    return has
  } catch {
    return false
  }
}

/** Separations in flight, by cache key, so two plans or renders of the same film separate it once. */
const separating = new Map<string, Promise<{ voice: string; background: string }>>()

/** The cache key of a file's stems: its stored path, size and modification time. */
async function stemKey(path: string): Promise<string> {
  const info = await stat(path)
  return createHash('sha1')
    .update(`${toStoredPath(path)}\n${info.size}\n${Math.round(info.mtimeMs)}`)
    .digest('hex')
}

/**
 * The voice and background stems of a recording (free, local; the AUSoundIsolation helper), cached in
 * .studio/stammar so a plan, the render after it and later operations on the same bed separate it only once.
 */
export async function stemsOf(
  path: string,
  o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<{ voice: string; background: string }> {
  const key = await stemKey(path)
  const dir = appDataDir(APP_DATA.stems)
  const voice = join(dir, `${key}.voice.flac`)
  const background = join(dir, `${key}.background.flac`)
  if (existsSync(voice) && existsSync(background)) {
    // Touched for the LRU pruning.
    const now = new Date()
    await Promise.all([utimes(voice, now, now), utimes(background, now, now)]).catch(() => {})
    return { voice, background }
  }
  const running = separating.get(key)
  if (running) return running
  const job = (async () => {
    try {
      await separateStems(path, { voice, background }, { signal: o.signal, onProgress: o.onProgress })
    } catch (err) {
      await Promise.all([rm(voice, { force: true }), rm(background, { force: true })])
      throw err
    }
    return { voice, background }
  })()
  separating.set(key, job)
  try {
    return await job
  } finally {
    separating.delete(key)
  }
}

/** Whether a separation is running (counts as busy for a library switch). */
export function separationsRunning(): number {
  return separating.size
}

/** Keeps the stem cache under STEM_CACHE_BYTES, least recently used first out. Never throws. */
export async function pruneStemCache(cap = STEM_CACHE_BYTES): Promise<void> {
  try {
    const dir = appDataDir(APP_DATA.stems)
    const files: { path: string; size: number; used: number }[] = []
    for (const name of await readdir(dir)) {
      if (!/\.(voice|background)\.flac$/.test(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile()) files.push({ path, size: info.size, used: info.mtimeMs })
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= cap) break
      await rm(f.path, { force: true }).catch(() => {})
      total -= f.size
    }
  } catch (err) {
    console.warn('Pruning the stem cache failed:', err)
  }
}

/**
 * The mix as files renderMix plays: every source looked up, stems separated where the mix splits its bed. Throws
 * (Swedish) when a source is gone; callers check mixIsComplete first and fall back on the base's own sound.
 */
export async function resolveMix(
  mix: AudioMix,
  duration: number,
  o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<ResolvedMix> {
  const bedPath = sourcePath(mix.bed.source)
  if (mix.bed.source && !bedPath) throw new Error(MISSING_SOURCE_NOTE)
  const bedSound = bedPath && (await hasAudio(bedPath)) ? bedPath : null
  const resolved: ResolvedMix = {
    duration,
    bed: { path: bedSound, gains: mix.bed.gains.map((g) => ({ ...g })) },
    layers: [],
    ...(mix.denoise ? { denoise: mix.denoise } : {}),
    ...(typeof mix.loudness === 'number' ? { loudness: mix.loudness } : {}),
    ...(mix.fadeIn ? { fadeIn: mix.fadeIn } : {}),
    ...(mix.fadeOut ? { fadeOut: mix.fadeOut } : {})
  }
  const stems = mix.bed.stems
  if (stems) {
    const separated =
      bedSound && (stems.voice === 'separated' || stems.background === 'separated')
        ? await stemsOf(bedSound, o)
        : undefined
    let voicePath: string | null = null
    if (stems.voice === 'separated') voicePath = separated?.voice ?? null
    else if (stems.voice) {
      voicePath = sourcePath(stems.voice) ?? null
      if (!voicePath) throw new Error(MISSING_SOURCE_NOTE)
    }
    resolved.bed.stems = {
      voicePath,
      voiceGains: stems.voiceGains.map((g) => ({ ...g })),
      backgroundPath: stems.background === 'separated' ? (separated?.background ?? null) : null,
      backgroundGains: stems.backgroundGains.map((g) => ({ ...g }))
    }
  }
  for (const layer of mix.layers) {
    const path = layer.mediaId ? sourcePath({ kind: 'media', id: layer.mediaId }) : undefined
    if (!path) throw new Error(MISSING_SOURCE_NOTE)
    const { mediaId: _m, assetAudioId: _a, ...rest } = layer
    resolved.layers.push({ ...rest, path })
  }
  return resolved
}
