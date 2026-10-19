// Cutting a sequence to its song: where each clip's take is cut (Segment.trimStart/trimEnd) and whether the clips'
// places can make the film. A take is made a little longer than its place (SONG_HEADROOM_SECONDS) and its singing may
// come in late: the cut starts it where its place in the song begins (TakeSongSync.offset, measured when it finished),
// moved on by however far the clip's place has moved since the take was made, plus the user's nudge, and keeps exactly
// the place's length. Pure: main (song-sync.ts, the export) and the window work it out the same way.

import { formatPlace, formatSongTime } from './song'
import { windowLength } from './song-window'
import type { SongWindow } from './types'

/** The shortest piece of a take a trim may leave (sequence-store.MIN_REMAINING_SECONDS). */
const MIN_REMAINING_SECONDS = 0.2
/** Places meet when their times agree to the millisecond (they are stored to the millisecond). */
const SAME_TIME = 0.0015

const ms = (t: number): number => Math.round(t * 1000) / 1000

/**
 * Seconds into the take where the clip's place begins, before any nudge: the measured offset (where the take's own
 * place begins in it) plus how far the clip's place starts after the place the take was made for. A take made without
 * a place (an own clip, one made before the song) starts where its offset says, 0.
 */
export function songTrimBase(
  offset: number,
  place: Pick<SongWindow, 'start'>,
  takePlace: Pick<SongWindow, 'start'> | undefined
): number {
  const moved = takePlace ? place.start - takePlace.start : 0
  return (Number.isFinite(offset) ? offset : 0) + moved
}

/** A song clip's cut of its take. */
export interface SongCut {
  trimStart: number
  trimEnd: number
  /** Seconds the take is too short to fill its place from trimStart on (0 if it does): the film holds its last frame. */
  shortBy: number
}

/**
 * The trims that cut a take to exactly its clip's place: from `start` (songTrimBase plus the nudge, never before the
 * take nor so late that less than 0.2 s is left) for the place's length, the rest trimmed off the end. A take too short
 * for that keeps all of its end (trimEnd 0) and says by how much it is short.
 */
export function songCut(takeLength: number, start: number, place: Pick<SongWindow, 'start' | 'end'>): SongCut {
  const length = windowLength(place)
  const room = Math.max(0, takeLength - MIN_REMAINING_SECONDS)
  const trimStart = ms(Math.min(room, Math.max(0, Number.isFinite(start) ? start : 0)))
  const rest = takeLength - trimStart - length
  return { trimStart, trimEnd: ms(Math.max(0, rest)), shortBy: ms(Math.max(0, -rest)) }
}

/** "The take is 0.4 s short of its place in the song": a clip problem the film can live with (its last frame holds). */
export function shortTakeNote(shortBy: number): string | undefined {
  if (!(shortBy >= 0.05)) return undefined
  return `The take is ${(Math.round(shortBy * 10) / 10).toFixed(1)} s short of its place in the song: the film holds its last frame.`
}

/**
 * Why the clips can't be cut to the song as they stand, or undefined: every clip needs a place, the first starting at
 * the song's beginning, each next one where the one before ends, the last ending with the song. `places[i]` is clip
 * i + 1's (undefined: none).
 */
export function songPlacesProblem(
  places: readonly (Pick<SongWindow, 'start' | 'end'> | undefined)[],
  duration: number
): string | undefined {
  if (!places.length) return 'The sequence has no clips to cut to the song.'
  const missing = places.findIndex((p) => !p)
  if (missing >= 0) {
    return `Clip ${missing + 1} has no place in the song. Set the clips' places in the song strip.`
  }
  const cut = places as readonly Pick<SongWindow, 'start' | 'end'>[]
  if (Math.abs(cut[0].start) > SAME_TIME) {
    return `Clip 1's place starts at ${formatSongTime(cut[0].start)}: the first clip must start where the song does. Move the boundaries in the song strip.`
  }
  for (let i = 1; i < cut.length; i++) {
    if (Math.abs(cut[i].start - cut[i - 1].end) > SAME_TIME) {
      return (
        `Clip ${i + 1}'s place (${formatPlace(cut[i].start, cut[i].end)}) doesn't start where clip ${i}'s ends ` +
        `(${formatSongTime(cut[i - 1].end)}): the clips must follow the song without gaps. Move the boundaries in the song strip.`
      )
    }
  }
  const last = cut[cut.length - 1]
  if (Math.abs(last.end - duration) > SAME_TIME) {
    return (
      `The clips cover the song to ${formatSongTime(last.end)}, but it is ${formatSongTime(duration)} long: the last ` +
      'clip must end where the song does. Move the boundaries in the song strip.'
    )
  }
  return undefined
}

/**
 * The film's frames of a place: round(end · fps) − round(start · fps). Counted from the song's start, so no rounding
 * adds up over many clips: the clips together are exactly round(duration · fps) frames.
 */
export function placeFrames(place: Pick<SongWindow, 'start' | 'end'>, fps: number): number {
  return Math.round(place.end * fps) - Math.round(place.start * fps)
}
