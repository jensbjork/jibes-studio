import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ASSET_KINDS, type Asset, type Generation, type VideoModel } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import AssetAvatar from '../assets/AssetAvatar'
import { KIND_TONE } from '../pickers/assetKinds'
import { CloseIcon } from '../sequences/icons'
import { Spinner, StatusDot } from '../work/StatusMark'
import {
  PERIOD_OPTIONS,
  PLACEMENT_OPTIONS,
  RATING_OPTIONS,
  SORT_OPTIONS,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  hasFilters,
  isSortKey,
  modelName,
  type FeedFilters,
  type FeedView,
  type SortKey
} from './feedFilter'
import FilterMenu, { type MenuOption } from './FilterMenu'
import { GridIcon, ListIcon, SearchIcon } from './icons'
import { assetUseCounts, type LibraryIndex } from './references'

interface Props {
  view: FeedView
  onView: (view: FeedView) => void
  filters: FeedFilters
  onFilters: (filters: FeedFilters) => void
  sort: SortKey
  onSort: (sort: SortKey) => void
  /** "42 clips · $38.20 · 5 min 12 s" for what is shown. */
  summary: string
  /** Every generation (not just the shown ones), for the choices and their counts. */
  generations: readonly Generation[]
  models: readonly VideoModel[]
  assets: readonly Asset[]
  index: LibraryIndex
  searchRef: RefObject<HTMLInputElement | null>
  /** ArrowDown in the search field hands the keyboard to the list. */
  onSearchArrowDown: () => void
  /** Clips being generated right now (all of them, not just the shown ones): the "◌ n in progress" chip. */
  pendingCount: number
  /** Finished clips not looked at yet: the "New" chip. */
  unseenCount: number
  /** Left end of the first row (Media's tabs). */
  leading?: ReactNode
  /** Right end of the first row (e.g. the folder button). */
  trailing?: ReactNode
}

const segment = (on: boolean) =>
  `flex h-full items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] transition ${
    on ? 'bg-raised text-text shadow-sm shadow-black/40' : 'text-muted hover:text-text'
  }`

/** The feed's header: view switch, search, filters as chips, sort order and a summary of what is shown. */
export default function FeedToolbar({
  view,
  onView,
  filters,
  onFilters,
  sort,
  onSort,
  summary,
  generations,
  models,
  assets,
  index,
  searchRef,
  onSearchArrowDown,
  pendingCount,
  unseenCount,
  leading,
  trailing
}: Props) {
  const set = (patch: Partial<FeedFilters>) => onFilters({ ...filters, ...patch })

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && filters.query) {
      e.preventDefault()
      e.stopPropagation()
      set({ query: '' })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onSearchArrowDown()
    }
  }

  // The models that made something, most used first; names from the model list when Venice still has it. Own clips
  // and versions have no model ('') and aren't one.
  const modelOptions = useMemo((): MenuOption<string>[] => {
    const counts = new Map<string, number>()
    for (const g of generations) if (g.model) counts.set(g.model, (counts.get(g.model) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || modelName(a[0], models).localeCompare(modelName(b[0], models), 'en'))
      .map(([id, count]) => ({ id, label: modelName(id, models), text: id, hint: count }))
  }, [generations, models])
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const g of generations) counts.set(g.source ?? 'generated', (counts.get(g.source ?? 'generated') ?? 0) + 1)
    return counts
  }, [generations])

  return (
    <div className="shrink-0 border-b border-line/60 px-6 pb-2.5">
      <div className="drag flex h-12 items-center gap-3">
        {leading}
        <ViewSwitch view={view} onView={onView} />

        <div className="no-drag relative min-w-36 max-w-72 flex-1">
          <SearchIcon size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={onSearchKey}
            placeholder="Search prompts and names…"
            aria-label="Search prompts and names"
            title="Search prompts and names (⌘ F)"
            className="h-7 w-full rounded-md border border-line bg-raised pl-7 pr-7 text-[12px] outline-none focus:border-muted"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => {
                set({ query: '' })
                searchRef.current?.focus()
              }}
              title="Clear the search"
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-line hover:text-text"
            >
              <CloseIcon size={9} />
            </button>
          )}
        </div>

        <span className="flex-1" />
        {trailing}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(pendingCount > 0 || filters.status === 'pending') && (
          <ToggleChip
            on={filters.status === 'pending'}
            onToggle={() => set({ status: filters.status === 'pending' ? undefined : 'pending' })}
            title="Show only what is generating right now"
          >
            <Spinner size={11} />
            {pendingCount} in progress
          </ToggleChip>
        )}
        {(unseenCount > 0 || filters.unseen) && (
          <ToggleChip
            on={!!filters.unseen}
            onToggle={() => set({ unseen: filters.unseen ? undefined : true })}
            title="Show only clips that are done but you haven’t watched yet"
          >
            <StatusDot />
            New
            {unseenCount > 0 && <span className="text-muted tabular-nums">{unseenCount}</span>}
          </ToggleChip>
        )}
        <FilterMenu
          title="Source"
          value={filters.source}
          valueLabel={SOURCE_OPTIONS.find((o) => o.id === filters.source)?.label}
          options={SOURCE_OPTIONS.map((o) => ({
            id: o.id,
            label: o.label,
            text: o.text,
            hint: sourceCounts.get(o.id)
          }))}
          onChange={(source) => set({ source })}
          allLabel="All"
        />
        <FilterMenu
          title="Status"
          value={filters.status}
          valueLabel={STATUS_OPTIONS.find((o) => o.id === filters.status)?.label}
          options={STATUS_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
          onChange={(status) => set({ status })}
        />
        <FilterMenu
          title="Model"
          value={filters.model}
          valueLabel={filters.model && modelName(filters.model, models)}
          options={modelOptions}
          onChange={(model) => set({ model })}
          allLabel="All models"
          width={300}
          empty={<p className="px-3 py-2 text-[12px] text-muted">No clips yet.</p>}
        />
        <AssetFilter
          value={filters.assetId}
          onChange={(assetId) => set({ assetId })}
          generations={generations}
          assets={assets}
          index={index}
        />
        <FilterMenu
          title="Rating"
          value={filters.rating}
          valueLabel={ratingFilterLabel(filters.rating)}
          options={RATING_OPTIONS.map((o) => ({
            id: o.id,
            label:
              typeof o.id === 'number' ? (
                <span className="text-amber-400">{o.label}</span>
              ) : o.id === 'thumbsDown' ? (
                <span>
                  <span aria-hidden className="mr-1.5">
                    👎
                  </span>
                  {o.label}
                </span>
              ) : (
                o.label
              ),
            text: o.label
          }))}
          onChange={(rating) => set({ rating })}
        />
        <FilterMenu
          title="Time"
          value={filters.period}
          valueLabel={PERIOD_OPTIONS.find((o) => o.id === filters.period)?.label}
          options={PERIOD_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
          onChange={(period) => set({ period })}
          allLabel="All time"
        />
        <FilterMenu
          title="Placement"
          value={filters.placement}
          valueLabel={PLACEMENT_OPTIONS.find((o) => o.id === filters.placement)?.label}
          options={PLACEMENT_OPTIONS.map((o) => ({
            id: o.id,
            label: o.label,
            text:
              o.id === 'sequence'
                ? 'Takes in a sequence or storyboard'
                : 'Clips that aren’t part of any sequence or storyboard'
          }))}
          onChange={(placement) => set({ placement })}
          allLabel="All clips"
        />
        {hasFilters(filters) && (
          <button
            type="button"
            onClick={() => onFilters({ query: '' })}
            className="no-drag ml-1 rounded px-1.5 py-1 text-[12px] text-muted underline-offset-2 hover:text-text hover:underline"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto flex min-w-0 items-center gap-3 pl-2">
          <span className="min-w-0 truncate text-[12px] text-muted tabular-nums" title={summary} aria-live="polite">
            {summary}
          </span>
          <SortSelect sort={sort} onSort={onSort} />
        </span>
      </div>
    </div>
  )
}

/** Cards or Table. */
function ViewSwitch({ view, onView }: { view: FeedView; onView: (view: FeedView) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="no-drag flex h-7 shrink-0 items-center rounded-md border border-line bg-panel p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={view === 'cards'}
        onClick={() => onView('cards')}
        title="Large cards with video"
        className={segment(view === 'cards')}
      >
        <GridIcon size={12} />
        Cards
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={view === 'table'}
        onClick={() => onView('table')}
        title="Table – many clips at once"
        className={segment(view === 'table')}
      >
        <ListIcon size={12} />
        Table
      </button>
    </div>
  )
}

/**
 * Generate's header over this session's clips: the view switch and the import and folder buttons, then what the
 * session has made so far and the way to everything older in Media. No search, filters or order: the list is
 * short and always newest first.
 */
export function SessionToolbar({
  view,
  onView,
  summary,
  onShowAll,
  trailing
}: {
  view: FeedView
  onView: (view: FeedView) => void
  /** "This session · 3 clips · $1.20 · 24 s". */
  summary: string
  /** "All videos in Media". */
  onShowAll: () => void
  trailing?: ReactNode
}) {
  return (
    <div className="shrink-0 border-b border-line/60 px-6 pb-2.5">
      <div className="drag flex h-12 items-center gap-3">
        <ViewSwitch view={view} onView={onView} />
        <span className="flex-1" />
        {trailing}
      </div>
      <div className="flex min-h-7 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted tabular-nums" title={summary} aria-live="polite">
          {summary}
        </span>
        <MediaLink onClick={onShowAll} />
      </div>
    </div>
  )
}

/** "All videos in Media →": from Generate's session list to every clip. */
export function MediaLink({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show every clip you have made, also from earlier sessions"
      className={`no-drag shrink-0 whitespace-nowrap text-[12px] text-text underline-offset-2 hover:underline ${className}`}
    >
      All videos in Media →
    </button>
  )
}

/** A one-click filter (In progress, New), styled like the filter menus' chips. */
function ToggleChip({
  on,
  onToggle,
  title,
  children
}: {
  on: boolean
  onToggle: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={title}
      className={`no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
        on ? 'border-accent/50 bg-accent/10 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}

/** The order of the list (the table's column headers change it too). */
function SortSelect({ sort, onSort }: { sort: SortKey; onSort: (sort: SortKey) => void }) {
  return (
    <label className="no-drag flex shrink-0 items-center gap-1 text-[12px] text-muted">
      <span>Sort:</span>
      <select
        value={sort}
        onChange={(e) => isSortKey(e.target.value) && onSort(e.target.value)}
        className="cursor-pointer rounded bg-transparent py-0.5 text-text outline-none hover:text-text focus-visible:ring-1 focus-visible:ring-muted"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** What the Rating chip says: "★★ or more", "★★★", "Thumbs down", "Not rated". */
function ratingFilterLabel(rating: FeedFilters['rating']): string | undefined {
  if (rating === undefined) return undefined
  return RATING_OPTIONS.find((o) => o.id === rating)?.label
}

/**
 * The asset filter: every character, environment, product, outfit and pose that some clip uses, with a search field.
 */
function AssetFilter({
  value,
  onChange,
  generations,
  assets,
  index
}: {
  value?: string
  onChange: (assetId: string | undefined) => void
  generations: readonly Generation[]
  assets: readonly Asset[]
  index: LibraryIndex
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // Counted only while the menu is open; it walks every generation's references.
  const counts = useMemo(() => (open ? assetUseCounts(generations, index) : new Map<string, number>()), [
    open,
    generations,
    index
  ])
  const selected = assets.find((a) => a.id === value)
  const needle = query.trim().toLocaleLowerCase('en')
  const options: MenuOption<string>[] = ASSET_KINDS.flatMap((kind) =>
    assets
      .filter((a) => a.kind === kind && (counts.get(a.id) ?? 0) > 0)
      .filter((a) => !needle || a.name.toLocaleLowerCase('en').includes(needle))
      .map((a) => ({
        id: a.id,
        text: `${a.name} (${ASSET_COPY[a.kind].singular})`,
        label: (
          <>
            <AssetAvatar asset={a} className={`h-5 w-5 rounded ring-1 ${KIND_TONE[a.kind].ring}`} />
            <span className="min-w-0 truncate">{a.name}</span>
          </>
        ),
        hint: counts.get(a.id)
      }))
  )

  return (
    <FilterMenu
      title="Asset"
      value={value}
      valueLabel={selected?.name}
      options={options}
      onChange={onChange}
      allLabel="All assets"
      width={280}
      onOpenChange={setOpen}
      header={
        <div className="border-b border-line p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                e.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
              }
            }}
            placeholder="Search characters, environments, products, outfits, poses…"
            aria-label="Search assets"
            className="w-full rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] outline-none focus:border-muted"
          />
        </div>
      }
      empty={
        <p className="px-3 py-2 text-[12px] leading-relaxed text-muted">
          {needle ? 'Nothing matches.' : 'No clips use the library yet.'}
        </p>
      }
    />
  )
}
