// Model-related defaults and helpers shared by the main process and the renderer.

import type { GenerationParams, ReferenceAudio, VideoModel } from './types'

export type Kind = 'text-to-video' | 'image-to-video' | 'reference-to-video'

export const KINDS: { id: Kind; label: string }[] = [
  { id: 'text-to-video', label: 'Text' },
  { id: 'image-to-video', label: 'Start image' },
  { id: 'reference-to-video', label: 'References' }
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
// Which models take reference audio (VideoModel.audioInput), from the same list: the id says nothing about it.
const knownAudioInput = new Map<string, boolean>()
// Which models take a source video (VideoModel.videoInput), and which of those are upscalers. The ids of some
// (minimax-h3-max-recast, kling-v3-*-motion-control) say nothing about it.
const knownVideoInput = new Map<string, boolean>()
const knownUpscale = new Set<string>()

/** An upscaler lists its factors ("2x", "4x") where other models list resolutions. */
function listsUpscaleFactors(resolutions: readonly string[] | undefined): boolean {
  return !!resolutions?.length && resolutions.every((r) => /^\d+(\.\d+)?x$/i.test(r))
}

/**
 * Records the kinds (and whether each model takes reference audio or a source video) from a fetched model list.
 * Main and renderer each call this when they get the list.
 */
export function rememberModelKinds(
  models: readonly (Pick<VideoModel, 'id' | 'kind'> &
    Partial<Pick<VideoModel, 'audioInput' | 'videoInput' | 'resolutions'>>)[]
): void {
  for (const m of models) {
    if (m.kind === 'text-to-video' || m.kind === 'image-to-video' || m.kind === 'reference-to-video') {
      knownKinds.set(m.id, m.kind)
    }
    if (typeof m.audioInput === 'boolean') knownAudioInput.set(m.id, m.audioInput)
    if (typeof m.videoInput === 'boolean') {
      knownVideoInput.set(m.id, m.videoInput)
      if (m.videoInput && (m.id.includes('upscale') || listsUpscaleFactors(m.resolutions))) knownUpscale.add(m.id)
      else knownUpscale.delete(m.id)
    }
  }
}

/**
 * Whether the model takes a source video (`video_url`): a video-to-video edit model or an upscaler. From the
 * fetched model list when it has been fetched (Venice's constraints.video_input), else by id: main may not have
 * fetched the list yet when a take is resumed or a request body is built.
 */
export function isVideoInputModel(id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  return knownVideoInput.get(id) ?? /video-to-video|upscale/.test(id)
}

/** Whether the model is an upscaler (Topaz): it takes `upscale_factor` and no prompt, resolution or aspect. */
export function isUpscaleModel(id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  return id.includes('upscale') || knownUpscale.has(id)
}

/**
 * Whether the model takes reference videos (`reference_video_urls`, "<Video 1>" in the prompt) and a reference
 * task (`omni_reference_task_type`): Seedance 2.x reference-to-video.
 */
export function supportsReferenceVideos(id: string): boolean {
  return typeof id === 'string' && /^seedance-2-.*reference-to-video/.test(id)
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

/**
 * The reference-to-video sibling of a model (seedance-2-5-image-to-video-basic → seedance-2-5-reference-to-video-basic),
 * or undefined when its family has none: a sequence clip that continues from the previous clip in reference mode is
 * sent with it (see continuation.ts). `available` (the model list's ids) decides when given; otherwise the model list
 * main and the window remember (rememberModelKinds), and before that has arrived the families known to have one
 * (Seedance 2.x).
 */
export function referenceToVideoVariant(modelId: string, available?: readonly string[]): string | undefined {
  if (typeof modelId !== 'string' || !modelId) return undefined
  if (kindOfModelId(modelId) === 'reference-to-video') return modelId
  const sibling = modelId.replace(/(image|text)-to-video/, 'reference-to-video')
  if (sibling === modelId) return undefined
  if (available) return available.includes(sibling) ? sibling : undefined
  if (knownKinds.size) return knownKinds.get(sibling) === 'reference-to-video' ? sibling : undefined
  return /^seedance-2-/.test(sibling) ? sibling : undefined
}

// ── Keyframes: start and end image ──────────────────────────────────────────
// Venice's /video/queue takes `image_url` (the first frame) and, with some image-to-video models, `end_image_url`
// (the last frame). The model list has no flag for the latter, so the models known to take it are listed here
// by id: Seedance's image-to-video models (first + last frame), Kling V3 and O3 image-to-video, and the models
// built for it (flux-3-first-last-frame-to-video, PixVerse's *-transition).

/** Whether the model takes an end image (`end_image_url`) besides its start image. */
export function supportsEndImage(modelId: string): boolean {
  if (typeof modelId !== 'string') return false
  const id = modelId.toLowerCase()
  if (id.includes('first-last-frame') || id.includes('transition')) return true
  return /^seedance-.+-image-to-video(-.*)?$/.test(id) || /^kling-[vo]3-.*image-to-video/.test(id)
}

/**
 * The model a clip with an end image is generated with: the model itself when it takes one, else its family's
 * image-to-video sibling when that does, else (only when `available`, the model list's ids, shows they exist)
 * the family's first-last-frame or transition model, else Seedance's image-to-video model. `available` also
 * rules out siblings Venice doesn't offer.
 */
export function endImageVariant(modelId: string, available?: readonly string[]): string {
  const offered = (id: string): boolean => supportsEndImage(id) && (!available || available.includes(id))
  const i2v = imageToVideoVariant(modelId)
  // Ids made up from the family name are only tried against the list: without it they may not exist at all.
  const guessed = available
    ? [i2v.replace(/image-to-video/, 'first-last-frame-to-video'), i2v.replace(/-image-to-video.*$/, '-transition')]
    : []
  const found = [modelId, i2v, ...guessed].find(offered)
  if (found) return found
  const fallback = DEFAULT_MODEL['image-to-video']
  return !available || available.includes(fallback) ? fallback : (available.find(supportsEndImage) ?? fallback)
}

export function maxReferenceImages(modelId: string): number {
  if (modelId.includes('grok')) return 7
  if (modelId.includes('kling')) return 4
  return 9
}

// ── Reference audio ───────────────────────────────────────────────────────────
// Venice takes `reference_audio_urls` with reference-to-video models whose constraints say `audio_input`:
// clips that steer a voice's timbre, pacing and tone (or a soundscape), never alone, always with at least one
// reference image. The prompt names them @Audio1, @Audio2 … like the pictures.

/** Venice accepts at most this many seconds of reference audio per generation, all clips together. */
export const MAX_REFERENCE_AUDIO_SECONDS = 15
/** The shortest reference audio clip Venice accepts, in seconds. */
export const MIN_AUDIO_CLIP_SECONDS = 2
/** The longest reference audio clip Venice accepts, in seconds. */
export const MAX_AUDIO_CLIP_SECONDS = 15
/** How much of a clip is sent when nothing else is chosen: room for a second voice within the 15 s. */
export const DEFAULT_AUDIO_CLIP_SECONDS = 10

/**
 * Whether a reference window is too short for Venice to take (the prompt check's rule, with a margin for slider
 * values and sums). Such a clip can never be sent, so it is never added on anyone's behalf: a character's voice
 * from a recording under 2 s stays out of the form instead of blocking it.
 */
export function isAudioClipTooShort(length: number): boolean {
  return length < MIN_AUDIO_CLIP_SECONDS - 0.005
}

/** How many reference audio clips a model takes. Seedance takes 3; later clips are not sent. */
export function maxReferenceAudios(_modelId: string): number {
  return 3
}

/**
 * Whether the model is used with reference audio: a reference-to-video model whose Venice constraints say
 * `audio_input`. (Some text- and image-to-video models take audio too, as a soundtrack to animate to, which
 * Studio doesn't offer.) By id it answers from the fetched model list (rememberModelKinds); until that has
 * arrived, from the families known to take it: Seedance's and MiniMax's reference-to-video models.
 */
export function supportsAudioInput(model: Pick<VideoModel, 'id' | 'kind' | 'audioInput'> | string): boolean {
  if (typeof model !== 'string') return model.kind === 'reference-to-video' && !!model.audioInput
  if (kindOfModelId(model) !== 'reference-to-video') return false
  return knownAudioInput.get(model) ?? (model.startsWith('seedance-') || model.startsWith('minimax-'))
}

/** Reference audio clips from the window, an agent or stored JSON, without malformed entries; undefined when none. */
export function sanitizeReferenceAudios(input: unknown): ReferenceAudio[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: ReferenceAudio[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const { path, start, length } = item as Partial<Record<keyof ReferenceAudio, unknown>>
    if (typeof path !== 'string' || !path) continue
    const clip: ReferenceAudio = { path }
    if (typeof start === 'number' && Number.isFinite(start) && start >= 0) clip.start = start
    if (typeof length === 'number' && Number.isFinite(length) && length > 0) clip.length = length
    out.push(clip)
  }
  return out.length ? out : undefined
}

/**
 * The part of the file a reference audio clip sends, in seconds: from `start` (default 0) for `length`
 * (default DEFAULT_AUDIO_CLIP_SECONDS), cut short where the file ends when its duration is known. Not clamped to
 * Venice's 2–15 s: a window outside it is reported by the prompt checks rather than quietly changed.
 */
export function referenceAudioWindow(clip: ReferenceAudio, duration?: number): { start: number; length: number } {
  const start = typeof clip.start === 'number' && Number.isFinite(clip.start) && clip.start > 0 ? clip.start : 0
  const known = typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration - start) : undefined
  const asked =
    typeof clip.length === 'number' && Number.isFinite(clip.length) && clip.length > 0
      ? clip.length
      : Math.min(known ?? DEFAULT_AUDIO_CLIP_SECONDS, DEFAULT_AUDIO_CLIP_SECONDS)
  return { start, length: known === undefined ? asked : Math.min(asked, known) }
}

/**
 * Drops inputs the model doesn't use, so stale form state isn't sent: start images outside image-to-video,
 * end images unless the model takes one (supportsEndImage), reference images outside reference-to-video (and
 * past the model's limit), and reference audio unless the model takes it (and past its limit). A video-input
 * model (an edit model or an upscaler) keeps only its source video (and an upscaler its factor) and drops every
 * image and audio; a Seedance 2.x reference-to-video model keeps its reference videos and reference task; every
 * other model drops those video fields.
 */
export function paramsForSubmit(params: GenerationParams): GenerationParams {
  const videoInput = isVideoInputModel(params.model)
  const upscale = videoInput && isUpscaleModel(params.model)
  const referenceVideos = !videoInput && supportsReferenceVideos(params.model)
  const kind = kindOfModelId(params.model)
  const audios =
    !videoInput && supportsAudioInput(params.model) ? sanitizeReferenceAudios(params.referenceAudios) : undefined
  return {
    ...params,
    startImage: !videoInput && kind === 'image-to-video' ? params.startImage : undefined,
    endImage: !videoInput && kind === 'image-to-video' && supportsEndImage(params.model) ? params.endImage : undefined,
    referenceImages:
      !videoInput && kind === 'reference-to-video'
        ? params.referenceImages?.slice(0, maxReferenceImages(params.model))
        : undefined,
    referenceAudios: audios?.slice(0, maxReferenceAudios(params.model)),
    sourceVideo: videoInput && typeof params.sourceVideo === 'string' ? params.sourceVideo || undefined : undefined,
    upscaleFactor: upscale ? params.upscaleFactor : undefined,
    referenceVideos:
      referenceVideos && Array.isArray(params.referenceVideos)
        ? params.referenceVideos.filter((v) => typeof v === 'string' && v !== '').slice(0, MAX_REFERENCE_VIDEOS)
        : undefined,
    referenceTask: referenceVideos ? params.referenceTask : undefined
  }
}

/** Venice takes at most this many reference videos per request. */
export const MAX_REFERENCE_VIDEOS = 10

/**
 * The most raw media (videos, images and audio together, before base64) Studio puts into one Venice request body.
 * Venice has no upload endpoint, so media travels as data URLs inside a JSON body capped at about 35 MB: 25 MB of
 * raw media passed, 26 MB got 413. 22 MB keeps a margin for base64 and the rest of the body.
 */
export const MAX_REQUEST_MEDIA_BYTES = 22_000_000

/** Parses "8s" → 8. */
export function durationSeconds(duration: string): number {
  return Number.parseFloat(duration) || 0
}
