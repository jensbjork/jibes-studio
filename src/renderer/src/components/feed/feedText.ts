// Swedish wording and number formatting for the clip feed: statuses, the summary line, review tags.

import { agentDisplayName } from '@shared/agent-name'
import { generationSeconds, type GenerationTotals } from '@shared/generation-filter'
import { THUMBS_DOWN, type Generation, type GenerationStatus } from '@shared/types'

export const STATUS_LABEL: Record<GenerationStatus, string> = {
  queued: 'I kö',
  processing: 'Genererar',
  completed: 'Klar',
  failed: 'Misslyckades'
}

export function isPending(g: Pick<Generation, 'status'>): boolean {
  return g.status === 'queued' || g.status === 'processing'
}

/** Estimated progress 0–1 of a pending generation, from Venice's average execution time. */
export function progressOf(g: Generation): number | undefined {
  if (!g.executionDuration || !g.averageExecutionTime) return undefined
  return Math.min(0.97, g.executionDuration / g.averageExecutionTime)
}

/** "48 s", "5 min 12 s", "1 h 5 min": a total running time. */
export function formatTotalLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

const oneDecimal = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })

/** "8 s" or "7,4 s": one clip's length. */
export function formatClipLength(seconds: number): string {
  return `${oneDecimal.format(seconds)} s`
}

/** The clip's real length when ffprobe measured it, else the length it was asked for (as the Längd sort reads it). */
export function clipSeconds(g: Pick<Generation, 'videoDuration' | 'params'>): number {
  return generationSeconds(g) ?? 0
}

/** "42 klipp · $38.20 · 5 min 12 s" for the totals of summarizeGenerations. */
export function summaryText({ count, costUsd, seconds }: GenerationTotals): string {
  const parts = [`${count} klipp`]
  if (costUsd > 0) parts.push(`$${costUsd.toFixed(2)}`)
  if (seconds > 0) parts.push(formatTotalLength(seconds))
  return parts.join(' · ')
}

/** "1 granskning", "3 granskningar". */
export function reviewCountText(n: number): string {
  return `${n} ${n === 1 ? 'granskning' : 'granskningar'}`
}

/** What a grade says next to the drawer's rating control: "Dåligt" for tumme ner, then "Okej", "Bra", "Mycket bra". */
export function ratingWord(rating: number | undefined): string | undefined {
  if (rating === THUMBS_DOWN) return 'Dåligt'
  return rating === 1 ? 'Okej' : rating === 2 ? 'Bra' : rating === 3 ? 'Mycket bra' : undefined
}

// ── Review tags ──────────────────────────────────────────────────────────────

export type TagTone = 'good' | 'bad'

/**
 * The suggested review vocabulary (the agents use the same words, see the agent guide), with how the UI says
 * it. Agents may write other tags too; those are shown as written.
 */
export const REVIEW_TAGS: { tag: string; label: string; tone: TagTone }[] = [
  { tag: 'prompt-followed', label: 'Följde prompten', tone: 'good' },
  { tag: 'prompt-ignored', label: 'Struntade i prompten', tone: 'bad' },
  { tag: 'identity-drift', label: 'Utseendet gled', tone: 'bad' },
  { tag: 'wrong-outfit', label: 'Fel kläder', tone: 'bad' },
  { tag: 'wrong-pose', label: 'Fel pose', tone: 'bad' },
  { tag: 'good-motion', label: 'Bra rörelser', tone: 'good' },
  { tag: 'bad-motion', label: 'Konstiga rörelser', tone: 'bad' },
  { tag: 'camera-good', label: 'Bra kamera', tone: 'good' },
  { tag: 'camera-wrong', label: 'Fel kamera', tone: 'bad' },
  { tag: 'artifacts', label: 'Bildfel', tone: 'bad' },
  { tag: 'voice-match', label: 'Rätt röst', tone: 'good' },
  { tag: 'voice-mismatch', label: 'Fel röst', tone: 'bad' },
  { tag: 'continuity-good', label: 'Hänger ihop', tone: 'good' },
  { tag: 'continuity-break', label: 'Hänger inte ihop', tone: 'bad' },
  { tag: 'lighting-good', label: 'Bra ljus', tone: 'good' },
  { tag: 'lighting-wrong', label: 'Fel ljus', tone: 'bad' }
]

const TAG_INFO = new Map(REVIEW_TAGS.map((t) => [t.tag, t]))

export function tagLabel(tag: string): string {
  return TAG_INFO.get(tag.trim().toLowerCase())?.label ?? tag
}

export function tagTone(tag: string): TagTone | undefined {
  return TAG_INFO.get(tag.trim().toLowerCase())?.tone
}

/** Chip colours for a review tag; full class strings so Tailwind sees them. */
export function tagChipClass(tag: string): string {
  const tone = tagTone(tag)
  if (tone === 'good') return 'bg-emerald-400/10 text-emerald-300'
  if (tone === 'bad') return 'bg-amber-400/10 text-amber-200'
  return 'bg-line/70 text-muted'
}

/** "Du" for the user's own review, else the agent's name ("Agenten" for a generic MCP client name like "mcp"). */
export function authorLabel(author: string): string {
  return author === 'user' ? 'Du' : agentDisplayName(author)
}
