import { useEffect, useRef } from 'react'
import { authorLabel } from '../feed/feedText'
import { PinIcon } from '../feed/icons'
import { evidenceText } from './learning-utils'

export interface LearningRow {
  title: string
  insight: string
  modelName?: string
  author: string
  pinned: boolean
  evidenceCount: number
}

interface Props {
  /** The learning's id: the list's keys find the row by it. Left out for a new learning that hasn't been saved yet. */
  id?: string
  row: LearningRow
  selected: boolean
  /** A new learning that hasn't been saved yet. */
  unsaved?: boolean
  onSelect: () => void
}

/**
 * One learning in the list, display-only as the side lists' rows are: its title, the start of its text, a pin when it
 * is pinned, its model, who wrote it and the clips it rests on. Pinning is the editor's.
 */
export default function LearningListItem({ id, row, selected, unsaved, onSelect }: Props) {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <button
      ref={ref}
      type="button"
      data-side-row={id}
      onClick={onSelect}
      aria-current={selected || undefined}
      className={`block w-full rounded-md px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-muted ${
        selected ? 'bg-raised' : 'hover:bg-raised/50'
      }`}
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className={`block truncate font-medium ${row.title ? '' : 'text-muted'}`}>
            {row.title || 'New learning'}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
            {row.insight || (unsaved ? 'Write the learning on the right…' : '')}
          </span>
        </span>
        {row.pinned && !unsaved && (
          <span role="img" aria-label="Pinned" title="Pinned" className="mt-0.5 shrink-0 text-amber-400">
            <PinIcon size={13} filled />
          </span>
        )}
      </span>
      <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
        {unsaved ? (
          <span>Not saved</span>
        ) : (
          <>
            <span className="min-w-0 truncate">{row.modelName ?? 'All models'}</span>
            <span>·</span>
            <span className="shrink-0">{authorLabel(row.author)}</span>
            {row.evidenceCount > 0 && (
              <>
                <span>·</span>
                <span className="shrink-0">{evidenceText(row.evidenceCount)}</span>
              </>
            )}
          </>
        )}
      </span>
    </button>
  )
}
