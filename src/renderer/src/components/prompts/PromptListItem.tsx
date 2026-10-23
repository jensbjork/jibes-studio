import { useEffect, useRef } from 'react'

export interface PromptRow {
  title: string
  body: string
  tags: string[]
  favorite: boolean
  useCount: number
}

interface Props {
  /** The prompt's id: the list's keys find the row by it. Left out for a new prompt that hasn't been saved yet. */
  id?: string
  row: PromptRow
  selected: boolean
  /** A new prompt that hasn't been saved yet. */
  unsaved?: boolean
  onSelect: () => void
}

const MAX_TAGS = 3

/**
 * One prompt in the list, display-only as the side lists' rows are: its title, the start of its text, a star when it
 * is a favourite, its first tags and how often it was used. Starring, filtering and using it are the editor's and the
 * filters' – and the list's keys: ↑ ↓ open a row, ⌘↵ generates with it.
 */
export default function PromptListItem({ id, row, selected, unsaved, onSelect }: Props) {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const hiddenTags = row.tags.length - MAX_TAGS

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
          <span className={`block truncate font-medium ${row.title ? '' : 'text-muted'}`}>{row.title || 'New prompt'}</span>
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
            {row.body || (unsaved ? 'Write the prompt on the right…' : '')}
          </span>
        </span>
        {row.favorite && (
          <span
            role="img"
            aria-label="Favourite"
            title="Favourite"
            className="mt-0.5 shrink-0 text-[15px] leading-none text-amber-400"
          >
            ★
          </span>
        )}
      </span>

      <span className="mt-1.5 flex h-5 items-center gap-1">
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {row.tags.slice(0, MAX_TAGS).map((tag) => (
            <span key={tag} className="max-w-28 shrink-0 truncate rounded bg-line/70 px-1.5 py-px text-[11px] text-muted">
              {tag}
            </span>
          ))}
          {hiddenTags > 0 && <span className="shrink-0 text-[11px] text-muted">+{hiddenTags}</span>}
        </span>

        {unsaved ? (
          <span className="shrink-0 text-[11px] text-muted">Not saved</span>
        ) : (
          row.useCount > 0 && (
            <span
              className="shrink-0 text-[11px] text-muted"
              title={row.useCount === 1 ? 'Used once' : `Used ${row.useCount} times`}
            >
              {row.useCount}×
            </span>
          )
        )}
      </span>
    </button>
  )
}
