import { z } from 'zod'
import { formatTimecode, MAX_SPEAK_LINES } from '@shared/edit-plan'
import type { BackgroundChoice, EditOperation, EditRange, SpeakLine, VoiceChoice } from '@shared/types'

// Redigera's operations as agents write them: one zod discriminated union on `op`, mirroring EditOperation in
// snake_case, and the one helper that turns it into the EditOperation the edit service plans and runs (and back,
// for answers). Every check of what an operation may do on a film lives in the service's plan
// (planEditOperation), the same one the window's operation cards use; this only fills the defaults the window's
// cards start from, so a plan an agent asks for is the plan the user would get from the same choices.

/** The models Redigera's cards start from (spec §8.5); a plan with another model is checked by the service. */
export const EDIT_DEFAULT_MODELS = {
  /** Gör om avsnittet and Förläng: image-to-video between (or from) frames of the film. */
  regenerate: 'seedance-2-5-image-to-video-basic',
  extend: 'seedance-2-5-image-to-video-basic',
  /** Ändra med prompt: Seedance 2.5 reference-to-video in its edit task. */
  promptEdit: 'seedance-2-5-reference-to-video-basic',
  /** New spoken lines in a preset voice, and in a cloned one. */
  speech: 'elevenlabs-tts-multilingual-v2',
  cloneSpeech: 'tts-chatterbox-hd',
  music: 'ace-step-15',
  effect: 'elevenlabs-sound-effects-v2'
} as const

const range = z
  .object({
    start: z.number().min(0).describe('Seconds into the base version.'),
    end: z.number().positive().describe('Seconds into the base version, after start.')
  })
  .strict()

const target = z.enum(['all', 'voice', 'background'])

const voice = z
  .union([
    z.object({ preset: z.string().min(1).describe("One of the model's voices (list_audio_models).") }).strict(),
    z
      .object({ voice_id: z.string().min(1).describe('A provider voice id (models with custom_voice_id).') })
      .strict(),
    z
      .object({
        clone_audio_id: z
          .string()
          .min(1)
          .describe(
            "A character's Röst clip (audio_id from list_assets), cloned for the new lines (speak_lines only; needs the user's consent, see clone_consent)."
          )
      })
      .strict()
  ])
  .describe('{preset}, {voice_id} or {clone_audio_id}.')

const background = z
  .enum(['keep', 'duck', 'remove'])
  .describe(
    'What happens to the original sound where the voice is replaced: keep (music and effects stay; needs voice separation), duck (lowered) or remove. Default keep when separation is available, else duck.'
  )

const pictureAudio = z
  .enum(['keep', 'model'])
  .describe("keep: the film's own sound stays (default); model: the new picture's sound from the model.")

const resolution = z
  .string()
  .optional()
  .describe("e.g. \"720p\"; default the film's own resolution capped at 720p.")

/** The operation input of apply_edit, plan_edit_operation and request_edit_operation. */
export const operationInput = z
  .discriminatedUnion('op', [
    // ── Free, made on this Mac ──
    z
      .object({ op: z.literal('trim'), keep: range.describe('The part to keep; the rest is cut away.') })
      .strict()
      .describe('Free. Keep only this part of the film.'),
    z.object({ op: z.literal('cut'), range: range.describe('The part to cut out.') }).strict().describe('Free. Cut a part out.'),
    z
      .object({
        op: z.literal('fade'),
        in_seconds: z.number().min(0).max(30).optional().describe('Fade in from black over this many seconds.'),
        out_seconds: z.number().min(0).max(30).optional().describe('Fade out to black over this many seconds.')
      })
      .strict()
      .describe('Free. Fade from / to black (picture and sound).'),
    z
      .object({
        op: z.literal('volume'),
        gain_db: z.number().min(-60).max(24).describe('Change in dB, e.g. -6 (half as loud) or 4.'),
        range: range.optional().describe('Only this part; the whole film when left out.'),
        target: target.optional().describe('all (default), or only the voice / the background (needs separation).')
      })
      .strict()
      .describe('Free. Louder or quieter.'),
    z
      .object({
        op: z.literal('mute'),
        range: range.optional().describe('Only this part; the whole film when left out.'),
        target: target.describe('all, voice (removes the voice, keeps music and effects) or background (keeps only the voice); voice/background need separation.')
      })
      .strict()
      .describe('Free. Silence, remove the voice, or keep only the voice.'),
    z
      .object({ op: z.literal('denoise'), strength: z.enum(['mild', 'strong']) })
      .strict()
      .describe('Free. Reduce background noise.'),
    z
      .object({
        op: z.literal('loudness'),
        lufs: z.union([z.literal(-14), z.literal(-16), z.literal(-23)]).describe('-14 web, -16, -23 TV.')
      })
      .strict()
      .describe('Free. Even out the loudness.'),
    z
      .object({
        op: z.literal('add_audio'),
        media_id: z.string().optional().describe("Audio already in this edit (get_edit's media: earlier music, effects, lines) – reused for free."),
        asset_audio_id: z
          .string()
          .optional()
          .describe("A library audio clip (audio_id from list_assets: a character's Röst or an environment's Ljudmiljö)."),
        at: z.number().min(0).describe('Seconds into the film where it starts.'),
        gain_db: z.number().min(-60).max(24).optional(),
        duck: z.boolean().optional().describe('Lower the film’s own sound while it plays.'),
        loop: z.boolean().optional(),
        length: z.number().positive().optional().describe('Seconds to play (trimmed or looped).'),
        fade_in_seconds: z.number().min(0).optional(),
        fade_out_seconds: z.number().min(0).optional(),
        replace_bed: z.boolean().optional().describe("Replace the film's own sound with it instead of mixing.")
      })
      .strict()
      .describe('Free. Put an audio clip on the Lager lane. Exactly one of media_id / asset_audio_id.'),
    z
      .object({
        op: z.literal('layer'),
        layer_id: z
          .string()
          .describe("A layer of the base version: get_edit lists every version's layers (layer_id), not only the current one's."),
        gain_db: z.number().min(-60).max(24).optional(),
        at: z.number().min(0).optional().describe('Move it to start here.'),
        remove: z.boolean().optional()
      })
      .strict()
      .describe('Free. Change or remove an added sound (music, effect, line).'),
    // ── Paid (Venice) ──
    z
      .object({
        op: z.literal('transcribe'),
        model: z.string().optional().describe('An ASR model (list_audio_models); default ElevenLabs Scribe v2 (word timestamps).'),
        language: z.string().optional().describe('A hint, e.g. "sv" or "en"; automatic when left out.')
      })
      .strict()
      .describe('Paid (about $0.01 a minute). Writes the transcript of the base version (no new version).'),
    z
      .object({
        op: z.literal('change_voice'),
        model: z.string().optional().describe("A voice changer (list_audio_models voice_changers); default the first one listed."),
        voice: voice.describe('{preset} or {voice_id} – not a clone.'),
        range: range.optional().describe('Only this part.'),
        segment_ids: z.array(z.string()).max(500).optional().describe('Only these transcript lines (get_transcript).'),
        background: background.optional(),
        remove_noise: z.boolean().optional()
      })
      .strict()
      .describe('Paid, per started minute per part. Speech-to-speech: a new voice, same performance and timing.'),
    z
      .object({
        op: z.literal('speak_lines'),
        model: z.string().optional().describe('A speech model (list_audio_models); default ElevenLabs multilingual v2, or Chatterbox HD for a clone.'),
        voice,
        lines: z
          .array(
            z
              .object({
                segment_id: z.string().optional().describe('Replaces this transcript line (get_transcript).'),
                at: z.number().min(0).optional().describe('Or a new line starting here (seconds).'),
                text: z.string().min(1).max(5000).describe('What is said.')
              })
              .strict()
          )
          .min(1)
          .max(MAX_SPEAK_LINES)
          .describe(`At most ${MAX_SPEAK_LINES} lines per request (more: split it into several requests).`),
        background: background.optional(),
        fit: z.enum(['tempo', 'overlap']).optional().describe('A line longer than its slot: tempo (up to 15 % faster, default) or overlap.'),
        style: z.string().max(500).optional().describe('Tone, for models with a style prompt.'),
        language: z.string().optional()
      })
      .strict()
      .describe('Paid, per line. Text-to-speech lines replacing transcript lines, or new ones; lips do not follow.'),
    z
      .object({
        op: z.literal('music'),
        model: z.string().optional().describe('A music model (list_audio_models); default ACE-Step (cheapest).'),
        prompt: z.string().min(1).max(2000).describe('English: genre, instruments, mood, tempo.'),
        range: range.optional().describe('Where it plays; the whole film when left out.'),
        instrumental: z.boolean().optional(),
        gain_db: z.number().min(-60).max(24).optional(),
        duck: z.boolean().optional().describe('Lower it under speech (default on).'),
        fade_seconds: z.number().min(0).max(10).optional()
      })
      .strict()
      .describe('Paid. Music on the Lager lane.'),
    z
      .object({
        op: z.literal('effect'),
        model: z.string().optional().describe('A sound-effect model (list_audio_models); default ElevenLabs SFX.'),
        prompt: z.string().min(1).max(1000).describe('English: the sound.'),
        at: z.number().min(0).describe('Seconds into the film.'),
        seconds: z.number().positive().max(180).describe("Length (per the model's limits)."),
        gain_db: z.number().min(-60).max(24).optional()
      })
      .strict()
      .describe('Paid. A sound effect on the Lager lane.'),
    z
      .object({
        op: z.literal('regenerate'),
        range: range.describe('The broken stretch; snapped to whole seconds (4–30 s for the default model).'),
        prompt: z.string().min(1).max(4000).describe('English: what happens between the frame before and the frame after the range.'),
        model: z.string().optional().describe('An image-to-video model that takes an end image; default Seedance 2.5.'),
        resolution,
        audio: pictureAudio.optional()
      })
      .strict()
      .describe('Paid. Gör om avsnittet: a new picture between the frame before and the frame after the range.'),
    z
      .object({
        op: z.literal('prompt_edit'),
        range: range.describe('The stretch to change (per-model limits, e.g. 4–30 s for Seedance).'),
        prompt: z.string().min(1).max(4000).describe('English: the one change to make.'),
        model: z.string().optional().describe('Default Seedance 2.5 reference-to-video (edit); also Gemini Omni Flash, Wan 2.7, HappyHorse video-to-video.'),
        resolution,
        reference_image_ids: z
          .array(z.string())
          .max(9)
          .optional()
          .describe('Library photos (image_ids) to work from, as @Image1… in the prompt (Seedance only).'),
        audio: pictureAudio.optional()
      })
      .strict()
      .describe('Paid. Ändra med prompt: video-to-video change of a stretch.'),
    z
      .object({
        op: z.literal('extend'),
        seconds: z.number().int().min(4).max(15).describe('How much longer.'),
        prompt: z.string().min(1).max(4000).describe('English: what happens next.'),
        model: z.string().optional().describe('Default Seedance 2.5 image-to-video.'),
        resolution,
        audio: z.enum(['model', 'silence']).optional().describe('Sound of the new part: the model’s (default) or silence.')
      })
      .strict()
      .describe('Paid. Förläng efter slutet, from the last frame.'),
    z
      .object({ op: z.literal('upscale'), factor: z.union([z.literal(2), z.literal(4)]) })
      .strict()
      .describe('Paid. Uppskala the whole version 2× or 4× (Topaz; needs the API key for its price).')
  ])
  .describe(
    'The operation, by op. Free: trim, cut, fade, volume, mute, denoise, loudness, add_audio, layer. Paid: transcribe, change_voice, speak_lines, music, effect, regenerate, prompt_edit, extend, upscale.'
  )

export type OperationInput = z.infer<typeof operationInput>

/** What the defaults depend on beyond the input: whether separation works, and the voice changer listed. */
export interface OperationDefaults {
  separation: boolean
  /** The first voice changer Venice lists; undefined while there is none. */
  voiceChanger?: string
}

const rangeOf = (r: { start: number; end: number } | undefined): EditRange | undefined =>
  r ? { start: r.start, end: r.end } : undefined

function voiceOf(v: OperationInputVoice): VoiceChoice {
  if ('preset' in v) return { kind: 'preset', voice: v.preset }
  if ('voice_id' in v) return { kind: 'custom', voiceId: v.voice_id }
  return { kind: 'clone', audioId: v.clone_audio_id }
}
type OperationInputVoice = z.infer<typeof voice>

/** Leaves out undefined fields, so a normalized operation compares and serializes the same however it was built. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/**
 * The agent's operation as the EditOperation Studio's edit service takes, with the defaults the window's cards
 * start from. Throws (Swedish) for what the schema can't say: a voice changer while Venice lists none, a clone
 * voice where only speak_lines takes one, add_audio without exactly one source.
 */
export function toEditOperation(input: OperationInput, defaults: OperationDefaults): EditOperation {
  const bg = (b: BackgroundChoice | undefined): BackgroundChoice => b ?? (defaults.separation ? 'keep' : 'duck')
  switch (input.op) {
    case 'trim':
      return { op: 'trim', keep: rangeOf(input.keep)! }
    case 'cut':
      return { op: 'cut', range: rangeOf(input.range)! }
    case 'fade':
      if (!input.in_seconds && !input.out_seconds) throw new Error('Ange in_seconds och/eller out_seconds.')
      return clean<EditOperation>({ op: 'fade', inSeconds: input.in_seconds, outSeconds: input.out_seconds })
    case 'volume':
      return clean<EditOperation>({ op: 'volume', gainDb: input.gain_db, range: rangeOf(input.range), target: input.target })
    case 'mute':
      return clean<EditOperation>({ op: 'mute', range: rangeOf(input.range), target: input.target })
    case 'denoise':
      return { op: 'denoise', strength: input.strength }
    case 'loudness':
      return { op: 'loudness', lufs: input.lufs }
    case 'add_audio': {
      if (!input.media_id === !input.asset_audio_id) {
        throw new Error(
          'Ange precis en ljudkälla: media_id (ljud som redan finns i redigeringen, get_edit) eller asset_audio_id (ett ljudklipp i biblioteket, list_assets). En egen ljudfil lägger du först till i redigeringen med add_edit_audio, som svarar med dess media_id.'
        )
      }
      return clean<EditOperation>({
        op: 'add-audio',
        source: input.media_id ? { mediaId: input.media_id } : { assetAudioId: input.asset_audio_id! },
        at: input.at,
        gainDb: input.gain_db,
        duck: input.duck,
        loop: input.loop,
        length: input.length,
        fadeInSeconds: input.fade_in_seconds,
        fadeOutSeconds: input.fade_out_seconds,
        replaceBed: input.replace_bed
      })
    }
    case 'layer':
      if (input.gain_db === undefined && input.at === undefined && !input.remove) {
        throw new Error('Ange gain_db, at eller remove för lagret.')
      }
      return clean<EditOperation>({ op: 'layer', layerId: input.layer_id, gainDb: input.gain_db, at: input.at, remove: input.remove })
    case 'transcribe':
      return clean<EditOperation>({ op: 'transcribe', model: input.model, language: input.language })
    case 'change_voice': {
      const v = voiceOf(input.voice)
      if (v.kind === 'clone') {
        throw new Error(
          'Röstbyte tar en av modellens röster ({preset}) eller ett röst-id ({voice_id}), inte en klonad röst. En karaktärs klonade röst går med speak_lines.'
        )
      }
      const model = input.model ?? defaults.voiceChanger
      if (!model) {
        throw new Error(
          'Röstbyte finns inte hos Venice just nu (ingen röstbytesmodell listas). Använd transcribe och sedan speak_lines för att läsa in replikerna på nytt.'
        )
      }
      return clean<EditOperation>({
        op: 'change-voice',
        model,
        voice: v,
        range: rangeOf(input.range),
        segmentIds: input.segment_ids,
        background: bg(input.background),
        removeNoise: input.remove_noise
      })
    }
    case 'speak_lines': {
      const v = voiceOf(input.voice)
      const lines: SpeakLine[] = input.lines.map((l) => {
        if (!l.segment_id === (l.at === undefined)) {
          throw new Error('Varje replik behöver antingen segment_id (en rad i transkriptionen) eller at (en ny replik), inte båda.')
        }
        return clean({ segmentId: l.segment_id, at: l.at, text: l.text.trim() })
      })
      return clean<EditOperation>({
        op: 'speak-lines',
        model: input.model ?? (v.kind === 'clone' ? EDIT_DEFAULT_MODELS.cloneSpeech : EDIT_DEFAULT_MODELS.speech),
        voice: v,
        lines,
        background: bg(input.background),
        fit: input.fit ?? 'tempo',
        style: input.style?.trim() || undefined,
        language: input.language
      })
    }
    case 'music':
      return clean<EditOperation>({
        op: 'music',
        model: input.model ?? EDIT_DEFAULT_MODELS.music,
        prompt: input.prompt.trim(),
        range: rangeOf(input.range),
        instrumental: input.instrumental,
        gainDb: input.gain_db,
        duck: input.duck,
        fadeSeconds: input.fade_seconds
      })
    case 'effect':
      return clean<EditOperation>({
        op: 'effect',
        model: input.model ?? EDIT_DEFAULT_MODELS.effect,
        prompt: input.prompt.trim(),
        at: input.at,
        seconds: input.seconds,
        gainDb: input.gain_db
      })
    case 'regenerate':
      return clean<EditOperation>({
        op: 'regenerate',
        range: rangeOf(input.range)!,
        prompt: input.prompt.trim(),
        model: input.model ?? EDIT_DEFAULT_MODELS.regenerate,
        resolution: input.resolution,
        audio: input.audio ?? 'keep'
      })
    case 'prompt_edit':
      return clean<EditOperation>({
        op: 'prompt-edit',
        range: rangeOf(input.range)!,
        prompt: input.prompt.trim(),
        model: input.model ?? EDIT_DEFAULT_MODELS.promptEdit,
        resolution: input.resolution,
        referenceImageIds: input.reference_image_ids?.length ? input.reference_image_ids : undefined,
        audio: input.audio ?? 'keep'
      })
    case 'extend':
      return clean<EditOperation>({
        op: 'extend',
        seconds: input.seconds,
        prompt: input.prompt.trim(),
        model: input.model ?? EDIT_DEFAULT_MODELS.extend,
        resolution: input.resolution,
        audio: input.audio ?? 'model'
      })
    case 'upscale':
      return { op: 'upscale', factor: input.factor }
  }
}

/** The op names agents use ("speak_lines") for Studio's ("speak-lines"). */
export const agentOpName = (op: string): string => op.replace(/-/g, '_')

const rangeOut = (r: EditRange | undefined): { start: number; end: number } | undefined =>
  r ? { start: round(r.start), end: round(r.end) } : undefined
const round = (s: number): number => Math.round(s * 1000) / 1000

function voiceOut(v: VoiceChoice): Record<string, string> {
  return v.kind === 'preset' ? { preset: v.voice } : v.kind === 'custom' ? { voice_id: v.voiceId } : { clone_audio_id: v.audioId }
}

/** An EditOperation as agents read it back (a plan's normalized operation, a version's recipe): snake_case. */
export function operationOutput(op: EditOperation): Record<string, unknown> {
  const out = (o: Record<string, unknown>): Record<string, unknown> => clean({ op: agentOpName(op.op), ...o })
  switch (op.op) {
    case 'trim':
      return out({ keep: rangeOut(op.keep) })
    case 'cut':
      return out({ range: rangeOut(op.range) })
    case 'fade':
      return out({ in_seconds: op.inSeconds, out_seconds: op.outSeconds })
    case 'volume':
      return out({ gain_db: op.gainDb, range: rangeOut(op.range), target: op.target })
    case 'mute':
      return out({ range: rangeOut(op.range), target: op.target })
    case 'denoise':
      return out({ strength: op.strength })
    case 'loudness':
      return out({ lufs: op.lufs })
    case 'add-audio':
      return out({
        ...('mediaId' in op.source ? { media_id: op.source.mediaId } : { asset_audio_id: op.source.assetAudioId }),
        at: op.at,
        gain_db: op.gainDb,
        duck: op.duck,
        loop: op.loop,
        length: op.length,
        fade_in_seconds: op.fadeInSeconds,
        fade_out_seconds: op.fadeOutSeconds,
        replace_bed: op.replaceBed
      })
    case 'layer':
      return out({ layer_id: op.layerId, gain_db: op.gainDb, at: op.at, remove: op.remove })
    case 'transcribe':
      return out({ model: op.model, language: op.language })
    case 'change-voice':
      return out({
        model: op.model,
        voice: voiceOut(op.voice),
        range: rangeOut(op.range),
        segment_ids: op.segmentIds,
        background: op.background,
        remove_noise: op.removeNoise
      })
    case 'speak-lines':
      return out({
        model: op.model,
        voice: voiceOut(op.voice),
        lines: op.lines.map((l) => clean({ segment_id: l.segmentId, at: l.at, text: l.text })),
        background: op.background,
        fit: op.fit,
        style: op.style,
        language: op.language
      })
    case 'music':
      return out({
        model: op.model,
        prompt: op.prompt,
        range: rangeOut(op.range),
        instrumental: op.instrumental,
        gain_db: op.gainDb,
        duck: op.duck,
        fade_seconds: op.fadeSeconds
      })
    case 'effect':
      return out({ model: op.model, prompt: op.prompt, at: op.at, seconds: op.seconds, gain_db: op.gainDb })
    case 'regenerate':
      return out({ range: rangeOut(op.range), prompt: op.prompt, model: op.model, resolution: op.resolution, audio: op.audio })
    case 'prompt-edit':
      return out({
        range: rangeOut(op.range),
        prompt: op.prompt,
        model: op.model,
        resolution: op.resolution,
        reference_image_ids: op.referenceImageIds,
        audio: op.audio
      })
    case 'extend':
      return out({ seconds: op.seconds, prompt: op.prompt, model: op.model, resolution: op.resolution, audio: op.audio })
    case 'upscale':
      return out({ factor: op.factor })
  }
}

/** The transcript lines an operation names (change_voice's segment_ids, speak_lines' replaced lines). */
export function segmentIdsOf(op: EditOperation): string[] {
  if (op.op === 'change-voice') return op.segmentIds ?? []
  if (op.op === 'speak-lines') return op.lines.flatMap((l) => (l.segmentId ? [l.segmentId] : []))
  return []
}

/** "0:41,0–0:45,0 (4,0 s)", the way Redigera names a range. */
export function rangeText(r: EditRange): string {
  const length = (r.end - r.start).toFixed(1).replace('.', ',')
  return `${formatTimecode(r.start)}–${formatTimecode(r.end)} (${length} s)`
}

/** "Hela filmen" or "markeringen 0:41,0–0:45,0 (4,0 s)". */
function scope(r: EditRange | undefined, whole: string): string {
  return r ? `markeringen ${rangeText(r)}` : whole
}

/** How a voice is named to the user: the preset's name, the id, or the character whose Röst is cloned. */
export interface VoiceNames {
  /** The character (asset) name of a cloned Röst clip, by audio id. */
  cloneOf?: (audioId: string) => string | undefined
}

/** "Anna" → "Annas", "Lars" → "Lars" (Swedish genitive). */
export function genitive(name: string): string {
  const n = name.trim()
  return /[sxz]$/i.test(n) ? n : `${n}s`
}

export function voiceText(v: VoiceChoice, names: VoiceNames = {}): string {
  if (v.kind === 'preset') return v.voice
  if (v.kind === 'custom') return `röst-id ${v.voiceId}`
  const who = names.cloneOf?.(v.audioId)
  return who ? `${genitive(who)} klonade röst` : 'en klonad röst'
}

/**
 * What the operation will do, in Swedish, in one line: the approval dialog's summary, the activity log and the
 * agent's answers. `seconds`: the base version's length, for "hela filmen (2:41)".
 */
export function operationSummary(op: EditOperation, seconds: number | undefined, names: VoiceNames = {}): string {
  const whole = seconds ? `hela filmen (${formatTimecode(seconds).replace(/,\d$/, '')})` : 'hela filmen'
  const quote = (s: string): string => `”${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`
  switch (op.op) {
    case 'trim':
      return `Behåll bara ${rangeText(op.keep)}`
    case 'cut':
      return `Klipp bort ${rangeText(op.range)}`
    case 'fade':
      return [op.inSeconds ? `tona in ${op.inSeconds} s` : '', op.outSeconds ? `tona ut ${op.outSeconds} s` : '']
        .filter(Boolean)
        .join(' och ')
        .replace(/^./, (c) => c.toUpperCase())
    case 'volume':
      return `Volym ${op.gainDb > 0 ? '+' : ''}${op.gainDb} dB${op.target && op.target !== 'all' ? (op.target === 'voice' ? ' på rösten' : ' på bakgrunden') : ''} – ${scope(op.range, whole)}`
    case 'mute':
      return `${op.target === 'voice' ? 'Ta bort rösten' : op.target === 'background' ? 'Bara rösten' : 'Tysta'} – ${scope(op.range, whole)}`
    case 'denoise':
      return `Ta bort brus (${op.strength === 'strong' ? 'stark' : 'mild'})`
    case 'loudness':
      return `Jämna ut ljudnivån till ${op.lufs} LUFS`
    case 'add-audio':
      return `Lägg till ljud vid ${formatTimecode(op.at)}`
    case 'layer':
      return op.remove ? 'Ta bort ett ljudlager' : 'Ändra ett ljudlager'
    case 'transcribe':
      return `Transkribera ljudet – ${whole}`
    case 'change-voice': {
      const where = op.segmentIds?.length
        ? `${op.segmentIds.length === 1 ? '1 vald replik' : `${op.segmentIds.length} valda repliker`}`
        : scope(op.range, whole)
      return `Byt röst till ${voiceText(op.voice, names)} – ${where}`
    }
    case 'speak-lines': {
      const replaced = op.lines.filter((l) => l.segmentId).length
      const added = op.lines.length - replaced
      const what = [
        replaced ? `läs in ${replaced === 1 ? '1 replik' : `${replaced} repliker`} på nytt` : '',
        added ? `lägg till ${added === 1 ? 'en ny replik' : `${added} nya repliker`}` : ''
      ]
        .filter(Boolean)
        .join(' och ')
      return `${what.replace(/^./, (c) => c.toUpperCase())} med ${voiceText(op.voice, names)}`
    }
    case 'music':
      return `Skapa musik: ${quote(op.prompt)} – ${scope(op.range, whole)}`
    case 'effect':
      return `Skapa ljudeffekt: ${quote(op.prompt)} vid ${formatTimecode(op.at)} (${op.seconds} s)`
    case 'regenerate':
      return `Gör om avsnittet ${rangeText(op.range)}`
    case 'prompt-edit':
      return `Ändra med prompt: ${rangeText(op.range)}`
    case 'extend':
      return `Förläng efter slutet med ${op.seconds} s`
    case 'upscale':
      return `Uppskala hela filmen ${op.factor}×`
  }
}
