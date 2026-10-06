// Model-related defaults and helpers shared by the main process and the renderer.

import type { GenerationParams, VideoModel } from './types'

export type Kind = 'text-to-video' | 'image-to-video' | 'reference-to-video'

export const KINDS: { id: Kind; label: string }[] = [
  { id: 'text-to-video', label: 'Text' },
  { id: 'image-to-video', label: 'Startbild' },
  { id: 'reference-to-video', label: 'Referens' }
]

export const DEFAULT_MODEL: Record<Kind, string> = {
  'text-to-video': 'seedance-2-5-text-to-video-basic',
  'image-to-video': 'seedance-2-5-image-to-video-basic',
  'reference-to-video': 'seedance-2-5-reference-to-video-basic'
}

/** Preferred values when a model is (re)selected and the current value isn't supported. */
export const PREFERRED = {
  durations: ['8s', '5s', '6s'],
  resolutions: ['480p', '720p'],
  aspectRatios: ['16:9']
}

export const DEFAULT_PARAMS: GenerationParams = {
  model: DEFAULT_MODEL['reference-to-video'],
  prompt: '',
  duration: '8s',
  resolution: '480p',
  aspectRatio: '16:9',
  audio: true
}

// Kinds of the models in Venice's list, as classified by the main process (VideoModel.kind). Some ids carry
// no kind at all (e.g. runway-gen4-5 is image-to-video), so the id alone would call them text-to-video and
// the form, the submit and the continuation logic would each disagree about what the model needs.
const knownKinds = new Map<string, Kind>()

/** Records the kinds from a fetched model list. Main and renderer each call this when they get the list. */
export function rememberModelKinds(models: readonly Pick<VideoModel, 'id' | 'kind'>[]): void {
  for (const m of models) {
    if (m.kind === 'text-to-video' || m.kind === 'image-to-video' || m.kind === 'reference-to-video') {
      knownKinds.set(m.id, m.kind)
    }
  }
}

/**
 * The model's mode. Uses the model list's classification when it has been fetched; otherwise the id decides
 * (Venice reports R2V models as "image-to-video", so the id comes before Venice's model_type there).
 */
export function kindOfModelId(id: string): Kind {
  const known = knownKinds.get(id)
  if (known) return known
  if (id.includes('reference-to-video')) return 'reference-to-video'
  if (id.includes('image-to-video') || id.includes('first-last-frame') || id.includes('transition')) {
    return 'image-to-video'
  }
  return 'text-to-video'
}

/** Keeps the current value if the model supports it, otherwise picks a preferred one. */
export function pickOption(options: string[], current: string | undefined, preferred: string[] = []): string | undefined {
  if (!options.length) return undefined
  if (current && options.includes(current)) return current
  return preferred.find((p) => options.includes(p)) ?? options[0]
}

/**
 * The audio setting params get with a model, as the form sets it when the model changes: none for a model
 * without audio, else the current choice (on by default). The agent's tools use the same rule, so a clip an
 * agent saved doesn't change (and lapse its pending approval) just because the user opens it.
 */
export function audioForModel(model: Pick<VideoModel, 'audio'>, audio: boolean | undefined): boolean | undefined {
  return model.audio ? (audio ?? true) : undefined
}

/** The image-to-video sibling of a model, e.g. seedance-2-5-reference-to-video-basic → seedance-2-5-image-to-video-basic. */
export function imageToVideoVariant(modelId: string): string {
  if (kindOfModelId(modelId) === 'image-to-video') return modelId
  return modelId.replace(/(reference|text)-to-video/, 'image-to-video')
}

export function maxReferenceImages(modelId: string): number {
  if (modelId.includes('grok')) return 7
  if (modelId.includes('kling')) return 4
  return 9
}

/** Drops image inputs the model's kind doesn't use, so stale form state isn't sent. */
export function paramsForSubmit(params: GenerationParams): GenerationParams {
  const kind = kindOfModelId(params.model)
  return {
    ...params,
    startImage: kind === 'image-to-video' ? params.startImage : undefined,
    endImage: kind === 'image-to-video' ? params.endImage : undefined,
    referenceImages:
      kind === 'reference-to-video' ? params.referenceImages?.slice(0, maxReferenceImages(params.model)) : undefined
  }
}

/** Parses "8s" → 8. */
export function durationSeconds(duration: string): number {
  return Number.parseFloat(duration) || 0
}
