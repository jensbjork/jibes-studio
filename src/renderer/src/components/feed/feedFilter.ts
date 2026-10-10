// The clip feed's filters as the toolbar shows them, and how they translate into the shared GenerationFilter
// (src/shared/generation-filter.ts), which the agents' list_generations tool applies the same way.

import type { GenerationQuery } from '@shared/generation-filter'
import type { Asset, GenerationFilter, GenerationSource, VideoModel } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'

export type FeedView = 'cards' | 'table'
export type SortKey = NonNullable<GenerationFilter['sort']>
export type StatusChoice = 'completed' | 'pending' | 'failed'
/** A number is "at least that many stars" (tumme ner never counts); 'thumbsDown' is the clips given tumme ner. */
export type RatingChoice = 1 | 2 | 3 | 'thumbsDown' | 'unrated' | 'reviewed'
export type PeriodChoice = 'today' | '7d' | '30d'
export type PlacementChoice = NonNullable<GenerationFilter['placement']>

export interface FeedFilters {
  query: string
  /** "Källa": Venice's clips, the user's own clips, or versions from Redigera. */
  source?: GenerationSource
  status?: StatusChoice
  model?: string
  assetId?: string
  rating?: RatingChoice
  period?: PeriodChoice
  placement?: PlacementChoice
  /** "Nya": finished and not looked at yet (Pågår och klart's seen state). */
  unseen?: boolean
}

export const NO_FILTERS: FeedFilters = { query: '' }

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'newest', label: 'Nyast' },
  { id: 'oldest', label: 'Äldst' },
  { id: 'rating', label: 'Betyg' },
  { id: 'cost', label: 'Kostnad' },
  { id: 'length', label: 'Längd' }
]

export const STATUS_OPTIONS: { id: StatusChoice; label: string }[] = [
  { id: 'completed', label: 'Klara' },
  { id: 'pending', label: 'Pågår' },
  { id: 'failed', label: 'Misslyckade' }
]

export const RATING_OPTIONS: { id: RatingChoice; label: string }[] = [
  { id: 3, label: '★★★' },
  { id: 2, label: '★★ eller mer' },
  { id: 1, label: '★ eller mer' },
  { id: 'thumbsDown', label: 'Tumme ner' },
  { id: 'unrated', label: 'Ej betygsatt' },
  { id: 'reviewed', label: 'Har granskningar' }
]

export const PERIOD_OPTIONS: { id: PeriodChoice; label: string }[] = [
  { id: 'today', label: 'Idag' },
  { id: '7d', label: 'Senaste 7 dagarna' },
  { id: '30d', label: 'Senaste 30 dagarna' }
]

export const SOURCE_OPTIONS: { id: GenerationSource; label: string; text: string }[] = [
  { id: 'generated', label: 'Genererade', text: 'Klipp som Venice har gjort' },
  { id: 'import', label: 'Egna klipp', text: 'Dina egna filmer, importerade till biblioteket' },
  { id: 'edit', label: 'Redigerade', text: 'Versioner gjorda i Redigera' }
]

export const PLACEMENT_OPTIONS: { id: PlacementChoice; label: string }[] = [
  { id: 'standalone', label: 'Fristående' },
  { id: 'sequence', label: 'Tagningar' }
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
  if (query) chips.push({ key: 'query', label: `”${query}”` })
  if (f.source) chips.push({ key: 'source', label: SOURCE_OPTIONS.find((o) => o.id === f.source)?.label ?? f.source })
  if (f.status) chips.push({ key: 'status', label: STATUS_OPTIONS.find((o) => o.id === f.status)?.label ?? f.status })
  if (f.model) chips.push({ key: 'model', label: modelName(f.model, models) })
  if (f.assetId) {
    const asset = assets.find((a) => a.id === f.assetId)
    chips.push({
      key: 'assetId',
      label: asset ? `${capitalize(ASSET_COPY[asset.kind].singular)}: ${asset.name}` : 'Tillgång'
    })
  }
  if (f.rating) {
    const option = RATING_OPTIONS.find((o) => o.id === f.rating)
    chips.push({ key: 'rating', label: typeof f.rating === 'number' ? `Betyg ${option?.label}` : (option?.label ?? '') })
  }
  if (f.period) chips.push({ key: 'period', label: PERIOD_OPTIONS.find((o) => o.id === f.period)?.label ?? '' })
  if (f.placement) {
    chips.push({ key: 'placement', label: PLACEMENT_OPTIONS.find((o) => o.id === f.placement)?.label ?? '' })
  }
  if (f.unseen) chips.push({ key: 'unseen', label: 'Nya' })
  return chips
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('sv') + text.slice(1)
}

export function withoutFilter(f: FeedFilters, key: keyof FeedFilters): FeedFilters {
  return key === 'query' ? { ...f, query: '' } : { ...f, [key]: undefined }
}

// ── Remembered choices ───────────────────────────────────────────────────────

const VIEW_KEY = 'feed:view'
const SORT_KEY = 'feed:sort'

export function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.id === value)
}

export function loadView(): FeedView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'
  } catch {
    return 'cards'
  }
}

export function saveView(view: FeedView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
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
 * The filters outlive the view (switching to Prompter and back keeps them) but not a restart: a filter that
 * silently hid clips the next morning would look like lost work.
 */
let sessionFilters: FeedFilters = NO_FILTERS

export function loadSessionFilters(): FeedFilters {
  return sessionFilters
}

export function saveSessionFilters(f: FeedFilters): void {
  sessionFilters = f
}
