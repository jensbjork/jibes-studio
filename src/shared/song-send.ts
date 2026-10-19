// What a clip of a sequence cut to a song sends (GenerationParams.song): its window of the song as its only reference
// audio (@Audio1 – the cast's voices give way to it, within Venice's 15 s), the words sung there, and sound on for a
// singing shot (the take's own sound is what song-sync measures; the film plays the song instead). Pure and shared, so
// a take (main's takeParams), the agents' tools (asSent) and the window send, show and check exactly the same.

import { supportsAudioInput } from './models'
import { formatPlace, formatPlaceLength } from './song'
import {
  lyricsInWindow,
  MAX_SONG_WINDOW_SECONDS,
  MIN_SONG_WINDOW_SECONDS,
  songAudioReference,
  windowLength
} from './song-window'
import type { GenerationParams, SequenceSong, SongWindow } from './types'

/**
 * The params a song clip's take is sent with. A clip that hears the song ('vocals' or 'mix') sends exactly its window
 * of the song as its reference audio (songAudioReference) and carries the words sung there in `song.lyrics`; a
 * 'vocals' clip is made with sound. A 'none' clip sends what it has, as any clip. Params without a place are returned
 * as they are; a place in a sequence without a song (`song` undefined) is dropped: the clip sends as an ordinary one.
 */
export function withSong(
  params: GenerationParams,
  song: Pick<SequenceSong, 'path' | 'vocalsPath' | 'lyrics'> | undefined
): GenerationParams {
  const place = params.song
  if (!place) return params
  if (!song) {
    const { song: _, ...rest } = params
    return rest
  }
  // The words are the song's, as its lyrics are now; never what an earlier take was sent with.
  const { lyrics: _, ...window } = place
  const reference = songAudioReference(song, window)
  if (!reference) return { ...params, song: window }
  const words = lyricsInWindow(song.lyrics, window.start, window.end)
  return {
    ...params,
    referenceAudios: [reference],
    ...(window.part === 'vocals' ? { audio: true } : {}),
    song: { ...window, ...(words ? { lyrics: words } : {}) }
  }
}

/** A window's start as a sent take keeps it: resolveReferenceAudios rounds it to the millisecond. */
const SAME_START = 0.002
/** Its length may come back a little shorter: the last place ends where the file does, give or take its rounding. */
const SAME_LENGTH = 0.05

/**
 * The 1-based number of the song's audio among the params' reference audio clips (1 once withSong has run: it is the
 * only one), found by the window it sends; 0 when no clip is the song's (no place, part 'none', or a clip whose own
 * references were never replaced).
 */
export function songAudioNumber(params: Pick<GenerationParams, 'song' | 'referenceAudios'>): number {
  const place = params.song
  if (!place || place.part === 'none') return 0
  const length = Math.min(windowLength(place), MAX_SONG_WINDOW_SECONDS)
  const i = (params.referenceAudios ?? []).findIndex(
    (a) =>
      !!a &&
      typeof a.start === 'number' &&
      Math.abs(a.start - place.start) < SAME_START &&
      (typeof a.length !== 'number' || Math.abs(a.length - length) < SAME_LENGTH)
  )
  return i + 1
}

/** A place too short to send any of the song (Venice takes 2–15 s of reference audio), as the checks say it. */
export function shortPlaceMessage(place: Pick<SongWindow, 'start' | 'end'>): string {
  return (
    `The clip's place in the song is only ${formatPlaceLength(place.start, place.end)} – a clip that hears the song ` +
    `needs at least ${MIN_SONG_WINDOW_SECONDS} s. Move a boundary in the song strip, or set “What the clip hears” to “No song”.`
  )
}

/**
 * Why a song clip can't be sent as its place says, or undefined: a clip that hears the song needs a model that takes
 * reference audio, a place inside the song and at least 2 s of it. `song`: the sequence's song (undefined: not a song
 * sequence, nothing to say). The prompt checks (prompt-refs) refuse the short place too, wherever params are checked.
 */
export function songClipProblem(
  params: Pick<GenerationParams, 'model' | 'song'>,
  song: Pick<SequenceSong, 'duration'> | undefined
): string | undefined {
  const place = params.song
  if (!place || !song || place.part === 'none') return undefined
  if (!supportsAudioInput(params.model)) {
    return (
      `The model ${params.model} can't hear the song – it takes no reference audio. Choose Seedance 2.5 ` +
      '(reference to video), or set “What the clip hears” to “No song”.'
    )
  }
  if (place.start >= song.duration - 0.001 || place.end > song.duration + SAME_LENGTH) {
    return (
      `The clip's place (${formatPlace(place.start, place.end)}) is not inside the song ` +
      `(${formatPlace(0, song.duration)}). Move its boundaries in the song strip.`
    )
  }
  return windowLength(place) < MIN_SONG_WINDOW_SECONDS - 0.005 ? shortPlaceMessage(place) : undefined
}
