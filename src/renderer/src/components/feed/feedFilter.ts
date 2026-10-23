// The clip feed's filters as the toolbar shows them, and how they translate into the shared GenerationFilter
// (src/shared/generation-filter.ts), which the agents' list_generations tool applies the same way.

import type { GenerationQuery } from '@shared/generation-filter'
import type { Asset, GenerationFilter, GenerationSource, VideoModel } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'

export type FeedView = 'cards' | 'table'
export type SortKey = NonNullable<GenerationFilter['sort']>
export type StatusChoice = 'completed' | 'pending' | 'failed'
/** A number is "at least that many stars" (thumbs down never counts); 'thumbsDown' is the clips given thumbs down. */
export type RatingChoice = 1 | 2 | 3 | 'thumbsDown' | 'unrated' | 'reviewed'
export type PeriodChoice = 'today' | '7d' | '30d'
export type PlacementChoice = NonNullable<GenerationFilter['placement']>

export interface FeedFilters {
  query: string
  /** "Source": Venice's clips, the user's own clips, or versions from the Editor. */
  source?: GenerationSource
  status?: StatusChoice
  model?: string
  assetId?: string
  rating?: RatingChoice
  period?: PeriodChoice
  placement?: PlacementChoice
  /** "New": finished and not looked at yet (Activity's seen state). */
  unseen?: boolean
}

export const NO_FILTERS: FeedFilters = { query: '' }

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'rating', label: 'Rating' },
  { id: 'cost', label: 'Cost' },
  { id: 'length', label: 'Duration' }
]

export const STATUS_OPTIONS: { id: StatusChoice; label: string }[] = [
  { id: 'completed', label: 'Done' },
  { id: 'pending', label: 'In progress' },
  { id: 'failed', label: 'Failed' }
]

export const RATING_OPTIONS: { id: RatingChoice; label: string }[] = [
  { id: 3, label: '★★★' },
  { id: 2, label: '★★ or more' },
  { id: 1, label: '★ or more' },
  { id: 'thumbsDown', label: 'Thumbs down' },
  { id: 'unrated', label: 'Not rated' },
  { id: 'reviewed', label: 'Has reviews' }
]

export const PERIOD_OPTIONS: { id: PeriodChoice; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' }
]

export const SOURCE_OPTIONS: { id: GenerationSource; label: string; text: string }[] = [
  { id: 'generated', label: 'Generated', text: 'Clips Venice has made' },
  { id: 'import', label: 'Own clips', text: 'Your own films, imported into the library' },
  { id: 'edit', label: 'Edited', text: 'Versions made in the Editor' }
]

export const PLACEMENT_OPTIONS: { id: PlacementChoice; label: string }[] = [
  { id: 'standalone', label: 'Standalone' },
  { id: 'sequence', label: 'Takes' }
]

const DAY = 24 * 60 * 60 * 1000

/** Epoch ms where the period starts: today from midnight, otherwise counted back from now. */
export function periodStart(period: PeriodChoice, now: number): number {
  if (period === 'today') {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return now - (period === '7d' ? 7 : 30) * DAY
}

export function toGenerationFilter(f: FeedFilters, sort: SortKey, now: number): GenerationQuery {
  const filter: GenerationQuery = { sort }
  const query = f.query.trim()
  if (query) filter.query = query
  if (f.source) filter.source = f.source
  if (f.status) filter.status = f.status
  if (f.model) filter.model = f.model
  if (f.assetId) filter.assetId = f.assetId
  if (typeof f.rating === 'number') filter.minRating = f.rating
  else if (f.rating === 'thumbsDown') filter.thumbsDown = true
  else if (f.rating === 'unrated') filter.unrated = true
  else if (f.rating === 'reviewed') filter.hasReviews = true
  if (f.period) filter.since = periodStart(f.period, now)
  if (f.placement) filter.placement = f.placement
  if (f.unseen) filter.unseen = true
  return filter
}

/**
 * Whether a filter can narrow the list: one of its choices matches some of the `total` items but not all of them.
 * Media shows a filter only while it can (or while it is set), so a small library isn't faced with seven chips that
 * have nothing to choose between. `counts` is how many items each choice matches.
 */
export function narrows(counts: ReadonlyMap<unknown, number>, total: number): boolean {
  for (const n of counts.values()) if (n > 0 && n < total) return true
  return false
}

export function hasFilters(f: FeedFilters): boolean {
  return !!(
    f.query.trim() ||
    f.source ||
    f.status ||
    f.model ||
    f.assetId ||
    f.rating ||
    f.period ||
    f.placement ||
    f.unseen
  )
}

/** Filters that point at something that no longer exists (a deleted asset) count as not set. */
export function effectiveFilters(f: FeedFilters, assets: readonly Asset[], assetsLoaded: boolean): FeedFilters {
  if (f.assetId && assetsLoaded && !assets.some((a) => a.id === f.assetId)) return { ...f, assetId: undefined }
  return f
}

export interface FilterChip {
  key: keyof FeedFilters
  label: string
}

export function modelName(id: string, models: readonly VideoModel[]): string {
  return models.find((m) => m.id === id)?.name ?? id
}

/** The active filters, in toolbar order, as removable chips. */
export function filterChips(f: FeedFilters, models: readonly VideoModel[], assets: readonly Asset[]): FilterChip[] {
  const chips: FilterChip[] = []
  const query = f.query.trim()
  if (query) chips.push({ key: 'query', label: `“${query}”` })
  if (f.source) chips.push({ key: 'source', label: SOURCE_OPTIONS.find((o) => o.id === f.source)?.label ?? f.source })
  if (f.status) chips.push({ key: 'status', label: STATUS_OPTIONS.find((o) => o.id === f.status)?.label ?? f.status })
  if (f.model) chips.push({ key: 'model', label: modelName(f.model, models) })
  if (f.assetId) {
    const asset = assets.find((a) => a.id === f.assetId)
    chips.push({
      key: 'assetId',
      label: asset ? `${capitalize(ASSET_COPY[asset.kind].singular)}: ${asset.name}` : 'Asset'
    })
  }
  if (f.rating) {
    const option = RATING_OPTIONS.find((o) => o.id === f.rating)
    chips.push({ key: 'rating', label: typeof f.rating === 'number' ? `Rating ${option?.label}` : (option?.label ?? '') })
  }
  if (f.period) chips.push({ key: 'period', label: PERIOD_OPTIONS.find((o) => o.id === f.period)?.label ?? '' })
  if (f.placement) {
    chips.push({ key: 'placement', label: PLACEMENT_OPTIONS.find((o) => o.id === f.placement)?.label ?? '' })
  }
  if (f.unseen) chips.push({ key: 'unseen', label: 'New' })
  return chips
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('en') + text.slice(1)
}

export function withoutFilter(f: FeedFilters, key: keyof FeedFilters): FeedFilters {
  return key === 'query' ? { ...f, query: '' } : { ...f, [key]: undefined }
}

// ── Remembered choices ───────────────────────────────────────────────────────

/** Cards or Table, remembered apart for Media's Clips ('library') and Generate's session list. */
const VIEW_KEYS = { library: 'feed:view', session: 'feed:view:session' } as const
const SORT_KEY = 'feed:sort'

/** Which list a ClipFeed is: every clip (Media) or what was made in Generate this session. */
export type FeedMode = keyof typeof VIEW_KEYS

export function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.id === value)
}

export function loadView(mode: FeedMode = 'library'): FeedView {
  try {
    return localStorage.getItem(VIEW_KEYS[mode]) === 'table' ? 'table' : 'cards'
  } catch {
    return 'cards'
  }
}

export function saveView(view: FeedView, mode: FeedMode = 'library'): void {
  try {
    localStorage.setItem(VIEW_KEYS[mode], view)
  } catch {
    // Remembering the view is only a convenience.
  }
}

export function loadSort(): SortKey {
  try {
    const stored = localStorage.getItem(SORT_KEY)
    return isSortKey(stored) ? stored : 'newest'
  } catch {
    return 'newest'
  }
}

export function saveSort(sort: SortKey): void {
  try {
    localStorage.setItem(SORT_KEY, sort)
  } catch {
    // Remembering the order is only a convenience.
  }
}

/**
 * The filters outlive the view (switching to Prompts and back keeps them) but not a restart: a filter that
 * silently hid clips the next morning would look like lost work.
 */
let sessionFilters: FeedFilters = NO_FILTERS

export function loadSessionFilters(): FeedFilters {
  return sessionFilters
}

export function saveSessionFilters(f: FeedFilters): void {
  sessionFilters = f
}
