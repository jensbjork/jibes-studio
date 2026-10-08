// Putting converted voice back exactly where it was. The voice changer keeps the timing of what it gets, but not the
// waveform, and what comes back is shifted by however the provider encodes it (an MP3 without a gapless header
// starts ~25 ms late) and a little longer or shorter than what was sent. So each returned chunk is located against
// the chunk that was sent by their loudness envelopes, then cut to start on the same sample and be exactly as long;
// ffmpeg.assembleAt anchors every chunk at its absolute sample, so nothing accumulates over a long film.

import { decodeSamples, filterAudio, MIX_RATE, resampleTo48k } from './ffmpeg'

/** Envelope resolution: 1 ms at 48 kHz. */
const HOP = 48
/** How far apart sent and returned may be (±500 ms): far more than any encoder delay. */
const MAX_LAG_HOPS = 500
/** The refinement compares every 4th sample of the smoothed signals: plenty after 1 ms smoothing, 4× faster. */
const REFINE_STRIDE = 4
/** Floor of the log envelope, so silence doesn't dominate the correlation. */
const ENVELOPE_FLOOR = 1e-4

/** log10 of the RMS of each 1 ms block, minus its mean. */
function logEnvelope(x: Float32Array): Float64Array {
  const n = Math.floor(x.length / HOP)
  const e = new Float64Array(n)
  let mean = 0
  for (let k = 0; k < n; k++) {
    let sum = 0
    for (let i = k * HOP, end = i + HOP; i < end; i++) sum += x[i] * x[i]
    e[k] = Math.log10(Math.sqrt(sum / HOP) + ENVELOPE_FLOOR)
    mean += e[k]
  }
  mean /= Math.max(1, n)
  for (let k = 0; k < n; k++) e[k] -= mean
  return e
}

/** The lag (in envelope steps, + = b late) where a and b correlate best, within ±maxLag. */
function bestLag(a: Float64Array, b: Float64Array, maxLag: number): number {
  let best = 0
  let bestValue = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let v = 0
    const from = Math.max(0, -lag)
    const to = Math.min(a.length, b.length - lag)
    for (let i = from; i < to; i++) v += a[i] * b[i + lag]
    if (v > bestValue) {
      bestValue = v
      best = lag
    }
  }
  return best
}

/** |x| smoothed over 1 ms (a centred moving average), minus its mean. */
function smoothedMagnitude(x: Float32Array): Float64Array {
  const out = new Float64Array(x.length)
  const half = HOP >> 1
  let sum = 0
  for (let i = 0; i < Math.min(x.length, half); i++) sum += Math.abs(x[i])
  let mean = 0
  for (let i = 0; i < x.length; i++) {
    const add = i + half
    const drop = i - half - 1
    if (add < x.length) sum += Math.abs(x[add])
    if (drop >= 0) sum -= Math.abs(x[drop])
    out[i] = sum / HOP
    mean += out[i]
  }
  mean /= Math.max(1, x.length)
  for (let i = 0; i < x.length; i++) out[i] -= mean
  return out
}

/**
 * How many samples (at 48 kHz) the returned audio is late against what was sent (negative: early): the best match
 * of their 1 ms loudness envelopes (log RMS) within ±500 ms, refined to the sample within ±1 ms on the smoothed
 * signal magnitudes. Converted speech keeps its rhythm, so its envelope matches the original's even though the
 * voice is another. 0 when either is silent.
 */
export async function estimateOffsetSamples(sent: string, returned: string): Promise<number> {
  const [a, b] = await Promise.all([decodeSamples(sent, { rate: MIX_RATE }), decodeSamples(returned, { rate: MIX_RATE })])
  if (a.length < HOP * 4 || b.length < HOP * 4) return 0
  const ea = logEnvelope(a)
  const eb = logEnvelope(b)
  const coarse = bestLag(ea, eb, Math.min(MAX_LAG_HOPS, Math.max(ea.length, eb.length))) * HOP

  const sa = smoothedMagnitude(a)
  const sb = smoothedMagnitude(b)
  const n = Math.min(sa.length, sb.length) - 2 * HOP - Math.abs(coarse) - HOP
  if (n <= 0) return coarse
  let best = coarse
  let bestValue = -Infinity
  for (let lag = coarse - HOP; lag <= coarse + HOP; lag++) {
    let v = 0
    if (lag >= 0) for (let i = 0; i < n; i += REFINE_STRIDE) v += sa[HOP + i] * sb[HOP + lag + i]
    else for (let i = 0; i < n; i += REFINE_STRIDE) v += sa[HOP - lag + i] * sb[HOP + i]
    if (v > bestValue) {
      bestValue = v
      best = lag
    }
  }
  return best
}

/**
 * The returned audio moved onto the sent chunk's samples: resampled to 48 kHz (soxr), its first `offsetSamples`
 * dropped (or that many samples of silence put in front when negative), padded or cut to exactly `lengthSamples`,
 * with 10 ms fades at both ends against clicks. A chunk cut inside speech fades over its overlap with the
 * neighbouring chunk instead (`fadeIn`/`fadeOut` seconds; planVoiceChunks says how long), so the two crossfade.
 * Written to `out` (.wav 32-bit float).
 */
export async function alignTo(
  returned: string,
  offsetSamples: number,
  lengthSamples: number,
  out: string,
  o: { fadeIn?: number; fadeOut?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const length = Math.max(1, Math.round(lengthSamples))
  const offset = Math.round(offsetSamples)
  const edge = Math.round(0.01 * MIX_RATE)
  const fadeIn = Math.min(length, o.fadeIn !== undefined ? Math.round(o.fadeIn * MIX_RATE) : edge)
  const fadeOut = Math.min(length, o.fadeOut !== undefined ? Math.round(o.fadeOut * MIX_RATE) : edge)
  const filters = [
    await resampleTo48k(),
    ...(offset > 0 ? [`atrim=start_sample=${offset}`] : offset < 0 ? [`adelay=delays=${-offset}S:all=1`] : []),
    'asetpts=PTS-STARTPTS',
    `apad=whole_len=${length}`,
    `atrim=end_sample=${length}`,
    ...(fadeIn > 0 ? [`afade=t=in:ss=0:ns=${fadeIn}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:ss=${length - fadeOut}:ns=${fadeOut}`] : [])
  ]
  await filterAudio(returned, out, filters, { signal: o.signal, failure: 'Den nya rösten kunde inte passas in' })
}
