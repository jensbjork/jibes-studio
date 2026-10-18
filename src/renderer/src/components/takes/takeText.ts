// Pure helpers for the take strip and the status marks of Sequences and Storyboards: the order and size of the
// tiles, the one-line description under the strip, the words a screen reader hears, and the tooltips of the list
// rows. No React and no window.studio here, so they can be tested on their own.

import { canUseAgain, generationTitle, sourceBadge } from '@shared/generation-label'
import type { FinishedWork, Generation, RunningWork, WorkCounts } from '@shared/types'
import { formatUsd } from '../../lib/media'
import { formatClock, formatTakeTime, isPending, takeDuration, takeProgress } from '../sequences/sequenceUtils'

/** A take that can be played and chosen: finished, with its file on disk. */
export function isPlayable(take: Generation): boolean {
  return take.status === 'completed' && !!take.filePath && !take.fileMissing
}

/**
 * The strip's order: newest first, as main lists them – so a take being made, the newest, comes first. Never by
 * status: a take keeps its place when it finishes, so two takes finishing out of order can't swap places under the
 * pointer (a click meant for one choosing the other).
 */
export function stripOrder(takes: readonly Generation[]): Generation[] {
  return [...takes]
}

/**
 * A tile's width for its height and the film's shape (width / height): as wide as the picture, but never narrower
 * than a portrait tile (0.78 of the height) nor wider than a 16:9 one, so a very wide or very tall film still gives
 * tiles that can be told apart and clicked.
 */
export function tileWidth(height: number, aspect: number): number {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  return Math.round(Math.min(height * (16 / 9), Math.max(height * 0.78, height * ratio)))
}

const oneDecimal = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** "5.0 s": a take's length, always with one decimal, so lengths line up in the strip. */
export function formatTakeLength(seconds: number): string {
  return `${oneDecimal.format(Math.max(0, seconds))} s`
}

/** "Generating 40%", "Queued", "Generating" – the short phase on a pending tile. */
export function pendingPhase(take: Generation): string {
  if (take.status === 'queued') return 'Queued'
  const progress = takeProgress(take)
  return progress !== undefined ? `Generating ${Math.round(progress * 100)}%` : 'Generating'
}

/** A version's title "Interview v3" as “Interview” v3; any other title in quotes. */
function quotedVersion(title: string): string {
  const m = /^(.*\S)\s+(v\d+)$/.exec(title)
  return m ? `“${m[1]}” ${m[2]}` : `“${title}”`
}

/** What kind of take it is, for the words around it. */
export type TakeKind = 'own' | 'version' | 'venice'

export function takeKind(take: Pick<Generation, 'source' | 'editId'>): TakeKind {
  const badge = sourceBadge(take)
  return badge?.kind === 'own' ? 'own' : badge?.kind === 'edited' ? 'version' : 'venice'
}

/**
 * The line under the strip for one take (hovered, else focused, else the active one), without its buttons:
 * "14:02 · 5.0 s · $0.35 · Seedance 2.5 · “A woman walks along the pier…”", "Own clip · IMG_2041.mov · 0:31",
 * "Edited film · “Interview” v3", "Queued…", "Generating 40% · 1:12 of ~3:00", or the error of a failed one
 * (`tone: 'error'`).
 */
export function takeInfo(take: Generation, modelName: string): { text: string; tone: 'muted' | 'error' } {
  if (take.status === 'failed') return { text: take.error?.trim() || 'The take failed.', tone: 'error' }
  if (take.status === 'queued') return { text: 'Queued…', tone: 'muted' }
  if (take.status === 'processing') {
    const progress = takeProgress(take)
    const head = progress !== undefined ? `Generating ${Math.round(progress * 100)}%` : 'Generating…'
    const elapsed = take.executionDuration !== undefined ? formatClock(take.executionDuration / 1000) : undefined
    const typical = take.averageExecutionTime ? formatClock(take.averageExecutionTime / 1000) : undefined
    const time = elapsed && typical ? `${elapsed} of ~${typical}` : elapsed
    return { text: time ? `${head} · ${time}` : head, tone: 'muted' }
  }
  const kind = takeKind(take)
  const title = generationTitle(take)
  if (take.fileMissing) {
    const when = formatTakeTime(take.createdAt)
    return { text: `${when} · The video file is gone (moved or deleted in Finder).`, tone: 'muted' }
  }
  if (kind === 'own') {
    const parts = ['Own clip', title]
    if (take.videoDuration) parts.push(formatClock(take.videoDuration))
    return { text: parts.join(' · '), tone: 'muted' }
  }
  if (kind === 'version') return { text: `Edited film · ${quotedVersion(title)}`, tone: 'muted' }
  const parts = [formatTakeTime(take.createdAt), formatTakeLength(takeDuration(take)), formatUsd(take.quote)]
  if (modelName) parts.push(modelName)
  parts.push(take.prompt.trim() ? `“${generationTitle(take, 70)}”` : 'No prompt')
  return { text: parts.join(' · '), tone: 'muted' }
}

/** Whether "Use the take’s prompt" can put the take's words back: a Venice take made from a prompt. */
export function hasReusablePrompt(take: Generation): boolean {
  return !!take.prompt.trim() && canUseAgain(take)
}

/**
 * What a screen reader hears for a tile: "Take 14:02, 5.0 seconds, selected, new" (only the parts that apply);
 * "Take, generating 40 percent" while it is being made.
 */
export function takeAriaLabel(
  take: Generation,
  flags: { active: boolean; fresh: boolean; previewed?: boolean }
): string {
  if (isPending(take)) {
    if (take.status === 'queued') return 'Take, queued'
    const progress = takeProgress(take)
    return progress !== undefined ? `Take, generating ${Math.round(progress * 100)} percent` : 'Take, generating'
  }
  const parts = [`Take ${formatTakeTime(take.createdAt)}`]
  if (take.status === 'failed') parts.push('failed')
  else if (take.fileMissing) parts.push('file missing')
  else parts.push(formatTakeLength(takeDuration(take)).replace(/ s$/, ' seconds'))
  const kind = takeKind(take)
  if (kind === 'own') parts.push('own clip')
  if (kind === 'version') parts.push('edited film')
  if (flags.active) parts.push('selected')
  if (flags.previewed) parts.push('previewing')
  if (flags.fresh) parts.push('new')
  return parts.join(', ')
}

/**
 * A pending tile's tooltip, mirroring main's autoSelect: a finished take is chosen by itself only while the clip
 * (or transition) has no usable chosen take.
 */
export function pendingTitle(autoSelects: boolean): string {
  return autoSelects
    ? 'Generating. It’s selected automatically when it’s done.'
    : 'Generating. Click it when it’s done to use it.'
}

// ── Status of a whole sequence or storyboard (list rows) ─────────────────────

/** Sequences talk about takes, storyboards about transitions. */
export type OwnerKind = 'sequence' | 'storyboard'

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * A list row's tooltip in words, from what runs and what is new for that sequence or storyboard:
 * "2 takes generating · 1 new take to look at", "Generate missing is running", "Exporting 62%",
 * "1 transition generating · 2 new transitions", "… · 1 failed". Undefined when there is nothing to say.
 * `unseen` may be cut short (the summary lists at most 200); `counts` are exact, so what the list doesn't explain
 * is counted as takes.
 */
export function ownerStatusText(
  kind: OwnerKind,
  running: readonly RunningWork[],
  unseen: readonly FinishedWork[],
  counts: WorkCounts
): string | undefined {
  const parts: string[] = []
  const takes = running.filter((w) => w.kind === 'video' || w.kind === 'sending').length
  if (takes) {
    parts.push(
      kind === 'storyboard'
        ? `${count(takes, 'transition', 'transitions')} generating`
        : `${count(takes, 'take', 'takes')} generating`
    )
  }
  if (running.some((w) => w.kind === 'run')) parts.push('Generate missing is running')
  const stills = running.filter((w) => w.kind === 'still').length
  if (stills) parts.push(`Creating ${count(stills, 'image', 'images')}`)
  const imports = running.filter((w) => w.kind === 'import').length
  if (imports) parts.push(`Importing ${count(imports, 'own film', 'own films')}`)
  const exporting = running.find((w) => w.kind === 'export')
  if (exporting) {
    parts.push(exporting.progress !== undefined ? `Exporting ${Math.round(exporting.progress * 100)}%` : 'Exporting')
  }

  const fresh = unseen.filter((w) => w.status === 'completed')
  const freshStills = fresh.filter((w) => w.kind === 'still').length
  const freshExports = fresh.filter((w) => w.kind === 'export').length
  // Everything else new here is a take (also what a list cut short at 200 leaves out).
  const freshTakes = Math.max(0, counts.unseen - freshStills - freshExports)
  if (freshTakes) {
    parts.push(
      kind === 'storyboard'
        ? count(freshTakes, 'new transition', 'new transitions')
        : `${count(freshTakes, 'new take', 'new takes')} to look at`
    )
  }
  if (freshStills) parts.push(count(freshStills, 'new image', 'new images'))
  if (freshExports) parts.push(freshExports === 1 ? 'The film was exported' : `${freshExports} new exports`)
  if (counts.failed) parts.push(`${counts.failed} failed`)
  return parts.length ? parts.join(' · ') : undefined
}

/** The unseen takes of one clip or transition among a summary's unseen items: new ones and failures. */
export interface SegmentNews {
  /** Finished takes not looked at yet. */
  fresh: string[]
  /** Failed takes not looked at yet (their summary keys). */
  failed: string[]
}

/** Groups unseen takes by the clip or transition they belong to (pictures and exports are left out). */
export function newsBySegment(unseen: readonly FinishedWork[]): Map<string, SegmentNews> {
  const out = new Map<string, SegmentNews>()
  for (const w of unseen) {
    if (!w.segmentId || !w.generationId) continue
    const entry = out.get(w.segmentId) ?? { fresh: [], failed: [] }
    if (w.status === 'failed') entry.failed.push(w.key)
    else entry.fresh.push(w.key)
    out.set(w.segmentId, entry)
  }
  return out
}

/** "New take", "3 new takes". */
export function freshTakesLabel(n: number): string {
  return n === 1 ? 'New take' : `${n} new takes`
}
