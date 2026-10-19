// A clip's place in its sequence's song (GenerationParams.song): the limits of a window, how long a take of it is made,
// what of the song it sends and the words sung in it. Pure, shared by the main process (sections, sending, sync) and
// the window.

import type { ReferenceAudio, SequenceSong, SongLyrics, SongWindow } from './types'

/** Venice takes reference audio clips of 2–15 s: a window shorter than this can't send any of the song. */
export const MIN_SONG_WINDOW_SECONDS = 2
/** The longest window that sends all of itself (Venice's 15 s of reference audio per generation). */
export const MAX_SONG_WINDOW_SECONDS = 15
/**
 * A take is made this much longer than its window, so the cut can start it a little later when its singing comes in
 * late (TakeSongSync.offset) and still keep the window's whole length.
 */
export const SONG_HEADROOM_SECONDS = 1
/** The clip length "New sequence from a song…" aims for unless told otherwise. */
export const DEFAULT_SONG_TARGET_SECONDS = 8

/** Seconds the window lasts. */
export function windowLength(w: Pick<SongWindow, 'start' | 'end'>): number {
  return Math.max(0, w.end - w.start)
}

/**
 * The duration a take of a window is made with: the shortest the model offers that holds the window plus the
 * headroom, else the longest it offers (the cut then holds the take's last frame no longer than it must – the
 * export's business). `durations` are the model's own ("5s", "10s", …) when known; without them whole seconds from
 * 4 to 15.
 */
export function songClipDuration(durations: readonly string[] | undefined, length: number): string {
  const want = length + SONG_HEADROOM_SECONDS
  const offered = (durations ?? [])
    .map((d) => Number.parseFloat(d))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  if (offered.length) {
    const fits = offered.find((n) => n >= want - 1e-6)
    return `${fits ?? offered[offered.length - 1]}s`
  }
  return `${Math.min(15, Math.max(4, Math.ceil(want - 1e-6)))}s`
}

/**
 * The reference audio a clip sends of its song: the window of the vocals ('vocals'; the mix when the song has no
 * vocals file) or of the mix ('mix'), at most MAX_SONG_WINDOW_SECONDS of it; undefined for 'none'. A window under
 * MIN_SONG_WINDOW_SECONDS is returned as it is – the prompt checks refuse it with a reason rather than this hiding it.
 */
export function songAudioReference(
  song: Pick<SequenceSong, 'path' | 'vocalsPath'>,
  w: SongWindow
): ReferenceAudio | undefined {
  if (w.part === 'none') return undefined
  const path = w.part === 'vocals' && song.vocalsPath ? song.vocalsPath : song.path
  return { path, start: w.start, length: Math.min(windowLength(w), MAX_SONG_WINDOW_SECONDS) }
}

/**
 * The words sung in a window: every word whose middle lies in [start, end), the words of one line joined by spaces
 * and the lines by " / ". '' without lyrics or words there.
 */
export function lyricsInWindow(lyrics: SongLyrics | undefined, start: number, end: number): string {
  if (!lyrics) return ''
  const lines: string[] = []
  for (const line of lyrics.lines) {
    const words = line.words.filter((w) => {
      const mid = (w.start + w.end) / 2
      return mid >= start && mid < end
    })
    if (words.length) lines.push(words.map((w) => w.text.trim()).filter(Boolean).join(' '))
  }
  return lines.filter(Boolean).join(' / ')
}
