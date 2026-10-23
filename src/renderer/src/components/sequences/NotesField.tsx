import { useCallback, useId } from 'react'
import type { Segment } from '@shared/types'
import PromptField from '../prompt/PromptField'
import DraftSaveState from '../ui/DraftSaveState'
import { useDraft, useRegisterFlush, type FlushRegistry } from './useDraft'
import type { SequenceStore } from './useSequence'

interface Notes {
  notes: string
}

interface Props {
  segment: Segment
  store: SequenceStore
  flushers: FlushRegistry
  className?: string
}

/**
 * The clip's Notes: free notes for planning the shot (any language), never sent – the prompt below is. Saved by
 * themselves as the user types, as a notes-only patch, so they can't overwrite the params the editor saves, and a
 * pending change is saved when the field goes away. Called Notes, not "What happens?": that is the prompt's label
 * in Storyboards and the Editor.
 */
export default function NotesField({ segment, store, flushers, className = '' }: Props) {
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
        <label htmlFor={id} className="text-muted">
          Notes
        </label>
        {/* Says what the field is for until there is a save to report (the live region stays mounted). */}
        <span className="flex items-baseline">
          {!draft.error && draft.status === 'idle' && <span className="text-[11px] text-muted">Not sent – just for you</span>}
          <DraftSaveState status={draft.status} error={draft.error} />
        </span>
      </div>
      <PromptField
        id={id}
        value={draft.value.notes}
        onChange={(notes) => draft.setValue({ notes })}
        onBlur={() => void draft.flush()}
        context="video"
        bare
        minRows={1}
        maxRows={8}
        title="Notes"
        focusHint="Notes for yourself – not sent to the model. Type / for a building block."
        placeholder="Notes for the shot – who's in it, the framing, ideas. Not sent; the prompt below is."
      />
    </div>
  )
}
