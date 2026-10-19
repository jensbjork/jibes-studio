import { continuationProblem } from '@shared/continuation'
import { kindOfModelId, supportsEndImage } from '@shared/models'
import { songClipProblem, withSong } from '@shared/song-send'
import type { GenerationParams, Sequence, VideoModel } from '@shared/types'
import { missingInput, unavailableModel } from '../ParamsForm'
import { continuationOf, continues, effectiveParams, readyTake } from './sequenceUtils'

/**
 * A sequence clip with an end image of its own that its image-to-video model can't take: main refuses to generate
 * it (sequences.ts endImageProblem) instead of leaving the picture out as the Generate form does.
 */
export function ownEndImageRefused(params: GenerationParams, endFromNext: boolean): boolean {
  return (
    !endFromNext &&
    !!params.endImage &&
    kindOfModelId(params.model) === 'image-to-video' &&
    !supportsEndImage(params.model)
  )
}

/**
 * What stands in the way of the clip's prompt and references as its take would be sent (without the full stop,
 * for a button), or undefined: the words main's clipProblem uses. A clip that continues from the previous one
 * is checked the way it is sent – in reference mode against the references it carries with the previous clip's last
 * frame after them, exactly against none – and any other clip like a generation (missingInput); a song clip with its
 * window of the song as its reference audio (withSong). `params`: the editor's draft for the clip (default: the stored
 * params).
 */
export function sendInputProblem(
  sequence: Sequence,
  index: number,
  params: GenerationParams = sequence.segments[index]?.params
): string | undefined {
  const s = sequence.segments[index]
  if (!s || !params) return undefined
  const segment = { ...s, params }
  const plan = continues(segment, index) ? continuationOf(segment, index, sequence) : undefined
  if (!plan) return missingInput(params.song ? withSong(params, sequence.song) : params, false)
  if (!params.prompt.trim()) return 'Write a prompt'
  return continuationProblem(effectiveParams(segment, index, sequence), plan)?.replace(/\.\s*$/, '')
}

export interface ClipCheck {
  sequence: Sequence
  index: number
  /** The clip's params: the editor's draft, or the stored params. */
  params: GenerationParams
  models: VideoModel[]
  modelsError?: string
  ffmpegOk: boolean
}

/**
 * Why a new take of the clip can't be generated right now (short text for a button), or undefined when it
 * can. Mirrors what main checks before any money is spent, so the segment editor doesn't offer a button that
 * would only be refused: the prompt and its references (as the take is sent, see sendInputProblem), the frames from
 * the neighbours (they need ffmpeg and a finished take to come from), an end image the model can take, and a model
 * that is online.
 */
export function clipBlocked({ sequence, index, params, models, modelsError, ffmpegOk }: ClipCheck): string | undefined {
  const s = sequence.segments[index]
  if (!s) return 'The clip no longer exists'
  const continuing = continues(s, index)
  const endFromNext = s.endFromNext && index < sequence.segments.length - 1
  const previous = continuing ? sequence.segments[index - 1] : undefined
  const next = endFromNext ? sequence.segments[index + 1] : undefined
  // The model the take is sent with (a continuation's family model), which must be there and online.
  const sent = effectiveParams({ ...s, params }, index, sequence)
  const model = models.find((m) => m.id === sent.model)
  // A song clip that can't hear its window of the song (its model, its place) says so first – after a missing prompt,
  // as main does.
  const song = params.prompt.trim() ? songClipProblem(sent, sequence.song)?.replace(/\.\s*$/, '') : undefined
  return (
    song ??
    sendInputProblem(sequence, index, params) ??
    ((continuing || endFromNext) && !ffmpegOk ? 'ffmpeg is needed for frames from the neighbouring clips' : undefined) ??
    (previous && !readyTake(previous) ? `Clip ${index} has no finished take` : undefined) ??
    (next && !readyTake(next) ? `Clip ${index + 2} has no finished take` : undefined) ??
    (endFromNext && !supportsEndImage(params.model) ? "This model can't take an end image – pick another" : undefined) ??
    // Main refuses a take whose own end image the model can't take (a keyframe paid for and lost), rather than
    // sending it without: so does the button.
    (ownEndImageRefused(params, endFromNext) ? "This model can't take an end image – pick another or remove the image" : undefined) ??
    (!model
      ? models.length
        ? 'Pick an available model'
        : modelsError
          ? "The models couldn't be loaded"
          : 'Loading models…'
      : unavailableModel(model))
  )
}
