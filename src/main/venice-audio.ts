// Venice's audio endpoints, for Redigera and voice design: the audio model lists, free quotes, the voice changer
// (speech-to-speech), text-to-speech (/audio/speech, synchronous), voice cloning, transcription, and the queued
// generators (/audio/queue: music, sound effects, ElevenLabs TTS, voice design). Nothing here touches the library;
// edit-ops.ts decides what is sent and where results go.
//
// Money rules this file keeps:
// - Paid requests (queue, speech, voices, transcriptions) are sent once and never retried here: Venice charges at
//   queue time, so a lost response is reported (it "may have been charged") and the caller polls instead.
// - Optional fields are only sent when the model's /models entry allows them: Venice answers 400 (free) to the rest,
//   so a gated body never fails a paid run on a field the model doesn't take.
// - Durations are whole seconds (duration_seconds must be a positive integer).

import type { AsrModel, AudioCatalog, AudioGenModel, SpeechModel, TranscriptWord, VoiceChangerModel } from '@shared/types'
import { NetworkError, VeniceError } from './venice'

const BASE_URL = 'https://api.venice.ai/api/v1'

/** Model lists rarely change; fetched again after this long, when asked to, or when the API key changes. */
const CATALOG_CACHE_MS = 10 * 60_000
const LIST_TIMEOUT_MS = 20_000
const QUOTE_TIMEOUT_MS = 20_000
const QUEUE_TIMEOUT_MS = 2 * 60_000
/** A voice-changer upload is up to 20 MB. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000
const RETRIEVE_TIMEOUT_MS = 3 * 60_000
/** /audio/speech answers when the line is spoken; a long line takes a while. */
const SPEECH_TIMEOUT_MS = 4 * 60_000
/** A transcription of up to ~50 minutes of sound. */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

/** /audio/speech takes 1–4096 characters. */
export const SPEECH_MAX_CHARACTERS = 4096
/** The voice seed-audio-1-0 designs from the prompt. */
export const DESCRIBE_IN_PROMPT = 'Describe in prompt'
/** Studio's assumption for a model without duration metadata (Lyria picks its own length, up to ~3 min). */
const ASSUMED_RANGE = { min: 1, max: 180, music: 60, effect: 10 }

const NO_KEY = 'Ingen API-nyckel är inställd. Lägg till den under Inställningar.'

// ── The model lists ──────────────────────────────────────────────────────────

interface Usd {
  usd?: number
}

/** model_spec of an audio model as /models?type=tts|music|asr gives it (the fields Studio reads). */
export interface RawAudioSpec {
  name?: string
  offline?: boolean
  pricing?: {
    input?: Usd
    per_thousand_characters?: Usd
    per_second?: Usd
    per_audio_second?: Usd
    generation?: Usd
    durations?: Record<string, Usd & { min_seconds?: number; max_seconds?: number }>
  }
  voices?: string[]
  default_voice?: string
  supports_custom_voice_id?: boolean
  voice_cloning?: { mode?: string; accepted_formats?: string[]; min_sample_seconds?: number; retention_days?: number }
  supported_formats?: string[]
  default_format?: string
  prompt_character_limit?: number
  min_prompt_length?: number
  supports_lyrics?: boolean
  lyrics_required?: boolean
  supports_force_instrumental?: boolean
  supports_lyrics_optimizer?: boolean
  supports_loop?: boolean
  supports_language_code?: boolean
  supports_speed?: boolean
  min_speed?: number
  max_speed?: number
  default_speed?: number
  duration_options?: number[]
  min_duration?: number
  max_duration?: number
  default_duration?: number
  voice_changer?: boolean
  supports_background_noise_removal?: boolean
  supports_seed?: boolean
  accepted_audio_formats?: string[]
  max_source_audio_duration_seconds?: number
}

export interface RawAudioModel {
  id: string
  type?: string
  model_spec?: RawAudioSpec
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined

const usdOf = (v: Usd | undefined): number | undefined =>
  typeof v?.usd === 'number' && Number.isFinite(v.usd) && v.usd >= 0 ? v.usd : undefined

const nameOf = (raw: RawAudioModel): string => (typeof raw.model_spec?.name === 'string' && raw.model_spec.name) || raw.id

/** Whether the model takes duration_seconds at all (Venice: "only for models that expose duration metadata"). */
function hasDurationMetadata(spec: RawAudioSpec): boolean {
  return positive(spec.min_duration) !== undefined || positive(spec.max_duration) !== undefined || numbers(spec.duration_options).length > 0
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0) : []
}

function speedOf(spec: RawAudioSpec): SpeechModel['speed'] {
  if (!spec.supports_speed) return undefined
  const min = positive(spec.min_speed) ?? 0.25
  const max = positive(spec.max_speed) ?? 4
  return { min, max, default: Math.min(max, Math.max(min, positive(spec.default_speed) ?? 1)) }
}

function ttsModel(raw: RawAudioModel): SpeechModel {
  const spec = raw.model_spec ?? {}
  const perMillion = usdOf(spec.pricing?.input)
  const cloning = spec.voice_cloning
  return {
    id: raw.id,
    name: nameOf(raw),
    endpoint: 'speech',
    voices: strings(spec.voices),
    defaultVoice: typeof spec.default_voice === 'string' ? spec.default_voice : undefined,
    customVoiceId: spec.supports_custom_voice_id === true,
    cloning: cloning
      ? {
          minSampleSeconds: positive(cloning.min_sample_seconds) ?? 5,
          formats: strings(cloning.accepted_formats),
          retentionDays: positive(cloning.retention_days) ?? 7
        }
      : undefined,
    formats: strings(spec.supported_formats).length ? strings(spec.supported_formats) : [spec.default_format ?? 'mp3'],
    maxCharacters: SPEECH_MAX_CHARACTERS,
    // pricing.input is USD per million characters.
    usdPerThousandChars: perMillion !== undefined ? perMillion / 1000 : undefined,
    // /models has no flag for it; the style prompt is Qwen 3's.
    stylePrompt: raw.id.startsWith('tts-qwen3'),
    // xAI and ElevenLabs take ISO 639-1 codes as their `language` hint (Qwen and MiniMax full names).
    languageCode: /^tts-(xai|elevenlabs)/.test(raw.id),
    speed: undefined
  }
}

function queuedSpeechModel(raw: RawAudioModel): SpeechModel {
  const spec = raw.model_spec ?? {}
  return {
    id: raw.id,
    name: nameOf(raw),
    endpoint: 'queue',
    voices: strings(spec.voices),
    defaultVoice: typeof spec.default_voice === 'string' ? spec.default_voice : undefined,
    customVoiceId: spec.supports_custom_voice_id === true,
    formats: strings(spec.supported_formats).length ? strings(spec.supported_formats) : [spec.default_format ?? 'mp3'],
    maxCharacters: positive(spec.prompt_character_limit) ?? 5000,
    usdPerThousandChars: usdOf(spec.pricing?.per_thousand_characters),
    stylePrompt: false,
    languageCode: spec.supports_language_code === true,
    speed: speedOf(spec)
  }
}

function generatorModel(raw: RawAudioModel, kind: 'music' | 'effect'): AudioGenModel {
  const spec = raw.model_spec ?? {}
  const options = numbers(spec.duration_options).map(Math.round).sort((a, b) => a - b)
  const durationControl = hasDurationMetadata(spec)
  const min = durationControl ? (positive(spec.min_duration) ?? options[0] ?? ASSUMED_RANGE.min) : ASSUMED_RANGE.min
  const max = durationControl ? (positive(spec.max_duration) ?? options[options.length - 1] ?? ASSUMED_RANGE.max) : ASSUMED_RANGE.max
  const fallback = kind === 'music' ? ASSUMED_RANGE.music : ASSUMED_RANGE.effect
  return {
    id: raw.id,
    name: nameOf(raw),
    kind,
    minSeconds: min,
    maxSeconds: Math.max(min, max),
    durationOptions: options.length ? options : undefined,
    defaultSeconds: Math.min(Math.max(min, max), Math.max(min, positive(spec.default_duration) ?? fallback)),
    loop: spec.supports_loop === true,
    instrumental: spec.supports_force_instrumental === true,
    promptLimit: positive(spec.prompt_character_limit) ?? 500,
    minPromptLength: positive(spec.min_prompt_length) ?? 1,
    durationControl
  }
}

function voiceChangerModel(raw: RawAudioModel): VoiceChangerModel {
  const spec = raw.model_spec ?? {}
  const formats = strings(spec.accepted_audio_formats)
  return {
    id: raw.id,
    name: nameOf(raw),
    voices: strings(spec.voices),
    defaultVoice: typeof spec.default_voice === 'string' ? spec.default_voice : undefined,
    customVoiceId: spec.supports_custom_voice_id === true,
    // The documented example; the real value comes with the model.
    maxSourceSeconds: positive(spec.max_source_audio_duration_seconds) ?? 300,
    formats: formats.length ? formats : ['mp3', 'wav'],
    backgroundNoiseRemoval: spec.supports_background_noise_removal === true,
    seed: spec.supports_seed === true
  }
}

function asrModel(raw: RawAudioModel): AsrModel | undefined {
  const id = raw.id
  // /models doesn't say which models give timestamps; Venice's documentation does, per model.
  const timestamps = /scribe|stt-xai/i.test(id) ? 'word' : /whisper|wizper/i.test(id) ? 'segment' : undefined
  if (!timestamps) return undefined
  return { id, name: nameOf(raw), usdPerSecond: usdOf(raw.model_spec?.pricing?.per_audio_second) ?? 0, timestamps }
}

/**
 * The audio catalogue from the three lists, by Venice's flags:
 * - type=tts → speech models on /audio/speech;
 * - type=music: `voice_changer` → voice changers; `voices` with "Describe in prompt" → voice design; other `voices`
 *   → queued speech (ElevenLabs TTS); ids with sound-effects/text-to-audio → effects; stable-audio → both music
 *   and effects; `lyrics_required` → left out (Studio writes no lyrics); the rest → music;
 * - type=asr → transcription models that give timestamps (word: Scribe, xAI; segment: Whisper, Wizper).
 * Offline models are left out.
 */
export function classifyAudioModels(
  tts: readonly RawAudioModel[],
  music: readonly RawAudioModel[],
  asr: readonly RawAudioModel[]
): Omit<AudioCatalog, 'keyed' | 'fetchedAt'> {
  const usable = (raw: RawAudioModel): boolean => !!raw && typeof raw.id === 'string' && !!raw.id && raw.model_spec?.offline !== true
  const catalog: Omit<AudioCatalog, 'keyed' | 'fetchedAt'> = {
    speech: tts.filter(usable).map(ttsModel),
    music: [],
    effects: [],
    transcription: asr.filter(usable).flatMap((raw) => asrModel(raw) ?? []),
    voiceChangers: [],
    voiceDesign: []
  }
  for (const raw of music.filter(usable)) {
    const spec = raw.model_spec ?? {}
    const voices = strings(spec.voices)
    if (spec.voice_changer === true) catalog.voiceChangers.push(voiceChangerModel(raw))
    else if (voices.includes(DESCRIBE_IN_PROMPT)) catalog.voiceDesign.push(queuedSpeechModel(raw))
    else if (voices.length) catalog.speech.push(queuedSpeechModel(raw))
    else if (spec.lyrics_required === true) continue
    else if (/stable-audio/i.test(raw.id)) {
      catalog.music.push(generatorModel(raw, 'music'))
      catalog.effects.push(generatorModel(raw, 'effect'))
    } else if (/sound-effects|text-to-audio/i.test(raw.id)) catalog.effects.push(generatorModel(raw, 'effect'))
    else catalog.music.push(generatorModel(raw, 'music'))
  }
  return catalog
}

// ── Request bodies ───────────────────────────────────────────────────────────

/** A positive whole number of seconds (Venice: "a positive integer"); rounded up, so a length is never cut. */
export function wholeSeconds(seconds: number): number {
  return Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 1) - 1e-9))
}

/**
 * The duration_seconds a generator model gets for a wanted length: one of its fixed lengths (the shortest that
 * covers it, else the longest), else clamped to its min–max; undefined when the model takes none (Lyria).
 */
export function durationFor(spec: RawAudioSpec, seconds: number): number | undefined {
  if (!hasDurationMetadata(spec)) return undefined
  const wanted = wholeSeconds(seconds)
  const options = numbers(spec.duration_options).map(Math.round).sort((a, b) => a - b)
  if (options.length) return options.find((d) => d >= wanted) ?? options[options.length - 1]
  const min = Math.ceil(positive(spec.min_duration) ?? 1)
  const max = Math.floor(positive(spec.max_duration) ?? Number.MAX_SAFE_INTEGER)
  return Math.min(Math.max(min, max), Math.max(min, wanted))
}

/**
 * An /audio/queue body with only what the model takes: model and prompt always; lyrics, duration, instrumental,
 * lyrics optimizer, loop, voice, language code and speed only when its /models entry allows them (each else 400),
 * the duration as whole seconds from its allowed lengths, the speed within its range.
 */
export function audioQueueBody(spec: RawAudioSpec, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { model: body.model, prompt: body.prompt }
  if (spec.supports_lyrics === true && typeof body.lyrics_prompt === 'string' && body.lyrics_prompt) {
    out.lyrics_prompt = body.lyrics_prompt
  }
  const wanted = Number(body.duration_seconds)
  if (body.duration_seconds !== undefined && Number.isFinite(wanted) && wanted > 0) {
    const seconds = durationFor(spec, wanted)
    if (seconds !== undefined) out.duration_seconds = seconds
  }
  if (spec.supports_force_instrumental === true && typeof body.force_instrumental === 'boolean') {
    out.force_instrumental = body.force_instrumental
  }
  if (spec.supports_lyrics_optimizer === true && typeof body.lyrics_optimizer === 'boolean') {
    out.lyrics_optimizer = body.lyrics_optimizer
  }
  if (spec.supports_loop === true && typeof body.loop === 'boolean') out.loop = body.loop
  const voices = strings(spec.voices)
  if (typeof body.voice === 'string' && body.voice && (voices.includes(body.voice) || (voices.length && spec.supports_custom_voice_id === true))) {
    out.voice = body.voice
  }
  if (spec.supports_language_code === true && typeof body.language_code === 'string' && body.language_code) {
    out.language_code = body.language_code
  }
  const speed = Number(body.speed)
  if (spec.supports_speed === true && body.speed !== undefined && Number.isFinite(speed)) {
    const range = speedOf(spec)!
    out.speed = Math.min(range.max, Math.max(range.min, speed))
  }
  return out
}

// ── Responses ────────────────────────────────────────────────────────────────

export type AudioRetrieve =
  | { state: 'processing'; averageMs?: number; elapsedMs?: number }
  | { state: 'audio'; data: Buffer; format: string }

/** The audio format of bytes by their signature; undefined when they don't say. */
function sniffAudio(data: Buffer): string | undefined {
  if (data.length < 4) return undefined
  const head = data.toString('latin1', 0, 4)
  if (head === 'RIFF') return 'wav'
  if (head === 'fLaC') return 'flac'
  if (head === 'OggS') return 'ogg'
  if (data.length >= 8 && data.toString('latin1', 4, 8) === 'ftyp') return 'm4a'
  if (head.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return 'mp3'
  return undefined
}

/**
 * The audio format of a response: Venice's own x-venice-audio-format header, else the content type, else the bytes'
 * signature, else `fallback` (what was asked for).
 */
export function audioFormatOf(contentType: string, data: Buffer, header?: string | null, fallback = 'mp3'): string {
  const named = header?.trim().toLowerCase()
  if (named && /^(mp3|wav|flac|m4a|aac|ogg|opus|pcm)$/.test(named)) return named
  const type = contentType.toLowerCase()
  if (/mpeg|mp3/.test(type)) return 'mp3'
  if (/wav|wave/.test(type)) return 'wav'
  if (/flac/.test(type)) return 'flac'
  if (/mp4|m4a/.test(type)) return 'm4a'
  if (/aac/.test(type)) return 'aac'
  if (/ogg|opus/.test(type)) return 'ogg'
  if (/pcm/.test(type)) return 'pcm'
  return sniffAudio(data) ?? fallback
}

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg'
}

function fileBlob(file: Buffer, filename: string): Blob {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? ''
  return new Blob([new Uint8Array(file)], { type: MIME[ext] ?? 'application/octet-stream' })
}

/** Venice's own wording of an error body (`error`, `message` or `details`), or the raw text. */
function detailOf(body: unknown, text: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown; details?: unknown }
    const error = typeof b.error === 'string' ? b.error : (b.error as { message?: unknown } | undefined)?.message
    for (const v of [error, b.message]) if (typeof v === 'string' && v.trim()) return v.trim()
    if (b.details !== undefined) return JSON.stringify(b.details).slice(0, 300)
  }
  return text.trim().slice(0, 300)
}

type What = 'list' | 'quote' | 'paid' | 'result'

/** A failed response in Swedish, keeping its status (callers tell retryable from final by it). */
async function responseError(res: Response, what: What): Promise<VeniceError> {
  const text = await res.text().catch(() => '')
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON; keep the text.
  }
  const detail = detailOf(body, text)
  const refunded = (body as { credits_refunded?: unknown } | undefined)?.credits_refunded
  const withDetail = (message: string): string => (detail ? `${message} (Venice: ${detail})` : message)
  let message: string
  switch (res.status) {
    case 400:
      message = withDetail('Venice godtog inte förfrågan.')
      break
    case 401:
      message = /pro/i.test(detail)
        ? 'Modellen kräver Venice Pro.'
        : 'Venice godtog inte API-nyckeln. Kontrollera den under Inställningar.'
      break
    case 402:
      message = 'Saldot hos Venice räcker inte. Fyll på hos Venice och försök igen.'
      break
    case 403:
      message = withDetail('Venice nekade förfrågan för den här API-nyckeln.')
      break
    case 404:
      message =
        what === 'result'
          ? refunded
            ? 'Venice kunde inte göra klart ljudet och har betalat tillbaka det.'
            : 'Venice hittar inte resultatet längre (det kan ha gått ut).'
          : 'Venice känner inte till modellen. Välj en annan modell.'
      break
    case 413:
      message = 'Underlaget är för stort. Välj en kortare del.'
      break
    case 415:
      message = withDetail('Venice kunde inte läsa förfrågan.')
      break
    case 422:
      message = withDetail('Venice nekade innehållet.')
      break
    case 429:
      message = 'Venice tar inte emot fler förfrågningar just nu. Vänta en stund och försök igen.'
      break
    case 503:
      message = 'Modellen är fullt upptagen hos Venice just nu. Försök igen om en stund.'
      break
    default:
      message =
        res.status >= 500
          ? `Venice kunde inte göra klart ljudet (serverfel ${res.status}).${refunded ? ' Venice har betalat tillbaka det.' : ' Försök igen om en stund.'}`
          : withDetail(`Venice svarade med fel ${res.status}.`)
  }
  if ((body as { code?: unknown } | undefined)?.code === 'INSUFFICIENT_BALANCE') {
    message = 'Saldot hos Venice räcker inte. Fyll på hos Venice och försök igen.'
  }
  if (what === 'list' && res.status !== 401 && res.status !== 429) {
    message = `Venice kunde inte skicka listan över ljudmodeller (fel ${res.status}). Försök igen om en stund.`
  }
  return new VeniceError(message, res.status, body)
}

/** Timeouts and dropped connections, without a status (callers poll again); a paid request may have been charged. */
function transportError(err: unknown, what: What, timeoutMs: number): NetworkError {
  const name = (err as { name?: string } | undefined)?.name
  const timedOut = name === 'TimeoutError' || name === 'AbortError'
  const waited = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`
  const message =
    what === 'paid'
      ? timedOut
        ? `Venice svarade inte inom ${waited}. Det kan ändå ha debiterats – kontrollera saldot innan du försöker igen.`
        : 'Anslutningen till Venice bröts. Det kan ändå ha debiterats – kontrollera saldot innan du försöker igen.'
      : timedOut
        ? `Venice svarade inte inom ${waited}. Försök igen om en stund.`
        : 'Kunde inte nå Venice. Kontrollera internetanslutningen och försök igen.'
  return new NetworkError(message, { cause: err })
}

// ── The client ───────────────────────────────────────────────────────────────

interface CallOptions {
  method: 'GET' | 'POST'
  json?: unknown
  form?: FormData
  /** Paid endpoints and results need the key; lists and quotes are public (the key is sent when there is one). */
  requireKey: boolean
  timeoutMs: number
  what: What
}

export class VeniceAudio {
  private cache: { at: number; key: string | null; catalog: AudioCatalog; music: Map<string, RawAudioSpec> } | undefined
  private loading: { key: string | null; promise: Promise<AudioCatalog> } | undefined
  private readonly quotes = new Map<string, number>()

  constructor(private readonly getKey: () => string | null) {}

  private async call(path: string, o: CallOptions): Promise<Response> {
    const headers = new Headers()
    const key = this.getKey()
    if (key) headers.set('Authorization', `Bearer ${key}`)
    else if (o.requireKey) throw new VeniceError(NO_KEY, 401)
    // A multipart body sets its own content type (with the boundary).
    if (o.json !== undefined) headers.set('Content-Type', 'application/json')
    let res: Response
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: o.method,
        headers,
        body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined),
        signal: AbortSignal.timeout(o.timeoutMs)
      })
    } catch (err) {
      throw transportError(err, o.what, o.timeoutMs)
    }
    if (res.headers.get('x-venice-is-content-violation')?.trim().toLowerCase() === 'true') {
      await res.body?.cancel().catch(() => {})
      throw new VeniceError('Venice nekade innehållet.', 422)
    }
    if (!res.ok) throw await responseError(res, o.what)
    return res
  }

  private async json<T>(res: Response, what: What, timeoutMs: number): Promise<T> {
    try {
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new VeniceError(
          what === 'paid'
            ? 'Venice skickade ett svar som inte gick att läsa. Det kan ändå ha debiterats – kontrollera saldot.'
            : 'Venice skickade ett svar som inte gick att läsa. Försök igen om en stund.',
          502
        )
      }
      throw transportError(err, what, timeoutMs)
    }
  }

  private async list(type: 'tts' | 'music' | 'asr'): Promise<RawAudioModel[]> {
    const res = await this.call(`/models?type=${type}`, { method: 'GET', requireKey: false, timeoutMs: LIST_TIMEOUT_MS, what: 'list' })
    const json = await this.json<{ data?: unknown }>(res, 'list', LIST_TIMEOUT_MS)
    if (!Array.isArray(json?.data)) throw new VeniceError('Venice skickade en oväntad lista över ljudmodeller.', res.status)
    return json.data as RawAudioModel[]
  }

  /**
   * The audio models, by GET /models?type=tts|music|asr (free; with the API key when one is set, since some models,
   * like the voice changer, may only be listed to keyed accounts). Cached for 10 minutes and per API key; a list
   * from a little while ago is returned when Venice can't be reached for a moment.
   */
  async catalog(force = false): Promise<AudioCatalog> {
    const key = this.getKey()
    const fresh = this.cache && this.cache.key === key && Date.now() - this.cache.at < CATALOG_CACHE_MS
    if (!force && fresh) return this.cache!.catalog
    if (this.loading && this.loading.key === key) return this.loading.promise
    const promise = (async () => {
      try {
        const [tts, music, asr] = await Promise.all([this.list('tts'), this.list('music'), this.list('asr')])
        const catalog: AudioCatalog = { ...classifyAudioModels(tts, music, asr), keyed: !!key, fetchedAt: Date.now() }
        const specs = new Map<string, RawAudioSpec>()
        for (const raw of music) if (raw && typeof raw.id === 'string') specs.set(raw.id, raw.model_spec ?? {})
        this.cache = { at: Date.now(), key, catalog, music: specs }
        return catalog
      } catch (err) {
        if (this.cache) return this.cache.catalog
        throw err
      }
    })()
    this.loading = { key, promise }
    try {
      return await promise
    } finally {
      if (this.loading?.promise === promise) this.loading = undefined
    }
  }

  /** The /models entry of a type=music model (generators, queued TTS, voice changers), fetched again once if unknown. */
  private async musicSpec(model: string): Promise<RawAudioSpec> {
    if (!this.cache?.music.has(model)) await this.catalog(!!this.cache)
    const spec = this.cache?.music.get(model)
    if (!spec) throw new VeniceError(`Venice listar inte modellen ${model} längre. Välj en annan modell.`, 404)
    return spec
  }

  // ── Free quotes ────────────────────────────────────────────────────────────

  /**
   * POST /audio/quote (free): the price of a music, sound-effect or queued TTS request. `durationSeconds` and
   * `characterCount` are sent as whole numbers; ElevenLabs TTS needs the character count (and has a per-request
   * minimum, so each line is quoted on its own). Cached per (model, duration | count) for the session.
   */
  async quoteAudio(o: { model: string; durationSeconds?: number; characterCount?: number }): Promise<number> {
    const body: Record<string, unknown> = { model: o.model }
    if (o.durationSeconds !== undefined) body.duration_seconds = wholeSeconds(o.durationSeconds)
    if (o.characterCount !== undefined) body.character_count = wholeSeconds(o.characterCount)
    const cacheKey = `audio|${o.model}|${body.duration_seconds ?? ''}|${body.character_count ?? ''}`
    const cached = this.quotes.get(cacheKey)
    if (cached !== undefined) return cached
    const res = await this.call('/audio/quote', { method: 'POST', json: body, requireKey: false, timeoutMs: QUOTE_TIMEOUT_MS, what: 'quote' })
    const quote = (await this.json<{ quote?: unknown }>(res, 'quote', QUOTE_TIMEOUT_MS)).quote
    if (typeof quote !== 'number' || !Number.isFinite(quote) || quote < 0) {
      throw new VeniceError('Venice skickade inget pris.', 502)
    }
    this.quotes.set(cacheKey, quote)
    return quote
  }

  /**
   * POST /audio/voice-changer/quote (free): the price of converting `seconds` of speech, sent as ceil(seconds)
   * (Venice bills per started minute of what it measures). Cached per (model, whole seconds) for the session.
   */
  async quoteVoiceChange(model: string, seconds: number): Promise<number> {
    const duration = wholeSeconds(seconds)
    const cacheKey = `voice-changer|${model}|${duration}`
    const cached = this.quotes.get(cacheKey)
    if (cached !== undefined) return cached
    const res = await this.call('/audio/voice-changer/quote', {
      method: 'POST',
      json: { model, duration_seconds: duration },
      requireKey: false,
      timeoutMs: QUOTE_TIMEOUT_MS,
      what: 'quote'
    })
    const quote = (await this.json<{ quote?: unknown }>(res, 'quote', QUOTE_TIMEOUT_MS)).quote
    if (typeof quote !== 'number' || !Number.isFinite(quote) || quote < 0) {
      throw new VeniceError('Venice skickade inget pris.', 502)
    }
    this.quotes.set(cacheKey, quote)
    return quote
  }

  // ── Queued generation: music, effects, ElevenLabs TTS, voice design ────────

  /** POST /audio/queue (paid, sent once): the body gated to what the model takes (audioQueueBody). */
  async queueAudio(body: Record<string, unknown>): Promise<{ queueId: string }> {
    const model = typeof body.model === 'string' ? body.model : ''
    if (!model || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw new Error('Förfrågan saknar modell eller text.')
    }
    const gated = audioQueueBody(await this.musicSpec(model), body)
    const res = await this.call('/audio/queue', { method: 'POST', json: gated, requireKey: true, timeoutMs: QUEUE_TIMEOUT_MS, what: 'paid' })
    const json = await this.json<{ queue_id?: unknown }>(res, 'paid', QUEUE_TIMEOUT_MS)
    if (typeof json.queue_id !== 'string' || !json.queue_id) {
      throw new VeniceError('Venice svarade utan kö-id. Det kan ändå ha debiterats – kontrollera saldot.', 502)
    }
    return { queueId: json.queue_id }
  }

  async retrieveAudio(model: string, queueId: string): Promise<AudioRetrieve> {
    return this.retrieve('/audio/retrieve', model, queueId)
  }

  /** Venice deletes its copy (idempotent). */
  async completeAudio(model: string, queueId: string): Promise<void> {
    await this.call('/audio/complete', {
      method: 'POST',
      json: { model, queue_id: queueId },
      requireKey: true,
      timeoutMs: QUOTE_TIMEOUT_MS,
      what: 'result'
    })
  }

  private async retrieve(path: string, model: string, queueId: string): Promise<AudioRetrieve> {
    const res = await this.call(path, {
      method: 'POST',
      json: { model, queue_id: queueId },
      requireKey: true,
      timeoutMs: RETRIEVE_TIMEOUT_MS,
      what: 'result'
    })
    const type = res.headers.get('content-type') ?? ''
    if (/json/i.test(type)) {
      const json = await this.json<{ status?: unknown; average_execution_time?: unknown; execution_duration?: unknown }>(
        res,
        'result',
        RETRIEVE_TIMEOUT_MS
      )
      if (json.status === 'PROCESSING' || json.status === 'QUEUED' || json.status === 'IN_PROGRESS') {
        return {
          state: 'processing',
          averageMs: positive(json.average_execution_time),
          elapsedMs: typeof json.execution_duration === 'number' ? json.execution_duration : undefined
        }
      }
      // Anything else is not a state Venice documents for audio: treated like a server hiccup and polled again.
      throw new VeniceError(`Venice svarade oväntat på frågan om ljudet (${String(json.status ?? 'okänt')}).`, 502)
    }
    let data: Buffer
    try {
      data = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw transportError(err, 'result', RETRIEVE_TIMEOUT_MS)
    }
    if (!data.length) throw new VeniceError('Venice skickade inget ljud.', 502)
    return { state: 'audio', data, format: audioFormatOf(type, data, res.headers.get('x-venice-audio-format')) }
  }

  // ── Voice changer ──────────────────────────────────────────────────────────

  /**
   * POST /audio/voice-changer/queue (paid at queue time, sent once: on a lost answer poll, never queue again): the
   * recording as a multipart `file`, the voice, and remove_background_noise / seed only where the model takes them.
   * `durationSeconds` is what Venice measured and bills.
   */
  async queueVoiceChange(o: {
    model: string
    file: Buffer
    filename: string
    voice: string
    removeNoise?: boolean
    seed?: number
  }): Promise<{ queueId: string; durationSeconds: number }> {
    const spec = await this.musicSpec(o.model)
    if (spec.voice_changer !== true) throw new VeniceError(`${o.model} är ingen röstbytarmodell.`, 400)
    const form = new FormData()
    form.append('model', o.model)
    form.append('file', fileBlob(o.file, o.filename), o.filename)
    if (o.voice) form.append('voice', o.voice)
    if (spec.supports_background_noise_removal === true && typeof o.removeNoise === 'boolean') {
      form.append('remove_background_noise', String(o.removeNoise))
    }
    if (spec.supports_seed === true && typeof o.seed === 'number' && Number.isInteger(o.seed) && o.seed >= 0) {
      form.append('seed', String(o.seed))
    }
    const res = await this.call('/audio/voice-changer/queue', { method: 'POST', form, requireKey: true, timeoutMs: UPLOAD_TIMEOUT_MS, what: 'paid' })
    const json = await this.json<{ queue_id?: unknown; duration_seconds?: unknown }>(res, 'paid', UPLOAD_TIMEOUT_MS)
    if (typeof json.queue_id !== 'string' || !json.queue_id) {
      throw new VeniceError('Venice svarade utan kö-id. Det kan ändå ha debiterats – kontrollera saldot.', 502)
    }
    const measured = Number(json.duration_seconds)
    return { queueId: json.queue_id, durationSeconds: Number.isFinite(measured) && measured > 0 ? measured : 0 }
  }

  /** JSON PROCESSING while it runs, then the converted audio (audio/mpeg). Polling again replays the result. */
  async retrieveVoiceChange(model: string, queueId: string): Promise<AudioRetrieve> {
    return this.retrieve('/audio/voice-changer/retrieve', model, queueId)
  }

  async completeVoiceChange(model: string, queueId: string): Promise<void> {
    await this.call('/audio/voice-changer/complete', {
      method: 'POST',
      json: { model, queue_id: queueId },
      requireKey: true,
      timeoutMs: QUOTE_TIMEOUT_MS,
      what: 'result'
    })
  }

  // ── Speech, cloning and transcription (synchronous, paid) ──────────────────

  /**
   * POST /audio/speech (paid, synchronous): one line in a voice (a preset, a provider voice id, or a vv_ clone handle
   * of the same model) as audio in `format`, which must be one of the model's formats (Chatterbox: wav only).
   * `speed` and `language` are sent when given; the style `prompt` only to Qwen 3, the one model that reads it.
   */
  async speech(o: {
    model: string
    input: string
    voice: string
    format: string
    speed?: number
    language?: string
    prompt?: string
  }): Promise<{ data: Buffer; format: string }> {
    const characters = Array.from(o.input).length
    if (!o.input.trim()) throw new Error('Repliken är tom.')
    if (characters > SPEECH_MAX_CHARACTERS) throw new Error(`Repliken är för lång (högst ${SPEECH_MAX_CHARACTERS} tecken).`)
    const body: Record<string, unknown> = { model: o.model, input: o.input, voice: o.voice, response_format: o.format }
    if (typeof o.speed === 'number' && Number.isFinite(o.speed)) body.speed = Math.min(4, Math.max(0.25, o.speed))
    if (o.language) body.language = o.language
    if (o.prompt && o.model.startsWith('tts-qwen3')) body.prompt = o.prompt.slice(0, 500)
    const res = await this.call('/audio/speech', { method: 'POST', json: body, requireKey: true, timeoutMs: SPEECH_TIMEOUT_MS, what: 'paid' })
    let data: Buffer
    try {
      data = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw transportError(err, 'paid', SPEECH_TIMEOUT_MS)
    }
    if (!data.length) throw new VeniceError('Venice skickade inget ljud. Det kan ändå ha debiterats – kontrollera saldot.', 502)
    const format = audioFormatOf(res.headers.get('content-type') ?? '', data, res.headers.get('x-venice-audio-format'), o.format)
    return { data, format }
  }

  /**
   * POST /audio/voices (paid): a cloned voice from a sample (multipart `file` + `model`, Chatterbox HD), returned as
   * the vv_ handle to pass as `voice` to /audio/speech with the same model. It expires after the model's retention
   * days (7).
   */
  async cloneVoice(o: { model: string; file: Buffer; filename: string }): Promise<{ handle: string }> {
    const form = new FormData()
    form.append('model', o.model)
    form.append('file', fileBlob(o.file, o.filename), o.filename)
    const res = await this.call('/audio/voices', { method: 'POST', form, requireKey: true, timeoutMs: UPLOAD_TIMEOUT_MS, what: 'paid' })
    const json = await this.json<{ id?: unknown }>(res, 'paid', UPLOAD_TIMEOUT_MS)
    if (typeof json.id !== 'string' || !json.id) {
      throw new VeniceError('Venice skickade ingen röst tillbaka. Det kan ändå ha debiterats – kontrollera saldot.', 502)
    }
    return { handle: json.id }
  }

  /**
   * POST /audio/transcriptions (paid): the text of a recording with its timing. Multipart: file, model,
   * response_format=json and timestamps=true (without it Venice returns no times at all); `language` is a hint
   * only some models (Whisper) use. Word times from Scribe and xAI, segment times from Whisper and Wizper.
   */
  async transcribe(o: { model: string; file: Buffer; filename: string; language?: string }): Promise<{
    text: string
    language?: string
    words?: TranscriptWord[]
    segments?: { text: string; start: number; end: number }[]
  }> {
    const form = new FormData()
    form.append('model', o.model)
    form.append('file', fileBlob(o.file, o.filename), o.filename)
    form.append('response_format', 'json')
    form.append('timestamps', 'true')
    if (o.language) form.append('language', o.language)
    const res = await this.call('/audio/transcriptions', { method: 'POST', form, requireKey: true, timeoutMs: TRANSCRIBE_TIMEOUT_MS, what: 'paid' })
    const json = await this.json<{
      text?: unknown
      language?: unknown
      timestamps?: { word?: unknown; segment?: unknown }
    }>(res, 'paid', TRANSCRIBE_TIMEOUT_MS)
    const timed = <T>(list: unknown, map: (item: Record<string, unknown>) => T | undefined): T[] =>
      Array.isArray(list)
        ? list.flatMap((item) => {
            if (!item || typeof item !== 'object') return []
            const r = item as Record<string, unknown>
            if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return []
            return map(r) ?? []
          })
        : []
    const words = timed(json.timestamps?.word, (w) =>
      typeof w.word === 'string' ? { text: w.word, start: w.start as number, end: w.end as number } : undefined
    )
    const segments = timed(json.timestamps?.segment, (s) =>
      typeof s.text === 'string' ? { text: s.text, start: s.start as number, end: s.end as number } : undefined
    )
    return {
      text: typeof json.text === 'string' ? json.text : '',
      ...(typeof json.language === 'string' && json.language ? { language: json.language } : {}),
      ...(words.length ? { words } : {}),
      ...(segments.length ? { segments } : {})
    }
  }
}
