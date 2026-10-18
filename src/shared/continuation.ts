// How a sequence clip that continues from the previous clip ("Start on the previous clip's last frame") is sent. Two ways,
// chosen per clip (Segment.continueMode):
//
// - 'references' (the default, "With references"): reference-to-video with the references the clip carries – its
//   own reference images and voices, or, when it has none, those of the clip it continues from (up the chain, so in
//   effect the sequence's first clip with references) – and the previous clip's last frame as one more reference
//   image after them, @Image{N+1}. The prompt as sent starts with an instruction to begin exactly on that frame
//   (prompt-compose.ts continuationLeadIn). The first frame is then close to, not guaranteed identical with, the
//   previous clip's last one; characters who leave the picture come back as themselves.
// - 'exact' ("Exact start frame"): image-to-video from that frame (its exact first frame), without references.
//
// A clip that also ends on the next clip's first frame (end_from_next, "Redo between neighbours") or has an end image of
// its own needs image-to-video with both frames, so it is always sent exactly; so is one whose model family has no
// reference-to-video model, or one with no references to carry. Pure and shared, so the clip editor, main's takes,
// "Generate missing" and the agent tools all decide it the same way.

import {
  imageToVideoVariant,
  kindOfModelId,
  maxReferenceAudios,
  maxReferenceImages,
  referenceToVideoVariant,
  sanitizeReferenceAudios,
  supportsAudioInput
} from './models'
import { blockingContinuationError, blockingPromptError, droppedForFrameMessage } from './prompt-refs'
import { remapPromptReferences, sameList } from './prompt-remap'
import { isExtractedFrame } from './seams'
import type { ContinueMode, GenerationParams, ReferenceAudio } from './types'

/** What the decision reads of a clip: a Segment, or a segment row as main reads it. */
export interface ChainClip {
  params: GenerationParams
  continueFromPrevious: boolean
  endFromNext: boolean
  /** Undefined (a clip from before the choice existed): 'references'. */
  continueMode?: ContinueMode
}

/** The choice a clip has until someone makes another. */
export const DEFAULT_CONTINUE_MODE: ContinueMode = 'references'

/** A stored or sent value as a ContinueMode: 'exact' when it says so, otherwise the default. */
export function continueModeOf(value: unknown): ContinueMode {
  return value === 'exact' ? 'exact' : DEFAULT_CONTINUE_MODE
}

/** Whether a value from the window or an agent is a ContinueMode at all. */
export function isContinueMode(value: unknown): value is ContinueMode {
  return value === 'references' || value === 'exact'
}

/** The clip at `index` starts on the previous clip's last frame (never the first clip). */
export function continuesAt(clips: readonly ChainClip[], index: number): boolean {
  return index > 0 && !!clips[index]?.continueFromPrevious
}

/** The clip at `index` ends on the next clip's first frame (never the last clip). */
export function endsOnNextAt(clips: readonly ChainClip[], index: number): boolean {
  return index >= 0 && index < clips.length - 1 && !!clips[index]?.endFromNext
}

/**
 * A clip's own references: the reference images and audio of a clip whose model is reference-to-video (in any other
 * mode they are left-over form state, never sent). A continuation frame a take was made from never counts.
 */
export function ownReferences(
  params: Pick<GenerationParams, 'model' | 'referenceImages' | 'referenceAudios'>
): { images: string[]; audios: ReferenceAudio[] } | undefined {
  if (kindOfModelId(params.model) !== 'reference-to-video') return undefined
  const images = (Array.isArray(params.referenceImages) ? params.referenceImages : []).filter(
    (p): p is string => typeof p === 'string' && !!p && !isExtractedFrame(p)
  )
  const audios = sanitizeReferenceAudios(params.referenceAudios) ?? []
  return images.length || audios.length ? { images, audios } : undefined
}

/** The references a continuing clip carries, and where they come from. */
export interface CarriedReferences {
  /** 1-based number of the clip whose references these are: the clip itself, or the one it inherits them from. */
  fromClip: number
  /** Inherited from a clip before it (it has none of its own). */
  inherited: boolean
  /** Every reference image carried, in @Image order (also one that gives way for the frame). */
  images: string[]
  audios: ReferenceAudio[]
}

/**
 * The references the clip at `index` carries: its own when it has any (they override the inherited ones), else those
 * of the clip it continues from, and so on up the chain of continuations. Undefined when no clip in the chain has
 * any (the chain ends at a clip that doesn't continue: a new shot, a clip with keyframes of its own).
 */
export function carriedReferences(clips: readonly ChainClip[], index: number): CarriedReferences | undefined {
  for (let i = index; i >= 0; i--) {
    const clip = clips[i]
    if (!clip) return undefined
    const own = ownReferences(clip.params)
    if (own) return { fromClip: i + 1, inherited: i !== index, images: own.images, audios: own.audios }
    if (!continuesAt(clips, i)) return undefined
  }
  return undefined
}

/** Said when "With references" doesn't apply to a clip that also ends on the next clip's first frame. */
export const ENDS_ON_NEXT_NOTE =
  "Doesn't apply here: the clip also ends on the next clip's first frame, so it is sent exactly (image-to-video with both frames, without references)."

/** Said when "With references" doesn't apply to a clip with an end image of its own. */
export const OWN_END_IMAGE_NOTE =
  "Doesn't apply here: the clip has an end image of its own, so it is sent exactly (image-to-video, without references)."

/** Said when a clip in reference mode has nothing to carry. */
export const NOTHING_CARRIED_NOTE =
  'There are no reference images or voices to send – neither in the clip nor in the clips it continues from – so the clip starts exactly on the frame. Add references here or in the clip before.'

/** How a continuing clip is sent (see the top of this file). */
export interface ContinuationPlan {
  /** What the user (or an agent) chose for the clip. */
  chosen: ContinueMode
  /** How its take is sent now: with the carried references and the frame as the last of them, or exactly. */
  mode: ContinueMode
  /**
   * False when the choice doesn't apply to the clip at all: it also ends on the next clip's first frame, or has an end
   * image of its own (image-to-video with both frames). The editor shows the choice greyed out with `note`.
   */
  applies: boolean
  /** Why the clip is sent exactly although 'references' was chosen, or why the choice doesn't apply. */
  note?: string
  /**
   * Which form the clip editor shows: the reference picker (the choice is 'references' and a reference-to-video model
   * exists for it, also while there is nothing to carry yet) or the image-to-video one.
   */
  form: 'reference-to-video' | 'image-to-video'
  /** The model its take is sent with: the family's reference-to-video model, or its image-to-video model. */
  model: string
  /** Reference mode: what it carries (every picture, also one that gives way for the frame). */
  carried?: CarriedReferences
  /** Reference mode: the carried pictures that are sent, in order; the frame goes after them. */
  images: string[]
  /** Reference mode: the carried audio clips that are sent. */
  audios: ReferenceAudio[]
  /** Reference mode: 1-based numbers of carried pictures left out to make room for the frame. */
  droppedImages: number[]
  /** Reference mode: N in @ImageN for the frame (the number after the pictures sent). */
  frameToken?: number
}

/**
 * How the clip at `index` is sent when it continues from the previous clip (undefined when it doesn't): the mode it
 * is actually sent in, with the model, the references it carries and the frame's token. The model list remembered
 * in this process (rememberModelKinds) decides which family has a reference-to-video model.
 */
export function continuationPlan(clips: readonly ChainClip[], index: number): ContinuationPlan | undefined {
  if (!continuesAt(clips, index)) return undefined
  const params = clips[index].params
  const chosen = continueModeOf(clips[index].continueMode)
  const exact = (note: string | undefined, applies = true): ContinuationPlan => ({
    chosen,
    mode: 'exact',
    applies,
    ...(note ? { note } : {}),
    form: 'image-to-video',
    model: imageToVideoVariant(params.model),
    images: [],
    audios: [],
    droppedImages: []
  })
  if (endsOnNextAt(clips, index)) return exact(ENDS_ON_NEXT_NOTE, false)
  if (kindOfModelId(params.model) === 'image-to-video' && params.endImage) return exact(OWN_END_IMAGE_NOTE, false)
  if (chosen === 'exact') return exact(undefined)
  const model = referenceToVideoVariant(params.model)
  if (!model) {
    return exact(`${params.model} has no model for references, so the clip starts exactly on the frame, without references.`)
  }
  const carried = carriedReferences(clips, index)
  const room = Math.max(0, maxReferenceImages(model) - 1)
  const images = carried ? carried.images.slice(0, room) : []
  const audios = carried && supportsAudioInput(model) ? carried.audios.slice(0, maxReferenceAudios(model)) : []
  if (!images.length && !audios.length) return { ...exact(NOTHING_CARRIED_NOTE), form: 'reference-to-video' }
  return {
    chosen,
    mode: 'references',
    applies: true,
    form: 'reference-to-video',
    model,
    carried,
    images,
    audios,
    droppedImages: carried ? carried.images.slice(room).map((_, i) => room + i + 1) : [],
    frameToken: images.length + 1
  }
}

/** Stands for the previous clip's last frame in a list of what a continuing clip's tokens name (never a path). */
const FRAME_SLOT = '\u0000previous-frame'

/** What the @ImageN / @AudioN tokens of a clip that inherits its references name. */
export interface InheritedTokens {
  /** 0-based index of the clip the references are carried from. */
  fromIndex: number
  /** The carried pictures sent, in @Image order, then the previous clip's last frame. */
  images: string[]
  audios: ReferenceAudio[]
}

/**
 * What the tokens of the clip at `index` name when it continues in reference mode with references inherited from a
 * clip before it (none of its own); undefined otherwise. Used to keep its prompt's tokens on the same pictures when
 * that clip's references change (remapInheritedTokens).
 */
export function inheritedTokensAt(clips: readonly ChainClip[], index: number): InheritedTokens | undefined {
  const plan = continuationPlan(clips, index)
  if (plan?.mode !== 'references' || !plan.carried?.inherited) return undefined
  return { fromIndex: plan.carried.fromClip - 1, images: [...plan.images, FRAME_SLOT], audios: plan.audios }
}

/**
 * A prompt of a clip that inherits its references, with every @ImageN / @AudioN kept on the same picture, voice or
 * frame after the references it carries changed in the clip they come from – as that clip's own prompt follows them
 * (prompt-remap.ts): reordered, they get their new numbers; one no longer sent goes; the frame's token moves with it.
 */
export function remapInheritedTokens(prompt: string, before: InheritedTokens, after: InheritedTokens): string {
  return remapPromptReferences(
    prompt,
    { before: before.images, after: after.images },
    { before: before.audios, after: after.audios }
  )
}

/** Whether the carried lists differ (by path, in order). */
export function inheritedTokensChanged(before: InheritedTokens, after: InheritedTokens): boolean {
  return (
    !sameList(before.images, after.images) ||
    !sameList(
      before.audios.map((a) => a.path),
      after.audios.map((a) => a.path)
    )
  )
}

/** "Reference image 9 is not sent – room is needed for the start image (…)", or undefined when every picture fits. */
export function droppedImagesNote(plan: ContinuationPlan | undefined): string | undefined {
  return plan?.droppedImages.length ? droppedForFrameMessage(plan.droppedImages) : undefined
}

/**
 * The params a take of the clip at `index` is sent with, without the frames taken from its neighbours (they are
 * extracted when the take is made): a clip that continues in reference mode gets the reference-to-video model and the
 * references it carries (the frame goes after them; withContinuationFrame); one that takes a frame from a neighbour
 * otherwise gets its family's image-to-video model and no references; any other clip is sent as it is.
 */
export function sendParams(clips: readonly ChainClip[], index: number): GenerationParams {
  const params = clips[index].params
  const continuing = continuesAt(clips, index)
  const ending = endsOnNextAt(clips, index)
  if (!continuing && !ending) return params
  const plan = continuing ? continuationPlan(clips, index) : undefined
  if (plan?.mode === 'references') {
    // An image-to-video clip takes its shape from its start image and stores no format (every continuation did before
    // reference mode); sent with references it needs one: that of the clip it carries them from, the shape the frame
    // has too.
    const source = plan.carried ? clips[plan.carried.fromClip - 1]?.params : undefined
    return {
      ...params,
      model: plan.model,
      aspectRatio:
        kindOfModelId(params.model) === 'reference-to-video'
          ? params.aspectRatio || source?.aspectRatio
          : source?.aspectRatio || params.aspectRatio,
      startImage: undefined,
      endImage: undefined,
      referenceImages: plan.images.length ? [...plan.images] : undefined,
      referenceAudios: plan.audios.length ? plan.audios.map((a) => ({ ...a })) : undefined
    }
  }
  return {
    ...params,
    model: imageToVideoVariant(params.model),
    referenceImages: undefined,
    referenceAudios: undefined,
    ...(continuing ? { startImage: undefined } : {}),
    ...(ending ? { endImage: undefined } : {})
  }
}

/**
 * Stands in for the previous clip's last frame before it is extracted (composing the prompt, the checks): no file,
 * and no asset's picture, so it adds nothing to the References legend.
 */
export const CONTINUATION_FRAME_PLACEHOLDER = '\u0000sista-bildrutan-i-foregaende-klipp'

/** Reference-mode params with the previous clip's last frame (or its placeholder) as the last reference image. */
export function withContinuationFrame(params: GenerationParams, frame: string): GenerationParams {
  return { ...params, referenceImages: [...(params.referenceImages ?? []), frame] }
}

/**
 * Why a continuing clip's prompt can't be sent as it stands, or undefined. `sent` is sendParams; the plan
 * says how. In reference mode the prompt is checked against every carried picture with the frame after those that
 * fit (a token naming a picture that gives way for the frame is an error); exactly, it may name no references at all.
 */
export function continuationProblem(sent: GenerationParams, plan: ContinuationPlan): string | undefined {
  if (plan.mode !== 'references') {
    return blockingContinuationError(sent, {
      referencesPossible: plan.applies && plan.chosen === 'exact' && !!referenceToVideoVariant(sent.model)
    })
  }
  return blockingPromptError(
    { ...sent, referenceImages: plan.carried?.images ?? [], referenceAudios: plan.audios.length ? plan.audios : undefined },
    { continuationFrame: true }
  )
}
