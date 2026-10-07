import type { PromptLanguage } from '@shared/types'
import AudioPlayButton from './AudioPlayButton'
import { KIND_TONE } from './assetKinds'
import { audioInsertText, audioLabel, audioLabelParts, type FormAudio } from './audioRefs'
import { formatClipSeconds } from './text'

interface Props {
  /** The form's reference audio, in @AudioN order. */
  audios: FormAudio[]
  /** Prompt language: decides what a click inserts ("Anna's voice (@Audio1)" / "Annas röst (@Audio1)"). */
  language: PromptLanguage
  onInsert: (text: string) => void
  /** Takes the clip out of the form (1-based @AudioN number). */
  onRemove: (index: number) => void
}

const chip = 'inline-flex max-w-full items-center rounded-full border text-[11px] transition'
const ownChip = 'border-line bg-raised/60 hover:border-muted'

/**
 * The form's audio clips as chips: ▶ plays the part that is sent, a click on the name inserts it into the prompt,
 * ✕ takes it out. Clips the model won't get are dimmed.
 */
export default function AudioChips({ audios, language, onInsert, onRemove }: Props) {
  if (!audios.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {audios.map((a) => {
        const kind = a.source?.asset.kind
        const tone = kind ? KIND_TONE[kind] : undefined
        const { name, detail } = audioLabelParts(a)
        const label = audioLabel(a)
        const text = audioInsertText(a, language)
        return (
          <span
            key={`${a.index}:${a.path}`}
            className={`${chip} ${tone?.chip ?? ownChip} ${a.sent ? '' : 'opacity-50'}`}
            title={a.sent ? undefined : 'Skickas inte med den här modellen'}
          >
            <span className="py-0.5 pl-0.5">
              <AudioPlayButton path={a.path} start={a.start} length={a.length} label={label} />
            </span>
            <button
              onClick={() => onInsert(text)}
              title={`Infoga ”${text}” i prompten`}
              className="flex min-w-0 items-center gap-1.5 py-0.5 pl-1.5 pr-1.5"
            >
              <span className="min-w-0 truncate font-medium">{name}</span>
              <span className="shrink-0 text-muted">{detail}</span>
              <span className={`shrink-0 ${tone?.text ?? 'text-text'}`}>@Audio{a.index}</span>
              <span className="shrink-0 tabular-nums text-muted">{formatClipSeconds(a.length)}</span>
            </button>
            <button
              onClick={() => onRemove(a.index)}
              title={`Ta bort ${label} från ljudreferenserna`}
              aria-label={`Ta bort ${label}`}
              className="mr-1 shrink-0 rounded-full px-1 text-muted hover:text-text"
            >
              ✕
            </button>
          </span>
        )
      })}
    </div>
  )
}
