// A sequence's cast: the library assets – characters, outfits (with who wears them), environments, products and
// poses – chosen once for the whole sequence instead of per clip, as an ordered list of their photos (@Image order) and
// their voices or sounds (@Audio order), plus who wears each outfit (SequenceCast).
//
// - New clips Studio makes empty start with the cast as their references – except a clip that continues from the
//   previous clip in reference mode: it carries the references of the clip it continues from and needs none of its
//   own (continuation.ts).
// - A clip *follows* the cast while its own references are exactly the cast's: the same pictures and audio clips (with
//   their windows), in the same order. Changing the cast changes those clips the same way, in one step: their prompts'
//   @ImageN / @AudioN tokens stay on their pictures and clips as a change in the form keeps them (prompt-remap.ts: a
//   removed picture's tokens go, a reorder renumbers, an addition gets the numbers after the existing ones), and one
//   asset swapped for another keeps every number (reference-swap.ts). A clip whose references were changed by hand no
//   longer follows; "Use the cast" brings it back. An empty cast is followed by the clips that would send references
//   but have none (a new shot in reference mode), so the first cast chosen reaches them.
//
// Stored without a schema change as the references of the sequence's defaults (sequences.defaults JSON:
// referenceImages, referenceAudios, outfitWearers, paths relative like a clip's params, so moving or tidying the library
// rewrites them too). Pure and shared: the sequence view, main and the agents' tools decide it the same way.
//
// Reference videos (@VideoN) are never the cast's: videos are no assets. A clip's own videos stay its own whatever
// the cast does, and whether it follows the cast is decided by its pictures and audio alone.

import { continuationPlan, continuesAt, endsOnNextAt, ownReferences, type ChainClip } from './continuation'
import { kindOfModelId, sanitizeReferenceAudios } from './models'
import { sanitizeOutfitWearers } from './outfits'
import { remapPromptReferences } from './prompt-remap'
import { swapReferenceAsset } from './reference-swap'
import type { Asset, GenerationParams, ReferenceAudio, ReferenceVideo, SequenceCast } from './types'

type CastFields = Pick<GenerationParams, 'referenceImages' | 'referenceAudios' | 'outfitWearers'>

/** No cast chosen. */
export const EMPTY_CAST: SequenceCast = { referenceImages: [], referenceAudios: [] }

/**
 * A cast from the window, an agent or stored JSON: picture paths and audio clips with their windows, in order, and the
 * "worn by" choices; anything malformed is dropped. A picture may be in several places, as in a clip: an asset swapped
 * in with fewer photos than the one it replaced reuses them, so that no number changes.
 */
export function sanitizeCast(input: unknown): SequenceCast {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof SequenceCast, unknown>>
  const images = Array.isArray(p.referenceImages)
    ? p.referenceImages.filter((r): r is string => typeof r === 'string' && !!r)
    : []
  const audios = sanitizeReferenceAudios(p.referenceAudios) ?? []
  const wearers = sanitizeOutfitWearers(p.outfitWearers)
  return { referenceImages: images, referenceAudios: audios, ...(wearers ? { outfitWearers: wearers } : {}) }
}

/** No pictures and no audio. */
export function castIsEmpty(cast: SequenceCast): boolean {
  return !cast.referenceImages.length && !cast.referenceAudios.length
}

/** The params' references (and who wears what) as the cast has them. */
export function castReferences(cast: SequenceCast): CastFields {
  return {
    referenceImages: cast.referenceImages.length ? [...cast.referenceImages] : undefined,
    referenceAudios: cast.referenceAudios.length ? cast.referenceAudios.map((a) => ({ ...a })) : undefined,
    outfitWearers: cast.outfitWearers ? { ...cast.outfitWearers } : undefined
  }
}

/** `params` with the cast as its references and its "worn by" choices (left out when the cast has none). */
export function withCastReferences(params: GenerationParams, cast: SequenceCast): GenerationParams {
  const next: GenerationParams = { ...params, ...castReferences(cast) }
  if (!next.outfitWearers) delete next.outfitWearers
  return next
}

const audioKey = (a: ReferenceAudio): string => `${a.path}\u0000${a.start ?? 0}\u0000${a.length ?? ''}`

/** The same pictures and audio clips (windows included), in the same order. */
export function sameCastReferences(
  refs: { images: readonly string[]; audios: readonly ReferenceAudio[] },
  cast: SequenceCast
): boolean {
  return (
    refs.images.length === cast.referenceImages.length &&
    refs.images.every((p, i) => p === cast.referenceImages[i]) &&
    refs.audios.length === cast.referenceAudios.length &&
    refs.audios.every((a, i) => audioKey(a) === audioKey(cast.referenceAudios[i]))
  )
}

/** The "worn by" choices in a form that compares (order of the outfits doesn't matter). */
export function wearersKey(wearers: GenerationParams['outfitWearers']): string {
  return JSON.stringify(Object.entries(wearers ?? {}).sort(([a], [b]) => a.localeCompare(b)))
}

/** Whether two casts are the same (pictures, audio and who wears what). */
export function sameCast(a: SequenceCast, b: SequenceCast): boolean {
  return (
    sameCastReferences({ images: a.referenceImages, audios: a.referenceAudios }, b) &&
    wearersKey(a.outfitWearers) === wearersKey(b.outfitWearers)
  )
}

/**
 * How a clip stands to the cast:
 * - 'follows': its own references are exactly the cast's (it changes with the cast);
 * - 'carries': it continues in reference mode without references of its own and carries those of clip `fromClip`,
 *   which follows the cast – so it sends the cast too, and needs nothing of its own;
 * - 'differs': it could send references but has others (chosen by hand), none, or carries those of a clip that doesn't
 *   follow; "Use the cast" makes them the cast's;
 * - 'none': it sends no references (an exact continuation, one that ends on the next clip's first frame, one with a
 *   start or end image of its own).
 */
export type CastFollow =
  | { state: 'follows' }
  | { state: 'carries'; fromClip: number }
  | { state: 'differs' }
  | { state: 'none' }

/** How the clip at `index` stands to the cast (see CastFollow). */
export function castFollowAt(clips: readonly ChainClip[], index: number, cast: SequenceCast): CastFollow {
  const clip = clips[index]
  if (!clip || endsOnNextAt(clips, index)) return { state: 'none' }
  const own = ownReferences(clip.params)
  const ownMatches = (): boolean => sameCastReferences(own ?? { images: [], audios: [] }, cast)
  if (continuesAt(clips, index)) {
    const plan = continuationPlan(clips, index)
    if (plan?.form !== 'reference-to-video') return { state: 'none' }
    if (own) return !castIsEmpty(cast) && ownMatches() ? { state: 'follows' } : { state: 'differs' }
    const from = plan.carried?.fromClip
    if (from && from - 1 !== index && castFollowAt(clips, from - 1, cast).state === 'follows') {
      return { state: 'carries', fromClip: from }
    }
    return { state: 'differs' }
  }
  const kind = kindOfModelId(clip.params.model)
  if (kind === 'image-to-video') {
    return clip.params.startImage || clip.params.endImage ? { state: 'none' } : { state: 'differs' }
  }
  // A text-to-video clip was made without references; "Use the cast" switches it to reference mode.
  if (kind !== 'reference-to-video') return { state: 'differs' }
  return ownMatches() ? { state: 'follows' } : { state: 'differs' }
}

/** The clip at `index` follows the cast (see castFollowAt). */
export function followsCastAt(clips: readonly ChainClip[], index: number, cast: SequenceCast): boolean {
  return castFollowAt(clips, index, cast).state === 'follows'
}

/** Stands for the previous clip's last frame in the lists a continuing clip's tokens name (never a path). */
const FRAME_SLOT = '\u0000frame-of-previous-clip'

/**
 * What the @ImageN / @AudioN / @VideoN tokens of the clip at `index` name, in order: its own references; for a
 * continuation in reference mode the pictures it sends (its own or carried) and then the previous clip's last frame,
 * and the videos it sends; nothing for a clip that sends no references.
 */
export function namedReferences(
  clips: readonly ChainClip[],
  index: number
): { images: string[]; audios: ReferenceAudio[]; videos: ReferenceVideo[] } {
  const plan = continuationPlan(clips, index)
  if (plan) {
    return plan.mode === 'references'
      ? { images: [...plan.images, FRAME_SLOT], audios: plan.audios, videos: plan.videos }
      : { images: [], audios: [], videos: [] }
  }
  if (endsOnNextAt(clips, index)) return { images: [], audios: [], videos: [] }
  const own = ownReferences(clips[index].params)
  return { images: own?.images ?? [], audios: own?.audios ?? [], videos: own?.videos ?? [] }
}

/**
 * A text written against the references of the clip at `index` (a negative prompt a new clip copies from the clip
 * before it) with its tokens moved onto the cast's pictures and clips: what both have keeps its token (renumbered), the
 * rest loses it, so a new shot that starts with the cast never sends a token naming another picture.
 */
export function followTokensToCast(clips: readonly ChainClip[], index: number, text: string, cast: SequenceCast): string {
  const was = namedReferences(clips, index)
  // The cast has no videos: a token naming one of the clip's goes.
  return remapPromptReferences(
    text,
    { before: was.images, after: cast.referenceImages },
    { before: was.audios, after: cast.referenceAudios },
    undefined,
    { before: was.videos, after: [] }
  )
}

/** The chain with the clip at `index` given other params. */
function withParamsAt(clips: readonly ChainClip[], index: number, params: GenerationParams): ChainClip[] {
  return clips.map((c, i) => (i === index ? { ...c, params } : c))
}

/** How the clip links to its neighbours from now on, when that changes with its references. */
type ClipLinks = Pick<ChainClip, 'continueFromPrevious' | 'endFromNext'>

/**
 * `next` (the clip at `index` with new references; `links`, when its links change too) with the prompt and negative
 * prompt of `written` (the params as they were written against the chain `before`) following their tokens from what
 * they named there to what they name now – the shared remap of the form: a picture that left takes its tokens along, a
 * reorder renumbers, one added gets a number after the others, and a continuation's frame keeps its token (or loses
 * it, when the clip no longer continues).
 */
function followTokens(
  before: readonly ChainClip[],
  index: number,
  written: GenerationParams,
  next: GenerationParams,
  links?: ClipLinks
): GenerationParams {
  const was = namedReferences(before, index)
  const after = before.map((c, i) => (i === index ? { ...c, ...links, params: next } : c))
  const now = namedReferences(after, index)
  const remap = (text: string): string =>
    remapPromptReferences(
      text,
      { before: was.images, after: now.images },
      { before: was.audios, after: now.audios },
      undefined,
      { before: was.videos, after: now.videos }
    )
  const out: GenerationParams = { ...next, prompt: remap(written.prompt ?? '') }
  if (written.negativePrompt !== undefined) out.negativePrompt = remap(written.negativePrompt) || undefined
  return out
}

/** One asset of the cast swapped for another (by the shared swap, which keeps every number). */
export interface CastSwap {
  from: Asset
  to: Asset
}

/**
 * The cast after one of its assets was swapped for another: every place of `from` taken by `to`, a character's outfit
 * handed over as in a clip (swapReferenceAsset with the library), and the notes the swap makes. Throws when `from`
 * isn't among the cast's pictures or `to` has no photos.
 */
export function swapCastAsset(
  cast: SequenceCast,
  swap: CastSwap,
  library: readonly Asset[]
): { cast: SequenceCast; notes: string[] } {
  const params = withCastReferences({ model: '', prompt: '', duration: '' }, cast)
  const swapped = swapReferenceAsset(params, swap.from, swap.to, library)
  return { cast: sanitizeCast(swapped.params), notes: swapped.notes }
}

/**
 * The params of every clip that follows the cast `before`, once it is `after` (undefined for a clip that doesn't
 * follow, which is left as it is): the cast's references and "worn by" choices, with the prompt and negative prompt
 * following – by the swap's own rules when one asset was swapped for another (`swap`: the name in front of its tokens
 * follows, no number changes; the `library` decides what a character's outfit does), else by the remap of the form.
 * A continuation that carries the cast from a clip that follows it changes through that clip (main keeps its tokens on
 * the same pictures).
 */
export function followCastChange(
  clips: readonly ChainClip[],
  before: SequenceCast,
  after: SequenceCast,
  opts: { swap?: CastSwap; library?: readonly Asset[] } = {}
): (GenerationParams | undefined)[] {
  return clips.map((clip, i) => {
    if (!followsCastAt(clips, i, before)) return undefined
    let written = clip.params
    if (opts.swap && opts.library) {
      // Swapped with the cast's "worn by" choices, so the clip's swap hands outfits over exactly as the cast's did.
      const asCast = withCastReferences(written, before)
      try {
        written = swapReferenceAsset(asCast, opts.swap.from, opts.swap.to, opts.library).params
      } catch {
        // Nothing of `from` among them: only the lists change.
        written = asCast
      }
    }
    // A swap keeps every number, so the prompt is written against the swapped lists from here on.
    return followTokens(withParamsAt(clips, i, written), i, written, withCastReferences(written, after))
  })
}

/**
 * "Use the cast": the clip at `index` with the cast as its references (and its "worn by" choices) and its prompt's
 * tokens following their pictures (followTokens): pictures the cast has too keep their tokens (renumbered), others
 * lose theirs, and a continuation's frame keeps its token. `model`: the reference-to-video model a clip in another
 * mode is sent with from now on (main picks it from the model list); its start and end images go. `links`: the clip's
 * links from now on, when they change with it (a clip that stops continuing takes the cast as a new shot, and the
 * frame's token goes).
 */
export function castAppliedAt(
  clips: readonly ChainClip[],
  index: number,
  cast: SequenceCast,
  model?: string,
  links?: ClipLinks
): GenerationParams {
  const written = clips[index].params
  const switched = model ? { ...written, model, startImage: undefined, endImage: undefined } : written
  return followTokens(clips, index, written, withCastReferences(switched, cast), links)
}
