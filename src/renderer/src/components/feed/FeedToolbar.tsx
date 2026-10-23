import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { generationAssetIds } from '@shared/generation-filter'
import {
  ASSET_KINDS,
  THUMBS_DOWN,
  type Asset,
  type Generation,
  type GenerationSource,
  type VideoModel
} from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import AssetAvatar from '../assets/AssetAvatar'
import { KIND_TONE } from '../pickers/assetKinds'
import Segmented from '../ui/Segmented'
import { StatusDot } from '../work/StatusMark'
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
  narrows,
  periodStart,
  type FeedFilters,
  type FeedView,
  type PeriodChoice,
  type PlacementChoice,
  type RatingChoice,
  type SortKey,
  type StatusChoice
} from './feedFilter'
import { isPending } from './feedText'
import FilterMenu, { type MenuOption } from './FilterMenu'
import { GridIcon, ListIcon } from './icons'
import { assetUseCounts, type LibraryIndex } from './references'
import SearchField from './SearchField'

interface Props {
  view: FeedView
  onView: (view: FeedView) => void
  filters: FeedFilters
  onFilters: (filters: FeedFilters) => void
  sort: SortKey
  onSort: (sort: SortKey) => void
  /** "42 clips · $38.20 · 5 min 12 s" for what is shown. */
  summary: string
  /** Every generation (not just the shown ones), for the choices, their counts and which filters can narrow. */
  generations: readonly Generation[]
  models: readonly VideoModel[]
  assets: readonly Asset[]
  index: LibraryIndex
  searchRef: RefObject<HTMLInputElement | null>
  /** ArrowDown in the search field hands the keyboard to the list. */
  onSearchArrowDown: () => void
  /** Enter in the search field opens the first match. */
  onSearchEnter?: () => void
  /** Finished clips not looked at yet: the "New" chip. */
  unseenCount: number
  /** Left end of the first row (Media's tabs). */
  leading?: ReactNode
  /** Right end of the first row (e.g. the folder button). */
  trailing?: ReactNode
}

/** How many clips each choice of a filter leaves, by filter. */
interface ChoiceCounts {
  source: Map<GenerationSource, number>
  status: Map<StatusChoice, number>
  model: Map<string, number>
  rating: Map<RatingChoice, number>
  period: Map<PeriodChoice, number>
  placement: Map<PlacementChoice, number>
}

/**
 * Every filter's counts in one pass, by the shared filter's rules (src/shared/generation-filter.ts): 'pending' is
 * queued or processing, a minimum of stars leaves thumbs down out, a row without a source is Venice's.
 */
function countChoices(generations: readonly Generation[], now: number): ChoiceCounts {
  const counts: ChoiceCounts = {
    source: new Map(),
    status: new Map(),
    model: new Map(),
    rating: new Map(),
    period: new Map(),
    placement: new Map()
  }
  const add = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1)
  const starts = PERIOD_OPTIONS.map((o) => [o.id, periodStart(o.id, now)] as const)
  for (const g of generations) {
    add(counts.source, g.source ?? 'generated')
    add(counts.status, isPending(g) ? 'pending' : g.status === 'failed' ? 'failed' : 'completed')
    // Own clips and versions have no model ('') and aren't one.
    if (g.model) add(counts.model, g.model)
    const rating = g.rating
    if (typeof rating !== 'number') add(counts.rating, 'unrated')
    else if (rating === THUMBS_DOWN) add(counts.rating, 'thumbsDown')
    else for (const stars of [1, 2, 3] as const) if (rating >= stars) add(counts.rating, stars)
    if (g.reviewCount > 0) add(counts.rating, 'reviewed')
    for (const [period, start] of starts) if (g.createdAt >= start) add(counts.period, period)
    add(counts.placement, g.segmentId ? 'sequence' : 'standalone')
  }
  return counts
}

/**
 * The feed's header. First row: Media's tabs, the search, Cards | Table, and the actions at the right end. Second
 * row: the filters as chips – each one only while it is set or can narrow the list – then a summary of what is
 * shown and the order.
 */
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
  onSearchEnter,
  unseenCount,
  leading,
  trailing
}: Props) {
  const set = (patch: Partial<FeedFilters>) => onFilters({ ...filters, ...patch })

  // Counted over every clip, not just the shown ones, so a chip doesn't come and go while another filter changes.
  const counts = useMemo(() => countChoices(generations, Date.now()), [generations])
  // The models that made something, most used first; names from the model list when Venice still has it.
  const modelOptions = useMemo(
    (): MenuOption<string>[] =>
      [...counts.model.entries()]
        .sort((a, b) => b[1] - a[1] || modelName(a[0], models).localeCompare(modelName(b[0], models), 'en'))
        .map(([id, count]) => ({ id, label: modelName(id, models), text: id, hint: count })),
    [counts, models]
  )
  // Whether any clip uses something from the library: stops at the first one; the asset counts wait for the menu.
  const usesAssets = useMemo(
    () => generations.some((g) => generationAssetIds(g, index.paths).length > 0),
    [generations, index]
  )
  const total = generations.length
  const shows = (value: unknown, choices: ReadonlyMap<unknown, number>) => value !== undefined || narrows(choices, total)

  return (
    <div className="shrink-0 border-b border-line/60 px-6 pb-2.5">
      <div className="drag flex h-12 items-center gap-3">
        {leading}
        <SearchField
          value={filters.query}
          onChange={(query) => set({ query })}
          placeholder="Search prompts and names…"
          inputRef={searchRef}
          onArrowDown={onSearchArrowDown}
          onEnter={onSearchEnter}
        />
        <ViewSwitch view={view} onView={onView} />
        <span className="flex-1" />
        {trailing}
      </div>

      {/* As tall as a chip when no filter can narrow the list, so the header keeps its height. */}
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        {shows(filters.source, counts.source) && (
          <FilterMenu
            title="Source"
            value={filters.source}
            valueLabel={SOURCE_OPTIONS.find((o) => o.id === filters.source)?.label}
            options={SOURCE_OPTIONS.map((o) => ({
              id: o.id,
              label: o.label,
              text: o.text,
              hint: counts.source.get(o.id)
            }))}
            onChange={(source) => set({ source })}
            allLabel="All"
          />
        )}
        {shows(filters.status, counts.status) && (
          <FilterMenu
            title="Status"
            value={filters.status}
            valueLabel={STATUS_OPTIONS.find((o) => o.id === filters.status)?.label}
            options={STATUS_OPTIONS.map((o) => ({ id: o.id, label: o.label, hint: counts.status.get(o.id) }))}
            onChange={(status) => set({ status })}
          />
        )}
        {shows(filters.model, counts.model) && (
          <FilterMenu
            title="Model"
            value={filters.model}
            valueLabel={filters.model && modelName(filters.model, models)}
            options={modelOptions}
            onChange={(model) => set({ model })}
            allLabel="All models"
            width={300}
            empty={<p className="px-3 py-2 text-[12px] text-muted">No clips made with a Venice model yet.</p>}
          />
        )}
        {(filters.assetId !== undefined || usesAssets) && (
          <AssetFilter
            value={filters.assetId}
            onChange={(assetId) => set({ assetId })}
            generations={generations}
            assets={assets}
            index={index}
          />
        )}
        {shows(filters.rating, counts.rating) && (
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
        )}
        {shows(filters.period, counts.period) && (
          <FilterMenu
            title="Time"
            value={filters.period}
            valueLabel={PERIOD_OPTIONS.find((o) => o.id === filters.period)?.label}
            options={PERIOD_OPTIONS.map((o) => ({ id: o.id, label: o.label }))}
            onChange={(period) => set({ period })}
            allLabel="All time"
          />
        )}
        {shows(filters.placement, counts.placement) && (
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
            allLabel="All"
          />
        )}
        {/* After the filters: it comes and goes as clips finish and are watched, and must not move them. */}
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

/**
 * Cards or Table: one Tab stop, ← → choose. The same switch wherever clips (or edits) can be shown both ways; the
 * tooltips say what each shows there.
 */
export function ViewSwitch({
  view,
  onView,
  cardsTitle = 'Large cards with video',
  tableTitle = 'Table – many clips at once'
}: {
  view: FeedView
  onView: (view: FeedView) => void
  cardsTitle?: string
  tableTitle?: string
}) {
  return (
    <Segmented
      ariaLabel="View"
      value={view}
      onChange={onView}
      className="no-drag"
      options={[
        {
          value: 'cards',
          label: (
            <>
              <GridIcon size={12} />
              Cards
            </>
          ),
          title: cardsTitle
        },
        {
          value: 'table',
          label: (
            <>
              <ListIcon size={12} />
              Table
            </>
          ),
          title: tableTitle
        }
      ]}
    />
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
  /** "All clips in Media". */
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

/** "All clips in Media →": from Generate's session list to every clip. */
function MediaLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show every clip you have made, also from earlier sessions"
      className="no-drag shrink-0 whitespace-nowrap text-[12px] text-text underline-offset-2 hover:underline"
    >
      All clips in Media →
    </button>
  )
}

/** A one-click filter ("New"), styled like the filter menus' chips. */
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
