import type { Ref } from 'react'
import type { PromptLanguage } from '@shared/types'
import AudioPlayButton from './AudioPlayButton'
import { KIND_TONE } from './assetKinds'
import { audioInsertText, audioLabel, audioLabelParts, type FormAudio } from './audioRefs'
import { formatClipSeconds } from './text'
import { occurrenceKeys, useReorder } from './useReorder'

/** Drag payload of a reference audio chip being moved within its row (its key). */
export const REFERENCE_AUDIO_DRAG_TYPE = 'application/x-studio-reference-audio'

interface Props {
  /** The form's reference audio, in @AudioN order. */
  audios: FormAudio[]
  /** Prompt language: decides what a click inserts ("Anna's voice (@Audio1)" / "Annas röst (@Audio1)"). */
  language: PromptLanguage
  onInsert: (text: string) => void
  /** Takes the clip out of the form (1-based @AudioN number). */
  onRemove: (index: number) => void
  /**
   * Moves the clip at `from` to `to` (0-based positions in `audios`), after a drag or ⌥← / ⌥→ on a chip. The
   * parent reorders the reference audio and renumbers the prompt's @AudioN tokens in one update. Left out: the
   * chips can't be reordered.
   */
  onMove?: (from: number, to: number) => void
}

const chip = 'inline-flex max-w-full items-center rounded-full border text-[11px] transition'
const ownChip = 'border-line bg-raised/60 hover:border-muted'

/**
 * Whether the clip that would sit at `position` is sent. Sent clips are a prefix of the list (the model's limit),
 * or none at all when the model takes no audio, so the limit can be read off the clips as they are now.
 */
function sentAt(audios: readonly FormAudio[], position: number): boolean {
  const sent = audios.filter((a) => a.sent).length
  if (!sent) return false
  return sent === audios.length || position < sent
}

/**
 * The form's audio clips as chips: ▶ plays the part that is sent, a click on the name inserts it into the prompt,
 * ✕ takes it out, and dragging a chip (or ⌥← / ⌥→ on it) puts it in another place – its @AudioN number follows.
 * Clips the model won't get are dimmed.
 */
export default function AudioChips({ audios, language, onInsert, onRemove, onMove }: Props) {
  const keys = occurrenceKeys(audios.map((a) => a.path))
  const reorder = useReorder({
    type: REFERENCE_AUDIO_DRAG_TYPE,
    keys,
    onMove,
    describeMove: (from, to) => {
      const name = audioLabel(audios[from])
      return sentAt(audios, to)
        ? `${name} moved to place ${to + 1} and is now @Audio${to + 1}.`
        : `${name} moved to place ${to + 1} and isn’t sent with this model.`
    }
  })
  if (!audios.length) return null
  const dragging = reorder.dragging !== -1

  return (
    <>
      <div
        role="list"
        aria-label={`Sound references${reorder.enabled ? ' – drag or press ⌥← / ⌥→ on a sound to change the order' : ''}`}
        onDragOver={(e) => void reorder.onDragOver(e)}
        onDrop={(e) => void reorder.onDrop(e)}
        onDragLeave={reorder.onDragLeave}
        className="flex flex-wrap gap-1.5"
      >
        {audios.map((a, i) => {
          // While dragging, every chip shows the number (and sent state) it would have after the drop.
          const at = reorder.positions[i] ?? i
          const sent = dragging ? sentAt(audios, at) : a.sent
          const renamed = dragging && at !== i
          const kind = a.source?.asset.kind
          const tone = kind ? KIND_TONE[kind] : undefined
          const { name, detail } = audioLabelParts(a)
          const label = audioLabel(a)
          const text = audioInsertText(a, language)
          const { ref, ...item } = reorder.itemProps(i)
          return (
            <span
              key={keys[i]}
              ref={ref as Ref<HTMLSpanElement>}
              {...item}
              role="listitem"
              className={`relative ${chip} ${tone?.chip ?? ownChip} ${
                reorder.dragging === i ? 'opacity-30' : sent ? '' : 'opacity-50'
              } ${reorder.enabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
              title={
                sent
                  ? reorder.enabled && !dragging
                    ? 'Drag to change the order (or ⌥← / ⌥→)'
                    : undefined
                  : 'Not sent with this model'
              }
            >
              <span className="py-0.5 pl-0.5">
                <AudioPlayButton path={a.path} start={a.start} length={a.length} label={label} />
              </span>
              <button
                onClick={() => onInsert(text)}
                title={`Insert “${text}” in the prompt${reorder.enabled ? ' – drag to change the order (⌥← / ⌥→)' : ''}`}
                className="flex min-w-0 items-center gap-1.5 py-0.5 pl-1.5 pr-1.5"
              >
                <span className="min-w-0 truncate font-medium">{name}</span>
                <span className="shrink-0 text-muted">{detail}</span>
                {/* The highlight bleeds into the gaps (negative margin = padding), so the chip keeps its width. */}
                <span
                  className={`-mx-0.5 shrink-0 rounded px-0.5 ${renamed ? 'bg-text text-bg' : (tone?.text ?? 'text-text')}`}
                >
                  @Audio{at + 1}
                </span>
                <span className="shrink-0 tabular-nums text-muted">{formatClipSeconds(a.length)}</span>
              </button>
              <button
                onClick={() => onRemove(a.index)}
                title={`Remove ${label} from the sound references`}
                aria-label={`Remove ${label}`}
                className="mr-1 shrink-0 rounded-full px-1 text-muted hover:text-text"
              >
                ✕
              </button>
              {reorder.gap === i && <DropMarker side="before" />}
              {reorder.gap === audios.length && i === audios.length - 1 && <DropMarker side="after" />}
            </span>
          )
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>
    </>
  )
}

/** The insertion marker in the 6 px gap before (or after) a chip. */
function DropMarker({ side }: { side: 'before' | 'after' }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute -inset-y-0.5 w-0.5 rounded-full bg-accent ${
        side === 'before' ? '-left-[4px]' : '-right-[4px]'
      }`}
    />
  )
}
