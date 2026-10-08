// What "Bildruta ur ett klipp" (FramePickerDialog) offers: a sequence's finished takes grouped by clip, or any
// finished video in the library. Pure functions, so the dialog's choices can be checked without a window.

import { generationTitle } from '@shared/generation-label'
import { durationSeconds } from '@shared/models'
import type { Generation, Segment, Sequence } from '@shared/types'
import { plainImagePrompt } from './imageModels'

/** A video that can be shown: finished, with its file on disk (as far as the list knows). */
export function isReadyVideo(take: Generation): boolean {
  return take.status === 'completed' && !!take.filePath && !take.fileMissing
}

/** A video to take the frame from, with what the player needs to know about it. */
export interface FrameChoice {
  take: Generation
  /**
   * The take is the one a sequence uses: its trims apply, the parts cut away are hatched, and ⇤ / ⇥ go to the
   * first and last frame the sequence keeps.
   */
  inCut: boolean
  /** Seconds the sequence cuts from the take's start and end (0 outside a cut). */
  trimStart: number
  trimEnd: number
  /** Where the video comes from, under the player ("Klipp 2, tagningen som används i sekvensen."). */
  caption: string
  /** The player starts on this frame: the video's first (or, in a cut, the first kept) or its last. */
  startAt: 'start' | 'end'
}

export interface ClipGroup {
  segment: Segment
  /** 1-based clip number. */
  clip: number
  /** The take in the cut first, then the others newest first. */
  choices: FrameChoice[]
}

/**
 * The sequence's finished takes, clip by clip. `wantedSegmentId`'s takes start at `at`; every other take at its
 * first frame.
 */
export function clipChoices(sequence: Sequence, wantedSegmentId: string | undefined, at: 'start' | 'end'): ClipGroup[] {
  return sequence.segments.map((segment, i) => {
    // Takes come newest first; a stable sort keeps that order behind the take in the cut.
    const inCutFirst = (t: Generation) => Number(t.id === segment.selectedGenerationId)
    const ready = segment.takes.filter(isReadyVideo).sort((a, b) => inCutFirst(b) - inCutFirst(a))
    return {
      segment,
      clip: i + 1,
      choices: ready.map((take): FrameChoice => {
        const inCut = take.id === segment.selectedGenerationId
        return {
          take,
          inCut,
          trimStart: inCut ? segment.trimStart : 0,
          trimEnd: inCut ? segment.trimEnd : 0,
          caption: inCut
            ? `Klipp ${i + 1}, tagningen som används i sekvensen.`
            : `Klipp ${i + 1}, en annan tagning än den som används.`,
          startAt: segment.id === wantedSegmentId ? at : 'start'
        }
      })
    }
  })
}

/** The take shown first: the wanted clip's (its take in the cut), else the first take in a cut, else any. */
export function firstClipChoice(
  groups: readonly ClipGroup[],
  wantedSegmentId: string | undefined
): FrameChoice | undefined {
  const all = groups.flatMap((g) => g.choices)
  const ofWanted = wantedSegmentId ? groups.find((g) => g.segment.id === wantedSegmentId)?.choices[0] : undefined
  return ofWanted ?? all.find((c) => c.inCut) ?? all[0]
}

/** A video from the library as a choice: the whole video, starting at `at` when it is the one asked for. */
export function libraryChoice(take: Generation, firstId: string | undefined, at: 'start' | 'end'): FrameChoice {
  return {
    take,
    inCut: false,
    trimStart: 0,
    trimEnd: 0,
    caption: describeVideo(take),
    startAt: take.id === firstId ? at : 'start'
  }
}

/**
 * The library's list after a live update: a video that finished is added in date order (newest first), one that
 * failed, is on its way again or lost its file goes.
 */
export function withLiveUpdate(list: readonly Generation[], g: Generation): Generation[] {
  const rest = list.filter((t) => t.id !== g.id)
  return isReadyVideo(g) ? [g, ...rest].sort((a, b) => b.createdAt - a.createdAt) : rest
}

/** "14:02" today, else "3 okt." – enough to tell videos apart. */
export function takeTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  return new Date(now).toDateString() === d.toDateString()
    ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
}

const lengthFormat = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })

/**
 * "Skapad 3 okt. · 5 s · ”Wide shot of …”": what a library video is, under the player. An own film or a version is
 * named by its title ("Eget klipp ”Strand”").
 */
export function describeVideo(take: Generation, now = Date.now()): string {
  const titled = !!take.title?.trim()
  const prompt = titled ? generationTitle(take) : plainImagePrompt(take.prompt || take.params.prompt || '')
  const excerpt = prompt.length > 140 ? `${prompt.slice(0, 137)}…` : prompt
  const seconds = take.videoDuration ?? durationSeconds(take.params.duration)
  return [
    `Skapad ${takeTime(take.createdAt, now)}`,
    seconds > 0 ? `${lengthFormat.format(seconds)} s` : undefined,
    excerpt ? `”${excerpt}”` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}
