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
  row: LearningRow
  selected: boolean
  /** A new learning that hasn't been saved yet. */
  unsaved?: boolean
  onSelect: () => void
  onTogglePin: () => void
}

export default function LearningListItem({ row, selected, unsaved, onSelect, onTogglePin }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`group rounded-md px-3 py-2.5 transition-colors ${selected ? 'bg-raised' : 'hover:bg-raised/50'}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={`truncate font-medium ${row.title ? '' : 'text-muted'}`}>{row.title || 'New learning'}</div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
            {row.insight || (unsaved ? 'Write the learning on the right…' : '')}
          </p>
        </div>
        {!unsaved && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
            aria-pressed={row.pinned}
            title={row.pinned ? 'Unpin – stop showing it at the top' : 'Pin to top – agents see pinned learnings first'}
            className={`mt-0.5 shrink-0 transition ${
              row.pinned
                ? 'text-amber-400 hover:text-amber-300'
                : `text-muted hover:text-text ${selected ? '' : 'opacity-0 group-hover:opacity-100'}`
            }`}
          >
            <PinIcon size={13} filled={row.pinned} />
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
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
      </div>
    </div>
  )
}
