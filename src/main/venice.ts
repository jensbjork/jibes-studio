import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { nativeImage } from 'electron'
import { rememberModelKinds } from '@shared/models'
import type { GenerationParams, VideoModel, VideoModelType } from '@shared/types'

const BASE_URL = 'https://api.venice.ai/api/v1'

export class VeniceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
  }
}

interface RawModel {
  id: string
  model_spec: {
    name: string
    privacy?: string
    offline?: boolean
    model_sets?: string[]
    constraints?: {
      model_type?: string
      aspect_ratios?: string[]
      resolutions?: string[]
      durations?: string[]
      audio?: boolean
      audio_configurable?: boolean
      prompt_character_limit?: number
    }
  }
}

function modelKind(raw: RawModel): VideoModelType {
  const id = raw.id
  if (id.includes('reference-to-video')) return 'reference-to-video'
  if (id.includes('video-to-video') || id.includes('upscale')) return 'video-to-video'
  if (id.includes('image-to-video') || id.includes('first-last-frame') || id.includes('transition')) return 'image-to-video'
  if (id.includes('text-to-video')) return 'text-to-video'
  const type = raw.model_spec.constraints?.model_type
  if (type === 'text-to-video' || type === 'image-to-video') return type
  return 'other'
}

function toVideoModel(raw: RawModel): VideoModel {
  const c = raw.model_spec.constraints ?? {}
  return {
    id: raw.id,
    name: raw.model_spec.name,
    kind: modelKind(raw),
    privacy: raw.model_spec.privacy ?? 'unknown',
    offline: raw.model_spec.offline ?? false,
    aspectRatios: c.aspect_ratios ?? [],
    resolutions: c.resolutions ?? [],
    durations: c.durations ?? [],
    audio: c.audio ?? false,
    audioConfigurable: c.audio_configurable ?? false,
    promptCharacterLimit: c.prompt_character_limit,
    modelSets: raw.model_spec.model_sets ?? []
  }
}

/** Venice couldn't be reached at all (no network, DNS, connection dropped mid-transfer). */
export class NetworkError extends Error {}

/** fetch() rejects with a bare "TypeError: fetch failed" (or "terminated" mid-body) when the network drops. */
function networkError(err: unknown, what: string): NetworkError {
  return new NetworkError(`${what} Kontrollera internetanslutningen och försök igen.`, { cause: err })
}

async function fetchOrExplain(url: string, init: RequestInit | undefined, what: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    throw networkError(err, what)
  }
}

/**
 * Fails with a Swedish message before anything is quoted, encoded or sent, e.g. when a character image the
 * params still point at was removed (removing it moves the file to the Trash).
 */
export function ensureImagesExist(params: GenerationParams): void {
  const check = (path: string | undefined, what: string): void => {
    if (path && !existsSync(path)) {
      throw new Error(`${what} finns inte längre: ${basename(path)}. Ta bort den och välj en ny bild.`)
    }
  }
  check(params.startImage, 'Startbilden')
  check(params.endImage, 'Slutbilden')
  for (const path of params.referenceImages ?? []) check(path, 'En referensbild')
}

/** Downscales large photos so request bodies stay reasonable, and returns a data URL. */
async function imageToDataUrl(path: string): Promise<string> {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) {
    // nativeImage can't decode e.g. webp; send the file as-is.
    const ext = extname(path).slice(1).toLowerCase()
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${(await readFile(path)).toString('base64')}`
  }
  const { width, height } = img.getSize()
  const maxSide = 2048
  const scaled =
    Math.max(width, height) > maxSide
      ? img.resize(width >= height ? { width: maxSide, quality: 'best' } : { height: maxSide, quality: 'best' })
      : img
  return `data:image/jpeg;base64,${scaled.toJPEG(92).toString('base64')}`
}

export async function buildRequestBody(params: GenerationParams): Promise<Record<string, unknown>> {
  ensureImagesExist(params)
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    duration: params.duration
  }
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt
  if (params.resolution) body.resolution = params.resolution
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio
  if (params.audio !== undefined) body.audio = params.audio
  if (params.startImage) body.image_url = await imageToDataUrl(params.startImage)
  if (params.endImage) body.end_image_url = await imageToDataUrl(params.endImage)
  if (params.referenceImages?.length) {
    body.reference_image_urls = await Promise.all(params.referenceImages.map(imageToDataUrl))
  }
  return body
}

export type RetrieveResult =
  | { state: 'processing'; averageExecutionTime?: number; executionDuration?: number }
  | { state: 'video'; data: Buffer }
  | { state: 'download'; url?: string }

export class VeniceClient {
  constructor(private readonly getKey: () => string | null) {}

  /** `requireKey: false` still sends the key when there is one, but doesn't fail without it. */
  private async request(path: string, init: RequestInit = {}, requireKey = true): Promise<Response> {
    const headers = new Headers(init.headers)
    const key = this.getKey()
    if (key) headers.set('Authorization', `Bearer ${key}`)
    else if (requireKey) throw new VeniceError('Ingen API-nyckel är inställd. Lägg till den under Inställningar.', 401)
    if (init.body) headers.set('Content-Type', 'application/json')
    const res = await fetchOrExplain(`${BASE_URL}${path}`, { ...init, headers }, 'Kunde inte nå Venice.')
    if (!res.ok) {
      const text = await res.text()
      let body: unknown = text
      let message = text
      try {
        body = JSON.parse(text)
        const b = body as { error?: string | { message?: string }; message?: string; details?: unknown }
        message =
          (typeof b.error === 'string' ? b.error : b.error?.message) ?? b.message ?? JSON.stringify(body)
      } catch {
        // Not JSON; keep the raw text.
      }
      throw new VeniceError(`Venice ${res.status}: ${message}`, res.status, body)
    }
    return res
  }

  private async post<T>(path: string, body: unknown, requireKey = true): Promise<T> {
    const res = await this.request(path, { method: 'POST', body: JSON.stringify(body) }, requireKey)
    return (await res.json()) as T
  }

  async listVideoModels(): Promise<VideoModel[]> {
    const res = await this.request('/models?type=video', {}, false)
    const json = (await res.json()) as { data: RawModel[] }
    const models = json.data.map(toVideoModel)
    // So the shared kindOfModelId (used by paramsForSubmit and imageToVideoVariant) agrees with this list.
    rememberModelKinds(models)
    return models
  }

  /** Validates the API key and returns the account balances (e.g. USD, DIEM). */
  async balances(): Promise<Record<string, number>> {
    const res = await this.request('/api_keys/rate_limits')
    const json = (await res.json()) as { data?: { balances?: Record<string, number> } }
    return json.data?.balances ?? {}
  }

  /** Price in USD. Only pricing-relevant fields are sent, so images aren't encoded for this. */
  async quote(params: GenerationParams): Promise<number> {
    const body: Record<string, unknown> = { model: params.model, duration: params.duration }
    if (params.resolution) body.resolution = params.resolution
    if (params.aspectRatio) body.aspect_ratio = params.aspectRatio
    if (params.audio !== undefined) body.audio = params.audio
    const res = await this.post<{ quote: number }>('/video/quote', body, false)
    return res.quote
  }

  queue(body: Record<string, unknown>): Promise<{ queue_id: string; download_url?: string }> {
    return this.post('/video/queue', body)
  }

  async retrieve(model: string, queueId: string): Promise<RetrieveResult> {
    const res = await this.request('/video/retrieve', {
      method: 'POST',
      body: JSON.stringify({ model, queue_id: queueId })
    })
    const type = res.headers.get('content-type') ?? ''
    if (type.startsWith('video/') || type === 'application/octet-stream') {
      try {
        return { state: 'video', data: Buffer.from(await res.arrayBuffer()) }
      } catch (err) {
        throw networkError(err, 'Videon kunde inte hämtas från Venice.')
      }
    }
    const json = (await res.json()) as {
      status?: string
      average_execution_time?: number
      execution_duration?: number
      download_url?: string
    }
    if (json.status === 'COMPLETED' || json.download_url) return { state: 'download', url: json.download_url }
    return {
      state: 'processing',
      averageExecutionTime: json.average_execution_time,
      executionDuration: json.execution_duration
    }
  }

  async complete(model: string, queueId: string): Promise<void> {
    await this.post('/video/complete', { model, queue_id: queueId })
  }
}

export async function download(url: string): Promise<Buffer> {
  if (!url) throw new Error('Venice skickade ingen nedladdningslänk för videon.')
  const what = 'Videon kunde inte laddas ner från Venice.'
  const res = await fetchOrExplain(url, undefined, what)
  if (!res.ok) throw new Error(`Nedladdningen misslyckades (${res.status})`)
  try {
    return Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw networkError(err, what)
  }
}
