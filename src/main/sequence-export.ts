// Turns a sequence's selected, trimmed takes into ffmpeg concat clips and picks the output file name.

import { join } from 'node:path'
import type { Generation } from '@shared/types'
import { probe, type ConcatClip } from './ffmpeg'
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
 * One concat clip per segment, in order. `takes[i]` must be the usable selected take of `rows[i]`.
 * Clips that continue from the previous one start with that clip's last frame, so it is dropped here
 * to avoid a visible freeze at the cut.
 */
export async function buildConcatClips(
  rows: SegmentRow[],
  takes: (Generation & { filePath: string })[]
): Promise<ConcatClip[]> {
  const clips: ConcatClip[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const take = takes[i]
    const continuing = i > 0 && !!row.continue_from_previous

    let length: number
    let fps = FALLBACK_FPS
    if (take.videoDuration === undefined || continuing) {
      try {
        const info = await probe(take.filePath)
        length = take.videoDuration ?? info.duration
        if (info.fps > 0) fps = info.fps
      } catch (err) {
        throw new Error(`Klipp ${i + 1} kunde inte läsas: ${errorText(err)}`)
      }
    } else {
      length = take.videoDuration
    }

    // Half a frame is enough to skip the duplicated first frame without risking the second one
    // to timestamp rounding; an explicit start trim has already removed it.
    const start = continuing ? Math.max(row.trim_start, 0.5 / fps) : row.trim_start
    const end = length - row.trim_end
    if (!(end - start > MIN_CLIP_SECONDS)) throw new Error(`Klipp ${i + 1} blir för kort efter trimningen.`)
    clips.push({ path: take.filePath, start, end })
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
