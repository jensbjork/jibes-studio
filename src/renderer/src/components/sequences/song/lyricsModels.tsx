import { activeServiceModels } from '@shared/service-models'
import { transcriptionPriceUsd } from '@shared/edit-plan'
import type { AsrModel } from '@shared/types'
import { SERVICE_NAME, useAudioCatalog } from '../../../lib/hooks'
import { LANGUAGES } from '../../editor/VoiceTab'

// The transcription models a song's lyrics can be made with: only those that time every word (the words are what the
// clips' places and the References legend are made from), the Editor's default first. Shared by the import dialog and
// the song strip's "Transcribe the lyrics…".

/** The Editor's default transcription model, also the lyrics' when the service lists it. */
const DEFAULT_LYRICS_MODEL = activeServiceModels().transcription

export interface LyricsModels {
  models: AsrModel[]
  /** The model used unless another is chosen. */
  defaultId?: string
  /** Why there is none to choose (the list couldn't be fetched, or none times words). */
  problem?: string
  loading: boolean
}

export function useLyricsModels(): LyricsModels {
  const audio = useAudioCatalog()
  const models = (audio.catalog?.transcription ?? []).filter((m) => m.timestamps === 'word')
  const defaultId = models.find((m) => m.id === DEFAULT_LYRICS_MODEL)?.id ?? models[0]?.id
  const problem =
    models.length || audio.loading
      ? undefined
      : audio.error
        ? `${SERVICE_NAME}'s transcription models couldn't be listed: ${audio.error}`
        : `${SERVICE_NAME} lists no transcription model that times every word right now.`
  return { models, defaultId, problem, loading: audio.loading && !audio.catalog }
}

/**
 * What transcribing `seconds` of song costs with the model (priced by the second), worked out as main does
 * (quoteSongLyrics) – the import dialog needs it before the sequence exists.
 */
export function lyricsPrice(model: AsrModel | undefined, seconds: number | undefined): number | undefined {
  if (!model || seconds === undefined || !Number.isFinite(seconds)) return undefined
  return transcriptionPriceUsd(seconds, model.usdPerSecond)
}

const select =
  'w-full min-w-0 rounded-md border border-line bg-raised px-2 py-1 text-[12px] outline-none focus:border-muted disabled:opacity-40'

/** The model and language of a transcription ("More" in the import dialog, the strip's transcribe panel). */
export function LyricsOptions({
  lyrics,
  model,
  language,
  disabled,
  onModel,
  onLanguage
}: {
  lyrics: LyricsModels
  model?: string
  language: string
  disabled?: boolean
  onModel: (id: string) => void
  onLanguage: (code: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="min-w-0">
        <span className="mb-1 block text-[11px] text-muted">Model</span>
        <select
          value={model ?? ''}
          onChange={(e) => onModel(e.target.value)}
          disabled={disabled || lyrics.models.length < 2}
          className={select}
        >
          {lyrics.models.length === 0 && <option value="">–</option>}
          {lyrics.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-[11px] text-muted">Language</span>
        <select value={language} onChange={(e) => onLanguage(e.target.value)} disabled={disabled} className={select}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
