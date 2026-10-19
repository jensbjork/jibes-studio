import { existsSync } from 'node:fs'
import { encodeAudioClip, extractAudioPreview, extractFrames, probe } from '../ffmpeg'
import { FILE_MANAGER } from '../platform'
import { jpegBlock, mp3Block, type AudioBlock } from './images'
import type { LabeledImage } from './tools/kit'

// Looking at results: frames from finished clips and exported films (so an agent can judge what came out), the
// soundtrack of a clip, and the reference windows of voices, all made with ffmpeg on the fly. Nothing is written
// into the library.

/** Width of the frames agents get: enough to judge faces, clothes, poses and continuity, small enough for many. */
export const FRAME_WIDTH = 512
export const MAX_FRAME_WIDTH = 768

/** How far before the end the "last frame" is taken, so the time is never past the final frame. */
const END_MARGIN = 0.06

/**
 * "t = 2.4 s" or "t = 2.458 s", the caption of a frame: to the millisecond (trailing zeros dropped), so a time read
 * off a caption and passed back (save_frame_as_still, get_frames) gives that very frame, not a neighbour of it.
 */
export function timeCaption(t: number): string {
  return `t = ${(Math.round(t * 1000) / 1000).toFixed(3).replace(/0{1,2}$/, '')} s`
}

/** The video's length in seconds: the measured one when known, else ffprobe's. */
export async function videoLength(path: string, known?: number): Promise<number> {
  if (known !== undefined && known > 0) return known
  return (await probe(path)).duration
}

/** The latest time a frame can be taken at in a video `length` seconds long. */
export function lastFrameTime(length: number): number {
  return Math.max(0, length - Math.min(END_MARGIN, length / 4))
}

/** A time inside the video (frames past the end are its last frame). */
export function clampTime(t: number, length: number): number {
  return Math.min(Math.max(0, Number.isFinite(t) ? t : 0), lastFrameTime(length))
}

/**
 * `count` times evenly spread over [from, to], the first at `from` and the last at `to` (a single one in the
 * middle), rounded to milliseconds.
 */
export function spreadTimes(from: number, to: number, count: number): number[] {
  if (count <= 0) return []
  if (count === 1 || to <= from) return [Math.round(((from + to) / 2) * 1000) / 1000]
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(Math.round((from + ((to - from) * i) / (count - 1)) * 1000) / 1000)
  return out
}

/** The video exists on disk; tools say so when it doesn't. */
export function requireVideoFile(path: string | undefined, what: string): string {
  if (!path) throw new Error(`${what} has no video file.`)
  if (!existsSync(path)) throw new Error(`${what} is no longer on disk (moved or deleted in ${FILE_MANAGER}?).`)
  return path
}

/**
 * Frames at the given times (seconds, already inside the video) as labelled JPEG images. `label` gets the
 * time's caption ("t = 2.4 s") and its position in `times`.
 */
export async function framesAt(
  videoPath: string,
  times: readonly number[],
  label: (caption: string, i: number) => string,
  width = FRAME_WIDTH
): Promise<LabeledImage[]> {
  if (!times.length) return []
  const frames = await extractFrames(videoPath, [...times], width)
  return frames.map((f, n) => {
    // Matched by time, so a frame ffmpeg couldn't make doesn't shift the labels of the ones after it.
    const i = times.findIndex((t) => Math.abs(t - f.time) < 0.0005)
    return { label: label(timeCaption(f.time), i >= 0 ? i : n), image: jpegBlock(f.jpeg) }
  })
}

/** Seconds of a clip's own sound returned at most (MP3 mono 128 kbps: about 16 KB a second). */
export const MAX_SOUNDTRACK_SECONDS = 30

/** The soundtrack of a video between `start` and start + length as MP3, or undefined when it has none. */
export async function soundtrack(videoPath: string, start: number, length: number): Promise<AudioBlock | undefined> {
  const mp3 = await extractAudioPreview(videoPath, Math.max(0, start), Math.min(MAX_SOUNDTRACK_SECONDS, length))
  return mp3 ? mp3Block(mp3) : undefined
}

/** A reference audio clip's window (see studio.audioWindow) as Venice gets it: mono 44.1 kHz MP3. */
export async function referenceAudioBlock(path: string, window: { start: number; length: number }): Promise<AudioBlock> {
  return mp3Block(await encodeAudioClip(path, window.start, window.length))
}
