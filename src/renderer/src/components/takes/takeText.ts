// Pure helpers for the take strip and the status marks of Sekvenser and Storyboards: the order and size of the
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

const oneDecimal = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** "5,0 s": a take's length, always with one decimal, so lengths line up in the strip. */
export function formatTakeLength(seconds: number): string {
  return `${oneDecimal.format(Math.max(0, seconds))} s`
}

/** "Genererar 40 %", "I kö", "Genererar" – the short phase on a pending tile. */
export function pendingPhase(take: Generation): string {
  if (take.status === 'queued') return 'I kö'
  const progress = takeProgress(take)
  return progress !== undefined ? `Genererar ${Math.round(progress * 100)} %` : 'Genererar'
}

/** A version's title "Intervju v3" as ”Intervju” v3; any other title in quotes. */
function quotedVersion(title: string): string {
  const m = /^(.*\S)\s+(v\d+)$/.exec(title)
  return m ? `”${m[1]}” ${m[2]}` : `”${title}”`
}

/** What kind of take it is, for the words around it. */
export type TakeKind = 'own' | 'version' | 'venice'

export function takeKind(take: Pick<Generation, 'source' | 'editId'>): TakeKind {
  const badge = sourceBadge(take)
  return badge?.kind === 'own' ? 'own' : badge?.kind === 'edited' ? 'version' : 'venice'
}

/**
 * The line under the strip for one take (hovered, else focused, else the active one), without its buttons:
 * "14:02 · 5,0 s · $0.35 · Seedance 2.5 · ”A woman walks along the pier…”", "Eget klipp · IMG_2041.mov · 0:31",
 * "Redigerad film · ”Intervju” v3", "I kö…", "Genererar 40 % · 1:12 av ~3:00", or the error of a failed one
 * (`tone: 'error'`).
 */
export function takeInfo(take: Generation, modelName: string): { text: string; tone: 'muted' | 'error' } {
  if (take.status === 'failed') return { text: take.error?.trim() || 'Tagningen misslyckades.', tone: 'error' }
  if (take.status === 'queued') return { text: 'I kö…', tone: 'muted' }
  if (take.status === 'processing') {
    const progress = takeProgress(take)
    const head = progress !== undefined ? `Genererar ${Math.round(progress * 100)} %` : 'Genererar…'
    const elapsed = take.executionDuration !== undefined ? formatClock(take.executionDuration / 1000) : undefined
    const typical = take.averageExecutionTime ? formatClock(take.averageExecutionTime / 1000) : undefined
    const time = elapsed && typical ? `${elapsed} av ~${typical}` : elapsed
    return { text: time ? `${head} · ${time}` : head, tone: 'muted' }
  }
  const kind = takeKind(take)
  const title = generationTitle(take)
  if (take.fileMissing) {
    const when = formatTakeTime(take.createdAt)
    return { text: `${when} · Videofilen finns inte längre (flyttad eller raderad i Finder).`, tone: 'muted' }
  }
  if (kind === 'own') {
    const parts = ['Eget klipp', title]
    if (take.videoDuration) parts.push(formatClock(take.videoDuration))
    return { text: parts.join(' · '), tone: 'muted' }
  }
  if (kind === 'version') return { text: `Redigerad film · ${quotedVersion(title)}`, tone: 'muted' }
  const parts = [formatTakeTime(take.createdAt), formatTakeLength(takeDuration(take)), formatUsd(take.quote)]
  if (modelName) parts.push(modelName)
  parts.push(take.prompt.trim() ? `”${generationTitle(take, 70)}”` : 'Ingen prompt')
  return { text: parts.join(' · '), tone: 'muted' }
}

/** Whether "Använd tagningens prompt" can put the take's words back: a Venice take made from a prompt. */
export function hasReusablePrompt(take: Generation): boolean {
  return !!take.prompt.trim() && canUseAgain(take)
}

/**
 * What a screen reader hears for a tile: "Tagning 14:02, 5,0 sekunder, vald, ny" (only the parts that apply);
 * "Tagning, genereras 40 procent" while it is being made.
 */
export function takeAriaLabel(
  take: Generation,
  flags: { active: boolean; fresh: boolean; previewed?: boolean }
): string {
  if (isPending(take)) {
    if (take.status === 'queued') return 'Tagning, i kö'
    const progress = takeProgress(take)
    return progress !== undefined ? `Tagning, genereras ${Math.round(progress * 100)} procent` : 'Tagning, genereras'
  }
  const parts = [`Tagning ${formatTakeTime(take.createdAt)}`]
  if (take.status === 'failed') parts.push('misslyckades')
  else if (take.fileMissing) parts.push('filen saknas')
  else parts.push(formatTakeLength(takeDuration(take)).replace(/ s$/, ' sekunder'))
  const kind = takeKind(take)
  if (kind === 'own') parts.push('eget klipp')
  if (kind === 'version') parts.push('redigerad film')
  if (flags.active) parts.push('vald')
  if (flags.previewed) parts.push('förhandsvisas')
  if (flags.fresh) parts.push('ny')
  return parts.join(', ')
}

/**
 * A pending tile's tooltip, mirroring main's autoSelect: a finished take is chosen by itself only while the clip
 * (or transition) has no usable chosen take.
 */
export function pendingTitle(autoSelects: boolean): string {
  return autoSelects
    ? 'Genereras. Den väljs automatiskt när den är klar.'
    : 'Genereras. Klicka på den när den är klar för att använda den.'
}

// ── Status of a whole sequence or storyboard (list rows) ─────────────────────

/** Sequences talk about takes, storyboards about transitions. */
export type OwnerKind = 'sequence' | 'storyboard'

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * A list row's tooltip in words, from what runs and what is new for that sequence or storyboard:
 * "2 tagningar genereras · 1 ny tagning att titta på", "Generera saknade pågår", "Exporterar 62 %",
 * "1 övergång genereras · 2 nya övergångar", "… · 1 misslyckades". Undefined when there is nothing to say.
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
        ? `${count(takes, 'övergång', 'övergångar')} genereras`
        : `${count(takes, 'tagning', 'tagningar')} genereras`
    )
  }
  if (running.some((w) => w.kind === 'run')) parts.push('Generera saknade pågår')
  const stills = running.filter((w) => w.kind === 'still').length
  if (stills) parts.push(`${count(stills, 'bild', 'bilder')} skapas`)
  const imports = running.filter((w) => w.kind === 'import').length
  if (imports) parts.push(`${count(imports, 'egen film', 'egna filmer')} importeras`)
  const exporting = running.find((w) => w.kind === 'export')
  if (exporting) {
    parts.push(exporting.progress !== undefined ? `Exporterar ${Math.round(exporting.progress * 100)} %` : 'Exporterar')
  }

  const fresh = unseen.filter((w) => w.status === 'completed')
  const freshStills = fresh.filter((w) => w.kind === 'still').length
  const freshExports = fresh.filter((w) => w.kind === 'export').length
  // Everything else new here is a take (also what a list cut short at 200 leaves out).
  const freshTakes = Math.max(0, counts.unseen - freshStills - freshExports)
  if (freshTakes) {
    parts.push(
      kind === 'storyboard'
        ? count(freshTakes, 'ny övergång', 'nya övergångar')
        : `${count(freshTakes, 'ny tagning', 'nya tagningar')} att titta på`
    )
  }
  if (freshStills) parts.push(count(freshStills, 'ny bild', 'nya bilder'))
  if (freshExports) parts.push(freshExports === 1 ? 'Filmen är exporterad' : `${freshExports} nya exporter`)
  if (counts.failed) parts.push(`${counts.failed} misslyckades`)
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

/** "Ny tagning", "3 nya tagningar". */
export function freshTakesLabel(n: number): string {
  return n === 1 ? 'Ny tagning' : `${n} nya tagningar`
}
