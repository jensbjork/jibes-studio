import { MAX_AUDIO_CLIP_SECONDS, MIN_AUDIO_CLIP_SECONDS } from '@shared/models'
import type { AssetAudio } from '@shared/types'
import { PATH_SEPARATOR } from '../../lib/platform'

// Pure helpers for an asset's sound clips: which files count as audio, the reference window (the part of a
// clip that is sent to Venice) and how times are written and read.

/** The formats main accepts for voices and soundscapes; it converts the window to MP3 when sending. */
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|aiff?|flac|ogg)$/i
export const AUDIO_FORMATS = 'MP3, WAV, M4A, AAC, AIFF, FLAC or OGG'

/** Longer recordings work, but then the window matters: only it is sent. */
export const LONG_AUDIO_SECONDS = 60

/** The part of a clip that is sent: from `start`, `length` seconds. */
export interface ClipWindow {
  start: number
  length: number
}

export function windowOf(clip: Pick<AssetAudio, 'clipStart' | 'clipLength'>): ClipWindow {
  return { start: clip.clipStart, length: clip.clipLength }
}

export function sameWindow(a: ClipWindow | undefined, b: ClipWindow | undefined): boolean {
  return !!a && !!b && Math.abs(a.start - b.start) < 0.005 && Math.abs(a.length - b.length) < 0.005
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round2 = (v: number) => Math.round(v * 100) / 100
// Rounding down keeps start + length inside the file after both are rounded.
const floor2 = (v: number) => Math.floor(v * 100 + 1e-6) / 100

/**
 * The window as main stores it: 2–15 s long (the whole file when it is shorter than 2 s) and inside the
 * file, in hundredths of a second.
 */
export function clampWindow(w: ClipWindow, duration: number): ClipWindow {
  const d = Number.isFinite(duration) ? Math.max(0, duration) : 0
  const wanted = Number.isFinite(w.length) ? w.length : MIN_AUDIO_CLIP_SECONDS
  const length = Math.min(
    round2(clamp(wanted, Math.min(MIN_AUDIO_CLIP_SECONDS, d), Math.min(MAX_AUDIO_CLIP_SECONDS, d))),
    floor2(d)
  )
  const start = clamp(floor2(Number.isFinite(w.start) ? w.start : 0), 0, floor2(Math.max(0, d - length)))
  return { start, length }
}

/** The same length starting at `start` (moving the whole window). */
export function moveWindow(w: ClipWindow, start: number, duration: number): ClipWindow {
  return clampWindow({ start, length: w.length }, duration)
}

/** A new start with the end kept where it is (dragging the left handle). */
export function resizeStart(w: ClipWindow, start: number, duration: number): ClipWindow {
  const end = Math.min(duration, w.start + w.length)
  const lo = Math.max(0, end - MAX_AUDIO_CLIP_SECONDS)
  const hi = Math.max(lo, end - Math.min(MIN_AUDIO_CLIP_SECONDS, duration))
  const s = clamp(start, lo, hi)
  return clampWindow({ start: s, length: end - s }, duration)
}

/** A new end with the start kept where it is (dragging the right handle). */
export function resizeEnd(w: ClipWindow, end: number, duration: number): ClipWindow {
  const min = Math.min(MIN_AUDIO_CLIP_SECONDS, duration)
  // Near the end of the file the minimum length can only be had by moving the start back; clampWindow does.
  const max = Math.max(min, Math.min(MAX_AUDIO_CLIP_SECONDS, duration - w.start))
  return clampWindow({ start: w.start, length: clamp(end - w.start, min, max) }, duration)
}

const tenths = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const upToTenths = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })

/** A position in a clip: "0:05.2", "2:31.0". */
export function formatPosition(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10) / 10)
  const minutes = Math.floor(t / 60)
  const rest = t - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${tenths.format(rest)}`
}

/** A length: "10 s", "7.5 s", "2 min 31 s". */
export function formatDuration(seconds: number): string {
  if (seconds < 59.95) return `${upToTenths.format(Math.round(seconds * 10) / 10)} s`
  const total = Math.round(seconds)
  const s = total % 60
  return `${Math.floor(total / 60)} min${s ? ` ${s} s` : ''}`
}

/** A length for an input field: "10.0". */
export function formatSecondsField(seconds: number): string {
  return tenths.format(Math.round(seconds * 10) / 10)
}

/**
 * Reads a time typed by hand: seconds ("5", "5.5", "5,5", "12 s", "12 sec") or minutes and seconds ("1:05",
 * "1:05.5"). A decimal comma and the Swedish units are still understood. Undefined when it isn't one.
 */
export function parseTime(text: string): number | undefined {
  const t = text
    .trim()
    .replace(/\s*(s|secs?|seconds?|sek|sekunder)$/i, '')
    .replace(',', '.')
  const m = /^(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(t)
  if (!m) return undefined
  const seconds = Number(m[2])
  if (m[1] !== undefined && seconds >= 60) return undefined
  const value = (m[1] !== undefined ? Number(m[1]) * 60 : 0) + seconds
  return Number.isFinite(value) ? value : undefined
}

/** The file name shown for a clip (its copy keeps the original name). */
export function clipFileName(path: string): string {
  return path.split(PATH_SEPARATOR).pop() ?? path
}
