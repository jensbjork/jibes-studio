// Sound on fal.ai, with the same calls as VeniceAudio (venice-audio.ts), so the Editor, voice design and a song's
// lyrics run on either service: lines in ElevenLabs v3's voices or in a character's cloned voice (Chatterbox, which
// takes the voice sample with every line – "cloning" uploads it and keeps its link for a day), voice design (Qwen 3
// TTS: a voice from a description, speaking the sample text), music (ACE-Step, ElevenLabs Music), sound effects and
// the voice changer (ElevenLabs), and transcripts with word times (Scribe v2). Every request runs on fal's queue; the
// queued ones are polled by the Editor as Venice's are, the rest are waited for here.

import {
  FAL_EFFECT_MODELS,
  FAL_MUSIC_MODELS,
  FAL_SPEECH_MODELS,
  FAL_TRANSCRIPTION_MODELS,
  FAL_VOICE_CHANGERS,
  FAL_VOICE_DESIGN,
  falAudioPrice
} from '@shared/fal-models'
import { falEndpoint } from '@shared/provider'
import type { AudioCatalog, TranscriptWord } from '@shared/types'
import { FalClient, FalError, mimeOf } from './fal'
import { audioFormatOf, type AudioRetrieve } from './venice-audio'

const SPEECH_TIMEOUT_MS = 3 * 60_000
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

const id = (model: string): string => falEndpoint(model)

/** The first line of a voice design prompt is the description, the rest the sample text (edit-ops designPrompt). */
function splitDesign(prompt: string): { description: string; text: string } {
  const at = prompt.indexOf('\n')
  return at < 0
    ? { description: prompt, text: prompt }
    : { description: prompt.slice(0, at), text: prompt.slice(at + 1) }
}

export class FalAudio {
  constructor(private readonly fal: FalClient) {}

  /** The audio models Studio offers on fal (Studio's own list, no request). */
  async catalog(_force = false): Promise<AudioCatalog> {
    return {
      speech: [...FAL_SPEECH_MODELS],
      music: [...FAL_MUSIC_MODELS],
      effects: [...FAL_EFFECT_MODELS],
      transcription: [...FAL_TRANSCRIPTION_MODELS],
      voiceChangers: [...FAL_VOICE_CHANGERS],
      voiceDesign: [...FAL_VOICE_DESIGN],
      keyed: this.fal.hasKey(),
      fetchedAt: Date.now()
    }
  }

  /** A price worked out from the model's rate (fal quotes nothing itself). */
  async quoteAudio(o: { model: string; durationSeconds?: number; characterCount?: number }): Promise<number> {
    const usd = falAudioPrice(o.model, o)
    if (usd === undefined) throw new FalError(`No price is known for ${o.model}.`, 404)
    return usd
  }

  async quoteVoiceChange(model: string, seconds: number): Promise<number> {
    return this.quoteAudio({ model, durationSeconds: seconds })
  }

  /** The model's input for a queued step (edit-ops queueBody's fields: prompt, voice, duration, instrumental). */
  private queueInput(body: Record<string, unknown>): Record<string, unknown> {
    const model = typeof body.model === 'string' ? body.model : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    const seconds = Number(body.duration_seconds)
    const hasSeconds = body.duration_seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    switch (id(model)) {
      case 'fal-ai/elevenlabs/tts/eleven-v3':
        return {
          text: prompt,
          voice: typeof body.voice === 'string' && body.voice ? body.voice : 'Rachel',
          ...(typeof body.language_code === 'string' && body.language_code ? { language_code: body.language_code } : {})
        }
      case 'fal-ai/chatterbox/text-to-speech': {
        // The "voice" is the link to the uploaded sample (cloneVoice).
        if (typeof body.voice !== 'string' || !/^https:\/\//.test(body.voice)) {
          throw new Error('The cloned voice has expired. Run the job again to clone it anew.')
        }
        return { text: prompt, audio_url: body.voice }
      }
      case 'fal-ai/qwen-3-tts/voice-design/1.7b': {
        const split = splitDesign(prompt)
        const description =
          typeof body.description === 'string' && body.description ? body.description : split.description
        const text = typeof body.sample_text === 'string' && body.sample_text ? body.sample_text : split.text
        return { prompt: description, text }
      }
      case 'fal-ai/ace-step/prompt-to-audio':
        return {
          prompt,
          ...(hasSeconds ? { duration: Math.min(240, Math.max(5, Math.round(seconds))) } : {}),
          ...(typeof body.force_instrumental === 'boolean' ? { instrumental: body.force_instrumental } : {})
        }
      case 'elevenlabs/music/v2.5':
        return {
          prompt,
          ...(hasSeconds ? { music_length_ms: Math.min(600_000, Math.max(3000, Math.round(seconds * 1000))) } : {}),
          ...(typeof body.force_instrumental === 'boolean' ? { force_instrumental: body.force_instrumental } : {})
        }
      case 'fal-ai/elevenlabs/sound-effects/v2':
        return {
          text: prompt,
          ...(hasSeconds ? { duration_seconds: Math.min(22, Math.max(0.5, seconds)) } : {}),
          ...(typeof body.loop === 'boolean' ? { loop: body.loop } : {})
        }
      default:
        throw new Error(`fal.ai has no audio model ${model} in Studio.`)
    }
  }

  /** Sends a music, effect, speech or voice design step (paid, sent once). */
  async queueAudio(body: Record<string, unknown>): Promise<{ queueId: string }> {
    const model = typeof body.model === 'string' ? body.model : ''
    if (!model || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw new Error('The request has no model or text.')
    }
    const { requestId } = await this.fal.submit(id(model), this.queueInput(body))
    return { queueId: requestId }
  }

  /** Still running, or the finished audio (downloaded from its link). */
  async retrieveAudio(model: string, queueId: string): Promise<AudioRetrieve> {
    const endpoint = id(model)
    const status = await this.fal.status(endpoint, queueId)
    if (status.state !== 'done') return { state: 'processing' }
    const out = await this.fal.result<{ audio?: { url?: string; content_type?: string } }>(endpoint, queueId)
    const url = out?.audio?.url
    if (!url)
      throw new FalError('fal.ai finished without audio. It may have been charged anyway – check your usage.', 502)
    const data = await this.fal.download(url, 'The audio could not be downloaded from fal.ai.')
    if (!data.length) throw new FalError('fal.ai sent no audio.', 502)
    return { state: 'audio', data, format: audioFormatOf(out.audio?.content_type ?? '', data) }
  }

  /** Nothing to do: fal drops the file after a day. */
  async completeAudio(_model: string, _queueId: string): Promise<void> {}

  /** The voice changer: the recording uploaded, then sent with the voice (paid at fal when it runs). */
  async queueVoiceChange(o: {
    model: string
    file: Buffer
    filename: string
    voice: string
    removeNoise?: boolean
    seed?: number
  }): Promise<{ queueId: string; durationSeconds: number }> {
    const url = await this.fal.upload(o.file, mimeOf(o.filename), o.filename)
    const input: Record<string, unknown> = { audio_url: url, voice: o.voice || 'Rachel' }
    if (typeof o.removeNoise === 'boolean') input.remove_background_noise = o.removeNoise
    if (typeof o.seed === 'number' && Number.isInteger(o.seed) && o.seed >= 0) input.seed = o.seed
    const { requestId } = await this.fal.submit(id(o.model), input)
    // fal says nothing of the seconds it bills: the plan's own measure stands.
    return { queueId: requestId, durationSeconds: 0 }
  }

  retrieveVoiceChange(model: string, queueId: string): Promise<AudioRetrieve> {
    return this.retrieveAudio(model, queueId)
  }

  async completeVoiceChange(_model: string, _queueId: string): Promise<void> {}

  /** One line, waited for (paid): ElevenLabs v3 in a voice, or Chatterbox in a cloned voice (`voice` = its link). */
  async speech(o: {
    model: string
    input: string
    voice: string
    format: string
    speed?: number
    language?: string
    prompt?: string
  }): Promise<{ data: Buffer; format: string }> {
    if (!o.input.trim()) throw new Error('The line is empty.')
    const body = {
      model: o.model,
      prompt: o.input,
      voice: o.voice,
      ...(o.language ? { language_code: o.language } : {})
    }
    const out = await this.fal.run<{ audio?: { url?: string; content_type?: string } }>(
      id(o.model),
      this.queueInput(body),
      {
        timeoutMs: SPEECH_TIMEOUT_MS
      }
    )
    const url = out?.audio?.url
    if (!url) throw new FalError('fal.ai sent no audio. It may have been charged anyway – check your usage.', 502)
    const data = await this.fal.download(url, 'The audio could not be downloaded from fal.ai.')
    return { data, format: audioFormatOf(out.audio?.content_type ?? '', data, undefined, o.format) }
  }

  /**
   * A "clone" for Chatterbox: the sample uploaded to fal (no charge), its link the handle every line in that voice
   * sends. The link lives a day (the model's retentionDays: 1), after which the Editor uploads the sample again.
   */
  async cloneVoice(o: { model: string; file: Buffer; filename: string }): Promise<{ handle: string }> {
    return { handle: await this.fal.upload(o.file, mimeOf(o.filename), o.filename) }
  }

  /** The text of a recording with its word times (Scribe v2), as VeniceAudio.transcribe gives it. */
  async transcribe(o: { model: string; file: Buffer; filename: string; language?: string }): Promise<{
    text: string
    language?: string
    words?: TranscriptWord[]
    segments?: { text: string; start: number; end: number }[]
  }> {
    const url = await this.fal.upload(o.file, mimeOf(o.filename), o.filename)
    const input: Record<string, unknown> = { audio_url: url, diarize: false, tag_audio_events: false }
    if (o.language) input.language_code = o.language
    const out = await this.fal.run<{
      text?: unknown
      language_code?: unknown
      words?: { text?: unknown; start?: unknown; end?: unknown; type?: unknown }[]
    }>(id(o.model), input, { timeoutMs: TRANSCRIBE_TIMEOUT_MS })
    const words = (Array.isArray(out?.words) ? out.words : []).flatMap((w) =>
      w &&
      (w.type === undefined || w.type === 'word') &&
      typeof w.text === 'string' &&
      typeof w.start === 'number' &&
      typeof w.end === 'number' &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end)
        ? [{ text: w.text, start: w.start, end: w.end }]
        : []
    )
    return {
      text: typeof out?.text === 'string' ? out.text : '',
      ...(typeof out?.language_code === 'string' && out.language_code ? { language: out.language_code } : {}),
      ...(words.length ? { words } : {})
    }
  }
}
