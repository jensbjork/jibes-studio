// The generation services behind one face: each call goes to the service its model belongs to (provider.ts: fal's
// ids are `fal:…`), so a job sent to Venice is fetched from Venice even after the user switched to fal.ai, and the other
// way round. Lists and defaults – what new work is made with – come from the active service (Settings → Service).

import { modelForService, rememberModelKinds } from '@shared/models'
import { rememberPromptLimits } from '@shared/prompt-compose'
import { providerOf, type Provider } from '@shared/provider'
import type { AudioCatalog, GenerationParams, VideoModel } from '@shared/types'
import { FalClient } from './fal'
import type { FalAudio } from './fal-audio'
import { FalVideo, isFalVideoBody } from './fal-video'
import { buildRequestBody, download, VeniceClient, type RetrieveResult } from './venice'
import type { VeniceAudio } from './venice-audio'

/** What the job manager, the Editor, sequences and the quotes need of a video service. */
export interface VideoBackend {
  listVideoModels(): Promise<VideoModel[]>
  quote(params: GenerationParams): Promise<number>
  buildRequestBody(params: GenerationParams): Promise<Record<string, unknown>>
  queue(body: Record<string, unknown>): Promise<{ queue_id: string; download_url?: string }>
  retrieve(model: string, queueId: string): Promise<RetrieveResult>
  complete(model: string, queueId: string): Promise<void>
  /** A finished video's link, downloaded (neither service's link needs the key). */
  download(url: string, model?: string): Promise<Buffer>
}

/** Venice's client as a VideoBackend (its request body and download are module functions). */
class VeniceVideo implements VideoBackend {
  constructor(private readonly client: VeniceClient) {}
  listVideoModels(): Promise<VideoModel[]> {
    return this.client.listVideoModels()
  }
  quote(params: GenerationParams): Promise<number> {
    return this.client.quote(params)
  }
  buildRequestBody(params: GenerationParams): Promise<Record<string, unknown>> {
    return buildRequestBody(params)
  }
  queue(body: Record<string, unknown>): Promise<{ queue_id: string; download_url?: string }> {
    return this.client.queue(body)
  }
  retrieve(model: string, queueId: string): Promise<RetrieveResult> {
    return this.client.retrieve(model, queueId)
  }
  complete(model: string, queueId: string): Promise<void> {
    return this.client.complete(model, queueId)
  }
  download(url: string): Promise<Buffer> {
    return download(url)
  }
}

export class VideoService implements VideoBackend {
  private readonly veniceVideo: VeniceVideo
  readonly falVideo: FalVideo

  constructor(
    readonly venice: VeniceClient,
    readonly fal: FalClient,
    private readonly active: () => Provider
  ) {
    this.veniceVideo = new VeniceVideo(venice)
    this.falVideo = new FalVideo(fal)
  }

  private by(model: string | undefined): VideoBackend {
    return providerOf(model) === 'fal' ? this.falVideo : this.veniceVideo
  }

  /** The active service's models (fal's list is Studio's own; Venice's is fetched, free). */
  async listVideoModels(): Promise<VideoModel[]> {
    if (this.active() !== 'fal') return this.veniceVideo.listVideoModels()
    const models = await this.falVideo.listVideoModels()
    // As Venice's list does: the shared helpers and the prompt limits agree with the list.
    rememberModelKinds(models)
    rememberPromptLimits(models)
    return models
  }

  /** The price where the job will go: a model of the other service is priced as the active one's (modelForService). */
  quote(params: GenerationParams): Promise<number> {
    const model = modelForService(params.model)
    return this.by(model).quote(model === params.model ? params : { ...params, model })
  }

  buildRequestBody(params: GenerationParams): Promise<Record<string, unknown>> {
    return this.by(params.model).buildRequestBody(params)
  }

  queue(body: Record<string, unknown>): Promise<{ queue_id: string; download_url?: string }> {
    const model = typeof body.model === 'string' ? body.model : undefined
    if (providerOf(model) === 'fal' && isFalVideoBody(body)) return this.falVideo.queue(body)
    return this.veniceVideo.queue(body)
  }

  retrieve(model: string, queueId: string): Promise<RetrieveResult> {
    return this.by(model).retrieve(model, queueId)
  }

  complete(model: string, queueId: string): Promise<void> {
    return this.by(model).complete(model, queueId)
  }

  download(url: string, model?: string): Promise<Buffer> {
    return this.by(model).download(url)
  }
}

/** What the Editor, voice design and a song's lyrics need of an audio service (VeniceAudio's calls). */
export type AudioBackend = Pick<
  VeniceAudio,
  | 'catalog'
  | 'quoteAudio'
  | 'quoteVoiceChange'
  | 'queueAudio'
  | 'retrieveAudio'
  | 'completeAudio'
  | 'queueVoiceChange'
  | 'retrieveVoiceChange'
  | 'completeVoiceChange'
  | 'speech'
  | 'cloneVoice'
  | 'transcribe'
>

/** Sound on either service: each call goes to its model's service, the catalogue comes from the active one. */
export class AudioService implements AudioBackend {
  constructor(
    readonly venice: VeniceAudio,
    readonly fal: FalAudio,
    private readonly active: () => Provider
  ) {}

  private by(model: unknown): AudioBackend {
    return providerOf(typeof model === 'string' ? model : undefined) === 'fal' ? this.fal : this.venice
  }

  catalog(force = false): Promise<AudioCatalog> {
    return this.active() === 'fal' ? this.fal.catalog(force) : this.venice.catalog(force)
  }
  quoteAudio(o: Parameters<AudioBackend['quoteAudio']>[0]): Promise<number> {
    return this.by(o.model).quoteAudio(o)
  }
  quoteVoiceChange(model: string, seconds: number): Promise<number> {
    return this.by(model).quoteVoiceChange(model, seconds)
  }
  queueAudio(body: Record<string, unknown>): Promise<{ queueId: string }> {
    return this.by(body.model).queueAudio(body)
  }
  retrieveAudio(model: string, queueId: string): ReturnType<AudioBackend['retrieveAudio']> {
    return this.by(model).retrieveAudio(model, queueId)
  }
  completeAudio(model: string, queueId: string): Promise<void> {
    return this.by(model).completeAudio(model, queueId)
  }
  queueVoiceChange(o: Parameters<AudioBackend['queueVoiceChange']>[0]): ReturnType<AudioBackend['queueVoiceChange']> {
    return this.by(o.model).queueVoiceChange(o)
  }
  retrieveVoiceChange(model: string, queueId: string): ReturnType<AudioBackend['retrieveVoiceChange']> {
    return this.by(model).retrieveVoiceChange(model, queueId)
  }
  completeVoiceChange(model: string, queueId: string): Promise<void> {
    return this.by(model).completeVoiceChange(model, queueId)
  }
  speech(o: Parameters<AudioBackend['speech']>[0]): ReturnType<AudioBackend['speech']> {
    return this.by(o.model).speech(o)
  }
  cloneVoice(o: Parameters<AudioBackend['cloneVoice']>[0]): ReturnType<AudioBackend['cloneVoice']> {
    return this.by(o.model).cloneVoice(o)
  }
  transcribe(o: Parameters<AudioBackend['transcribe']>[0]): ReturnType<AudioBackend['transcribe']> {
    return this.by(o.model).transcribe(o)
  }
}
