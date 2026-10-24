// Pure planning helpers for the Editor, shared by main (plans and jobs), the window (live previews of a plan) and the
// agents' tools: snapping a marked range to what an operation allows, cutting a long voice into chunks Venice bills
// as few minutes as possible for, turning word timestamps into lines, carrying a transcript across a cut, SRT,
// fitting a new line into the gap the old one left, the labels of operations and the price arithmetic.
// Pure (no Node or DOM), like everything in src/shared.

import type { AudioGenModel, EditOperation, EditRange, TranscriptSegment, TranscriptWord } from './types'

/** Re-recording lines: the most lines one operation takes (the window, the plans and the agents' schema). */
export const MAX_SPEAK_LINES = 200

// ── Numbers as the window shows them ─────────────────────────────────────────

/** "0:41.0" (minutes, seconds and tenths; hours when there are any: "1:02:03.4"). Negative and NaN read as 0. */
export function formatTimecode(seconds: number): string {
  const tenths = Math.round((Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * 10)
  const h = Math.floor(tenths / 36_000)
  const m = Math.floor((tenths % 36_000) / 600)
  const s = Math.floor((tenths % 600) / 10)
  const d = tenths % 10
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}.${d}` : `${m}:${ss}.${d}`
}

/** "4.0 s": seconds with one decimal. (The name is kept from when it wrote a Swedish decimal comma.) */
export function formatSecondsSv(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`
}

/**
 * "$0.51" (three decimals under ten cents, "$0.035"); "–" without a price. Dollars are written the way the rest of
 * Studio and the agents' approval dialogs write them, so a card and an approval show the same number the same way.
 */
export function formatPrice(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '–'
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

// ── Ranges ───────────────────────────────────────────────────────────────────

export interface SnapOptions {
  /** The film's length in seconds. */
  duration: number
  /** The frame grid edges are snapped to. */
  fps?: number
  /** Shortest and longest length the operation allows, seconds. */
  min?: number
  max?: number
  /** The model makes whole seconds only (image-to-video): the length becomes a whole number of seconds. */
  wholeSeconds?: boolean
  /** The only lengths the model makes (seconds); the nearest one is used. */
  allowed?: number[]
  /** Points an edge sticks to when it is near: cut markers, transcript line edges. */
  cuts?: number[]
  /** How near (seconds) an edge must be to a cut to stick to it; default 0.2. */
  tolerance?: number
}

/** Below this a change of the range isn't worth a note (well under a frame at any frame rate). */
const SNAP_EPSILON = 0.005

function listText(values: number[]): string {
  const parts = values.map((v) => String(v))
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0]
}

/**
 * The marked range as the operation will use it: inside the film, its edges on cut markers they are near and on the
 * frame grid, and its length one the operation allows (whole seconds, one of the model's lengths, min–max). A length
 * change keeps the start and moves the end, or moves the start back when the end would pass the film's end. `note`
 * says how the range changed when it changed visibly; `problem` says why the operation can't run on
 * this film at all (the film is shorter than the operation's shortest length, nothing is marked).
 */
export function snapRange(r: EditRange, o: SnapOptions): { range: EditRange; note?: string; problem?: string } {
  const duration = Number.isFinite(o.duration) ? Math.max(0, o.duration) : 0
  if (!(duration > 0)) return { range: { start: 0, end: 0 }, problem: 'The film has no length to mark in.' }
  const fps = o.fps && Number.isFinite(o.fps) && o.fps > 0 ? o.fps : undefined
  const clampT = (t: number): number => Math.min(duration, Math.max(0, Number.isFinite(t) ? t : 0))
  let start = clampT(Math.min(r.start, r.end))
  let end = clampT(Math.max(r.start, r.end))

  // Cut markers (and the film's own ends) pull an edge that is near one onto it.
  const tolerance = o.tolerance ?? 0.2
  const points = [0, duration, ...(o.cuts ?? []).filter((c) => Number.isFinite(c) && c > 0 && c < duration)]
  const nearest = (t: number): number => {
    let best = t
    let dist = tolerance
    for (const p of points) {
      const d = Math.abs(p - t)
      if (d <= dist) {
        dist = d
        best = p
      }
    }
    return best
  }
  const snappedStart = nearest(start)
  const snappedEnd = nearest(end)
  // Both edges onto the same marker would leave nothing marked: only the nearer one sticks then.
  if (snappedStart === snappedEnd && end - start > 0) {
    if (Math.abs(snappedStart - start) <= Math.abs(snappedEnd - end)) start = snappedStart
    else end = snappedEnd
  } else {
    start = snappedStart
    end = snappedEnd
  }

  if (fps) {
    start = Math.round(start * fps) / fps
    end = Math.min(duration, Math.round(end * fps) / fps)
  }

  const length = end - start
  const frame = fps ? 1 / fps : 0.01
  const constrained = o.wholeSeconds || !!o.allowed?.length || o.min !== undefined || o.max !== undefined
  if (length < frame / 2 && !constrained) {
    return {
      range: { start: round6(start), end: round6(start) },
      problem: 'The selection is empty. Drag across the timeline to mark a section.'
    }
  }

  let wanted = length
  let why: string | undefined
  const allowed = (o.allowed ?? []).filter((a) => Number.isFinite(a) && a > 0).sort((a, b) => a - b)
  if (allowed.length) {
    wanted = allowed.reduce((best, a) => (Math.abs(a - length) < Math.abs(best - length) ? a : best), allowed[0])
    why = allowed.length <= 4 ? `the model only makes ${listText(allowed)} s` : 'the model makes whole seconds'
  } else if (o.wholeSeconds) {
    wanted = Math.max(1, Math.round(length))
    why = 'the model makes whole seconds'
  }
  if (o.min !== undefined && wanted < o.min - 1e-9) {
    wanted = allowed.length ? (allowed.find((a) => a >= o.min! - 1e-9) ?? o.min) : o.min
    if (o.wholeSeconds) wanted = Math.ceil(wanted - 1e-9)
    why = `at least ${String(o.min)} s`
  }
  if (o.max !== undefined && wanted > o.max + 1e-9) {
    wanted = allowed.length ? ([...allowed].reverse().find((a) => a <= o.max! + 1e-9) ?? o.max) : o.max
    if (o.wholeSeconds) wanted = Math.floor(wanted + 1e-9)
    why = `at most ${String(o.max)} s`
  }
  // A length that isn't fixed by the model stays on the frame grid (rounded inwards to the limit it hit).
  if (fps && !allowed.length && !o.wholeSeconds && Math.abs(wanted - length) > 1e-9) {
    wanted = wanted > length ? Math.ceil(wanted * fps - 1e-6) / fps : Math.floor(wanted * fps + 1e-6) / fps
  }
  if (wanted > duration + 1e-6) {
    return {
      range: { start: 0, end: round6(duration) },
      problem: `The film is only ${formatSecondsSv(duration)} long – the operation needs at least ${formatSecondsSv(wanted)}.`
    }
  }
  if (Math.abs(wanted - length) > 1e-9) {
    end = start + wanted
    if (end > duration) {
      end = duration
      start = Math.max(0, duration - wanted)
    }
  }
  const range = { start: round6(start), end: round6(end) }
  const moved = Math.abs(range.end - range.start - length) > SNAP_EPSILON
  return moved && why
    ? { range, note: `The selection is adjusted to ${formatSecondsSv(range.end - range.start)} — ${why}` }
    : { range }
}

// ── Speech regions and voice chunks ──────────────────────────────────────────

function mergeRanges(ranges: readonly EditRange[], gap = 0): EditRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start)
  const out: EditRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start - last.end < gap + 1e-9) last.end = Math.max(last.end, r.end)
    else out.push(r)
  }
  return out
}

/**
 * Where someone speaks: the complement of the silences found on the voice (silencedetect on the isolated voice stem,
 * not the mix, where music hides the pauses), each widened by `pad` (breaths, reverb tails) and merged across gaps
 * shorter than `mergeGap`.
 */
export function speechRegions(
  silences: EditRange[],
  duration: number,
  o: { pad?: number; mergeGap?: number } = {}
): EditRange[] {
  const pad = o.pad ?? 0.2
  const total = Math.max(0, duration)
  const quiet = mergeRanges(silences.map((s) => ({ start: Math.max(0, s.start), end: Math.min(total, s.end) })))
  const speech: EditRange[] = []
  let cursor = 0
  for (const s of quiet) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < total) speech.push({ start: cursor, end: total })
  const padded = speech.map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(total, r.end + pad) }))
  return mergeRanges(padded, o.mergeGap ?? 0.6).map((r) => ({ start: round6(r.start), end: round6(r.end) }))
}

/** One request to the voice changer: [start, end) of the voice, and what Venice bills for it. */
export interface VoiceChunk {
  start: number
  end: number
  /** ceil((end − start + margin) / billingSeconds). */
  billedMinutes: number
  /**
   * Set where the chunk overlaps its neighbour because a long stretch of speech had to be cut inside it: the two
   * converted chunks are crossfaded over the overlap (alignTo's fadeIn/fadeOut), so the cut is not heard.
   */
  fadeIn?: number
  fadeOut?: number
}

export interface VoiceChunkOptions {
  /** The model's max_source_audio_duration_seconds. */
  maxSeconds: number
  /** Venice bills each request per started minute. */
  billingSeconds?: number
  /** Seconds each side of a cut made inside speech, crossfaded when the chunks are put back together. */
  overlap?: number
  /**
   * Seconds Venice may measure beyond the cut: an MP3 is a few frames longer than what was encoded. A chunk counts
   * as ceil((span + margin) / billingSeconds) minutes and keeps span + margin ≤ maxSeconds − 1.
   */
  margin?: number
  /**
   * Short pauses inside speech (silencedetect with a short minimum on the voice stem), where a stretch of speech
   * longer than a chunk is best cut; without them it is cut where the billing works out best.
   */
  pauses?: EditRange[]
}

const minutesOf = (span: number, margin: number, billing: number): number =>
  Math.max(1, Math.ceil((span + margin) / billing - 1e-9))

/**
 * The fewest billed minutes (then the fewest requests) that send every stretch of speech to the voice changer, as
 * chunks of consecutive speech regions: silence between chunks is never uploaded (the background still plays
 * there), and a chunk may hold silence between its regions when that is cheaper than another request. A speech
 * region longer than one chunk is cut inside it, preferably in a pause, into pieces that each fill whole billed
 * minutes, with `overlap` seconds on each side of the cut for a crossfade.
 */
export function planVoiceChunks(speech: EditRange[], o: VoiceChunkOptions): VoiceChunk[] {
  const billing = o.billingSeconds && o.billingSeconds > 0 ? o.billingSeconds : 60
  const margin = o.margin ?? 0.5
  const overlap = Math.max(0, o.overlap ?? 0.25)
  const limit = Math.max(2 * overlap + 1, o.maxSeconds - 1 - margin)
  const regions = mergeRanges(speech)
  if (!regions.length) return []
  const pauses = mergeRanges(o.pauses ?? [])

  // 1. Atoms: the speech regions, the long ones cut into pieces that overlap at each cut.
  const atoms: EditRange[] = []
  const wholeMinutes = Math.floor((limit + margin) / billing + 1e-9)
  const piece = wholeMinutes >= 1 ? wholeMinutes * billing - margin : limit
  for (const r of regions) {
    let from = r.start
    while (r.end - from > limit + 1e-9) {
      // The cut that fills whole minutes; a pause up to half a piece earlier is better (the cut is not heard there).
      const target = from + piece - overlap
      const earliest = from + Math.max(piece / 2, 2 * overlap + 0.5)
      let cut = target
      let best = -Infinity
      for (const p of pauses) {
        const mid = (p.start + p.end) / 2
        if (mid < earliest || mid > target) continue
        // Longer pauses are quieter places to cut; later ones waste less of the billed minutes.
        const score = (p.end - p.start) * (1 + (mid - earliest) / Math.max(1e-9, target - earliest))
        if (score > best) {
          best = score
          cut = mid
        }
      }
      atoms.push({ start: from, end: cut + overlap })
      from = cut - overlap
    }
    atoms.push({ start: from, end: r.end })
  }

  // 2. Minute-aware DP: chunk = atoms i..j with span ≤ limit; fewest minutes, then fewest chunks.
  const n = atoms.length
  const best: { minutes: number; chunks: number; from: number }[] = [{ minutes: 0, chunks: 0, from: -1 }]
  for (let j = 1; j <= n; j++) {
    let cand = { minutes: Infinity, chunks: Infinity, from: -1 }
    for (let i = j; i >= 1; i--) {
      const span = atoms[j - 1].end - atoms[i - 1].start
      if (span > limit + 1e-9) break
      const prev = best[i - 1]
      const minutes = prev.minutes + minutesOf(span, margin, billing)
      const chunks = prev.chunks + 1
      if (minutes < cand.minutes || (minutes === cand.minutes && chunks < cand.chunks)) {
        cand = { minutes, chunks, from: i - 1 }
      }
    }
    best.push(cand)
  }
  const chunks: VoiceChunk[] = []
  for (let j = n; j > 0; j = best[j].from) {
    const i = best[j].from
    const start = atoms[i].start
    const end = atoms[j - 1].end
    chunks.push({ start: round6(start), end: round6(end), billedMinutes: minutesOf(end - start, margin, billing) })
  }
  chunks.reverse()
  for (let k = 1; k < chunks.length; k++) {
    const shared = chunks[k - 1].end - chunks[k].start
    if (shared > 1e-9) {
      chunks[k - 1].fadeOut = round6(shared)
      chunks[k].fadeIn = round6(shared)
    }
  }
  return chunks
}

/** The whole seconds a voice-changer chunk is quoted for: ceil(span + margin), what Venice will measure at most. */
export function voiceChunkQuoteSeconds(chunk: EditRange, margin = 0.5): number {
  return Math.max(1, Math.ceil(chunk.end - chunk.start + margin - 1e-9))
}

// ── Transcripts ──────────────────────────────────────────────────────────────

const SENTENCE_END = /[.!?…]["'»”’)\]]*$/
const LEADING_PUNCTUATION = /^[,.;:!?…)\]»”’%]/

/** Words as one line of text: a space between words, none before punctuation that came as its own token. */
export function joinWords(words: readonly { text: string }[]): string {
  let text = ''
  for (const w of words) {
    const t = w.text.trim()
    if (!t) continue
    text += text && !LEADING_PUNCTUATION.test(t) ? ` ${t}` : t
  }
  return text
}

function cleanWords(words: readonly TranscriptWord[]): TranscriptWord[] {
  return words
    .filter((w) => w && typeof w.text === 'string' && w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start)
}

/**
 * Lines from word timestamps (Scribe, xAI): a new line after a sentence ends, at a pause longer than `maxGap`, and
 * before a line would run longer than `maxSeconds`. Ids are "s1", "s2"… in order.
 */
export function segmentsFromWords(
  words: TranscriptWord[],
  o: { maxGap?: number; maxSeconds?: number } = {}
): TranscriptSegment[] {
  const maxGap = o.maxGap ?? 0.6
  const maxSeconds = o.maxSeconds ?? 12
  const segments: TranscriptSegment[] = []
  let current: TranscriptWord[] = []
  const flush = (): void => {
    if (!current.length) return
    const text = joinWords(current)
    if (text) {
      segments.push({
        id: `s${segments.length + 1}`,
        start: round6(current[0].start),
        end: round6(Math.max(...current.map((w) => w.end))),
        text,
        words: current
      })
    }
    current = []
  }
  for (const w of cleanWords(words)) {
    const last = current[current.length - 1]
    if (last && (w.start - last.end > maxGap || w.end - current[0].start > maxSeconds)) flush()
    current.push(w)
    if (SENTENCE_END.test(w.text)) flush()
  }
  flush()
  return segments
}

/** Lines from segment timestamps (Whisper, Wizper), with ids "s1", "s2"… and empty lines left out. */
export function segmentsFromTimed(segments: readonly { text: string; start: number; end: number }[]): TranscriptSegment[] {
  return segments
    .filter((s) => s && typeof s.text === 'string' && s.text.trim() && Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ id: `s${i + 1}`, start: round6(Math.max(0, s.start)), end: round6(Math.max(s.start, s.end)), text: s.text.trim() }))
}

/**
 * Lines moved onto where the voice really starts and stops. ASR times can be off by up to a second, so each edge is
 * moved to the edge of the speech region (from silencedetect on the voice stem; unpadded regions work best) that is
 * within a second of it, then padded by `pad`; an edge with no region near it stays. Regions shorter than 0.1 s are
 * blips and ignored. Lines never overlap afterwards and keep their words and text.
 */
export function snapSegments(segments: TranscriptSegment[], speech: EditRange[], pad = 0.15): TranscriptSegment[] {
  const regions = mergeRanges(speech).filter((r) => r.end - r.start >= 0.1)
  const reach = 1
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const out: TranscriptSegment[] = []
  for (const [i, seg] of sorted.entries()) {
    let start = seg.start
    let end = seg.end
    let startDist = reach
    let endDist = reach
    for (const r of regions) {
      if (r.end < seg.start - reach || r.start > seg.end + reach) continue
      const ds = Math.abs(r.start - seg.start)
      if (ds <= startDist && r.start < seg.end) {
        startDist = ds
        start = r.start - pad
      }
      const de = Math.abs(r.end - seg.end)
      if (de <= endDist && r.end > seg.start) {
        endDist = de
        end = r.end + pad
      }
    }
    const prevEnd = out.length ? out[out.length - 1].end : 0
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].start : Infinity
    start = Math.max(0, prevEnd, start)
    end = Math.min(end, Math.max(start + 0.05, nextStart))
    if (end <= start) end = Math.max(start + 0.05, seg.end)
    out.push({ ...seg, start: round6(start), end: round6(end) })
  }
  return out
}

/**
 * A transcript carried onto a version whose timing changed: base [from, to) plays at `at`. A line inside a kept span
 * moves with it, a line in removed material goes, a line cut by an edit keeps its kept part (its text rebuilt from
 * the words that are left, when there are words). Ids stay, so edits of the text survive.
 */
export function remapTranscript(
  segments: TranscriptSegment[],
  spans: { from: number; to: number; at: number }[]
): TranscriptSegment[] {
  const kept = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from)
  // A time inside a kept span, mapped by that span (adjacent spans share their edge, so the span decides).
  const map = (t: number, s: { from: number; to: number; at: number }): number =>
    s.at + (Math.min(Math.max(t, s.from), s.to) - s.from)
  const out: TranscriptSegment[] = []
  for (const seg of segments) {
    const parts = kept
      .map((k) => ({ k, start: Math.max(seg.start, k.from), end: Math.min(seg.end, k.to) }))
      .filter((p) => p.end - p.start > 1e-6)
    if (!parts.length) continue
    const first = parts[0]
    const last = parts[parts.length - 1]
    const start = map(first.start, first.k)
    const end = map(last.end, last.k)
    let words: TranscriptWord[] | undefined
    let text = seg.text
    if (seg.words?.length) {
      words = []
      for (const w of seg.words) {
        // A word stays when its middle was kept; it is clipped to the kept part it sits in.
        const mid = (w.start + w.end) / 2
        const part = parts.find((p) => mid >= p.start - 1e-9 && mid <= p.end + 1e-9)
        if (!part) continue
        const ws = map(Math.max(w.start, part.start), part.k)
        const we = map(Math.min(w.end, part.end), part.k)
        words.push({ text: w.text, start: round6(ws), end: round6(Math.max(ws, we)) })
      }
      if (!words.length) continue
      // Only an untouched line keeps its text as is (it may have been edited by hand); a cut one is rebuilt.
      if (words.length !== seg.words.length) text = joinWords(words)
    }
    out.push({ ...seg, start: round6(start), end: round6(Math.max(start, end)), text, ...(words ? { words } : {}) })
  }
  return out.sort((a, b) => a.start - b.start)
}

function srtTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const pad = (v: number, n = 2): string => String(v).padStart(n, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`
}

/** A subtitle line longer than this is split in two at the space nearest its middle. */
const SRT_LINE = 42

function wrapSubtitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= SRT_LINE) return t
  const mid = t.length / 2
  let best = -1
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i
  return best < 0 ? t : `${t.slice(0, best)}\n${t.slice(best + 1)}`
}

/** The lines as an SubRip (.srt) file: numbered from 1, in time order, empty lines left out. */
export function toSrt(segments: TranscriptSegment[]): string {
  return [...segments]
    .filter((s) => s.text.trim() && s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${wrapSubtitle(s.text)}\n`)
    .join('\n')
}

/**
 * How a new line fits the gap the old one left: tempo 1 when it fits; else sped up as much as needed but at most
 * `maxTempo` (×1.15 still sounds natural), and `overflow` the seconds it still runs past the slot.
 */
export function fitLine(lineSeconds: number, slotSeconds: number, maxTempo = 1.15): { tempo: number; overflow: number } {
  if (!(lineSeconds > 0) || !(slotSeconds > 0) || lineSeconds <= slotSeconds) return { tempo: 1, overflow: 0 }
  const tempo = Math.min(lineSeconds / slotSeconds, Math.max(1, maxTempo))
  return { tempo: round6(tempo), overflow: round6(Math.max(0, lineSeconds / tempo - slotSeconds)) }
}

// ── Operations ───────────────────────────────────────────────────────────────

const PAID_OPS = new Set<EditOperation['op']>([
  'transcribe',
  'change-voice',
  'speak-lines',
  'music',
  'effect',
  'regenerate',
  'prompt-edit',
  'extend',
  'upscale',
  'lip-sync'
])

/** Operations that call Venice (and cost money); the rest are local and free. */
export function isPaidOperation(op: Pick<EditOperation, 'op'>): boolean {
  return PAID_OPS.has(op.op)
}

function excerpt(text: string, max = 32): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const rangeText = (r: EditRange): string => `${formatTimecode(r.start)}–${formatTimecode(r.end)}`
const dbText = (db: number): string => `${db > 0 ? '+' : db < 0 ? '−' : '±'}${String(Math.abs(Math.round(db * 10) / 10))} dB`
const secondsShort = (s: number): string => `${String(Math.round(s * 10) / 10)} s`

/**
 * What an operation did, for the version list and the jobs ("Changed voice → Aria", "Music: calm piano").
 * `voiceName` names the voice of a voice operation, `mediaLabel` the sound an add-audio or layer operation uses.
 */
export function operationLabel(op: EditOperation, ctx: { voiceName?: string; mediaLabel?: string } = {}): string {
  const target = (t: 'all' | 'voice' | 'background' | undefined): string =>
    t === 'voice' ? ' on the voice' : t === 'background' ? ' on the background' : ''
  switch (op.op) {
    case 'trim':
      return `Kept ${rangeText(op.keep)}`
    case 'cut':
      return `Cut out ${rangeText(op.range)}`
    case 'fade': {
      const fin = op.inSeconds && op.inSeconds > 0 ? op.inSeconds : 0
      const fout = op.outSeconds && op.outSeconds > 0 ? op.outSeconds : 0
      if (fin && fout) return `Faded in ${secondsShort(fin)} and out ${secondsShort(fout)}`
      return fin ? `Faded in from black ${secondsShort(fin)}` : `Faded out to black ${secondsShort(fout)}`
    }
    case 'volume':
      return `Volume ${dbText(op.gainDb)}${target(op.target)}${op.range ? ` ${rangeText(op.range)}` : ''}`
    case 'mute':
      if (!op.range) {
        if (op.target === 'voice') return 'Removed the voice'
        if (op.target === 'background') return 'Voice only'
        return 'Muted the whole film'
      }
      return op.target === 'voice'
        ? `Muted the voice ${rangeText(op.range)}`
        : op.target === 'background'
          ? `Muted the background ${rangeText(op.range)}`
          : `Muted ${rangeText(op.range)}`
    case 'denoise':
      return `Removed noise (${op.strength === 'strong' ? 'strong' : 'mild'})`
    case 'loudness':
      return `Evened out the loudness to ${String(op.lufs).replace('-', '−')} LUFS`
    case 'add-audio':
      return op.replaceBed
        ? `Replaced the original sound${ctx.mediaLabel ? `: ${excerpt(ctx.mediaLabel)}` : ''}`
        : `Added sound${ctx.mediaLabel ? `: ${excerpt(ctx.mediaLabel)}` : ''}`
    case 'layer': {
      const name = ctx.mediaLabel ? ` ${excerpt(ctx.mediaLabel)}` : ''
      if (op.remove) return `Removed the layer${name}`
      if (op.at !== undefined && op.gainDb === undefined) return `Moved the layer${name}`
      return `Changed the layer${name}`
    }
    case 'transcribe':
      return 'Transcribed'
    case 'change-voice': {
      const voice = ctx.voiceName ?? (op.voice.kind === 'preset' ? op.voice.voice : 'own voice ID')
      return `Changed voice → ${voice}`
    }
    case 'speak-lines': {
      const voice = ctx.voiceName ?? (op.voice.kind === 'preset' ? op.voice.voice : op.voice.kind === 'custom' ? 'own voice ID' : 'cloned voice')
      const n = op.lines.length
      if (n === 1 && op.lines[0].segmentId === undefined) return `New line: ${excerpt(op.lines[0].text)} (${voice})`
      return `Recorded ${n} ${n === 1 ? 'line' : 'lines'} (${voice})`
    }
    case 'music':
      return `Music: ${excerpt(op.prompt)}`
    case 'effect':
      return `Sound effect: ${excerpt(op.prompt)}`
    case 'regenerate':
      return `Regenerated ${rangeText(op.range)}`
    case 'prompt-edit':
      return `Edited ${rangeText(op.range)}: ${excerpt(op.prompt, 28)}`
    case 'extend':
      return `Extended ${secondsShort(op.seconds)}`
    case 'upscale':
      return `Upscaled ${op.factor}×`
    case 'lip-sync':
      return `Lip-synced ${rangeText(op.range)}`
  }
}

/** What a frame of a picture operation's plan (plan.frames) shows: short for the dialogs, fuller for the agents. */
export interface FrameCaption {
  ui: string
  en: string
}

/**
 * The captions of a picture operation's start and end frames (plan.frames): what Regenerate section starts and ends on,
 * where Extend continues from, what Edit with prompt rewrites. A range starting at the film's first frame starts on
 * that frame, which the take replaces too.
 */
export function frameCaptions(op: EditOperation | undefined): { start: FrameCaption; end: FrameCaption } {
  switch (op?.op) {
    case 'extend':
      return {
        start: {
          ui: "The film's last frame – the extension continues from here",
          en: "Start frame: the film's last frame (the extension continues from it)"
        },
        end: { ui: 'End image', en: 'End frame' }
      }
    case 'prompt-edit':
      return {
        start: { ui: 'The first frame of the selection', en: 'The first frame of the range (the stretch the change rewrites)' },
        end: { ui: 'The last frame of the selection', en: 'The last frame of the range' }
      }
    case 'regenerate':
      return {
        start:
          op.range.start <= 1e-3
            ? {
                ui: "The film's first frame – the section starts there",
                en: "Start frame: the film's first frame (the range starts at the film's start)"
              }
            : { ui: 'The last frame before the selection', en: 'Start frame (the last frame before the range)' },
        end: { ui: 'The first frame after the selection', en: 'End frame (the first frame after the range)' }
      }
    default:
      return { start: { ui: 'Start image', en: 'Start frame' }, end: { ui: 'End image', en: 'End frame' } }
  }
}

/** The video-input models Edit with prompt offers, with the source lengths each takes (seconds). */
export const PICTURE_EDIT_MODELS: Record<
  string,
  { label: string; minSeconds: number; maxSeconds: number; referenceImages: boolean; kind: 'r2v-edit' | 'v2v' }
> = {
  'seedance-2-5-reference-to-video-basic': {
    label: 'Seedance 2.5',
    minSeconds: 4,
    maxSeconds: 30,
    referenceImages: true,
    kind: 'r2v-edit'
  },
  'gemini-omni-flash-1-1-video-to-video': {
    label: 'Gemini Omni Flash 1.1 Edit',
    minSeconds: 1,
    maxSeconds: 10,
    referenceImages: false,
    kind: 'v2v'
  },
  'wan-2-7-video-to-video': { label: 'Wan 2.7 Edit', minSeconds: 2, maxSeconds: 10, referenceImages: false, kind: 'v2v' },
  'happyhorse-1-0-video-to-video': {
    label: 'HappyHorse 1.0 Edit',
    minSeconds: 3,
    maxSeconds: 15,
    referenceImages: false,
    kind: 'v2v'
  },
  // fal.ai's (shared/fal-models.ts): Seedance 2.5's editing task, and Wan's and Gemini's edit endpoints.
  'fal:bytedance/seedance-2.5/reference-to-video': {
    label: 'Seedance 2.5',
    minSeconds: 4,
    maxSeconds: 30,
    referenceImages: true,
    kind: 'r2v-edit'
  },
  'fal:fal-ai/wan/v2.7/edit-video': { label: 'Wan 2.7 Edit', minSeconds: 2, maxSeconds: 10, referenceImages: false, kind: 'v2v' },
  'fal:google/gemini-omni-flash/v1.1/edit': {
    label: 'Gemini Omni Flash 1.1 Edit',
    minSeconds: 1,
    maxSeconds: 10,
    referenceImages: false,
    kind: 'v2v'
  }
}

// ── Price arithmetic ─────────────────────────────────────────────────────────

/** A price cut to a millionth of a dollar, so float sums of list prices (0.0023000000000000004) stay readable. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

/** One /audio/speech line: Venice lists USD per million characters; Studio keeps it per thousand. An estimate. */
export function speechPriceUsd(characters: number, usdPerThousandChars: number): number {
  return roundUsd((Math.max(0, characters) / 1000) * Math.max(0, usdPerThousandChars))
}

/** A transcription: per second of audio sent. */
export function transcriptionPriceUsd(seconds: number, usdPerSecond: number): number {
  return roundUsd(Math.max(0, seconds) * Math.max(0, usdPerSecond))
}

/**
 * The duration_seconds a music or sound-effect request sends for a wanted length: clamped to the model's min–max,
 * or the shortest of its fixed lengths that covers it (else the longest; ACE-Step makes only 60…210 s); undefined for
 * a model that takes no duration (Lyria picks its own length). Always a whole number of seconds.
 */
export function audioDurationFor(
  model: Pick<AudioGenModel, 'minSeconds' | 'maxSeconds' | 'durationOptions' | 'durationControl'>,
  wantedSeconds: number
): number | undefined {
  if (!model.durationControl) return undefined
  const wanted = Math.max(1, Math.ceil((Number.isFinite(wantedSeconds) ? wantedSeconds : 1) - 1e-9))
  const options = (model.durationOptions ?? []).filter((d) => Number.isInteger(d) && d > 0).sort((a, b) => a - b)
  if (options.length) return options.find((d) => d >= wanted) ?? options[options.length - 1]
  const min = Math.max(1, Math.ceil(model.minSeconds))
  const max = Math.max(min, Math.floor(model.maxSeconds))
  return Math.min(max, Math.max(min, wanted))
}

/**
 * The total of an operation's parts: the sum of those Venice prices, `partialPrice` when a part has no price (a
 * voice clone), and no price at all when none of them has one.
 */
export function totalPrice(parts: readonly (number | undefined)[]): { priceUsd?: number; partialPrice: boolean } {
  const known = parts.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  if (!known.length) return { partialPrice: false }
  return { priceUsd: roundUsd(known.reduce((sum, p) => sum + p, 0)), partialPrice: known.length < parts.length }
}

/** The price note of a per-minute billed operation: "billed per started minute: 3 min". */
export function minuteBillingNote(minutes: number): string {
  return `billed per started minute: ${Math.max(0, Math.round(minutes))} min`
}
