import { useState, type KeyboardEvent, type RefObject } from 'react'
import { shortcut } from '../../lib/platform'
import { CloseIcon } from '../sequences/icons'
import { SORT_OPTIONS, isSortKey, type SortKey, type TagInfo } from './prompt-utils'

interface Props {
  query: string
  onQuery: (query: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** The list's keys in the search (lib/listKeys): ↓ to the rows, Enter opens the first match, Esc clears. */
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  tags: TagInfo[]
  activeTags: string[]
  onToggleTag: (key: string) => void
  favoritesOnly: boolean
  onFavoritesOnly: (value: boolean) => void
  hasFavorites: boolean
  sort: SortKey
  onSort: (sort: SortKey) => void
  shown: number
  total: number
}

const COLLAPSED_TAGS = 10

const chip = (active: boolean) =>
  `rounded-full border px-2 py-0.5 text-[12px] transition ${
    active ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
  }`

/** The Prompts list's search (the side lists' search), the favourites and tag chips, the count and the sort order. */
export default function PromptFilters({
  query,
  onQuery,
  searchRef,
  onSearchKeyDown,
  tags,
  activeTags,
  onToggleTag,
  favoritesOnly,
  onFavoritesOnly,
  hasFavorites,
  sort,
  onSort,
  shown,
  total
}: Props) {
  const [expanded, setExpanded] = useState(false)

  // Active tags stay visible even when the rest is collapsed.
  const visibleTags = expanded
    ? tags
    : tags.filter((t, i) => i < COLLAPSED_TAGS || activeTags.includes(t.key))
  const hiddenCount = tags.length - visibleTags.length

  return (
    <div className="shrink-0 space-y-2.5 px-2 pb-2">
      <div className="relative">
        <input
          ref={searchRef}
          type="text"
          role="searchbox"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search title, text and tags…"
          aria-label="Search prompts"
          title={shortcut('Search prompts (⌘F)')}
          spellCheck={false}
          className="w-full rounded-md border border-line bg-raised py-1.5 pl-2.5 pr-7 outline-none focus:border-muted"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              onQuery('')
              searchRef.current?.focus()
            }}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
          >
            <CloseIcon size={9} />
          </button>
        )}
      </div>

      {(hasFavorites || favoritesOnly || tags.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {(hasFavorites || favoritesOnly) && (
            <button type="button" onClick={() => onFavoritesOnly(!favoritesOnly)} className={chip(favoritesOnly)}>
              <span className={favoritesOnly ? 'text-amber-400' : ''}>★</span> Favourites
            </button>
          )}
          {visibleTags.map((t) => (
            <button key={t.key} type="button" onClick={() => onToggleTag(t.key)} className={chip(activeTags.includes(t.key))}>
              {t.label}
              <span className="ml-1 text-[11px] text-muted">{t.count}</span>
            </button>
          ))}
          {(hiddenCount > 0 || expanded) && tags.length > COLLAPSED_TAGS && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="px-1 text-[12px] text-muted hover:text-text"
            >
              {expanded ? 'Show fewer' : `+${hiddenCount} more`}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-0.5 text-[11px] text-muted">
        <span>{shown === total ? `${total} ${total === 1 ? 'prompt' : 'prompts'}` : `${shown} of ${total}`}</span>
        <label className="flex items-center gap-1">
          <span className="sr-only">Sort order</span>
          <select
            value={sort}
            onChange={(e) => isSortKey(e.target.value) && onSort(e.target.value)}
            className="cursor-pointer rounded bg-transparent py-0.5 text-right text-muted outline-none hover:text-text focus-visible:ring-1 focus-visible:ring-muted"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
