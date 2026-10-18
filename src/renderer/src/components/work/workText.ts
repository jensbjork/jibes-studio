import type { FinishedWork, RunningWork, WorkCounts, WorkView } from '@shared/types'
import { agentInSentence } from '../agent/agentText'

// Wording of Activity: the tooltips of sidebar rows and list rows, the accessible labels of the
// marks, and the phase, estimate and time lines of the panel. Main writes the labels and phases themselves.

/** "2 running, 1 new, 1 failed": the accessible label of a mark. */
export function countsAria(c: WorkCounts): string {
  const parts: string[] = []
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.unseen > 0) parts.push(c.unseen === 1 ? '1 new to look at' : `${c.unseen} new to look at`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  return parts.join(', ')
}

/** What a place makes, for "2 takes generating · 1 new take". */
export type WorkNoun = 'video' | 'take' | 'transition' | 'edit' | 'voice' | 'picture'

const RUNNING: Record<WorkNoun, [one: string, many: (n: number) => string]> = {
  video: ['1 video generating', (n) => `${n} videos generating`],
  take: ['1 take generating', (n) => `${n} takes generating`],
  transition: ['1 transition generating', (n) => `${n} transitions generating`],
  edit: ['1 edit running', (n) => `${n} edits running`],
  voice: ['Creating a voice', (n) => `Creating ${n} voices`],
  picture: ['Creating an image', (n) => `Creating ${n} images`]
}

const FRESH: Record<WorkNoun, [one: string, many: (n: number) => string]> = {
  video: ['1 new video to look at', (n) => `${n} new videos to look at`],
  take: ['1 new take', (n) => `${n} new takes`],
  transition: ['1 new transition', (n) => `${n} new transitions`],
  edit: ['1 new version', (n) => `${n} new versions`],
  voice: ['1 new voice', (n) => `${n} new voices`],
  picture: ['1 new image', (n) => `${n} new images`]
}

export function runningText(noun: WorkNoun, n: number): string {
  return n === 1 ? RUNNING[noun][0] : RUNNING[noun][1](n)
}

/** `watch` adds "to look at" where the noun doesn't already say it (list rows). */
export function freshText(noun: WorkNoun, n: number, watch = false): string {
  const text = n === 1 ? FRESH[noun][0] : FRESH[noun][1](n)
  return watch && !text.endsWith('to look at') ? `${text} to look at` : text
}

export function failedText(n: number): string {
  return `${n} failed`
}

/**
 * A list row's tooltip from its counts, e.g. "2 takes generating · 1 new take to look at · 1 failed".
 * Undefined when nothing runs and nothing is new.
 */
export function countsTitle(noun: WorkNoun, c: WorkCounts, watch = true): string | undefined {
  const parts: string[] = []
  if (c.running > 0) parts.push(runningText(noun, c.running))
  if (c.unseen > 0) parts.push(freshText(noun, c.unseen, watch))
  if (c.failed > 0) parts.push(failedText(c.failed))
  return parts.length ? parts.join(' · ') : undefined
}

const VIEW_NOUN: Partial<Record<WorkView, WorkNoun>> = {
  generate: 'video',
  sequences: 'take',
  storyboards: 'transition',
  editor: 'edit',
  characters: 'voice'
}

/**
 * "Export of “Sommar”" → "Exporting “Sommar” 40%", an import's file name → "Importing IMG_2041.mov 30%"; main's
 * other labels are used as they are.
 */
function runLine(w: RunningWork): string {
  const pct = w.progress !== undefined ? ` ${Math.round(w.progress * 100)}%` : ''
  if (w.kind === 'export') return `Exporting ${w.label.replace(/^Export of /, '')}${pct}`
  if (w.kind === 'import') return `Importing ${w.label}${pct}`
  if (w.kind === 'run') return w.label.replace(/^Generate missing in /, 'Generate missing is running in ')
  return w.label
}

/** Running kinds that make one of the view's media (counted with its noun); the rest are named one by one. */
const MEDIA_KINDS = new Set<RunningWork['kind']>(['video', 'sending', 'edit-job', 'render', 'voice-design'])

/**
 * A sidebar row's status in words (its tooltip, the rail's second line and the button's accessible label), e.g.
 * Sequences "2 takes generating · Exporting “Sommar” 40% · 1 new take · 1 failed". Undefined when
 * nothing runs and nothing is new.
 */
export function viewStatusText(
  view: WorkView,
  counts: WorkCounts,
  running: readonly RunningWork[],
  unseen: readonly FinishedWork[]
): string | undefined {
  const noun = VIEW_NOUN[view]
  const parts: string[] = []

  const media = running.filter((w) => MEDIA_KINDS.has(w.kind)).length
  const pictures = running.filter((w) => w.kind === 'still').length
  if (noun && media > 0) parts.push(runningText(noun, media))
  if (pictures > 0) parts.push(runningText('picture', pictures))
  for (const w of running) if (!MEDIA_KINDS.has(w.kind) && w.kind !== 'still') parts.push(runLine(w))
  // Running work main counts but this window didn't get listed (it shouldn't happen): still say something.
  if (!parts.length && counts.running > 0) parts.push(`${counts.running} running`)

  const fresh = unseen.filter((w) => w.status === 'completed')
  const freshMedia = fresh.filter((w) => w.kind === 'video' || w.kind === 'version' || w.kind === 'voice').length
  const freshPictures = fresh.filter((w) => w.kind === 'still').length
  const freshExports = fresh.filter((w) => w.kind === 'export').length
  if (noun && freshMedia > 0) parts.push(freshText(noun, freshMedia))
  if (freshPictures > 0) parts.push(freshText('picture', freshPictures))
  if (freshExports > 0) parts.push(freshExports === 1 ? 'A film was exported' : `${freshExports} films were exported`)
  const listedFresh = freshMedia + freshPictures + freshExports
  if (counts.unseen > listedFresh) {
    const more = counts.unseen - listedFresh
    parts.push(listedFresh ? `${more} more to look at` : `${more} new to look at`)
  }
  if (counts.failed > 0) parts.push(failedText(counts.failed))
  return parts.length ? parts.join(' · ') : undefined
}

// ── Times and estimates ──────────────────────────────────────────────────────

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayAndClock = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "14:32" today, "9 Oct, 14:32" before that. */
export function timeOfDay(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return (sameDay ? clock : dayAndClock).format(d)
}

/** "0:42", "12:05": time elapsed. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "≈ 40 s", "≈ 3 min": a remaining time, rounded so it doesn't flicker. */
function aboutText(ms: number): string {
  const s = ms / 1000
  if (s < 55) return `${Math.max(10, Math.round(s / 10) * 10)} s`
  return `${Math.max(1, Math.round(s / 60))} min`
}

/**
 * The estimate of a running item at `now`: "≈ 1 min left" from Venice's own timing (counted down between pushes),
 * "Almost done" past it, or "1:12 · usually takes ~3 min" while queued with only the typical time to go by.
 */
export function etaText(w: RunningWork, now: number): string | undefined {
  if (w.remainingMs !== undefined) {
    const left = w.remainingMs - Math.max(0, now - w.measuredAt)
    return left > 1000 ? `≈ ${aboutText(left)} left` : 'Almost done'
  }
  if (w.typicalMs !== undefined && w.typicalMs > 0) {
    return `${elapsedText(now - w.startedAt)} · usually takes ~${aboutText(w.typicalMs)}`
  }
  return undefined
}

/** A running row's right-hand side: main's phase, then the estimate, then who asked for it. */
export function runningMeta(w: RunningWork, now: number): string {
  const parts: string[] = []
  if (w.detail) parts.push(w.detail)
  else if (w.progress !== undefined) parts.push(`${Math.round(w.progress * 100)}%`)
  const eta = etaText(w, now)
  // "Almost done" from main already says it.
  if (eta && !(eta === 'Almost done' && w.detail === 'Almost done')) parts.push(eta)
  if (w.via) parts.push(`via ${agentInSentence(w.via)}`)
  return parts.join(' · ')
}

/** "Done 14:32", "Exported 13:58", "Failed 14:30 – {error}". */
export function finishedMeta(w: FinishedWork, now = Date.now()): string {
  const at = timeOfDay(w.finishedAt, now)
  const via = w.via ? ` · via ${agentInSentence(w.via)}` : ''
  if (w.status === 'failed') return `Failed ${at}${w.error ? ` – ${w.error}` : ''}${via}`
  return `${w.kind === 'export' ? 'Exported' : 'Done'} ${at}${via}`
}

/** The panel's group heading of a place: "Sequences", "Generate", "Editor" … */
export const VIEW_LABEL: Record<WorkView, string> = {
  generate: 'Generate',
  media: 'Media',
  sequences: 'Sequences',
  storyboards: 'Storyboards',
  editor: 'Editor',
  characters: 'Characters',
  environments: 'Environments',
  products: 'Products',
  outfits: 'Outfits',
  poses: 'Poses'
}
