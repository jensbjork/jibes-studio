// Where two clips of a sequence meet: whether the take on one side was made from the other side's frame as it is
// now. A take that continues from the previous clip starts on that clip's last shown frame, and one that ends on the
// next clip ends on that clip's first shown frame; main extracts those frames into the library's frame cache and
// names them after the take and the trim they were taken at (sequences.ts lastFrameOf / firstFrameOf). The
// renderer's warnings and the export's dedupe both read the names through these, so they agree. Pure (no Node or
// DOM), like everything in src/shared.

/** What one side of a cut needs to say: the take's id, the pictures it was generated from and its length. */
export interface SeamTake {
  id: string
  params: { startImage?: string; endImage?: string; referenceImages?: readonly string[] }
  /** Seconds, when measured. */
  videoDuration?: number
}

/** How far apart two frame times may be and still be the same cut (trims come in 0.1 s steps). */
const SAME_TIME = 0.05

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * A picture main extracted from a take: frames live in .studio/frames/ (.studio/bildrutor/ before English folder
 * names, frames/ in libraries from before the base folder could be chosen).
 */
export function isExtractedFrame(path: string | undefined): boolean {
  return !!path && /[/\\](frames|bildrutor)[/\\]/.test(path)
}

/**
 * The previous clip's last frame a take of a continuing clip was made from, and how it was sent: as its start image
 * ('exact': image-to-video, the frame is the take's first frame) or as its last reference image ('references': the
 * frame went along after the carried reference images, and the prompt said to start on it, so the take starts close to
 * it). Undefined for a take made from no such frame. A frame main extracted for an end image (`-first-`) never counts.
 */
export function continuationFrameOf(
  params: SeamTake['params']
): { path: string; mode: 'exact' | 'references' } | undefined {
  const start = params.startImage
  if (start && isExtractedFrame(start)) return { path: start, mode: 'exact' }
  const refs = params.referenceImages
  const last = Array.isArray(refs) && refs.length ? refs[refs.length - 1] : undefined
  if (typeof last === 'string' && isExtractedFrame(last) && !isExtractedFirstFrame(last)) {
    return { path: last, mode: 'references' }
  }
  return undefined
}

/**
 * The take was made to start on `previous`'s last shown frame as it is now: its start image (or, made in reference
 * mode, its last reference image; see continuationFrameOf) is the frame main extracted from that take
 * (`<id>-last.png`, or `<id>-v2-<ms>.png` / `<id>-<ms>.png` where an end trim cuts it) at the end trim the previous
 * clip has now. What can't be told (a name without a time, a length not measured yet) counts as a match. A take made
 * in reference mode starts close to that frame rather than exactly on it; it still counts, and the export still drops
 * one frame at the cut (harmless either way).
 */
export function startsOnLastFrameOf(take: SeamTake, previous: SeamTake, previousTrimEnd: number): boolean {
  const start = continuationFrameOf(take.params)?.path
  if (!start) return false
  const name = fileName(start)
  if (!name.startsWith(previous.id)) return false
  const at = /-(last|\d+)\.png$/.exec(name)?.[1]
  if (!at) return true
  if (at === 'last') return !(previousTrimEnd > 0)
  if (!(previousTrimEnd > 0)) return false
  if (previous.videoDuration === undefined) return true
  return Math.abs(Number(at) / 1000 - (previous.videoDuration - previousTrimEnd)) <= SAME_TIME
}

/**
 * The take was made to end on `next`'s first shown frame as it is now: its end image is the frame main extracted
 * from that take (`<id>-first-<ms>.png`) at the start trim the next clip has now.
 */
export function endsOnFirstFrameOf(take: SeamTake, next: SeamTake, nextTrimStart: number): boolean {
  const end = take.params.endImage
  if (!end || !isExtractedFrame(end)) return false
  const name = fileName(end)
  if (!name.startsWith(next.id) || !name.includes('-first')) return false
  const ms = /-(\d+)\.png$/.exec(name)?.[1]
  if (ms === undefined) return !(nextTrimStart > SAME_TIME)
  return Math.abs(Number(ms) / 1000 - nextTrimStart) <= SAME_TIME
}

/** A picture main extracted as a clip's first shown frame (`<take id>-first-<ms>.png`), for an end image. */
export function isExtractedFirstFrame(path: string | undefined): boolean {
  return isExtractedFrame(path) && fileName(path!).includes('-first')
}
