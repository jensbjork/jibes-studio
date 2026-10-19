// A sequence cut to a song (Sequence.song): the pure rules main, the window and the agents' tools share.
//
// - Stored form: a song and its lyrics, and a clip's place in the song (GenerationParams.song), from the window, an
//   agent or stored JSON, with anything malformed dropped.
// - Places: the clips cover the song end to end, in order, without gaps; the cut points ("boundaries", strictly inside
//   the song) say where one clip's place ends and the next begins. Each place is at least MIN_SONG_WINDOW_SECONDS; a
//   longer one than MAX_SONG_WINDOW_SECONDS is allowed, but only its first 15 s are sent (song-window.ts).
// - Suggested cut points: about every `targetSeconds`, in the pauses between sung lines (or where the vocals pause),
//   on a bar or a beat, never in the middle of a word when it can be helped.
// - Lyrics: lines from a transcription's words (or its segments), and a line corrected by hand keeps its timing
//   (retimeLine).
// Pure (no Node or DOM), like everything in src/shared.

import { formatTimecode, joinWords } from './edit-plan'
import { lyricsInWindow, MAX_SONG_WINDOW_SECONDS, MIN_SONG_WINDOW_SECONDS } from './song-window'
import type { SequenceSong, SongLyricLine, SongLyrics, SongPart, SongWindow, TranscriptWord } from './types'

/** What a song clip can hear of the song, in the order the window offers them. */
export const SONG_PARTS: readonly SongPart[] = ['vocals', 'mix', 'none']

/** The clip lengths "New sequence from a song…" offers. */
export const SONG_TARGET_CHOICES: readonly number[] = [4, 6, 8, 10, 12]

/** The longest song Studio takes (the analysis decodes the whole song at once). */
export const MAX_SONG_SECONDS = 15 * 60

/** The shortest: a song must hold at least one clip's place. */
export const MIN_SONG_SECONDS = MIN_SONG_WINDOW_SECONDS

export function isSongPart(value: unknown): value is SongPart {
  return typeof value === 'string' && (SONG_PARTS as readonly string[]).includes(value)
}

/** Times are kept to the millisecond. */
const ms = (t: number): number => Math.round(t * 1000) / 1000
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ── Stored form ──────────────────────────────────────────────────────────────

/**
 * A clip's place in the song from the window, an agent or stored JSON: finite times in milliseconds, start ≥ 0 and end
 * after start, what it hears (an unknown part reads as 'mix', which claims no singing), who sings (a character id,
 * null for nobody, else left out) and the words filled in when a take was sent. undefined when it isn't a place.
 */
export function sanitizeSongWindow(input: unknown): SongWindow | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const w = input as Record<string, unknown>
  if (!finite(w.start) || !finite(w.end)) return undefined
  const start = ms(Math.max(0, w.start))
  const end = ms(w.end)
  if (!(end > start)) return undefined
  const out: SongWindow = { start, end, part: isSongPart(w.part) ? w.part : 'mix' }
  if (w.singer === null) out.singer = null
  else if (typeof w.singer === 'string' && w.singer) out.singer = w.singer
  if (typeof w.lyrics === 'string' && w.lyrics.trim()) out.lyrics = w.lyrics
  return out
}

function sanitizeWords(input: unknown): TranscriptWord[] {
  if (!Array.isArray(input)) return []
  const out: TranscriptWord[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const w = item as Record<string, unknown>
    if (typeof w.text !== 'string' || !w.text.trim() || !finite(w.start) || !finite(w.end)) continue
    const start = ms(Math.max(0, w.start))
    out.push({ text: w.text.trim(), start, end: Math.max(start, ms(w.end)) })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** One lyric line as stored: its words with their times (sorted), its text, start and end. undefined when malformed. */
export function sanitizeLyricLine(input: unknown): SongLyricLine | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const l = input as Record<string, unknown>
  const words = sanitizeWords(l.words)
  const text = typeof l.text === 'string' ? l.text.replace(/\s+/gu, ' ').trim() : joinWords(words)
  if (!text) return undefined
  const start = finite(l.start) ? ms(Math.max(0, l.start)) : words[0]?.start
  const end = finite(l.end) ? ms(l.end) : words[words.length - 1]?.end
  if (start === undefined || end === undefined || end < start) return undefined
  return { start, end, text, words, ...(l.edited === true ? { edited: true } : {}) }
}

/** The lyrics as stored: their lines in time order, with what they were made with. undefined when it isn't lyrics. */
export function sanitizeLyrics(input: unknown): SongLyrics | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const l = input as Record<string, unknown>
  if (!Array.isArray(l.lines)) return undefined
  const lines = l.lines.flatMap((line) => sanitizeLyricLine(line) ?? []).sort((a, b) => a.start - b.start)
  const now = Date.now()
  const createdAt = finite(l.createdAt) ? l.createdAt : now
  return {
    lines,
    ...(typeof l.model === 'string' && l.model ? { model: l.model } : {}),
    ...(typeof l.language === 'string' && l.language ? { language: l.language } : {}),
    ...(finite(l.costUsd) && l.costUsd >= 0 ? { costUsd: l.costUsd } : {}),
    createdAt,
    updatedAt: finite(l.updatedAt) ? l.updatedAt : createdAt
  }
}

/**
 * A sequence's song as stored or sent (paths as they come: relative in the database, absolute over IPC): its file, the
 * name it was imported with (the file's name when missing), its length, the vocals and the lyrics. undefined when it
 * has no file or no length.
 */
export function sanitizeSequenceSong(input: unknown): SequenceSong | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const s = input as Record<string, unknown>
  if (typeof s.path !== 'string' || !s.path || !finite(s.duration) || !(s.duration > 0)) return undefined
  const name = typeof s.name === 'string' && s.name.trim() ? s.name : (s.path.split(/[/\\]/).pop() ?? s.path)
  const lyrics = sanitizeLyrics(s.lyrics)
  return {
    path: s.path,
    name,
    duration: ms(s.duration),
    ...(typeof s.vocalsPath === 'string' && s.vocalsPath ? { vocalsPath: s.vocalsPath } : {}),
    ...(lyrics ? { lyrics } : {})
  }
}

// ── Words on the screen ──────────────────────────────────────────────────────

/** "0:16.0": a moment in the song as the window shows it. */
export function formatSongTime(seconds: number): string {
  return formatTimecode(seconds)
}

/** "0:16.0 – 0:24.0": a place in the song. */
export function formatPlace(start: number, end: number): string {
  return `${formatSongTime(start)} – ${formatSongTime(end)}`
}

/** "8.0 s". */
export function formatPlaceLength(start: number, end: number): string {
  return `${(Math.round(Math.max(0, end - start) * 10) / 10).toFixed(1)} s`
}

// ── Places ───────────────────────────────────────────────────────────────────

/** The places the cut points make: from 0 to the first, between each two, from the last to the song's end. */
export function placesOf(boundaries: readonly number[], duration: number): { start: number; end: number }[] {
  const edges = [0, ...boundaries, duration]
  return edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1] }))
}

/** The cut points between places that follow each other (each place's start after the first). */
export function boundariesOf(places: readonly { start: number }[]): number[] {
  return places.slice(1).map((p) => p.start)
}

/**
 * Cut points from the window or an agent, checked against a song of `duration` seconds: numbers (seconds into the
 * song) strictly inside it, going up, every place they make at least MIN_SONG_WINDOW_SECONDS long. Returned in
 * milliseconds; throws with a reason the user can act on.
 */
export function checkSongBoundaries(input: unknown, duration: number): number[] {
  if (!Array.isArray(input) || !input.every((t) => finite(t))) {
    throw new Error('The boundaries must be a list of seconds into the song.')
  }
  const cuts = (input as number[]).map(ms)
  cuts.forEach((t, i) => {
    if (t <= 0 || t >= duration) {
      throw new Error(
        `Boundary ${i + 1} (${formatSongTime(t)}) is outside the song (${formatPlace(0, duration)}): boundaries lie strictly inside it.`
      )
    }
    if (i > 0 && t <= cuts[i - 1]) {
      throw new Error(`The boundaries must go up: ${formatSongTime(t)} comes after ${formatSongTime(cuts[i - 1])}.`)
    }
  })
  placesOf(cuts, duration).forEach((p, i) => {
    if (p.end - p.start < MIN_SONG_WINDOW_SECONDS - 1e-6) {
      throw new Error(
        `Place ${i + 1} (${formatPlace(p.start, p.end)}) would be ${formatPlaceLength(p.start, p.end)}: a clip's place in the song must be at least ${MIN_SONG_WINDOW_SECONDS} s.`
      )
    }
  })
  return cuts
}

/** Said of a place longer than the 15 s Venice takes: only its start is sent. Undefined for one that fits. */
export function longPlaceNote(start: number, end: number): string | undefined {
  if (end - start <= MAX_SONG_WINDOW_SECONDS + 1e-6) return undefined
  return `The place is ${formatPlaceLength(start, end)} long: only its first ${MAX_SONG_WINDOW_SECONDS} s of the song are sent.`
}

/** The seconds in [start, end) where any of `intervals` lies. */
function covered(intervals: readonly { start: number; end: number }[], start: number, end: number): number {
  let total = 0
  for (const r of intervals) total += Math.max(0, Math.min(end, r.end) - Math.max(start, r.start))
  return total
}

/**
 * The vocals are sung for at least this long in a place (or a quarter of a shorter one) for it to start as a 'vocals'
 * clip without lyrics: less is a breath or what the separation let through.
 */
const ACTIVE_SECONDS = 1

/**
 * What a new clip's place hears by default: 'vocals' (lip sync) when the lyrics have words there – or, without lyrics,
 * when the vocals are clearly active there (`vocalActivity`: where they sing) – else 'mix' (mood and rhythm).
 */
export function defaultSongPart(
  start: number,
  end: number,
  lyrics: SongLyrics | undefined,
  vocalActivity?: readonly { start: number; end: number }[]
): SongPart {
  if (lyrics?.lines.length) return lyricsInWindow(lyrics, start, end) ? 'vocals' : 'mix'
  if (!vocalActivity) return 'mix'
  const sung = covered(vocalActivity, start, end)
  return sung >= Math.min(ACTIVE_SECONDS, (end - start) / 4) ? 'vocals' : 'mix'
}

/**
 * Where a place [start, end) is split in two (a clip added after it): the beat nearest its middle that leaves both
 * halves at least MIN_SONG_WINDOW_SECONDS, else the middle itself; undefined when the place is too short to split.
 */
export function splitPoint(start: number, end: number, beats: readonly number[] = []): number | undefined {
  const min = MIN_SONG_WINDOW_SECONDS
  if (end - start < 2 * min - 1e-6) return undefined
  const middle = (start + end) / 2
  let best: number | undefined
  for (const b of beats) {
    if (b < start + min - 1e-6 || b > end - min + 1e-6) continue
    if (best === undefined || Math.abs(b - middle) < Math.abs(best - middle) - 1e-9) best = b
  }
  return ms(best ?? middle)
}

/**
 * `count` places spread evenly over a song of `duration` seconds (cut points on the beat nearest each even point when
 * that keeps every place at least 2 s). Fewer when the song is too short for that many: as many as fit.
 */
export function evenBoundaries(count: number, duration: number, beats: readonly number[] = []): number[] {
  const n = Math.max(1, Math.min(Math.floor(count), Math.floor(duration / MIN_SONG_WINDOW_SECONDS)))
  const cuts: number[] = []
  for (let i = 1; i < n; i++) {
    const even = (i * duration) / n
    const previous = cuts[cuts.length - 1] ?? 0
    const nextEven = ((i + 1) * duration) / n
    let best = even
    for (const b of beats) {
      if (Math.abs(b - even) >= Math.abs(best - even)) continue
      if (b - previous < MIN_SONG_WINDOW_SECONDS || nextEven - b < MIN_SONG_WINDOW_SECONDS) continue
      if (Math.abs(b - even) <= duration / n / 4) best = b
    }
    cuts.push(ms(best))
  }
  return cuts
}

// ── Suggested cut points ─────────────────────────────────────────────────────

export interface SectionInput {
  /** The song's length (seconds). */
  duration: number
  /** Beat times (seconds), ascending; [] when no steady beat was found. */
  beats: readonly number[]
  /** Bar starts among the beats, when the bars were found. */
  bars?: readonly number[]
  lyrics?: SongLyrics
  /** Where the vocals pause (without lyrics): cut points there don't cut into singing. */
  vocalPauses?: readonly { start: number; end: number }[]
  /** About how long each place should be (clamped to 2–15 s). */
  targetSeconds: number
}

/** What a cut point costs where it lies (lower is better), on top of what the places' lengths cost. */
const COST = {
  /** In the middle of a sung word. */
  inWord: 8,
  /** Between two words of a line. */
  inLine: 3,
  /** In a breath between two words of a line (a gap of at least PHRASE_GAP). */
  inPhrase: 1.4,
  /** Right before a line starts or right after it ends (within EDGE_SECONDS): the singer needs a moment. */
  nearLine: 0.3,
  /** Where the vocals sing (vocal activity known, no lyrics). */
  singing: 1.5,
  /** On a beat that isn't the first of a bar (bars known). */
  offBar: 0.4,
  /** Not on a beat at all (a beat was found). */
  offBeat: 1.2,
  /** Weight of a place's distance from the target length: weight · ((length − target) / target)². */
  length: 4
} as const
const PHRASE_GAP = 0.35
const EDGE_SECONDS = 0.25
/** Candidates are also put on this grid where no beat is near, so a split always exists. */
const GRID_SECONDS = 0.5

/**
 * The cut points a song suggests for places of about `targetSeconds`: chosen together (dynamic programming over the
 * candidates: every beat, the middle of every pause between lines, a fallback grid) so that every place is 2–15 s, the
 * places come close to the target, and the cuts fall between sung lines (or where the vocals pause) on a bar or a beat
 * rather than in a word. Deterministic; ascending, strictly inside the song, in milliseconds. [] for a song too short
 * to split.
 */
export function suggestSections(input: SectionInput): number[] {
  const duration = input.duration
  const min = MIN_SONG_WINDOW_SECONDS
  const max = MAX_SONG_WINDOW_SECONDS
  if (!finite(duration) || duration < 2 * min) return []
  const target = Math.min(max, Math.max(min, finite(input.targetSeconds) ? input.targetSeconds : 8))
  if (duration <= target * 1.25 && duration <= max) return []

  const beats = [...input.beats].filter((b) => finite(b) && b > 0 && b < duration).sort((a, b) => a - b)
  const bars = new Set((input.bars ?? []).map(ms))
  const lines = input.lyrics?.lines ?? []
  const words = lines.flatMap((l) => l.words)
  const pauses = input.vocalPauses

  // The candidates: beats, the middle of every gap between lines (and of every vocal pause), and a grid where nothing
  // else is near.
  const points = new Set<number>()
  for (const b of beats) points.add(ms(b))
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i + 1].start > lines[i].end) points.add(ms((lines[i].end + lines[i + 1].start) / 2))
  }
  for (const p of pauses ?? []) if (p.end > p.start) points.add(ms((p.start + p.end) / 2))
  const sorted = [...points].sort((a, b) => a - b)
  for (let t = GRID_SECONDS; t < duration; t += GRID_SECONDS) {
    const g = ms(t)
    if (!sorted.some((p) => Math.abs(p - g) < GRID_SECONDS / 2)) points.add(g)
  }
  const candidates = [...points].filter((t) => t >= min - 1e-6 && t <= duration - min + 1e-6).sort((a, b) => a - b)

  const onBeat = (t: number): boolean => beats.some((b) => Math.abs(b - t) < 0.02)
  const pointCost = (t: number): number => {
    let cost = 0
    if (beats.length) {
      if (!onBeat(t)) cost += COST.offBeat
      else if (bars.size && !bars.has(ms(t)) && ![...bars].some((b) => Math.abs(b - t) < 0.02)) cost += COST.offBar
    }
    if (words.length) {
      const line = lines.find((l) => t > l.start && t < l.end)
      if (words.some((w) => t > w.start && t < w.end)) cost += COST.inWord
      else if (line) {
        const before = [...line.words].reverse().find((w) => w.end <= t)
        const after = line.words.find((w) => w.start >= t)
        cost += before && after && after.start - before.end >= PHRASE_GAP ? COST.inPhrase : COST.inLine
      } else if (lines.some((l) => (l.start >= t && l.start - t < EDGE_SECONDS) || (t >= l.end && t - l.end < EDGE_SECONDS))) {
        cost += COST.nearLine
      }
    } else if (pauses) {
      if (!pauses.some((p) => t >= p.start && t <= p.end)) cost += COST.singing
    }
    return cost
  }
  const lengthCost = (length: number): number => COST.length * ((length - target) / target) ** 2

  // best[i]: the cheapest way to cut the song up to nodes[i], with every place 2–15 s.
  const nodes = [0, ...candidates, duration]
  const own = nodes.map((t, i) => (i === 0 || i === nodes.length - 1 ? 0 : pointCost(t)))
  const best = new Array<number>(nodes.length).fill(Infinity)
  const from = new Array<number>(nodes.length).fill(-1)
  best[0] = 0
  let lo = 0
  for (let i = 1; i < nodes.length; i++) {
    while (nodes[i] - nodes[lo] > max + 1e-6) lo++
    for (let j = lo; j < i; j++) {
      const length = nodes[i] - nodes[j]
      if (length < min - 1e-6) break
      if (best[j] === Infinity) continue
      const cost = best[j] + lengthCost(length) + own[i]
      if (cost < best[i] - 1e-9) {
        best[i] = cost
        from[i] = j
      }
    }
  }
  const last = nodes.length - 1
  if (best[last] === Infinity) return evenBoundaries(Math.round(duration / target), duration, beats)
  const cuts: number[] = []
  for (let i = from[last]; i > 0; i = from[i]) cuts.push(ms(nodes[i]))
  return cuts.reverse()
}

// ── Lyrics ───────────────────────────────────────────────────────────────────

/** A line ends after a sentence or a clause. */
const LINE_END = /[.!?…,;:]["'»”’)\]]*$/
/** Words longer apart than this are separate lines. */
const LINE_GAP = 0.6
/** At most this many words to a line. */
const MAX_LINE_WORDS = 10

/** What a transcription gives back (venice-audio transcribe): word times, or segment times, or neither. */
export interface AsrResult {
  text?: string
  words?: readonly TranscriptWord[]
  segments?: readonly { text: string; start: number; end: number }[]
}

/** The words of a text (split at white space). */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean)
}

/**
 * `texts` sharing the span [start, end] in proportion to their length (characters, at least one each), back to back:
 * how a line's words are timed when a transcription gives only the line's times or the words were changed by hand.
 */
export function spreadWords(texts: readonly string[], start: number, end: number): TranscriptWord[] {
  const weights = texts.map((t) => Math.max(1, [...t].length))
  const total = weights.reduce((a, b) => a + b, 0)
  const span = Math.max(0, end - start)
  let at = start
  return texts.map((text, i) => {
    const length = (span * weights[i]) / total
    const word = { text, start: ms(at), end: ms(i === texts.length - 1 ? end : at + length) }
    at += length
    return word
  })
}

function lineOf(words: readonly TranscriptWord[], text = joinWords(words)): SongLyricLine {
  return {
    start: ms(words[0].start),
    end: ms(Math.max(...words.map((w) => w.end))),
    text,
    words: words.map((w) => ({ text: w.text, start: ms(w.start), end: ms(w.end) }))
  }
}

/**
 * The lyric lines of a transcription. With word times (Scribe, xAI) and segments, each segment is a line with the
 * words whose middle lies in it; with words alone, a line ends after a sentence or clause, at a pause longer than
 * LINE_GAP, or at MAX_LINE_WORDS words. With segment times only (Whisper), each segment is a line whose words share
 * its span (spreadWords). Lines without words are left out; [] without any times.
 */
export function lyricLines(asr: AsrResult): SongLyricLine[] {
  const words = sanitizeWords(asr.words)
  const segments = (asr.segments ?? [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim() && finite(s.start) && finite(s.end) && s.end >= s.start)
    .map((s) => ({ text: s.text.replace(/\s+/gu, ' ').trim(), start: Math.max(0, s.start), end: s.end }))
    .sort((a, b) => a.start - b.start)
  const lines: SongLyricLine[] = []
  if (words.length && segments.length) {
    const groups = segments.map(() => [] as TranscriptWord[])
    for (const w of words) {
      const mid = (w.start + w.end) / 2
      let at = segments.findIndex((s) => mid >= s.start && mid < s.end)
      // A word between segments goes with the nearest one.
      if (at < 0) {
        at = 0
        segments.forEach((s, i) => {
          const d = Math.min(Math.abs(mid - s.start), Math.abs(mid - s.end))
          const bestD = Math.min(Math.abs(mid - segments[at].start), Math.abs(mid - segments[at].end))
          if (d < bestD) at = i
        })
      }
      groups[at].push(w)
    }
    for (const group of groups) if (group.length) lines.push(lineOf(group))
    return lines
  }
  if (words.length) {
    let current: TranscriptWord[] = []
    const flush = (): void => {
      if (current.length) lines.push(lineOf(current))
      current = []
    }
    for (const w of words) {
      const last = current[current.length - 1]
      if (last && (w.start - last.end > LINE_GAP || current.length >= MAX_LINE_WORDS)) flush()
      current.push(w)
      if (LINE_END.test(w.text) && current.length >= 2) flush()
    }
    flush()
    return lines
  }
  for (const s of segments) {
    const texts = wordsOf(s.text)
    if (texts.length) lines.push(lineOf(spreadWords(texts, s.start, s.end), s.text))
  }
  return lines
}

/**
 * A line corrected by hand (or by an agent): `text` becomes its words. The same number of words keeps every word's
 * time (a misheard word replaced); otherwise the new words share the line's span in proportion to their length. The
 * line keeps its start and end and is marked edited. Throws for an empty text (remove the line instead).
 */
export function retimeLine(line: SongLyricLine, text: string): SongLyricLine {
  const texts = wordsOf(typeof text === 'string' ? text : '')
  if (!texts.length) throw new Error('A line of the lyrics cannot be empty.')
  const words =
    texts.length === line.words.length
      ? line.words.map((w, i) => ({ text: texts[i], start: w.start, end: w.end }))
      : spreadWords(texts, line.start, line.end)
  return { start: line.start, end: line.end, text: texts.join(' '), words, edited: true }
}
