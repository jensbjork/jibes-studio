import { useCallback, useId } from 'react'
import type { Segment } from '@shared/types'
import PromptField from '../prompt/PromptField'
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
 * The clip's "What happens": free notes for planning the shot (any language), saved by themselves as the user types.
 * A notes-only patch, so it can't overwrite the params the editor saves, and a pending change is saved when the
 * field goes away.
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
          What happens
        </label>
        <span className="text-[10px] text-muted" aria-live="polite">
          {draft.error ? <span className="text-accent" title={draft.error}>Couldn't save</span> : draft.status !== 'idle' ? 'Saving…' : ''}
        </span>
      </div>
      <PromptField
        id={id}
        value={draft.value.notes}
        onChange={(notes) => draft.setValue({ notes })}
        onBlur={() => void draft.flush()}
        context="video"
        bare
        minRows={2}
        maxRows={8}
        title="What happens"
        focusHint="What should happen in the clip. Type / for a building block."
        placeholder="What should happen on screen? E.g. “She turns around and smiles at the camera.”"
      />
    </div>
  )
}
