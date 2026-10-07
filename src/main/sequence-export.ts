// Turns a sequence's selected, trimmed takes into ffmpeg concat clips and picks the output file name.

import { join } from 'node:path'
import { endsOnFirstFrameOf, startsOnLastFrameOf, type SeamTake } from '@shared/seams'
import type { Generation } from '@shared/types'
import { probe, type ConcatClip, type ProbeResult } from './ffmpeg'
import { dayStamp, timeStamp } from './paths'
import { firstFreeName, folderBaseName, pathTaken, type SegmentRow } from './sequence-store'

const FALLBACK_FPS = 24
/** Anything shorter than this after trimming is almost certainly a mistake, not an intended flash cut. */
const MIN_CLIP_SECONDS = 0.04

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** "1", "1 och 3", "1, 3 och 4". */
export function swedishList(items: (string | number)[]): string {
  const s = items.map(String)
  return s.length <= 1 ? (s[0] ?? '') : `${s.slice(0, -1).join(', ')} och ${s[s.length - 1]}`
}

export function missingTakesMessage(clipNumbers: number[]): string {
  return clipNumbers.length === 1
    ? `Klipp ${clipNumbers[0]} saknar en färdig vald tagning.`
    : `Klipp ${swedishList(clipNumbers)} saknar färdiga valda tagningar.`
}

/**
 * Whether a clip starts by showing the previous clip's last frame again: it continues from that clip
 * (continue_from_previous) and its take was made from that very frame, at the end trim the previous clip has now.
 * A take made otherwise (before continuation was switched on, or from another take of the previous clip) starts
 * on a picture of its own, which stays. `take` and `previousTake` carry their measured lengths.
 */
export function repeatsPreviousFrame(
  row: SegmentRow,
  take: SeamTake,
  previous: SegmentRow,
  previousTake: SeamTake
): boolean {
  return !!row.continue_from_previous && startsOnLastFrameOf(take, previousTake, previous.trim_end)
}

/**
 * Whether the export drops a clip's last frame. A clip that takes its end image from the next clip
 * (end_from_next) and whose take was made from the next clip's first shown frame as it is now (its frame at
 * trimStart) shows that picture a second time as its own last frame. Except when the next clip already drops that
 * picture as its own first frame (`nextRepeats`, see repeatsPreviousFrame, and no start trim): dropping both copies
 * would skip it. Only one copy ever goes; a take not made from the next clip's frame (the old take of a clip just
 * set up to be redone between its neighbours) keeps its real last frame.
 */
export function dropsLastFrame(
  row: SegmentRow,
  take: SeamTake,
  next: SegmentRow | undefined,
  nextTake: SeamTake | undefined,
  nextRepeats: boolean
): boolean {
  if (!next || !nextTake || !row.end_from_next) return false
  if (!endsOnFirstFrameOf(take, nextTake, next.trim_start)) return false
  return !(nextRepeats && !(next.trim_start > 0))
}

/**
 * One concat clip per segment, in order. `takes[i]` must be the usable selected take of `rows[i]`.
 * Where two clips share a picture at the cut, one copy is dropped to avoid a visible freeze there: a clip whose
 * take starts on the previous clip's last frame (see repeatsPreviousFrame) loses its first frame; a clip whose take
 * ends on the next clip's first frame (see dropsLastFrame) loses its last one. Which take was made from which is
 * read from the takes themselves, as the clip editor's warnings read it, never from the switches alone.
 */
export async function buildConcatClips(
  rows: SegmentRow[],
  takes: (Generation & { filePath: string })[]
): Promise<ConcatClip[]> {
  const probed = new Map<number, ProbeResult>()
  const probeClip = async (i: number): Promise<ProbeResult> => {
    const known = probed.get(i)
    if (known) return known
    try {
      const info = await probe(takes[i].filePath)
      probed.set(i, info)
      return info
    } catch (err) {
      throw new Error(`Klipp ${i + 1} kunde inte läsas: ${errorText(err)}`)
    }
  }
  // Every length first: whether a clip repeats its neighbour's frame depends on where that neighbour's trim cuts.
  const lengths: number[] = []
  for (let i = 0; i < rows.length; i++) lengths.push(takes[i].videoDuration ?? (await probeClip(i)).duration)
  const seam = (i: number): SeamTake => ({ id: takes[i].id, params: takes[i].params, videoDuration: lengths[i] })
  const repeats = rows.map((row, i) => i > 0 && repeatsPreviousFrame(row, seam(i), rows[i - 1], seam(i - 1)))

  const clips: ConcatClip[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const dropFirst = repeats[i]
    const hasNext = i + 1 < rows.length
    const dropLast = dropsLastFrame(row, seam(i), rows[i + 1], hasNext ? seam(i + 1) : undefined, !!repeats[i + 1])
    const length = lengths[i]
    let fps = FALLBACK_FPS
    if (dropFirst || dropLast) {
      const info = await probeClip(i)
      if (info.fps > 0) fps = info.fps
    }

    // Half a frame is enough to skip the duplicated first frame without risking the second one
    // to timestamp rounding; an explicit start trim has already removed it.
    const start = dropFirst ? Math.max(row.trim_start, 0.5 / fps) : row.trim_start
    // The last frame starts one frame before the end: cutting half a frame before that skips it and keeps the
    // one before (the trim keeps frames that start before `end`). An end trim of at least that much has
    // already removed it.
    const end = dropLast ? Math.min(length - row.trim_end, length - 1.5 / fps) : length - row.trim_end
    if (!(end - start > MIN_CLIP_SECONDS)) throw new Error(`Klipp ${i + 1} blir för kort efter trimningen.`)
    clips.push({ path: takes[i].filePath, start, end })
  }
  return clips
}

/** Output paths of exports being placed right now (compared case-insensitively, like the disk does). */
const reserved = new Set<string>()
const key = (path: string): string => path.normalize('NFC').toLowerCase()

/**
 * `<dir>/<Sekvensnamn> <YYYY-MM-DD HH.MM>.mp4`, or "… (2).mp4" and so on: never an earlier export, a file
 * that some row still records, or the path of another export being placed at the same time (two same-named
 * sequences exported within the same minute). Call `release` once the file is in place or has failed.
 */
export function reserveExportPath(dir: string, sequenceName: string, at: Date): { path: string; release: () => void } {
  const base = `${folderBaseName(sequenceName)} ${dayStamp(at)} ${timeStamp(at)}`
  const name = firstFreeName(base, '.mp4', (n) => reserved.has(key(join(dir, n))) || pathTaken(join(dir, n)))
  const path = join(dir, name)
  reserved.add(key(path))
  return { path, release: () => void reserved.delete(key(path)) }
}
