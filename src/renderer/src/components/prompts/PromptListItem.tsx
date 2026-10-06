import { useEffect, useRef } from 'react'
import { FavoriteButton } from './controls'
import { fold } from './prompt-utils'

export interface PromptRow {
  title: string
  body: string
  tags: string[]
  favorite: boolean
  useCount: number
}

interface Props {
  row: PromptRow
  selected: boolean
  /** A new prompt that hasn't been saved yet. */
  unsaved?: boolean
  activeTags: string[]
  onSelect: () => void
  onToggleFavorite: () => void
  onUse?: () => void
  onTagClick: (tag: string) => void
}

const MAX_TAGS = 3

export default function PromptListItem({
  row,
  selected,
  unsaved,
  activeTags,
  onSelect,
  onToggleFavorite,
  onUse,
  onTagClick
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const hiddenTags = row.tags.length - MAX_TAGS

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
          <div className={`truncate font-medium ${row.title ? '' : 'text-muted'}`}>{row.title || 'Ny prompt'}</div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
            {row.body || (unsaved ? 'Skriv prompten till höger…' : '')}
          </p>
        </div>
        <FavoriteButton
          active={row.favorite}
          onToggle={onToggleFavorite}
          className={`mt-0.5 text-[15px] ${row.favorite || selected ? '' : 'opacity-0 group-hover:opacity-100'}`}
        />
      </div>

      <div className="mt-1.5 flex h-5 items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {row.tags.slice(0, MAX_TAGS).map((tag) => {
            const active = activeTags.includes(fold(tag))
            return (
              <button
                key={tag}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onTagClick(tag)
                }}
                title={active ? `Sluta filtrera på ${tag}` : `Filtrera på ${tag}`}
                className={`max-w-28 shrink-0 truncate rounded px-1.5 py-px text-[11px] transition ${
                  active ? 'bg-accent/15 text-text' : 'bg-line/70 text-muted hover:text-text'
                }`}
              >
                {tag}
              </button>
            )
          })}
          {hiddenTags > 0 && <span className="shrink-0 text-[11px] text-muted">+{hiddenTags}</span>}
        </div>

        {unsaved ? (
          <span className="shrink-0 text-[11px] text-muted">Ej sparad</span>
        ) : (
          <>
            {row.useCount > 0 && (
              <span
                className={`shrink-0 text-[11px] text-muted ${onUse ? 'group-hover:hidden' : ''}`}
                title={row.useCount === 1 ? 'Använd 1 gång' : `Använd ${row.useCount} gånger`}
              >
                {row.useCount}×
              </span>
            )}
            {onUse && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onUse()
                }}
                title="Öppna i Generera"
                className="hidden shrink-0 rounded px-1.5 py-px text-[11px] text-accent hover:bg-accent/15 group-hover:block"
              >
                Använd →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
