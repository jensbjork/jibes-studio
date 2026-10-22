// What a sequence's song looks like to Studio (songOverview, the suggested cut points, a clip's default part): its
// waveform, its beat and bars, and where its vocals are sung. Free and local; cached in .studio/timeline by the files'
// identity, so a song is analysed once (again after its vocals are separated).
//
// - Peaks: ffmpeg.waveform of the song and of the vocals.
// - Beat: the onset strength (spectral flux of a log-magnitude spectrum, 11.6 ms frames), its tempo by autocorrelation
//   in 60–180 BPM (a gentle preference for ~120 resolves double and half tempo), then the beats themselves by dynamic
//   programming (Ellis 2007: each beat on a strong onset, about one period after the one before, so a tempo that drifts
//   a little is followed). No steady beat (speech, a free-time intro): none.
// - Bars: the beats that start a bar, when the accents make it clear (3 or 4 beats to a bar, the loudest low end on the
//   same beat of nearly every bar); otherwise none.
// - Vocal activity: where the separated vocals are louder than ~28 dB under their loud parts (pauses under 0.3 s
//   bridged); without vocals the voice band of the mix, which only says where it is quiet.

import { createHash } from 'node:crypto'
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SequenceSong, SongOverview } from '@shared/types'
import { MAX_SONG_SECONDS } from '@shared/song'
import { decodeSamples, waveform } from './ffmpeg'
import { APP_DATA, appDataDir } from './paths'

/** Bump when what is cached changes: older entries are made again. */
const CACHE_VERSION = 1
/** The rate the song is analysed at: plenty for kicks, snares and the voice band. */
export const ANALYSIS_RATE = 11_025
/** FFT size and hop at ANALYSIS_RATE: 46 ms windows every 11.6 ms. */
const FFT_SIZE = 512
const HOP = 128
/** Frames per second of the onset envelope. */
export const FRAME_RATE = ANALYSIS_RATE / HOP
/** Tempo range searched (BPM) and the tempo the search leans towards. */
const MIN_BPM = 60
const MAX_BPM = 180
const PREFERRED_BPM = 120
/** How strongly the beat tracker holds the tempo (higher: steadier). */
const TIGHTNESS = 400
/** A tempo whose autocorrelation stands this far out of the rest counts as a steady beat. */
const MIN_BEAT_CONFIDENCE = 0.08
/** Bars: the accented beat of a bar is this much louder on average than the others… */
const BAR_CONTRAST = 1.15
/** …and the loudest of its bar in at least this share of the bars. */
const BAR_CONSISTENCY = 0.6
/** Vocal activity: frames this many dB under the loud parts of the vocals count as silence… */
const ACTIVITY_RANGE_DB = 28
/** …and never above this level (dBFS). */
const ACTIVITY_FLOOR_DB = -55
/** Pauses shorter than this are breaths inside a phrase; sung bits shorter than that are bleed. */
const MIN_PAUSE_SECONDS = 0.3
const MIN_ACTIVE_SECONDS = 0.12

export interface SongAnalysis extends SongOverview {
  /** Where the vocals are sung (seconds), from the separated vocals when `fromVocals`, else from the mix. */
  vocalActivity: { start: number; end: number }[]
  /** The pauses between, at least MIN_PAUSE_SECONDS long. */
  vocalPauses: { start: number; end: number }[]
  fromVocals: boolean
}

// ── The onset envelope ───────────────────────────────────────────────────────

/** Bit-reversal order and twiddle factors of a radix-2 FFT of size n, worked out once. */
function fftPlan(n: number): { order: Uint32Array; cos: Float64Array; sin: Float64Array } {
  const bits = Math.log2(n)
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    order[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n)
    sin[k] = Math.sin((-2 * Math.PI * k) / n)
  }
  return { order, cos, sin }
}

/** In-place radix-2 FFT of re/im (length n, a power of two), the input in bit-reversed order already. */
function fft(re: Float64Array, im: Float64Array, plan: ReturnType<typeof fftPlan>): void {
  const n = re.length
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const stride = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = plan.cos[k * stride]
        const wi = plan.sin[k * stride]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

export interface Envelopes {
  /** Onset strength per frame (spectral flux), normalised. */
  onset: Float64Array
  /** Energy below ~150 Hz per frame (kicks: the bar accents). */
  low: Float64Array
  /** Energy in the voice band (300–3400 Hz) per frame. */
  voice: Float64Array
}

/** The spectra worked out between two breaks for the event loop (~30 ms of work): a long song never freezes the app. */
const FRAMES_PER_STEP = 3000

/**
 * The per-frame envelopes of mono samples at ANALYSIS_RATE: the onset strength (half-wave rectified flux of
 * log(1 + 100·|X|), minus its running mean over ~0.5 s, divided by its standard deviation), and the energy of the low
 * end and of the voice band. Frame n is centred on sample n·HOP + FFT_SIZE/2.
 */
export function envelopes(samples: Float32Array): Envelopes {
  const steps = envelopeSteps(samples)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/** envelopes, letting the event loop run every FRAMES_PER_STEP frames. */
export async function envelopesInSteps(samples: Float32Array): Promise<Envelopes> {
  const steps = envelopeSteps(samples)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** envelopes as a generator that pauses every FRAMES_PER_STEP frames. */
function* envelopeSteps(samples: Float32Array): Generator<void, Envelopes> {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1)
  const bins = FFT_SIZE / 2 + 1
  const hann = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
  const binHz = ANALYSIS_RATE / FFT_SIZE
  const lowTop = Math.max(1, Math.round(150 / binHz))
  const voiceFrom = Math.round(300 / binHz)
  const voiceTo = Math.min(bins - 1, Math.round(3400 / binHz))
  const flux = new Float64Array(frames)
  const low = new Float64Array(frames)
  const voice = new Float64Array(frames)
  const plan = fftPlan(FFT_SIZE)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  let previous = new Float64Array(bins)
  let current = new Float64Array(bins)
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP
    for (let i = 0; i < FFT_SIZE; i++) {
      const from = plan.order[i]
      re[i] = samples[offset + from] * hann[from]
      im[i] = 0
    }
    fft(re, im, plan)
    let rise = 0
    let lowEnergy = 0
    let voiceEnergy = 0
    for (let k = 0; k < bins; k++) {
      const power = re[k] * re[k] + im[k] * im[k]
      const level = Math.log1p(100 * Math.sqrt(power))
      current[k] = level
      if (f > 0 && level > previous[k]) rise += level - previous[k]
      if (k > 0 && k <= lowTop) lowEnergy += power
      if (k >= voiceFrom && k <= voiceTo) voiceEnergy += power
    }
    flux[f] = rise
    low[f] = lowEnergy
    voice[f] = voiceEnergy
    ;[previous, current] = [current, previous]
    if (f % FRAMES_PER_STEP === FRAMES_PER_STEP - 1) yield
  }
  // Minus its running mean (so a crescendo isn't a beat), rectified, in units of its spread.
  const half = Math.round(FRAME_RATE / 4)
  const onset = new Float64Array(frames)
  let sum = 0
  let count = 0
  for (let i = 0; i < Math.min(frames, half); i++) {
    sum += flux[i]
    count++
  }
  for (let f = 0; f < frames; f++) {
    const add = f + half
    const drop = f - half - 1
    if (add < frames) {
      sum += flux[add]
      count++
    }
    if (drop >= 0) {
      sum -= flux[drop]
      count--
    }
    onset[f] = Math.max(0, flux[f] - sum / Math.max(1, count))
  }
  let sq = 0
  for (let f = 0; f < frames; f++) sq += onset[f] * onset[f]
  const spread = Math.sqrt(sq / Math.max(1, frames))
  if (spread > 0) for (let f = 0; f < frames; f++) onset[f] /= spread
  return { onset, low, voice }
}

/** Seconds of frame n's centre. */
export function frameTime(n: number): number {
  return (n * HOP + FFT_SIZE / 2) / ANALYSIS_RATE
}

// ── Tempo and beats ──────────────────────────────────────────────────────────

/**
 * The beat period of an onset envelope (frames, fractional) and how clearly it stands out (0–1: the autocorrelation at
 * that lag above its average over the searched range, over the envelope's energy). The lag with the highest
 * autocorrelation in 60–180 BPM, weighted towards PREFERRED_BPM (a log-normal of one octave), refined between frames.
 */
export function estimatePeriod(onset: Float64Array): { period: number; confidence: number } | undefined {
  const n = onset.length
  const minLag = Math.floor((FRAME_RATE * 60) / MAX_BPM)
  const maxLag = Math.ceil((FRAME_RATE * 60) / MIN_BPM)
  if (n < maxLag * 3) return undefined
  const ac = new Float64Array(maxLag + 2)
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let v = 0
    for (let i = 0; i + lag < n; i++) v += onset[i] * onset[i + lag]
    ac[lag] = v / (n - lag)
  }
  if (!(ac[0] > 0)) return undefined
  let best = -1
  let bestScore = -Infinity
  let mean = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    mean += ac[lag]
    const bpm = (FRAME_RATE * 60) / lag
    const weight = Math.exp(-0.5 * Math.log2(bpm / PREFERRED_BPM) ** 2)
    const score = ac[lag] * weight
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  mean /= maxLag - minLag + 1
  // Parabolic interpolation around the best lag.
  const a = ac[best - 1]
  const b = ac[best]
  const c = ac[best + 1]
  const denominator = a - 2 * b + c
  const shift = denominator < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator)) : 0
  return { period: best + shift, confidence: Math.max(0, (ac[best] - mean) / ac[0]) }
}

/**
 * The beat frames of an onset envelope at about `period` frames apart (Ellis's dynamic programming): every frame's
 * best chain of beats ending there scores its onset plus the best earlier chain 0.5–2 periods before, less a penalty
 * for straying from the period; the best chain ending in the last period is traced back. Leading and trailing beats
 * on hardly any onset (a quiet intro or ending) are left out.
 */
export function trackBeats(onset: Float64Array, period: number): number[] {
  const n = onset.length
  if (!n || !(period > 1)) return []
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const from = Math.max(1, Math.round(period / 2))
  const to = Math.round(2 * period)
  for (let t = 0; t < n; t++) {
    let best = 0
    let bestAt = -1
    for (let tau = t - to; tau <= t - from; tau++) {
      if (tau < 0) continue
      const stray = Math.log((t - tau) / period)
      const v = score[tau] - TIGHTNESS * stray * stray
      if (bestAt < 0 || v > best) {
        best = v
        bestAt = tau
      }
    }
    score[t] = onset[t] + (bestAt >= 0 ? Math.max(0, best) : 0)
    back[t] = bestAt >= 0 && best > 0 ? bestAt : -1
  }
  let end = n - 1
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) if (score[t] > score[end]) end = t
  const beats: number[] = []
  for (let t = end; t >= 0; t = back[t]) beats.push(t)
  beats.reverse()
  // The strength of each beat: its onset, or a neighbour's (±2 frames).
  const strength = (t: number): number => Math.max(...[-2, -1, 0, 1, 2].map((d) => onset[t + d] ?? 0))
  const typical = [...beats.map(strength)].sort((x, y) => x - y)[Math.floor(beats.length / 2)] ?? 0
  let first = 0
  let last = beats.length - 1
  while (first <= last && strength(beats[first]) < 0.25 * typical) first++
  while (last >= first && strength(beats[last]) < 0.25 * typical) last--
  return beats.slice(first, last + 1)
}

/**
 * The beats that start a bar, by their accents (`accent`: how loud each beat is, e.g. its low end): for 4 and 3 beats
 * to a bar, the beat of the bar that is loudest on average; a meter counts when that beat is BAR_CONTRAST louder than
 * the others and the loudest of its bar in BAR_CONSISTENCY of the bars. The clearer meter wins (4 on a tie); none
 * when neither is clear. Returns indices into the beats.
 */
export function findBars(accent: readonly number[]): number[] | undefined {
  let chosen: { meter: number; phase: number; consistency: number; contrast: number } | undefined
  for (const meter of [4, 3]) {
    const bars = Math.floor(accent.length / meter)
    if (bars < 4) continue
    for (let phase = 0; phase < meter; phase++) {
      let on = 0
      let off = 0
      let onCount = 0
      let offCount = 0
      for (let i = 0; i < accent.length; i++) {
        if ((i - phase) % meter === 0 && i >= phase) {
          on += accent[i]
          onCount++
        } else {
          off += accent[i]
          offCount++
        }
      }
      const contrast = offCount && off > 0 ? on / onCount / (off / offCount) : 0
      let wins = 0
      let groups = 0
      for (let start = phase; start + meter <= accent.length; start += meter) {
        groups++
        const group = accent.slice(start, start + meter)
        if (group[0] >= Math.max(...group)) wins++
      }
      const consistency = groups ? wins / groups : 0
      if (contrast < BAR_CONTRAST || consistency < BAR_CONSISTENCY) continue
      if (!chosen || consistency > chosen.consistency + 0.05 || (consistency > chosen.consistency - 0.05 && contrast > chosen.contrast)) {
        chosen = { meter, phase, consistency, contrast }
      }
    }
  }
  if (!chosen) return undefined
  const out: number[] = []
  for (let i = chosen.phase; i < accent.length; i += chosen.meter) out.push(i)
  return out
}

/** Beats (seconds), bars among them and the tempo of mono samples at ANALYSIS_RATE; no beats without a steady one. */
export function beatsOf(samples: Float32Array, env = envelopes(samples)): Pick<SongOverview, 'beats' | 'bars' | 'bpm'> {
  const estimate = estimatePeriod(env.onset)
  if (!estimate || estimate.confidence < MIN_BEAT_CONFIDENCE) return { beats: [] }
  const frames = trackBeats(env.onset, estimate.period)
  if (frames.length < 4) return { beats: [] }
  const round = (t: number): number => Math.round(t * 1000) / 1000
  const beats = frames.map((f) => round(frameTime(f)))
  const intervals = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
  const median = intervals[Math.floor(intervals.length / 2)]
  const bpm = median > 0 ? Math.round((600 / median)) / 10 : undefined
  // A beat's accent: the loudest low end from just before it to ~50 ms after.
  const accent = frames.map((f) => Math.max(...[-1, 0, 1, 2, 3, 4].map((d) => env.low[f + d] ?? 0)))
  const barIndices = findBars(accent)
  return {
    beats,
    ...(barIndices ? { bars: barIndices.map((i) => beats[i]) } : {}),
    ...(bpm ? { bpm } : {})
  }
}

// ── Vocal activity ───────────────────────────────────────────────────────────

/**
 * Where `energy` (per frame, frames at `frameRate`) is active: above ACTIVITY_RANGE_DB under its loud parts (its 95th
 * percentile) and above ACTIVITY_FLOOR_DB; pauses shorter than MIN_PAUSE_SECONDS bridged, bits shorter than
 * MIN_ACTIVE_SECONDS dropped. Seconds, in order, within [0, duration].
 */
export function activityOf(
  energy: ArrayLike<number>,
  frameRate: number,
  duration: number,
  frameSeconds = (i: number): number => (i + 0.5) / frameRate
): { start: number; end: number }[] {
  const n = energy.length
  if (!n) return []
  const db = new Float64Array(n)
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(Math.max(1e-12, energy[i]))
  const audible = [...db].filter((v) => v > -110).sort((a, b) => a - b)
  if (!audible.length) return []
  const loud = audible[Math.floor(audible.length * 0.95)]
  const threshold = Math.max(loud - ACTIVITY_RANGE_DB, ACTIVITY_FLOOR_DB)
  const raw: { start: number; end: number }[] = []
  let from = -1
  for (let i = 0; i <= n; i++) {
    const on = i < n && db[i] > threshold
    if (on && from < 0) from = i
    if (!on && from >= 0) {
      raw.push({ start: Math.max(0, frameSeconds(from) - 0.5 / frameRate), end: Math.min(duration, frameSeconds(i - 1) + 0.5 / frameRate) })
      from = -1
    }
  }
  const merged: { start: number; end: number }[] = []
  for (const r of raw) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < MIN_PAUSE_SECONDS) last.end = r.end
    else merged.push({ ...r })
  }
  const round = (t: number): number => Math.round(t * 1000) / 1000
  return merged
    .filter((r) => r.end - r.start >= MIN_ACTIVE_SECONDS)
    .map((r) => ({ start: round(r.start), end: round(r.end) }))
}

/** The pauses of at least MIN_PAUSE_SECONDS between, before and after `active` in [0, duration]. */
export function pausesOf(active: readonly { start: number; end: number }[], duration: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let at = 0
  for (const r of active) {
    if (r.start - at >= MIN_PAUSE_SECONDS) out.push({ start: at, end: r.start })
    at = Math.max(at, r.end)
  }
  if (duration - at >= MIN_PAUSE_SECONDS) out.push({ start: at, end: duration })
  return out
}

/** RMS energy per 20 ms of mono samples. */
function frameEnergy(samples: Float32Array, rate: number): { energy: Float64Array; frameRate: number } {
  const size = Math.max(1, Math.round(rate * 0.02))
  const n = Math.floor(samples.length / size)
  const energy = new Float64Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * size, end = i + size; i < end; i++) sum += samples[i] * samples[i]
    energy[f] = sum / size
  }
  return { energy, frameRate: rate / size }
}

// ── The cache ────────────────────────────────────────────────────────────────

/** A file's identity: survives a rename or move on the same volume (the sequence's folder renamed), not a new file. */
async function identity(path: string | undefined): Promise<string> {
  if (!path) return '-'
  const s = await stat(path)
  return `${s.size}:${Math.round(s.mtimeMs)}:${s.ino}`
}

async function cacheFile(song: Pick<SequenceSong, 'path' | 'vocalsPath'>): Promise<string> {
  const key = createHash('sha1')
    .update(`song-analysis\n${await identity(song.path)}\n${await identity(song.vocalsPath)}\n${CACHE_VERSION}`)
    .digest('hex')
  return join(appDataDir(APP_DATA.timeline), `song-${key}.json`)
}

function isAnalysis(value: unknown): value is SongAnalysis {
  const a = value as Partial<SongAnalysis> | null
  return !!a && typeof a === 'object' && Array.isArray(a.peaks) && Array.isArray(a.beats) && Array.isArray(a.vocalActivity)
}

/** The song's analysis when it is cached already (nothing is analysed here); undefined otherwise. Never rejects. */
export async function cachedSongAnalysis(
  song: Pick<SequenceSong, 'path' | 'vocalsPath'>
): Promise<SongAnalysis | undefined> {
  try {
    const parsed = JSON.parse(await readFile(await cacheFile(song), 'utf8')) as unknown
    return isAnalysis(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const running = new Map<string, Promise<SongAnalysis>>()

/** Analyses running right now (a library switch waits for none of them, but counts them as busy). */
export function songAnalysesRunning(): number {
  return running.size
}

/**
 * The song's peaks, beat, bars and vocal activity (see the top of this file), from the cache or analysed now and
 * cached. `onProgress`: 0–1.
 */
export async function analyseSong(
  song: Pick<SequenceSong, 'path' | 'vocalsPath' | 'duration'>,
  o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<SongAnalysis> {
  const file = await cacheFile(song)
  const cached = await cachedSongAnalysis(song)
  if (cached) {
    await utimes(file, new Date(), new Date()).catch(() => {})
    return cached
  }
  const already = running.get(file)
  if (already) return already
  const report = (f: number): void => {
    try {
      o.onProgress?.(f)
    } catch (err) {
      console.warn('Song analysis progress callback failed:', err)
    }
  }
  const job = (async (): Promise<SongAnalysis> => {
    const duration = song.duration
    const buckets = Math.min(8000, Math.max(400, Math.ceil(duration * 20)))
    const peaks = await waveform(song.path, buckets, { duration, signal: o.signal })
    const vocalPeaks = song.vocalsPath ? await waveform(song.vocalsPath, buckets, { duration, signal: o.signal }) : undefined
    report(0.2)
    const samples = await decodeSamples(song.path, { rate: ANALYSIS_RATE, maxSeconds: MAX_SONG_SECONDS + 5, signal: o.signal })
    report(0.45)
    const env = await envelopesInSteps(samples)
    const beat = beatsOf(samples, env)
    report(0.8)
    let vocalActivity: { start: number; end: number }[]
    if (song.vocalsPath) {
      const vocals = await decodeSamples(song.vocalsPath, { rate: ANALYSIS_RATE, maxSeconds: MAX_SONG_SECONDS + 5, signal: o.signal })
      const { energy, frameRate } = frameEnergy(vocals, ANALYSIS_RATE)
      vocalActivity = activityOf(energy, frameRate, duration)
    } else {
      vocalActivity = activityOf(env.voice, FRAME_RATE, duration, frameTime)
    }
    const result: SongAnalysis = {
      duration,
      peaks,
      ...(vocalPeaks ? { vocalPeaks } : {}),
      ...beat,
      vocalActivity,
      vocalPauses: pausesOf(vocalActivity, duration),
      fromVocals: !!song.vocalsPath
    }
    await writeFile(file, JSON.stringify(result)).catch((err: unknown) => console.warn('Could not cache the song analysis:', err))
    report(1)
    return result
  })()
  running.set(file, job)
  try {
    return await job
  } finally {
    running.delete(file)
  }
}

/** What the song panel draws (SongOverview) from an analysis. */
export function overviewOf(a: SongAnalysis): SongOverview {
  return {
    duration: a.duration,
    peaks: a.peaks,
    ...(a.vocalPeaks ? { vocalPeaks: a.vocalPeaks } : {}),
    beats: a.beats,
    ...(a.bars ? { bars: a.bars } : {}),
    ...(a.bpm ? { bpm: a.bpm } : {})
  }
}
