import { formatPrice as formatUsdPrice, formatSecondsSv, formatTimecode } from '@shared/edit-plan'
import type {
  EditJob,
  EditSummary,
  EditOperation,
  EditOrigin,
  EditPlan,
  EditRange,
  EditTimeline,
  EditVersion,
  TranscriptSegment
} from '@shared/types'
import { PATH_SEPARATOR, TRASH } from '../../lib/platform'

// Pure helpers for the Editor: how times, prices and versions are written, the version tree, snapping a
// marked range on the timeline, and what a plan needs before its button may send anything. No DOM, no IPC.

// ── Times and sizes ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "0:41.0", "1:04:05.3": the player's and the timeline's times, to a tenth of a second (as plans write them). */
export const formatClock = formatTimecode

/**
 * What deleting an edit does, in one line under its question: the ✕ in the side list and Delete… in the edit's ⋯
 * menu ask the same.
 */
export const DELETE_EDIT_TEXT = `The film you started from, the AI takes and versions used elsewhere are kept; the rest goes to ${TRASH}.`

/** "1:04" (whole seconds), for lengths in lists and cards. */
export function formatLength(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '–'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`
}

/** "4.0 s", "12.5 s". */
export const formatSecondsShort = formatSecondsSv

/** "$0.51", "$0.035": dollars as everywhere else in Studio (Generate, Sequences, the agents' approvals). */
export const formatPrice = formatUsdPrice

/** What a price nobody can give in advance is called, after a "·" on a button or in a list ("Unknown price" alone). */
export const UNKNOWN_PRICE = 'unknown price'

/** "$0.51", "≈ $0.70" (an estimate), "≈ $0.45 +" (a part has no price), "unknown price". */
export function priceText(priceUsd: number | undefined, o: { partial?: boolean; approximate?: boolean } = {}): string {
  if (priceUsd === undefined) return UNKNOWN_PRICE
  const usd = formatPrice(priceUsd)
  if (o.partial) return `≈ ${usd} +`
  return o.approximate ? `≈ ${usd}` : usd
}

/** "0:41.0–0:45.0 (4.0 s)". */
export function formatRange(range: EditRange): string {
  return `${formatClock(range.start)}–${formatClock(range.end)} (${formatSecondsShort(range.end - range.start)})`
}

/** "1.2 GB", "340 MB": binary units, as the import dialog counts them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('en-GB', { maximumFractionDigits: 1 })} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto', style: 'short' })
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** "2 min ago", "3 hr ago", "yesterday", "7 Oct". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.round((at - now) / 1000)
  if (Math.abs(seconds) < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 7) return relative.format(days, 'day')
  return dateFormat.format(at)
}

// ── Where an edit came from ─────────────────────────────────────────────────

/** The source badge: "Clip from Media", "Take of clip 3 in “X”", "Export of “X”", "Own film". */
export function originLabel(origin: EditOrigin): string {
  switch (origin.kind) {
    case 'take':
      return origin.clipNumber && origin.sequenceName
        ? `Take of clip ${origin.clipNumber} in “${origin.sequenceName}”`
        : origin.sequenceName
          ? `Take in “${origin.sequenceName}”`
          : 'Take of a clip'
    case 'export':
      return origin.sequenceName ? `Export of “${origin.sequenceName}”` : 'Exported film'
    case 'import':
      return 'Own film'
    default:
      return 'Clip from Media'
  }
}

/** The edits made from this clip or export (its v1), for "Open the edit" / "New edit". */
export function editsFrom(
  edits: readonly EditSummary[],
  source: { generationId: string } | { exportId: string }
): EditSummary[] {
  return 'exportId' in source
    ? edits.filter((e) => e.origin.exportId === source.exportId)
    : edits.filter((e) => e.origin.generationId === source.generationId)
}

/**
 * The edits a clip belongs to without being their original: one of these may have it as a version (its AI takes
 * are listed too, so the caller checks the versions).
 */
export function editsContaining(edits: readonly EditSummary[], generationId: string): EditSummary[] {
  return edits.filter((e) => e.origin.generationId !== generationId && e.generationIds.includes(generationId))
}

/** "4 versions · 1:04 · $2.13", "Original · 0:31". */
export function summaryLine(e: Pick<EditSummary, 'versionCount' | 'duration' | 'totalCostUsd'>): string {
  const parts = [e.versionCount > 1 ? `${e.versionCount} versions` : 'Original']
  if (e.duration !== undefined) parts.push(formatLength(e.duration))
  if (e.totalCostUsd > 0) parts.push(formatPrice(e.totalCostUsd))
  return parts.join(' · ')
}

// ── Versions ─────────────────────────────────────────────────────────────────

export interface TreeRow {
  version: EditVersion
  /** 0 for v1 (and versions whose parent is gone), 1 for its children … */
  depth: number
}

/**
 * The versions as a tree, depth first: each version followed by its children, oldest child first. A version whose
 * parent isn't among them (deleted outside Studio) is shown at the top level, so none is ever hidden.
 */
export function versionTree(versions: readonly EditVersion[]): TreeRow[] {
  const ids = new Set(versions.map((v) => v.id))
  const byParent = new Map<string | undefined, EditVersion[]>()
  for (const v of versions) {
    const parent = v.parentId && ids.has(v.parentId) && v.parentId !== v.id ? v.parentId : undefined
    const list = byParent.get(parent) ?? []
    list.push(v)
    byParent.set(parent, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt)
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const walk = (parent: string | undefined, depth: number) => {
    for (const v of byParent.get(parent) ?? []) {
      if (seen.has(v.id)) continue
      seen.add(v.id)
      rows.push({ version: v, depth })
      walk(v.id, depth + 1)
    }
  }
  walk(undefined, 0)
  // A cycle (never written by main, but cheap to survive) would leave versions unreached.
  for (const v of versions) if (!seen.has(v.id)) rows.push({ version: v, depth: 0 })
  return rows
}

/** ⌘⇧Z "Redo": the newest child of the version (highest number), if it has one. */
export function newestChild(versions: readonly EditVersion[], id: string): EditVersion | undefined {
  return versions.filter((v) => v.parentId === id).sort((a, b) => b.number - a.number)[0]
}

/** The number the next version will get ("v5"), as main gives it: one more than the highest. */
export function nextVersionNumber(versions: readonly EditVersion[]): number {
  return versions.reduce((n, v) => Math.max(n, v.number), 0) + 1
}

/** "v4 Music: calm piano", "v1 Original". */
export function versionName(v: Pick<EditVersion, 'number' | 'label'>): string {
  return `v${v.number} ${v.label || (v.number === 1 ? 'Original' : '')}`.trim()
}

/**
 * Why a version can't be deleted, or undefined. Main refuses the same; saying it up front keeps a
 * click from turning into an error.
 */
export function deleteVersionBlocked(v: EditVersion): string | undefined {
  if (v.number === 1 || v.op === 'original' || v.op === 'import') return 'The original can’t be deleted.'
  const use = v.usedBy[0]
  if (use) return `The version is used in “${use.sequenceName}” (clip ${use.clipNumber}).`
  return undefined
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * Operations whose job is one AI take put into the film: their "Continue" puts the paid take in again (free), and the
 * take stays among the edit's takes whatever happens to the job.
 */
export const PICTURE_JOB_OPS: ReadonlySet<string> = new Set<string>(['regenerate', 'prompt-edit', 'extend', 'upscale'])

/**
 * The jobs worth showing at the top of Versions: running ones, failed audio jobs that can go on (their sent parts
 * are paid for and live only in the job), and other failed or cancelled ones until the user hides them – a picture job
 * too, even one that could be finished again, since its paid take stays either way. Finished jobs show as their
 * version.
 */
export function visibleJobs(jobs: readonly EditJob[], dismissed: ReadonlySet<string>): EditJob[] {
  return jobs.filter((j) => {
    if (j.status === 'running') return true
    if (j.status === 'completed') return false
    if (j.status === 'failed' && j.canResume && !PICTURE_JOB_OPS.has(j.op)) return true
    return !dismissed.has(j.id)
  })
}

/** "part 2 of 3", from the job's own words when it has them. */
export function jobProgressText(job: EditJob): string | undefined {
  if (job.currentStep) return job.currentStep
  if (job.stepsTotal > 1) return `part ${Math.min(job.stepsDone + 1, job.stepsTotal)} of ${job.stepsTotal}`
  return undefined
}

// ── Prices: what a click may send ────────────────────────────────────────────

/** D5: above this, a click asks once more ("This costs $7.20. Continue?"). */
export const CONFIRM_ABOVE_USD = 5

export interface PriceCheck {
  /** Nothing of it can be priced in advance. */
  unknown: boolean
  /** A part Venice doesn't price is left out (a voice clone). */
  partial: boolean
  /** Over CONFIRM_ABOVE_USD. */
  expensive: boolean
}

/** What the run button must ask before a paid plan is sent. Free plans ask nothing. */
export function priceCheck(plan: Pick<EditPlan, 'paid' | 'priceUsd' | 'partialPrice'>): PriceCheck {
  if (!plan.paid) return { unknown: false, partial: false, expensive: false }
  const unknown = plan.priceUsd === undefined
  return {
    unknown,
    partial: !unknown && !!plan.partialPrice,
    expensive: !unknown && plan.priceUsd! > CONFIRM_ABOVE_USD
  }
}

export function needsConfirm(check: PriceCheck): boolean {
  return check.unknown || check.partial || check.expensive
}

// ── The timeline ─────────────────────────────────────────────────────────────

export interface SnapOptions {
  /** Cut markers and transcript line edges (seconds). */
  points: readonly number[]
  /** Seconds within which a point pulls the time to it. */
  tolerance: number
  fps: number
  duration: number
}

/**
 * Where a dragged edge lands: on the nearest cut marker or transcript line edge within the tolerance, else on the
 * frame grid (the start of the frame the time falls in), always inside the film.
 */
export function snapTime(t: number, o: SnapOptions): number {
  const clamped = Math.min(o.duration, Math.max(0, t))
  let best: number | undefined
  for (const p of o.points) {
    if (p < 0 || p > o.duration) continue
    const d = Math.abs(p - clamped)
    if (d <= o.tolerance && (best === undefined || d < Math.abs(best - clamped))) best = p
  }
  if (best !== undefined) return best
  if (clamped >= o.duration) return o.duration
  const fps = o.fps > 0 ? o.fps : 30
  const frame = Math.round(clamped * fps)
  return Math.min(o.duration, frame / fps)
}

/** The range between two snapped times, in order; undefined when it is shorter than one frame. */
export function rangeBetween(a: number, b: number, fps: number): EditRange | undefined {
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  return end - start >= 1 / (fps > 0 ? fps : 30) - 1e-6 ? { start, end } : undefined
}

/** The marked range kept inside a film of this length; undefined when nothing of it is left. */
export function clampRange(range: EditRange | undefined, duration: number): EditRange | undefined {
  if (!range) return undefined
  const start = Math.max(0, Math.min(range.start, duration))
  const end = Math.max(0, Math.min(range.end, duration))
  return end - start > 1e-3 ? { start, end } : undefined
}

/**
 * Mark in at t (I): the marking's start moves there; an in-point alone (or after the marking) marks to the end,
 * as in an editing program. Undefined when nothing would be left.
 */
export function markedIn(t: number, selection: EditRange | undefined, duration: number): EditRange | undefined {
  const end = selection && selection.end > t ? selection.end : duration
  return end > t ? { start: t, end } : undefined
}

/** Mark out at t (O): the marking's end moves there; an out-point alone (or before the marking) marks from the start. */
export function markedOut(t: number, selection: EditRange | undefined): EditRange | undefined {
  const start = selection && selection.start < t ? selection.start : 0
  return t > start ? { start, end: t } : undefined
}

/** The points a dragged edge snaps to: cut markers, and every transcript line's start and end. */
export function snapPoints(timeline: Pick<EditTimeline, 'cuts' | 'transcript'> | undefined): number[] {
  if (!timeline) return []
  const points = [...timeline.cuts]
  for (const s of timeline.transcript?.segments ?? []) points.push(s.start, s.end)
  return points
}

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

/** Seconds between the ruler's labelled ticks, so that labels stay at least minPx apart. */
export function rulerStep(duration: number, widthPx: number, minPx = 64): number {
  if (!(duration > 0) || !(widthPx > 0)) return 1
  const perPx = duration / widthPx
  return RULER_STEPS.find((s) => s / perPx >= minPx) ?? RULER_STEPS[RULER_STEPS.length - 1]
}

/**
 * Rows for the Layers lane: each layer goes in the first row where it doesn't overlap the one before it, so bars
 * never cover each other.
 */
export function layerRows<T extends { id: string; start: number; end: number }>(
  layers: readonly T[]
): { row: Map<string, number>; count: number } {
  const ends: number[] = []
  const row = new Map<string, number>()
  for (const l of [...layers].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let r = ends.findIndex((end) => end <= l.start + 1e-6)
    if (r === -1) {
      r = ends.length
      ends.push(l.end)
    } else ends[r] = l.end
    row.set(l.id, r)
  }
  return { row, count: ends.length }
}

// ── Operations ───────────────────────────────────────────────────────────────

/** The part of the film an operation works on, for drawing it on the timeline; undefined for the whole film. */
export function operationRange(op: EditOperation | undefined): EditRange | undefined {
  if (!op) return undefined
  switch (op.op) {
    case 'trim':
      return op.keep
    case 'cut':
    case 'regenerate':
    case 'prompt-edit':
      return op.range
    case 'volume':
    case 'mute':
    case 'music':
    case 'change-voice':
      return op.range
    case 'effect':
      return { start: op.at, end: op.at + op.seconds }
    default:
      return undefined
  }
}

/** Transcript lines that overlap the range (by more than a hair). */
export function segmentsInRange(segments: readonly TranscriptSegment[], range: EditRange): TranscriptSegment[] {
  return segments.filter((s) => Math.min(s.end, range.end) - Math.max(s.start, range.start) > 0.05)
}

/**
 * "Suggest" for Regenerate section: a plain template (no AI), with what is said in the range when it is known.
 */
export function suggestRegeneratePrompt(segments: readonly TranscriptSegment[], range: EditRange | undefined): string {
  const base = 'Continuous shot. Same people, place and light as the start image.'
  if (!range) return base
  const said = segmentsInRange(segments, range)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
  return said ? `${base} "${said}"` : base
}

// ── Files ────────────────────────────────────────────────────────────────────

/** The file's name without its folder. */
export function fileName(path: string): string {
  return path.split(PATH_SEPARATOR).pop() ?? path
}
