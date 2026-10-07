import { useCallback, useId } from 'react'
import type { Segment } from '@shared/types'
import { useDraft, useRegisterFlush, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

interface Notes {
  notes: string
}

interface Props {
  segment: Segment
  store: SequenceStore
  flushers: FlushRegistry
  /** Smaller type and no label of its own (a storyboard panel labels it). */
  compact?: boolean
  className?: string
}

/**
 * The clip's "Vad händer": free notes for planning the shot (any language), saved by themselves as the user types.
 * A notes-only patch, so it can't overwrite the params the editor saves, and a pending change is saved when the
 * field goes away.
 */
export default function NotesField({ segment, store, flushers, compact = false, className = '' }: Props) {
  const { mutate } = store
  const segmentId = segment.id
  const save = useCallback(
    (v: Notes) => mutate(() => window.studio.updateSegment(segmentId, { notes: v.notes })),
    [mutate, segmentId]
  )
  const draft = useDraft<Notes>({ notes: segment.notes ?? '' }, save, 700)
  useRegisterFlush(flushers, draft.flush)
  const id = useId()

  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={compact ? 'text-[11px] text-muted' : 'text-muted'}>
          Vad händer
        </label>
        <span className="text-[10px] text-muted" aria-live="polite">
          {draft.error ? <span className="text-accent" title={draft.error}>Kunde inte spara</span> : draft.status !== 'idle' ? 'Sparar…' : ''}
        </span>
      </div>
      <textarea
        id={id}
        value={draft.value.notes}
        onChange={(e) => draft.setValue({ notes: e.target.value })}
        onBlur={() => void draft.flush()}
        placeholder="Vad ska hända i bild? T.ex. ”Hon vänder sig om och ler mot kameran.”"
        spellCheck={false}
        rows={2}
        className={`block max-h-40 min-h-[3.25rem] w-full resize-none rounded-md border border-line bg-raised/60 px-2.5 py-1.5 leading-snug outline-none transition [field-sizing:content] placeholder:text-muted/70 focus:border-muted focus:bg-raised ${
          compact ? 'text-[12px]' : ''
        }`}
      />
    </div>
  )
}
