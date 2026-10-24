// Video on fal.ai: what jobs.ts, the Editor and the quotes need from a video service (providers.ts VideoBackend),
// for the models in shared/fal-models.ts. Each request's input is written in its endpoint's own terms (Seedance's
// image_urls/video_urls/audio_urls with @Image1 … in the prompt, Kling's start_image_url, Veo's first and last frame);
// every file goes up to fal's storage first (fal.ts) and the input names its link. Pictures are prepared as for Venice
// (upright, at most 2048 px), reference audio cut to its windows as MP3, reference videos to their proxies, so a clip
// gets the same inputs on either service. Prices are worked out here (fal has no quote that looks at the inputs).

import { basename } from 'node:path'
import { falVideoModel, falVideoModelList, falVideoPrice, type FalVideoModel } from '@shared/fal-models'
import { paramsForSubmit, referenceVideosOf, videosAreReferences } from '@shared/models'
import { falEndpoint } from '@shared/provider'
import { videoToken } from '@shared/prompt-refs'
import type { GenerationParams, VideoModel } from '@shared/types'
import { FalClient, FalError } from './fal'
import { encodeAudioClip, probe } from './ffmpeg'
import { isInsideRoot } from './paths'
import { referenceVideoProxy, referenceVideoSeconds, resolveReferenceVideos } from './reference-videos'
import { encodeInputImage, encodeReferenceAudios, ensureImagesExist, resolveReferenceAudios } from './venice'
import type { RetrieveResult } from './venice'

/** A queued fal video request as jobs.ts sends it: the model, the endpoint and its input. */
export interface FalVideoBody extends Record<string, unknown> {
  model: string
  endpoint: string
  input: Record<string, unknown>
}

export function isFalVideoBody(body: Record<string, unknown>): body is FalVideoBody {
  return typeof body.endpoint === 'string' && !!body.input && typeof body.input === 'object'
}

/** "8s" → 8, whole seconds. */
function wholeSeconds(duration: string | undefined): number {
  return Math.max(1, Math.round(Number.parseFloat(duration ?? '') || 0))
}

/**
 * The duration in the endpoint's own form: "8" (Seedance, Kling 3), 8 (Kling 4.0), "8s" (Veo); "auto" (the Editor's
 * edit, which follows its video) only Seedance takes, the others get none.
 */
function durationInput(model: FalVideoModel, duration: string | undefined): string | number | undefined {
  if (!Number.isFinite(Number.parseFloat(duration ?? ''))) return model.style === 'seedance' ? 'auto' : undefined
  const s = wholeSeconds(duration)
  if (model.style === 'kling4') return s
  if (model.style === 'veo') return `${s}s`
  return String(s)
}

function modelOf(params: Pick<GenerationParams, 'model'>): FalVideoModel {
  const model = falVideoModel(params.model)
  if (!model) throw new Error(`fal.ai has no model ${params.model} in Studio. Choose another model.`)
  return model
}

export class FalVideo {
  constructor(private readonly fal: FalClient) {}

  /** The models Studio offers on fal (no request: the list is Studio's own). */
  listVideoModels(): Promise<VideoModel[]> {
    return Promise.resolve(falVideoModelList())
  }

  private async image(path: string): Promise<string> {
    const { bytes, mime } = await encodeInputImage(path)
    return this.fal.upload(bytes, mime, basename(path).replace(/\.[^.]+$/, mime === 'image/png' ? '.png' : '.jpg'))
  }

  /** A video Studio made small enough itself (a proxy, the Editor's selection): only files in the library are sent. */
  private async video(path: string): Promise<string> {
    if (!isInsideRoot(path)) throw new Error(`The video ${basename(path)} is not in the library and is not sent.`)
    return this.fal.uploadFile(path)
  }

  /**
   * The request for these params (already composed: the prompt is what is sent). Files are uploaded on the way. The
   * Editor's video to edit or extend goes as Seedance 2.5's `editing` / `extension` task; lip sync sends the source
   * video and the first reference audio clip's window.
   */
  async buildRequestBody(params: GenerationParams): Promise<FalVideoBody> {
    ensureImagesExist(params)
    const model = modelOf(params)
    if (params.referenceAudios?.some((a) => a.start === undefined || a.length === undefined)) {
      params = await resolveReferenceAudios(params)
    }
    const references = videosAreReferences(params)
    if (references && referenceVideosOf(params).some((v) => v.start === undefined || v.length === undefined)) {
      params = await resolveReferenceVideos(params)
    }
    const sent = paramsForSubmit(params)
    const input: Record<string, unknown> = {}
    let endpoint = model.endpoint
    const prompt = typeof params.prompt === 'string' ? params.prompt : ''

    switch (model.style) {
      case 'topaz': {
        if (!params.sourceVideo) throw new Error('The source video is missing.')
        input.video_url = await this.video(params.sourceVideo)
        input.upscale_factor = params.upscaleFactor ?? 2
        // Studio plays and cuts H.264; Topaz gives H.265 unless asked.
        input.H264_output = true
        return { model: params.model, endpoint, input }
      }
      case 'lipsync': {
        // The mouths follow the first reference audio clip's window, else the source video's own sound (the Editor's
        // selection with the sound it has now, after re-recorded lines, say).
        if (!params.sourceVideo) throw new Error('The source video is missing.')
        const clip = params.referenceAudios?.[0]
        const mp3 = clip
          ? await encodeAudioClip(clip.path, clip.start ?? 0, clip.length ?? 10)
          : await encodeAudioClip(params.sourceVideo, 0, (await probe(params.sourceVideo)).duration)
        input.video_url = await this.video(params.sourceVideo)
        input.audio_url = await this.fal.upload(mp3, 'audio/mpeg', 'speech.mp3')
        input.model = 'lipsync-2'
        // Sound and picture are the same length; a model that finds them apart cuts the longer one.
        input.sync_mode = 'cut_off'
        return { model: params.model, endpoint, input }
      }
      case 'wan-edit':
      case 'gemini-edit': {
        if (!params.sourceVideo) throw new Error('The source video is missing.')
        input.prompt = prompt
        input.video_url = await this.video(params.sourceVideo)
        if (model.style === 'wan-edit') input.audio_setting = 'origin'
        if (params.resolution && model.resolutions.includes(params.resolution)) {
          input.resolution = params.resolution
        }
        return { model: params.model, endpoint, input }
      }
      default:
        break
    }

    input.prompt = prompt
    const duration = durationInput(model, params.duration)
    if (duration !== undefined) input.duration = duration
    if (params.resolution && model.resolutions.includes(params.resolution)) input.resolution = params.resolution
    if (params.aspectRatio && model.aspectRatios.includes(params.aspectRatio)) input.aspect_ratio = params.aspectRatio
    if (model.audioConfigurable) input.generate_audio = params.audio !== false
    if (model.negativePrompt && params.negativePrompt?.trim()) input.negative_prompt = params.negativePrompt
    if (model.style === 'seedance') input.codec = 'H264'
    if (model.style === 'veo') input.auto_fix = false

    if (model.kind === 'image-to-video') {
      if (!sent.startImage) throw new Error('The start image is missing.')
      const start = await this.image(sent.startImage)
      const end = sent.endImage && model.endImage ? await this.image(sent.endImage) : undefined
      if (model.style === 'veo') {
        if (end && model.endEndpoint) {
          endpoint = model.endEndpoint
          input.first_frame_url = start
          input.last_frame_url = end
        } else {
          input.image_url = start
        }
      } else if (model.style === 'seedance') {
        input.image_url = start
        if (end) input.end_image_url = end
      } else {
        input.start_image_url = start
        if (end) input.end_image_url = end
      }
    }

    if (model.kind === 'reference-to-video') {
      const images = sent.referenceImages ?? []
      if (images.length) input.image_urls = await Promise.all(images.map((p) => this.image(p)))
      if (sent.referenceAudios?.length && model.maxAudios > 0) {
        const mp3s = await encodeReferenceAudios(sent.referenceAudios)
        input.audio_urls = await Promise.all(
          mp3s.map((mp3, i) => this.fal.upload(mp3, 'audio/mpeg', `audio-${i + 1}.mp3`))
        )
      }
      const videos = referenceVideosOf(params)
      if (videos.length && model.videoLimits) {
        const urls: string[] = []
        if (references) {
          for (const [i, clip] of (sent.referenceVideos ?? []).entries()) {
            try {
              urls.push(await this.video(await referenceVideoProxy(clip, i)))
            } catch (err) {
              throw new Error(`${videoToken(i + 1)}: ${err instanceof Error ? err.message : String(err)}`, {
                cause: err
              })
            }
          }
          if (model.referenceTask) input.task = 'reference'
        } else {
          // The Editor's video to edit or extend, as it is.
          for (const clip of videos) urls.push(await this.video(clip.path))
          if (model.referenceTask) input.task = params.referenceTask === 'extend' ? 'extension' : 'editing'
        }
        if (urls.length) input.video_urls = urls
      }
      if (model.style === 'veo' && !images.length) throw new Error('Veo needs at least one reference image.')
    }
    return { model: params.model, endpoint, input }
  }

  /**
   * The price of these params in USD (no request: worked out from the model's rates). Reference videos count with
   * their length (the windows that are sent, or the Editor's whole video); an upscaler, an edit model and lip sync
   * count their source video's.
   */
  async quote(params: GenerationParams): Promise<number> {
    const model = modelOf(params)
    const inputs: { inputVideoSeconds?: number; sourceSeconds?: number; sourceHeight?: number } = {}
    if (params.sourceVideo) {
      const info = await probe(params.sourceVideo)
      inputs.sourceSeconds = info.duration
      inputs.sourceHeight = info.height
    }
    if (model.videoLimits) {
      const sent = paramsForSubmit(params).referenceVideos
      if (sent?.length) inputs.inputVideoSeconds = await referenceVideoSeconds({ ...params, referenceVideos: sent })
    }
    if (model.lipSync && !inputs.sourceSeconds && params.referenceAudios?.[0]?.length) {
      inputs.sourceSeconds = params.referenceAudios[0].length
    }
    const usd = falVideoPrice(params.model, params, inputs)
    if (usd === undefined) throw new Error(`No price is known for ${model.name}.`)
    return usd
  }

  async queue(body: FalVideoBody): Promise<{ queue_id: string }> {
    const { requestId } = await this.fal.submit(body.endpoint, body.input)
    return { queue_id: requestId }
  }

  /** Where a request stands; when it is done, the link to the video. */
  async retrieve(modelId: string, requestId: string): Promise<RetrieveResult> {
    const endpoint = falVideoModel(modelId)?.endpoint ?? falEndpoint(modelId)
    const status = await this.fal.status(endpoint, requestId)
    if (status.state !== 'done') return { state: 'processing' }
    const out = await this.fal.result<{ video?: { url?: string } }>(endpoint, requestId)
    const url = out?.video?.url
    if (!url)
      throw new FalError('fal.ai finished without a video. It may have been charged anyway – check your usage.', 502)
    return { state: 'download', url }
  }

  /** Nothing to do: fal drops the files after a day, and only a key with full rights may delete them sooner. */
  async complete(_modelId: string, _requestId: string): Promise<void> {}

  download(url: string): Promise<Buffer> {
    return this.fal.download(url, 'The video could not be downloaded from fal.ai.')
  }
}
