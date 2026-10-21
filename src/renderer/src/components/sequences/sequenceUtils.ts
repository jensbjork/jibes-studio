import { sameCastReferences } from '@shared/cast'
import { continuationPlan, sendParams, type ContinuationPlan } from '@shared/continuation'
import { effectiveDirectorId, resolveDirector, withDirection, type DirectorSource } from '@shared/direction'
import {
  durationSeconds,
  endImageVariant,
  imageToVideoVariant,
  kindOfModelId,
  referenceToVideoVariant,
  referenceVideosOf
} from '@shared/models'
import { remapPromptReferences } from '@shared/prompt-remap'
import { endsOnFirstFrameOf, startsOnLastFrameOf } from '@shared/seams'
import { withSong } from '@shared/song-send'
import { directorAssets } from '../../lib/directors'
import {
  NEEDS_CONSENT,
  type ConsentRequest,
  type Generation,
  type GenerationParams,
  type GenerationStatus,
  type Segment,
  type SegmentPatch,
  type Sequence,
  type SequenceCast
} from '@shared/types'

/** The main process keeps at least this much of a take when clamping trims. */
export const MIN_CLIP_SECONDS = 0.2

export function isPending(g: Generation): boolean {
  return g.status === 'queued' || g.status === 'processing'
}

export function selectedTake(segment: Segment): Generation | undefined {
  const id = segment.selectedGenerationId
  return id ? segment.takes.find((t) => t.id === id) : undefined
}

/** The selected take, if it is finished and its file is on disk (i.e. it can be previewed and exported). */
export function readyTake(segment: Segment): Generation | undefined {
  const take = selectedTake(segment)
  return take?.status === 'completed' && take.filePath && !take.fileMissing ? take : undefined
}

/** Newest take that is still queued or generating. */
export function pendingTake(segment: Segment): Generation | undefined {
  return segment.takes.find(isPending)
}

/**
 * The take is an own clip: the user's own film or a version from the Editor, not a Venice generation (an AI take made
 * in the Editor counts as Venice's).
 */
export function isOwnTake(take: Pick<Generation, 'source'> | undefined): boolean {
  return !!take && take.source !== undefined && take.source !== 'generated'
}

/**
 * The shape a sequence's film has ("16:9"): its first clip's selected take, else its defaults, else 16:9. What an own
 * film of another shape is compared with ("Fit or crop"), the way main crops to it.
 */
export function sequenceAspect(sequence: Sequence): string {
  const first = sequence.segments[0]
  const take = first && selectedTake(first)
  const valid = (a: string | undefined): a is string => !!a && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(a)
  const own = take?.params.aspectRatio
  if (valid(own)) return own
  const defaults = sequence.defaults.aspectRatio
  return valid(defaults) ? defaults : '16:9'
}

/**
 * A clip nobody has done anything with yet: no takes, no prompt, no keyframes, no notes (the empty Clip 1 a new
 * sequence starts with). A first own film brought into a sequence of only such clips takes their place. References
 * that are exactly the sequence's `cast` count as nothing: Studio put them there.
 */
export function isUntouchedClip(segment: Segment, cast?: SequenceCast): boolean {
  const p = segment.params
  const onlyCast =
    !!cast && sameCastReferences({ images: p.referenceImages ?? [], audios: p.referenceAudios ?? [] }, cast)
  return (
    !segment.takes.length &&
    !segment.selectedGenerationId &&
    !p.prompt?.trim() &&
    !p.startImage &&
    !p.endImage &&
    (onlyCast || (!p.referenceImages?.length && !p.referenceAudios?.length)) &&
    !referenceVideosOf(p).length &&
    !segment.continueFromPrevious &&
    !segment.endFromNext &&
    !segment.notes.trim()
  )
}

/** Real length when ffprobe has measured it, else the requested duration. */
export function takeDuration(take: Generation): number {
  return take.videoDuration ?? durationSeconds(take.params.duration)
}

/** Seconds the segment contributes to the cut, or undefined while it has no ready take. */
export function clipLength(segment: Segment): number | undefined {
  const take = readyTake(segment)
  if (!take) return undefined
  return Math.max(0, takeDuration(take) - segment.trimStart - segment.trimEnd)
}

export function totalLength(sequence: Sequence): number {
  return sequence.segments.reduce((sum, s) => sum + (clipLength(s) ?? 0), 0)
}

/** Estimated progress 0–1 of a pending take, from Venice's average execution time. */
export function takeProgress(g: Generation): number | undefined {
  if (!g.executionDuration || !g.averageExecutionTime) return undefined
  return Math.min(0.97, g.executionDuration / g.averageExecutionTime)
}

/** The segment takes its start frame from the previous clip (never the first clip). */
export function continues(segment: Segment, index: number): boolean {
  return segment.continueFromPrevious && index > 0
}

/**
 * The params a new take of the segment will actually be generated with, as main's takeParams works them out (the
 * shared continuation.ts sendParams): a clip that continues in reference mode gets its family's reference-to-video
 * model and the references it carries – its own, or the clip's it continues from, so `sequence` is needed for those
 * (the previous clip's last frame goes after them when the take is made); a clip that otherwise takes a frame from a
 * neighbour gets the image-to-video sibling of its model and no references. `segment` stands in for the sequence's
 * clip at `index` (the editor's draft). Not the end-capable model: main switches to one when "End on the next
 * clip's first frame" is turned on (and patchSegmentLocally does until its answer arrives), but a model the user
 * picks afterwards is theirs, and one that can't take an end image is refused (clipBlocked says so) rather than
 * priced as another model. Without `sequence` only the clip's own references are known (an inheriting clip is then
 * shown exactly). A clip of a sequence cut to a song sends its window of the song as its reference audio, with the
 * words sung there and sound on for a singing shot (song-send.ts withSong, as main's takeParams) – known only with
 * `sequence`. Last, its director – its own, else the sequence's (null: none) – adds its `avoid`, style frames and
 * style videos (direction.ts withDirection); `directors`: the user's own (default: as last loaded, lib/directors).
 */
export function effectiveParams(
  segment: Segment,
  index: number,
  sequence?: Sequence,
  directors: readonly DirectorSource[] = directorAssets()
): GenerationParams {
  const continuing = continues(segment, index)
  const params =
    !continuing && !segment.endFromNext ? segment.params : sendParams(chainWith(segment, index, sequence), index)
  const songed = params.song && sequence ? withSong(params, sequence.song) : params
  // A clip that starts on the previous clip's last frame in reference mode gets no style frames (the frame goes last).
  const framed = continuing && continuationOf(segment, index, sequence)?.mode === 'references'
  return withClipDirector(songed, segment.params.director, sequence, directors, framed)
}

/**
 * `params` as a clip's director sends them: the clip's own director (`own`, its params' `director`; null: none), else
 * the sequence's (direction.ts withDirection). Unchanged without one.
 */
export function withClipDirector(
  params: GenerationParams,
  own: string | null | undefined,
  sequence: Pick<Sequence, 'director'> | undefined,
  directors: readonly DirectorSource[] = directorAssets(),
  continuationFrame = false
): GenerationParams {
  const director = resolveDirector(effectiveDirectorId(own, sequence?.director), directors)
  return director ? withDirection(params, director, { continuationFrame }) : params
}

/** How the clip continues from the previous clip (continuation.ts), with `segment` in its place; see effectiveParams. */
export function continuationOf(segment: Segment, index: number, sequence?: Sequence): ContinuationPlan | undefined {
  return continuationPlan(chainWith(segment, index, sequence), index)
}

/** A stand-in for a clip that isn't known (effectiveParams without the sequence): no references, no links. */
const UNKNOWN_CLIP: Segment['params'] = { model: '', prompt: '', duration: '' }

/** The sequence's clips with `segment` at `index`; without the sequence, unknown clips around it. */
function chainWith(segment: Segment, index: number, sequence: Sequence | undefined): Segment[] {
  if (sequence) return sequence.segments.map((s, i) => (i === index ? segment : s))
  const unknown = (i: number): Segment => ({ ...segment, id: `unknown-${i}`, params: UNKNOWN_CLIP, takes: [] })
  const before = Array.from({ length: Math.max(0, index) }, (_, i) => ({
    ...unknown(i),
    continueFromPrevious: false,
    endFromNext: false
  }))
  const after = segment.endFromNext ? [{ ...unknown(index + 1), continueFromPrevious: false, endFromNext: false }] : []
  return [...before, segment, ...after]
}

/**
 * What a new take of the clip would be made from, as one comparable string: its params and the neighbours'
 * frames it starts or ends on. Used to tell whether a clip changed while a dialog (Venice's terms) was open, so
 * accepting can never pay for something other than what the user looked at.
 */
export function clipKey(sequence: Sequence, index: number): string {
  const s = sequence.segments[index]
  if (!s) return ''
  const before = continues(s, index) ? sequence.segments[index - 1] : undefined
  const after = s.endFromNext ? sequence.segments[index + 1] : undefined
  const plan = continuationOf(s, index, sequence)
  return stableJson([
    s.id,
    effectiveParams(s, index, sequence),
    plan ? [plan.mode, plan.frameToken ?? null] : null,
    before ? [before.id, before.selectedGenerationId, before.trimEnd] : null,
    after ? [after.id, after.selectedGenerationId, after.trimStart] : null
  ])
}

/**
 * The segment is part of the cut only once its selected take is completed and its file still exists. Must
 * match what "generate all" in main regenerates, since the run's count and price are shown from this.
 */
export function needsTake(segment: Segment): boolean {
  return !readyTake(segment)
}

/**
 * The cut between `left` and `right` is seamless as far as their selected takes say: one side was made from the
 * other side's frame as it is now. Either direction will do: a clip redone between its neighbours ends on the next
 * clip's first frame without that clip being made again, and the next clip, continuing from the old take, still
 * meets it exactly (see @shared/seams; the export drops one copy of that picture either way).
 */
function seamMade(left: Segment, leftTake: Generation, right: Segment, rightTake: Generation): boolean {
  return (
    (right.continueFromPrevious && startsOnLastFrameOf(rightTake, leftTake, left.trimEnd)) ||
    (left.endFromNext && endsOnFirstFrameOf(leftTake, rightTake, right.trimStart))
  )
}

/**
 * True when the segment continues from the previous one but neither take at the cut was made from the other's
 * frame as it is now: the selected take was made from another frame than the one the previous clip now ends on
 * (a different take was chosen or its end trim changed, or continuation was switched on after generating), and
 * the previous clip wasn't made to end on this take's first frame either.
 */
export function continuationMismatch(segment: Segment, previous: Segment | undefined): boolean {
  if (!segment.continueFromPrevious || !previous) return false
  const take = selectedTake(segment)
  const prevTake = readyTake(previous)
  if (!take || take.status !== 'completed' || !prevTake) return false
  return !seamMade(previous, prevTake, segment, take)
}

/**
 * The end-frame counterpart of continuationMismatch: the segment takes its end frame from the next clip, but its
 * selected take was made from another frame than the one the next clip now starts on (another take was chosen
 * there, or its start trim changed, or the switch was turned on after generating), and the next clip's take
 * wasn't made from this take's last frame either.
 */
export function endMismatch(segment: Segment, next: Segment | undefined): boolean {
  if (!segment.endFromNext || !next) return false
  const take = selectedTake(segment)
  const nextTake = readyTake(next)
  if (!take || take.status !== 'completed' || !nextTake) return false
  return !seamMade(segment, take, next, nextTake)
}

/**
 * What "Redo between neighbours" will do for the clip at `index` of `count`, or undefined when it has no neighbour
 * to work between (a sequence of one clip). Shared by the timeline cards and the editor's keyframe box.
 */
export function bridgeDescription(index: number, count: number): string | undefined {
  const before = index > 0
  const after = index < count - 1
  if (before && after) {
    return `Redo the clip so it starts exactly where clip ${index} ends and ends exactly where clip ${index + 2} starts. The neighbours aren't touched, and the old take is kept.`
  }
  if (before) return `Redo the clip so it starts exactly where clip ${index} ends. The old take is kept.`
  if (after) return `Redo the clip so it ends exactly where clip ${index + 2} starts. The old take is kept.`
  return undefined
}

/** Applies a patch to the local copy the same way the main process will, for instant feedback. */
export function patchSegmentLocally(sequence: Sequence, segmentId: string, patch: SegmentPatch): Sequence {
  return {
    ...sequence,
    segments: sequence.segments.map((s) => {
      if (s.id !== segmentId) return s
      const next: Segment = { ...s }
      if (patch.params) next.params = patch.params
      if (patch.continueMode !== undefined) next.continueMode = patch.continueMode
      if (patch.continueFromPrevious !== undefined) next.continueFromPrevious = patch.continueFromPrevious
      if (patch.continueFromPrevious || patch.continueMode !== undefined) {
        // As main does it: a continuation in reference mode takes its family's reference-to-video model, any other
        // the image-to-video one (main has the final word when its answer arrives).
        const reference =
          next.continueFromPrevious &&
          !next.endFromNext &&
          next.continueMode === 'references' &&
          !(kindOfModelId(next.params.model) === 'image-to-video' && next.params.endImage)
        const model = reference ? referenceToVideoVariant(next.params.model) : undefined
        if (model) next.params = { ...next.params, model }
        else if (next.continueFromPrevious) next.params = { ...next.params, model: imageToVideoVariant(next.params.model) }
      }
      if (patch.endFromNext !== undefined) {
        next.endFromNext = patch.endFromNext
        if (patch.endFromNext) next.params = { ...next.params, model: endImageVariant(next.params.model) }
      }
      if (patch.notes !== undefined) next.notes = patch.notes
      if (patch.trimStart !== undefined) next.trimStart = patch.trimStart
      if (patch.trimEnd !== undefined) next.trimEnd = patch.trimEnd
      if (patch.selectedGenerationId !== undefined) next.selectedGenerationId = patch.selectedGenerationId ?? undefined
      return next
    })
  }
}

/** Local copy of a move: same renumbering rules as the main process. */
export function moveSegmentLocally(sequence: Sequence, segmentId: string, toIndex: number): Sequence {
  const segments = sequence.segments.slice()
  const from = segments.findIndex((s) => s.id === segmentId)
  if (from === -1) return sequence
  const [moved] = segments.splice(from, 1)
  segments.splice(Math.max(0, Math.min(toIndex, segments.length)), 0, moved)
  return {
    ...sequence,
    segments: segments.map((s, i) => ({
      ...s,
      position: i,
      continueFromPrevious: i === 0 ? false : s.continueFromPrevious,
      endFromNext: i === segments.length - 1 ? false : s.endFromNext
    }))
  }
}

const STATUS_RANK: Record<GenerationStatus, number> = { queued: 0, processing: 1, completed: 2, failed: 2 }

/**
 * Picks the fresher of a take as fetched with the sequence and the latest live update for it.
 * Fetches can be answered after a newer progress event arrived, so neither source always wins.
 */
export function freshestTake(fetched: Generation, live: Generation): Generation {
  const a = STATUS_RANK[fetched.status]
  const b = STATUS_RANK[live.status]
  if (b > a) return live
  if (b < a) return fetched
  if (fetched.status === 'processing' && (live.executionDuration ?? 0) > (fetched.executionDuration ?? 0)) return live
  if (fetched.status === 'completed') {
    // Thumbnail and duration are stored after the video itself; keep whichever copy already has them.
    const filePath = fetched.filePath ?? live.filePath
    const thumbPath = fetched.thumbPath ?? live.thumbPath
    const videoDuration = fetched.videoDuration ?? live.videoDuration
    if (filePath === fetched.filePath && thumbPath === fetched.thumbPath && videoDuration === fetched.videoDuration) {
      return fetched
    }
    return { ...fetched, filePath, thumbPath, videoDuration }
  }
  return fetched
}

/** Merges a live generation update into every segment that shows it (or owns it, for brand-new takes). */
export function applyGenerationUpdate(sequence: Sequence, g: Generation): Sequence {
  let changed = false
  const segments = sequence.segments.map((s) => {
    const i = s.takes.findIndex((t) => t.id === g.id)
    if (i !== -1) {
      const fresh = freshestTake(s.takes[i], g)
      if (fresh === s.takes[i]) return s
      changed = true
      const takes = s.takes.slice()
      takes[i] = fresh
      return { ...s, takes }
    }
    if (g.segmentId === s.id) {
      changed = true
      return { ...s, takes: [g, ...s.takes] }
    }
    return s
  })
  return changed ? { ...sequence, segments } : sequence
}

/**
 * JSON with sorted keys, for comparing params regardless of key order. Empty values are left out, since
 * main normalises `''` and `[]` to absent fields and that alone isn't a change.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined && x !== '' && !(Array.isArray(x) && x.length === 0))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  })
}

/**
 * A take's list as the clip's: the pictures (or clips) the take had that the clip no longer has by that path are
 * paired, in order, with the clip's own that the take didn't have – an outside file the take sent as its copy in
 * "Referensbilder", a picture swapped since – so their tokens keep their place as before. The rest are matched by
 * path; one left over has left the clip.
 */
function takeListAsClips(take: readonly string[], clip: readonly string[]): string[] {
  const inClip = new Set(clip)
  const inTake = new Set(take)
  const newcomers = clip.filter((p) => !inTake.has(p))
  return take.map((p) => (inClip.has(p) ? p : (newcomers.shift() ?? p)))
}

/**
 * A take's prompts as they read with the clip's references now ("Use prompt"): every @ImageN / @AudioN / @VideoN
 * token renumbered from the take's reference lists to the clip's (remapPromptReferences), so after the references
 * were reordered or one removed the take's words come back naming the same pictures, clips and videos, not whatever
 * holds their old numbers now. A token whose picture, clip or video has left the clip goes.
 */
export function takePromptsFor(
  take: Pick<GenerationParams, 'prompt' | 'negativePrompt' | 'referenceImages' | 'referenceAudios'> &
    Partial<Pick<GenerationParams, 'referenceVideos'>>,
  clip: Pick<GenerationParams, 'referenceImages' | 'referenceAudios'> & Partial<Pick<GenerationParams, 'referenceVideos'>>
): { prompt: string; negativePrompt?: string } {
  const clipImages = clip.referenceImages ?? []
  const clipAudios = clip.referenceAudios ?? []
  const clipVideos = referenceVideosOf(clip)
  const takeAudioPaths = takeListAsClips(
    (take.referenceAudios ?? []).map((a) => a.path),
    clipAudios.map((a) => a.path)
  )
  const takeVideoPaths = takeListAsClips(
    referenceVideosOf(take).map((v) => v.path),
    clipVideos.map((v) => v.path)
  )
  const images = { before: takeListAsClips(take.referenceImages ?? [], clipImages), after: clipImages }
  const audios = { before: takeAudioPaths.map((path) => ({ path })), after: clipAudios }
  const videos = { before: takeVideoPaths.map((path) => ({ path })), after: clipVideos }
  const negative = take.negativePrompt && remapPromptReferences(take.negativePrompt, images, audios, undefined, videos)
  return {
    prompt: remapPromptReferences(take.prompt, images, audios, undefined, videos),
    negativePrompt: negative || undefined
  }
}

/** Finds a consent request in an error message, also when it is wrapped (e.g. "Clip 2: NEEDS_CONSENT:{…}"). */
export function parseConsent(message: string | undefined): ConsentRequest | undefined {
  if (!message) return undefined
  const i = message.indexOf(NEEDS_CONSENT)
  if (i === -1) return undefined
  try {
    return JSON.parse(message.slice(i + NEEDS_CONSENT.length)) as ConsentRequest
  } catch {
    return undefined
  }
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

const decimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })

/** "7.4 s" or "1 min 23 s". */
export function formatLength(seconds: number): string {
  if (seconds < 59.95) return `${decimal.format(seconds)} s`
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)} min ${total % 60} s`
}

/** "0:07.5": where in a clip a frame sits, to a tenth of a second. */
export function formatFrameTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10))
  const s = Math.floor(tenths / 10)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`
}

/** "1:07" for player clocks. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatTakeTime(ms: number): string {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}
