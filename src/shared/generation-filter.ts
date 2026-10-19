// Which generations the clip feed shows, and in what order: the search, filters and sorts of the feed's toolbar.
// The renderer and the agents' list_generations tool both use these, so a filter means the same thing to the
// user and to an agent. Pure (no Node or DOM), like everything in src/shared.

import { durationSeconds, referenceVideosOf } from './models'
import { THUMBS_DOWN, type Generation, type GenerationFilter } from './types'

export type GenerationSort = NonNullable<GenerationFilter['sort']>

/**
 * What filterGenerations and queryGenerations take: a GenerationFilter, plus `thumbsDown` – true keeps only the clips
 * the user gave thumbs down (the feed's Rating filter "Thumbs down", list_generations' thumbs_down).
 */
export type GenerationQuery = GenerationFilter & { thumbsDown?: boolean }

export const GENERATION_SORTS: readonly GenerationSort[] = ['newest', 'oldest', 'rating', 'cost', 'length']

/**
 * What filtering and sorting read of a generation (a Generation has all of it). `source` and `title` may be left
 * out: a row without a source is a Venice generation. `unseen` is not part of a Generation: the caller fills it from
 * the status summary (finished and not looked at yet) when it wants the "New" filter to work.
 */
export type FilterableGeneration = Pick<
  Generation,
  'id' | 'createdAt' | 'model' | 'prompt' | 'params' | 'status' | 'segmentId' | 'quote' | 'videoDuration' | 'rating'
> &
  Partial<Pick<Generation, 'source' | 'title'>> & { reviewCount?: number; unseen?: boolean }

// ── Assets used by a generation ──────────────────────────────────────────────

/** An asset as far as the index needs it: its photos and audio clips (an Asset has both). */
export interface IndexableAsset {
  id: string
  images: readonly { path: string }[]
  audio?: readonly { path: string }[]
}

/**
 * Which asset each library file belongs to: pathKey(path) → asset id, for the photos and audio clips of every
 * asset. Build it with indexAssetPaths; filterGenerations also takes the asset list itself.
 */
export type AssetPathIndex = ReadonlyMap<string, string>

/** How paths are compared: the way macOS volumes compare names (letter case and Unicode form ignored). */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/** The index for a list of assets (build it once per asset list, e.g. in a useMemo, when filtering often). */
export function indexAssetPaths(assets: readonly IndexableAsset[]): AssetPathIndex {
  const index = new Map<string, string>()
  for (const asset of assets) {
    for (const file of [...(asset.images ?? []), ...(asset.audio ?? [])]) {
      if (typeof file?.path === 'string' && file.path) index.set(pathKey(file.path), asset.id)
    }
  }
  return index
}

function isAssetList(assets: AssetPathIndex | readonly IndexableAsset[]): assets is readonly IndexableAsset[] {
  return Array.isArray(assets)
}

function toIndex(assets: AssetPathIndex | readonly IndexableAsset[] | undefined): AssetPathIndex | undefined {
  if (!assets) return undefined
  return isAssetList(assets) ? indexAssetPaths(assets) : assets
}

/**
 * Every file a generation's params use, in order: start image, end image, reference images, reference audio, the
 * source video and reference videos (video-to-video models). Params come from the database and older versions, so
 * anything malformed is skipped.
 */
export function generationFilePaths(g: Pick<Generation, 'params'>): string[] {
  const p = g.params
  if (!p || typeof p !== 'object') return []
  const images = Array.isArray(p.referenceImages) ? p.referenceImages : []
  const audio = Array.isArray(p.referenceAudios) ? p.referenceAudios.map((a) => a?.path) : []
  const videos = referenceVideosOf(p).map((v) => v.path)
  return [p.startImage, p.endImage, ...images, ...audio, p.sourceVideo, ...videos].filter(
    (v): v is string => typeof v === 'string' && v !== ''
  )
}

function assetOf(path: string, index: AssetPathIndex): string | undefined {
  // Keys are pathKey()s; an index built by hand with plain paths still works for paths spelt the same way.
  return index.get(pathKey(path)) ?? index.get(path)
}

/** The assets whose photos or audio a generation uses, in order of first use, each once. */
export function generationAssetIds(
  g: Pick<Generation, 'params'>,
  assets: AssetPathIndex | readonly IndexableAsset[]
): string[] {
  const index = toIndex(assets)
  if (!index) return []
  const ids: string[] = []
  for (const path of generationFilePaths(g)) {
    const id = assetOf(path, index)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function usesAsset(g: FilterableGeneration, assetId: string, index: AssetPathIndex | undefined): boolean {
  return !!index && generationFilePaths(g).some((path) => assetOf(path, index) === assetId)
}

// ── Filtering ────────────────────────────────────────────────────────────────

const fold = (s: string): string => s.normalize('NFC').toLowerCase()

/** The words of a search, folded; empty when there is nothing to search for. */
function searchWords(query: unknown): string[] {
  return typeof query === 'string' ? fold(query).split(/\s+/).filter(Boolean) : []
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The generations that pass every filter set in `filter`, in the order given (sort with sortGenerations, or use
 * queryGenerations for both). Filters left out don't filter:
 * - query: every word appears in the prompt, the negative prompt or the title (an own clip's file name, a
 *   version's "<edit> v3"); letter case ignored.
 * - status: that status; 'pending' is queued or processing.
 * - model: that model id.
 * - assetId: the params use one of that asset's photos or audio clips (needs `assets`: the asset list or
 *   indexAssetPaths of it; without it nothing matches).
 * - minRating: the user gave at least that many stars (1–3). Thumbs down counts below one star, so it never passes:
 *   a minimum of 1 means "at least one star". unrated: true for the ones the user hasn't graded. thumbsDown: true
 *   for the ones the user gave tumme ner.
 * - since: created at or after that time (epoch ms).
 * - placement: 'standalone' (not a take) or 'sequence' (a take of a sequence clip or a storyboard transition).
 * - hasReviews: true for the ones with a review (the user's or an agent's), false for the ones without.
 * - source ("Source"): 'generated' (made by Venice, also AI takes made in the Editor), 'import' (the user's own
 *   clips) or 'edit' (versions made in the Editor). A row without a source counts as 'generated'.
 * - unseen ("New"): true keeps only the rows marked `unseen: true` (finished, and the user hasn't looked at them).
 */
export function filterGenerations<T extends FilterableGeneration>(
  list: readonly T[],
  filter: GenerationQuery | undefined,
  assets?: AssetPathIndex | readonly IndexableAsset[]
): T[] {
  const f: GenerationQuery = filter && typeof filter === 'object' ? filter : {}
  const words = searchWords(f.query)
  const index = f.assetId ? toIndex(assets) : undefined
  const minRating = finite(f.minRating) && f.minRating > 0 ? f.minRating : undefined
  const since = finite(f.since) ? f.since : undefined
  const source = f.source === 'generated' || f.source === 'import' || f.source === 'edit' ? f.source : undefined

  return list.filter((g) => {
    if (source && (g.source ?? 'generated') !== source) return false
    if (f.status) {
      const pending = g.status === 'queued' || g.status === 'processing'
      if (f.status === 'pending' ? !pending : g.status !== f.status) return false
    }
    if (f.model && g.model !== f.model) return false
    // Thumbs down is -1, below every star, so a minimum of stars leaves it out.
    if (minRating !== undefined && !(finite(g.rating) && g.rating >= minRating)) return false
    if (f.unrated === true && finite(g.rating)) return false
    if (f.thumbsDown === true && g.rating !== THUMBS_DOWN) return false
    if (since !== undefined && !(g.createdAt >= since)) return false
    if (f.placement === 'standalone' && g.segmentId) return false
    if (f.placement === 'sequence' && !g.segmentId) return false
    if (typeof f.hasReviews === 'boolean' && ((g.reviewCount ?? 0) > 0) !== f.hasReviews) return false
    if (f.unseen === true && g.unseen !== true) return false
    if (words.length) {
      const text = fold(`${g.prompt ?? g.params?.prompt ?? ''}\n${g.params?.negativePrompt ?? ''}\n${g.title ?? ''}`)
      if (!words.every((w) => text.includes(w))) return false
    }
    if (f.assetId && !usesAsset(g, f.assetId, index)) return false
    return true
  })
}

// ── Sorting ──────────────────────────────────────────────────────────────────

/** Seconds of video: the real length when ffprobe measured it, else the length asked for; undefined if neither. */
export function generationSeconds(g: Pick<Generation, 'videoDuration' | 'params'>): number | undefined {
  if (finite(g.videoDuration) && g.videoDuration > 0) return g.videoDuration
  const asked = typeof g.params?.duration === 'string' ? durationSeconds(g.params.duration) : 0
  return asked > 0 ? asked : undefined
}

type Compare<T> = (a: T, b: T) => number

const newestFirst: Compare<FilterableGeneration> = (a, b) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Larger values first, missing ones last; ties newest first. */
function byValue(value: (g: FilterableGeneration) => number | undefined): Compare<FilterableGeneration> {
  return (a, b) => {
    const va = value(a)
    const vb = value(b)
    const ha = finite(va)
    const hb = finite(vb)
    if (ha && hb && va !== vb) return vb - va
    if (ha !== hb) return ha ? -1 : 1
    return newestFirst(a, b)
  }
}

const COMPARE: Record<GenerationSort, Compare<FilterableGeneration>> = {
  newest: newestFirst,
  oldest: (a, b) => -newestFirst(a, b),
  rating: byValue((g) => g.rating),
  cost: byValue((g) => g.quote),
  length: byValue(generationSeconds)
}

/**
 * A sorted copy: newest (default) or oldest first, or by the user's rating, the price or the length, largest first
 * with the ones lacking a value last (by rating: three stars, two, one, tumme ner, then the ungraded clips). Ties are
 * newest first, so the order is stable from one call to the next.
 */
export function sortGenerations<T extends FilterableGeneration>(list: readonly T[], sort?: GenerationSort): T[] {
  const compare = (sort && COMPARE[sort]) || COMPARE.newest
  return [...list].sort(compare)
}

/** filterGenerations, then sortGenerations by filter.sort. */
export function queryGenerations<T extends FilterableGeneration>(
  list: readonly T[],
  filter: GenerationQuery | undefined,
  assets?: AssetPathIndex | readonly IndexableAsset[]
): T[] {
  return sortGenerations(filterGenerations(list, filter, assets), filter?.sort)
}

// ── Totals ───────────────────────────────────────────────────────────────────

export interface GenerationTotals {
  count: number
  /** USD over the generations that are done or on their way (Venice doesn't charge failed ones). */
  costUsd: number
  /** Seconds of finished video. */
  seconds: number
}

/** The feed's summary line in numbers ("42 clips · $38.20 · 5 min 12 s"). */
export function summarizeGenerations(list: readonly FilterableGeneration[]): GenerationTotals {
  let costUsd = 0
  let seconds = 0
  for (const g of list) {
    if (g.status !== 'failed' && finite(g.quote)) costUsd += g.quote
    if (g.status === 'completed') seconds += generationSeconds(g) ?? 0
  }
  return { count: list.length, costUsd, seconds }
}
