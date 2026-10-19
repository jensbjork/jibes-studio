import { formatPlace, formatPlaceLength } from '@shared/song'
import { MIN_SONG_WINDOW_SECONDS, windowLength } from '@shared/song-window'
import type { Generation, Segment, Sequence, SongPart, SongWindow, SongWork, TakeSongSync } from '@shared/types'

// Words and small pure rules of a sequence cut to a song (Sequence.song): places, boundaries, beats, progress and a
// take's sync, as the song strip, the clip editor's song box, the header and the preview say them.

/** "8.0 s": a place's length, always to a tenth (a place is read against its neighbours). */
export function songSeconds(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`
}

/** "0:16.0 – 0:24.0 · 8.0 s": a clip's place in the song (as main and the agents write it). */
export function placeText(w: Pick<SongWindow, 'start' | 'end'>): string {
  return `${formatPlace(w.start, w.end)} · ${formatPlaceLength(w.start, w.end)}`
}

/** "9 s for 8.0 s of the song": a song clip's automatic duration. */
export function durationText(duration: string, w: Pick<SongWindow, 'start' | 'end'>): string {
  return `${duration.replace(/s$/, ' s')} for ${songSeconds(windowLength(w))} of the song`
}

export const PART_LABEL: Record<SongPart, string> = {
  vocals: 'Vocals – lip sync',
  mix: 'Music – mood and rhythm',
  none: 'No song'
}

export const PART_HINT: Record<SongPart, string> = {
  vocals: "The song's voice at this place is sent, for a shot of someone singing it.",
  mix: 'The whole song at this place is sent: the shot moves with its rhythm and mood.',
  none: 'Nothing of the song is sent. It still plays over the clip in the film.'
}

/** "Separating the vocals… 40%" (no share while none is known: a step that doesn't report progress stays at 0). */
export function workText(work: SongWork): string {
  const what = {
    copying: 'Copying the song…',
    separating: 'Separating the vocals…',
    transcribing: 'Transcribing the lyrics…',
    analysing: 'Finding the beat…',
    splitting: 'Splitting the song into clips…'
  }[work.stage]
  return work.fraction ? `${what} ${Math.round(Math.min(1, Math.max(0, work.fraction)) * 100)}%` : what
}

/** A clip's place as it is now, or undefined for a clip without one (an ordinary sequence, or not split yet). */
export function placeOf(segment: Segment): SongWindow | undefined {
  const w = segment.params.song
  return w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start ? w : undefined
}

/** The clips that have a place, in order, with their places. */
export function placedClips(sequence: Sequence): { segment: Segment; index: number; place: SongWindow }[] {
  return sequence.segments.flatMap((segment, index) => {
    const place = placeOf(segment)
    return place ? [{ segment, index, place }] : []
  })
}

/**
 * The cut points between the clips' places (setSongSections' argument): where each place but the last ends. Only
 * when every clip has a place; otherwise undefined (the song is still being split).
 */
export function boundariesOf(sequence: Sequence): number[] | undefined {
  const places = sequence.segments.map(placeOf)
  if (!places.length || places.some((p) => !p)) return undefined
  return (places as SongWindow[]).slice(0, -1).map((p) => p.end)
}

/** The beat nearest `t`, or `t` to a tenth when there are no beats. */
export function snapToBeat(t: number, beats: readonly number[] | undefined): number {
  if (!beats?.length) return Math.round(t * 10) / 10
  let best = beats[0]
  for (const b of beats) if (Math.abs(b - t) < Math.abs(best - t)) best = b
  return best
}

/** The next (direction 1) or previous (-1) beat from `t`; `t` ± 0.5 s without beats. */
export function stepBeat(t: number, direction: 1 | -1, beats: readonly number[] | undefined): number {
  if (!beats?.length) return round2(t + direction * 0.5)
  if (direction > 0) return beats.find((b) => b > t + 0.01) ?? t
  return [...beats].reverse().find((b) => b < t - 0.01) ?? t
}

/**
 * Boundary `i` moved to `t`: the new list, or why not. Each place keeps at least MIN_SONG_WINDOW_SECONDS, so `t` is
 * held inside its neighbours with that margin; `held` says the drag was stopped there (and which clip it was for).
 */
export function moveBoundary(
  boundaries: readonly number[],
  i: number,
  t: number,
  duration: number
): { boundaries: number[]; held?: string } {
  const lo = (i > 0 ? boundaries[i - 1] : 0) + MIN_SONG_WINDOW_SECONDS
  const hi = (i < boundaries.length - 1 ? boundaries[i + 1] : duration) - MIN_SONG_WINDOW_SECONDS
  const next = [...boundaries]
  if (lo > hi) return { boundaries: next, held: minimumText(i + 1) }
  const clamped = round2(Math.min(hi, Math.max(lo, t)))
  next[i] = clamped
  const held = t < lo - 0.01 ? minimumText(i + 1) : t > hi + 0.01 ? minimumText(i + 2) : undefined
  return { boundaries: next, held }
}

/** "Clip 3's place can't be shorter than 2 s – a shorter one can't send any of the song." */
export function minimumText(clipNumber: number): string {
  return `Clip ${clipNumber}'s place can't be shorter than ${MIN_SONG_WINDOW_SECONDS} s – a shorter one can't send any of the song.`
}

/** Why the place can't be split at `t`, or undefined when it can. */
export function splitProblem(place: SongWindow, t: number, clipNumber: number): string | undefined {
  if (t <= place.start || t >= place.end) return `The playhead isn't in clip ${clipNumber}'s place.`
  const before = t - place.start
  const after = place.end - t
  if (before < MIN_SONG_WINDOW_SECONDS || after < MIN_SONG_WINDOW_SECONDS) {
    return `Can't split clip ${clipNumber} here: both parts need at least ${MIN_SONG_WINDOW_SECONDS} s (they would be ${songSeconds(before)} and ${songSeconds(after)}). Move the playhead.`
  }
  return undefined
}

/** The clip whose place holds `t` (the last one for the song's very end). */
export function clipAt(
  sequence: Sequence,
  t: number
): { segment: Segment; index: number; place: SongWindow } | undefined {
  const placed = placedClips(sequence)
  const last = placed.at(-1)
  return placed.find((c) => t >= c.place.start && t < c.place.end) ?? (last && t >= last.place.end - 1e-6 ? last : undefined)
}

export type SyncState =
  /** Its singing was found against the song's vocals (measured 'vocals', matched). */
  | { kind: 'in-sync'; sync: TakeSongSync }
  /** Measured against the vocals, but no singing was found there. */
  | { kind: 'not-found'; sync: TakeSongSync }
  /** Made for a place in the song and not measured yet: main measures every finished take of a song clip. */
  | { kind: 'measuring' }
  /** Nothing to say: a Music or No song take (measured 'none'), or a take made without a place (an own film). */
  | { kind: 'none' }

/** Where the take's singing sits against its place (Segment.songSyncs), as the song box and the take tiles say it. */
export function syncState(segment: Segment, take: Generation | undefined): SyncState {
  if (!take || take.status !== 'completed') return { kind: 'none' }
  const sync = segment.songSyncs?.[take.id]
  if (sync) {
    if (sync.measured !== 'vocals') return { kind: 'none' }
    return sync.matched ? { kind: 'in-sync', sync } : { kind: 'not-found', sync }
  }
  return take.params.song ? { kind: 'measuring' } : { kind: 'none' }
}

/** "+0.32 s". */
export function offsetText(seconds: number): string {
  return `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(2)} s`
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
