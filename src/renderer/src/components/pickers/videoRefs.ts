// How a form's reference videos (Seedance 2.x reference-to-video, @Video1 … in the prompt) are listed, labelled,
// added and checked against the model family's limits. Pure functions, like audioRefs: the row in the form, the "@"
// menu, the prompt's key, the clip drawer and the approval dialog read them the same way.
//
// A reference video is a window of a file (start, length), like a sound clip. The form always stores an explicit
// window, so what is sent is exactly what the form shows. What a file is (a clip from Media, a take, an exported film,
// a file from disk) and how long it lasts are facts the window looks up (videoFacts.ts); they are never stored.

import {
  DEFAULT_VIDEO_CLIP_SECONDS,
  MIN_VIDEO_CLIP_SECONDS,
  referenceVideoWindow,
  type ReferenceVideoLimits
} from '@shared/models'
import type { ReferenceVideo } from '@shared/types'
import { fileName } from '../../lib/library'
import { clampWindow, type ClipWindow, type WindowLimits } from '../assets/audioUtils'
import { formatClipSeconds } from './text'

/** Where a reference video comes from, as far as the window knows. */
export type VideoOrigin = 'clip' | 'take' | 'film' | 'file'

/** What the window knows about a video file (looked up, never stored in the params). */
export interface VideoFacts {
  /** Seconds, when known (from the library's records, or measured). */
  duration?: number
  origin?: VideoOrigin
  /** What it is: a clip's title, "Clip 3 in “Summer”", a film's sequence name. */
  name?: string
  /** A poster frame of the file, when the library has one. */
  thumbPath?: string
  /** Why the file can't be used ("The file has no video track."), when it was measured and refused. */
  error?: string
}

/** One reference video of a form: the N in @VideoN, the window that is sent and what the file is. */
export interface FormVideo {
  /** N in @VideoN, 1-based. */
  index: number
  path: string
  /** The window sent, in seconds. */
  start: number
  length: number
  facts?: VideoFacts
  /** False when it isn't sent: the model takes no reference videos, or it is past the family's count. */
  sent: boolean
}

/** Seconds to the millisecond, so windows compare and add up without floating-point crumbs. */
function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/** Slack when comparing a total with a limit. */
const EPSILON = 0.001

/** The window a reference sends: its own, else from 0 for at most the default length (never past a known end). */
export function videoWindowOf(ref: ReferenceVideo, facts?: VideoFacts): ClipWindow {
  return referenceVideoWindow(ref, facts?.duration)
}

/** The form's reference videos as @VideoN references. `limits`: the model family's, undefined when it takes none. */
export function formVideos(
  refs: readonly ReferenceVideo[],
  facts: ReadonlyMap<string, VideoFacts>,
  limits: ReferenceVideoLimits | undefined
): FormVideo[] {
  return refs.map((ref, i) => {
    const f = facts.get(ref.path)
    return { index: i + 1, path: ref.path, ...videoWindowOf(ref, f), facts: f, sent: !!limits && i < limits.maxVideos }
  })
}

/** The total length of the windows, in seconds. */
export function videoSeconds(refs: readonly ReferenceVideo[], facts: ReadonlyMap<string, VideoFacts>): number {
  return ms(refs.reduce((sum, ref) => sum + videoWindowOf(ref, facts.get(ref.path)).length, 0))
}

/** The same files with the same windows, in the same order. */
export function sameVideos(a: readonly ReferenceVideo[], b: readonly ReferenceVideo[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.start === b[i].start && x.length === b[i].length)
}

/** The windows' key for memoising (path, start and length of each). */
export function videosKey(refs: readonly ReferenceVideo[]): string {
  return refs.map((v) => `${v.path}\u0000${v.start ?? ''}\u0000${v.length ?? ''}`).join('\n')
}

// ── Words ────────────────────────────────────────────────────────────────────

const ORIGIN_WORD: Record<VideoOrigin, string> = { clip: 'clip', take: 'take', film: 'film', file: 'own video' }

/**
 * What a video is, in two parts: its name ("Clip 3 in “Summer”", a clip's title, a film's sequence) and what kind
 * it is ("take", "clip", "film"); a file from disk is "Own video" and its file name.
 */
export function videoLabelParts(video: Pick<FormVideo, 'path' | 'facts'>): { name: string; detail: string } {
  const f = video.facts
  if (!f?.name || !f.origin || f.origin === 'file') return { name: 'Own video', detail: fileName(video.path) }
  return { name: f.name, detail: ORIGIN_WORD[f.origin] }
}

/** "Clip 3 in “Summer” · take", "Own video · dance.mp4". */
export function videoLabel(video: Pick<FormVideo, 'path' | 'facts'>): string {
  const { name, detail } = videoLabelParts(video)
  return `${name} · ${detail}`
}

/** "@Video1 · Clip 3 in “Summer” (take)", the hover card's title line. */
export function videoTitle(video: Pick<FormVideo, 'index' | 'path' | 'facts'>): string {
  const { name, detail } = videoLabelParts(video)
  return name === 'Own video' ? `@Video${video.index} · own video` : `@Video${video.index} · ${name} (${detail})`
}

/** "1 video", "3 videos". */
export function videoCount(n: number): string {
  return `${n} ${n === 1 ? 'video' : 'videos'}`
}

/** "2–15 s per video": the per-video range of a family, for hints. */
export function perVideoText(limits: ReferenceVideoLimits): string {
  return `${limits.minSeconds}–${limits.maxSeconds} s per video`
}

/** A video's length as the form writes it: "5 s", "7.5 s". */
export function videoLengthText(seconds: number): string {
  return formatClipSeconds(seconds)
}

// ── Windows ──────────────────────────────────────────────────────────────────

/** How long one video's window may be with the family: its per-video range. */
export function videoWindowLimits(limits: ReferenceVideoLimits | undefined): WindowLimits {
  return { min: limits?.minSeconds ?? MIN_VIDEO_CLIP_SECONDS, max: limits?.maxSeconds ?? 15 }
}

/** The window kept inside the file and the family's per-video range, in hundredths of a second. */
export function clampVideoWindow(
  w: ClipWindow,
  duration: number,
  limits: ReferenceVideoLimits | undefined
): ClipWindow {
  return clampWindow(w, duration, videoWindowLimits(limits))
}

/**
 * The window a newly added video gets: from the start, the default length (5 s – three fit Seedance 2.0's 15 s) or
 * the whole file when it is shorter, within the family's per-video maximum and the room left in the total. Undefined
 * when less than the minimum would fit (or the file is shorter than that).
 */
export function defaultVideoWindow(
  duration: number,
  limits: ReferenceVideoLimits | undefined,
  room = Infinity
): ClipWindow | undefined {
  const min = limits?.minSeconds ?? MIN_VIDEO_CLIP_SECONDS
  const max = limits?.maxSeconds ?? Infinity
  if (!(duration > 0)) return undefined
  const length = Math.floor(Math.min(duration, DEFAULT_VIDEO_CLIP_SECONDS, max, room) * 100 + 1e-6) / 100
  if (length < min - 0.005) return undefined
  return { start: 0, length: ms(length) }
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** A video to add: its file and how long it is (measured or from the library). */
export interface VideoCandidate {
  path: string
  duration?: number
  /** What it is, for the note when it doesn't fit ("the take Clip 3 in “Summer”"). */
  name?: string
}

/** A new video list, and a note when not everything fitted. */
export interface VideosChange {
  videos: ReferenceVideo[]
  note?: string
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function englishNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "the video dance.mp4", or what the candidate says it is. */
function candidateName(c: VideoCandidate): string {
  return c.name ?? `the video ${fileName(c.path)}`
}

/**
 * Whether a video would fit after the ones there: not there already, long enough, a free place and room in the
 * total for at least the shortest window the family takes.
 */
export function videoFits(
  current: readonly ReferenceVideo[],
  candidate: VideoCandidate,
  facts: ReadonlyMap<string, VideoFacts>,
  limits: ReferenceVideoLimits | undefined
): { fits: boolean; reason?: string } {
  if (!limits) return { fits: false, reason: 'the model takes no reference videos' }
  if (current.some((v) => v.path === candidate.path)) return { fits: false, reason: 'already added' }
  if (candidate.duration !== undefined && candidate.duration < limits.minSeconds - 0.005) {
    return { fits: false, reason: `shorter than ${limits.minSeconds} s` }
  }
  if (current.length >= limits.maxVideos) return { fits: false, reason: `at most ${videoCount(limits.maxVideos)}` }
  if (videoSeconds(current, facts) + limits.minSeconds > limits.maxTotalSeconds + EPSILON) {
    return { fits: false, reason: `no room left in the ${limits.maxTotalSeconds} s` }
  }
  return { fits: true }
}

/**
 * Appends the videos whose files aren't in the list yet, in order, as long as they fit the family: at most its number
 * of videos and its total length. Each gets an explicit window (defaultVideoWindow), shortened to the room left in the
 * total. A video shorter than the family's minimum, or whose length isn't known, is left out with a note.
 */
export function addVideos(
  current: readonly ReferenceVideo[],
  wanted: readonly VideoCandidate[],
  facts: ReadonlyMap<string, VideoFacts>,
  limits: ReferenceVideoLimits | undefined
): VideosChange {
  if (!limits) return { videos: [...current], note: 'This model takes no reference videos.' }
  const out = [...current]
  const have = new Set(current.map((v) => v.path))
  let total = videoSeconds(current, facts)
  const unknown: string[] = []
  const tooShort: string[] = []
  const full: string[] = []
  const noRoom: string[] = []
  for (const c of wanted) {
    if (!c || typeof c.path !== 'string' || !c.path || have.has(c.path)) continue
    const name = candidateName(c)
    const duration = c.duration ?? facts.get(c.path)?.duration
    if (duration === undefined || !(duration > 0)) {
      unknown.push(name)
      continue
    }
    if (duration < limits.minSeconds - 0.005) {
      tooShort.push(name)
      continue
    }
    if (out.length >= limits.maxVideos) {
      full.push(name)
      continue
    }
    const window = defaultVideoWindow(duration, limits, limits.maxTotalSeconds - total)
    if (!window) {
      noRoom.push(name)
      continue
    }
    out.push({ path: c.path, start: window.start, length: window.length })
    have.add(c.path)
    total = ms(total + window.length)
  }
  const notes: string[] = []
  if (unknown.length) {
    notes.push(`${capitalized(englishNames(unknown))} couldn’t be read as a video.`)
  }
  if (tooShort.length) {
    notes.push(
      `${capitalized(englishNames(tooShort))} ${tooShort.length === 1 ? 'is' : 'are'} shorter than ` +
        `${limits.minSeconds} s – ${limits.family} takes no reference videos that short.`
    )
  }
  if (full.length) {
    notes.push(`${capitalized(englishNames(full))} didn’t fit – ${limits.family} takes at most ${videoCount(limits.maxVideos)}.`)
  }
  if (noRoom.length) {
    notes.push(
      `${capitalized(englishNames(noRoom))} didn’t fit – the reference videos may be at most ` +
        `${limits.maxTotalSeconds} s together (now ${formatClipSeconds(total)}). Shorten one first.`
    )
  }
  return { videos: out, ...(notes.length ? { note: notes.join(' ') } : {}) }
}

/**
 * Appends videos that come with their windows (an agent's set_references: main resolved and measured each one), in
 * order and without repeating a file, as many as the family takes – its count and its total length; a note says
 * what was left out. Windows are kept as given (a wrong length is the prompt checks' to report).
 */
export function appendVideoWindows(
  current: readonly ReferenceVideo[],
  wanted: readonly ReferenceVideo[],
  limits: ReferenceVideoLimits | undefined
): VideosChange {
  if (!limits) return { videos: [...current], note: 'This model takes no reference videos.' }
  const out = [...current]
  const have = new Set(current.map((v) => v.path))
  const noFacts = new Map<string, VideoFacts>()
  let total = videoSeconds(current, noFacts)
  const full: string[] = []
  const noRoom: string[] = []
  for (const v of wanted) {
    if (!v || typeof v.path !== 'string' || !v.path || have.has(v.path)) continue
    const length = videoWindowOf(v).length
    if (out.length >= limits.maxVideos) full.push(fileName(v.path))
    else if (total + length > limits.maxTotalSeconds + EPSILON) noRoom.push(fileName(v.path))
    else {
      out.push(v)
      have.add(v.path)
      total = ms(total + length)
    }
  }
  const notes: string[] = []
  if (full.length) notes.push(`${englishNames(full)} didn’t fit – ${limits.family} takes at most ${videoCount(limits.maxVideos)}.`)
  if (noRoom.length) {
    notes.push(
      `${englishNames(noRoom)} didn’t fit – the reference videos may be at most ${limits.maxTotalSeconds} s together ` +
        `with ${limits.family} (now ${formatClipSeconds(total)}).`
    )
  }
  return { videos: out, ...(notes.length ? { note: notes.join(' ') } : {}) }
}

/** The list with the video at `index` (0-based) given another window. */
export function withVideoWindow(current: readonly ReferenceVideo[], index: number, w: ClipWindow): ReferenceVideo[] {
  return current.map((v, i) => (i === index ? { path: v.path, start: ms(w.start), length: ms(w.length) } : v))
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** What is wrong with the videos for the model family, in plain words, for the row under the tiles. */
export interface VideoProblems {
  /** More videos than the family takes: the last ones aren't sent. */
  count?: string
  /** Windows outside the family's per-video range, by @VideoN number. */
  lengths: { index: number; message: string }[]
  /** The windows together are longer than the family takes. */
  total?: string
}

/** What is wrong with the videos for `limits` (the model's family); nothing when the model takes none. */
export function videoProblems(videos: readonly FormVideo[], limits: ReferenceVideoLimits | undefined): VideoProblems {
  const out: VideoProblems = { lengths: [] }
  if (!limits || !videos.length) return out
  const over = videos.length - limits.maxVideos
  if (over > 0) {
    out.count =
      `${limits.family} takes at most ${videoCount(limits.maxVideos)} – ` +
      (over === 1 ? 'the last one isn’t sent.' : `the last ${over} aren’t sent.`)
  }
  const sent = videos.filter((v) => v.sent)
  for (const v of sent) {
    if (v.length < limits.minSeconds - 0.005) {
      out.lengths.push({
        index: v.index,
        message: `@Video${v.index} is ${formatClipSeconds(v.length)} – ${limits.family} needs ${perVideoText(limits)}.`
      })
    } else if (v.length > limits.maxSeconds + 0.005) {
      out.lengths.push({
        index: v.index,
        message: `@Video${v.index} is ${formatClipSeconds(v.length)} – ${limits.family} takes at most ${limits.maxSeconds} s per video.`
      })
    }
  }
  const total = ms(sent.reduce((sum, v) => sum + v.length, 0))
  if (total > limits.maxTotalSeconds + EPSILON) {
    out.total =
      `The videos are ${formatClipSeconds(total)} together – ${limits.family} takes at most ` +
      `${limits.maxTotalSeconds} s. Shorten a window or remove a video.`
  }
  return out
}

/** Whether any of the problems blocks generating (a window's length or the total; a video past the count isn't sent). */
export function videoProblemsBlock(p: VideoProblems): boolean {
  return p.lengths.length > 0 || !!p.total
}
