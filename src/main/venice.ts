import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { nativeImage } from 'electron'
import {
  MAX_AUDIO_CLIP_SECONDS,
  MAX_REFERENCE_AUDIO_SECONDS,
  MIN_AUDIO_CLIP_SECONDS,
  referenceAudioWindow,
  rememberModelKinds
} from '@shared/models'
import { audioToken } from '@shared/prompt-refs'
import type { GenerationParams, ReferenceAudio, VideoModel, VideoModelType } from '@shared/types'
import { encodeAudioClip, probeAudio } from './ffmpeg'

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
      /** Takes `reference_audio_urls` (with reference-to-video models: voices and sound to follow). */
      audio_input?: boolean
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
    audioInput: c.audio_input === true,
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
 * Fails with a Swedish message before anything is quoted, encoded or sent, e.g. when a character image or
 * voice clip the params still point at was removed (removing it moves the file to the Trash).
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
  params.referenceAudios?.forEach((clip, i) => {
    if (clip?.path && !existsSync(clip.path)) {
      throw new Error(
        `Ljudklippet ${audioToken(i + 1)} finns inte längre: ${basename(clip.path)}. Ta bort det och välj ett nytt.`
      )
    }
  })
}

/** A failure about one clip, named by its token and file: "@Audio2 (röst.m4a): Filen innehåller inget ljud." */
function clipError(clip: ReferenceAudio, index: number, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err)
  return new Error(`${audioToken(index + 1)} (${basename(clip.path)}): ${reason}`, { cause: err })
}

/** Milliseconds are plenty for a window, and keep the stored params readable. */
const toMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

/**
 * The reference audio exactly as it will be sent: each file measured with ffprobe and its window filled in
 * (start 0 and min(rest of the file, 10 s) unless chosen, and never past the end of the file), so the 2–15 s
 * and 15 s-in-all checks can run on the real lengths before anything is uploaded. Rejects (Swedish) when a
 * file can't be read, has no sound, or its window starts after the end. Params without audio come back as is.
 */
export async function resolveReferenceAudios(params: GenerationParams): Promise<GenerationParams> {
  const clips = params.referenceAudios
  if (!clips?.length) return params
  const resolved: ReferenceAudio[] = []
  for (const [i, clip] of clips.entries()) {
    let duration: number
    try {
      duration = (await probeAudio(clip.path)).duration
    } catch (err) {
      throw clipError(clip, i, err)
    }
    const window = referenceAudioWindow(clip, duration)
    if (window.length <= 0) {
      const seconds = String(Math.round(duration * 10) / 10).replace('.', ',')
      throw new Error(
        `${audioToken(i + 1)} börjar efter slutet av ${basename(clip.path)}, som bara är ${seconds} s långt – flytta urvalet.`
      )
    }
    resolved.push({ path: clip.path, start: toMs(window.start), length: toMs(window.length) })
  }
  return { ...params, referenceAudios: resolved }
}

// ── Reference audio as MP3 files Venice accepts ──────────────────────────────
// encodeAudioClip writes MPEG-1 Layer III at 44.1 kHz without a gapless header, so a decoder returns whole
// frames of 1152 samples, the first of them holding the encoder's 1105-sample delay: `length` seconds come back
// as ceil((length · 44100 + 1105) / 1152) frames, up to 51 ms more than asked. That is enough to take a 15 s
// window, or two of 7.5 s, over Venice's 15 s, however Venice measures (decoding, or from the constant bitrate).
const MP3_RATE = 44100
const MP3_FRAME = 1152
const MP3_DELAY = 1105
/** Samples of slack so a cut never spills into one frame more (resampling may round a sample either way). */
const MP3_SLACK = 8
/** At least 2 s even without the encoder's delay. */
const MIN_FRAMES = Math.ceil((MIN_AUDIO_CLIP_SECONDS * MP3_RATE + MP3_DELAY) / MP3_FRAME)
const MAX_FRAMES = Math.floor((MAX_AUDIO_CLIP_SECONDS * MP3_RATE) / MP3_FRAME)
const MAX_TOTAL_FRAMES = Math.floor((MAX_REFERENCE_AUDIO_SECONDS * MP3_RATE) / MP3_FRAME)

/** Seconds of audio to encode for an MP3 of exactly `frames` frames. */
const secondsForFrames = (frames: number): number => (frames * MP3_FRAME - MP3_DELAY - MP3_SLACK) / MP3_RATE

/**
 * How many MP3 frames each window becomes so the files keep to Venice's limits: as close to the window as whole
 * frames get, 2–15 s each, 15 s in all. The windows were checked against the same limits, so this moves each by
 * at most about a frame (26 ms); a frame that rounding adds over the total comes off the longest clip.
 */
export function mp3FramePlan(windowLengths: readonly number[]): number[] {
  const frames = windowLengths.map((length) =>
    Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round((length * MP3_RATE) / MP3_FRAME)))
  )
  let excess = frames.reduce((sum, f) => sum + f, 0) - MAX_TOTAL_FRAMES
  while (excess > 0) {
    const longest = frames.indexOf(Math.max(...frames))
    if (frames[longest] <= MIN_FRAMES) break
    frames[longest]--
    excess--
  }
  return frames
}

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG1_RATES = [44100, 48000, 32000]

/**
 * The frames of an MPEG-1 Layer III stream (each decodes to 1152 samples), read from the frame headers; undefined
 * for anything else (another layer or version, a tag, a cut-off frame), which the caller then doesn't second-guess.
 */
export function mp3FrameCount(bytes: Buffer): number | undefined {
  let offset = 0
  let frames = 0
  while (offset + 4 <= bytes.length) {
    // Sync, MPEG-1, Layer III (with or without CRC).
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfe) !== 0xfa) return undefined
    const b2 = bytes[offset + 2]
    const kbps = MPEG1_L3_KBPS[b2 >> 4]
    const rate = MPEG1_RATES[(b2 >> 2) & 3]
    if (!kbps || !rate) return undefined
    offset += Math.floor((144_000 * kbps) / rate) + ((b2 >> 1) & 1)
    frames++
  }
  return offset === bytes.length ? frames : undefined
}

/**
 * Each clip's window as the MP3 bytes Venice gets (mono 44.1 kHz, 128 kb/s), in order, each exactly the frames
 * mp3FramePlan gives it. Some sources decode with a few samples more than they are cut to (an AAC file's encoder
 * priming survives the seek), which adds a frame; such a clip is cut again that much shorter.
 */
async function encodeReferenceAudios(clips: readonly ReferenceAudio[]): Promise<Buffer[]> {
  const plan = mp3FramePlan(clips.map((clip) => referenceAudioWindow(clip).length))
  return Promise.all(
    clips.map(async (clip, i) => {
      const { start } = referenceAudioWindow(clip)
      try {
        let frames = plan[i]
        let mp3 = await encodeAudioClip(clip.path, start, secondsForFrames(frames))
        for (let attempt = 0; attempt < 2; attempt++) {
          const extra = (mp3FrameCount(mp3) ?? plan[i]) - plan[i]
          if (extra <= 0 || frames - extra < 1) break
          frames -= extra
          mp3 = await encodeAudioClip(clip.path, start, secondsForFrames(frames))
        }
        return mp3
      } catch (err) {
        throw clipError(clip, i, err)
      }
    })
  )
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

/**
 * The /video/queue body: images as JPEG data URLs, and each reference audio clip's window cut out with ffmpeg
 * as an MP3 data URL, in the params' order (@Audio1 first; see encodeReferenceAudios). Clips are sent with the
 * window they have; those without one are measured first (resolveReferenceAudios), which a submit has normally
 * done already.
 */
export async function buildRequestBody(params: GenerationParams): Promise<Record<string, unknown>> {
  ensureImagesExist(params)
  if (params.referenceAudios?.some((a) => a.start === undefined || a.length === undefined)) {
    params = await resolveReferenceAudios(params)
  }
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
  if (params.referenceAudios?.length) {
    const mp3s = await encodeReferenceAudios(params.referenceAudios)
    body.reference_audio_urls = mp3s.map((mp3) => `data:audio/mpeg;base64,${mp3.toString('base64')}`)
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
