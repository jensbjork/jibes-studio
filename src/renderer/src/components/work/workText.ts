import type { FinishedWork, RunningWork, WorkCounts, WorkView } from '@shared/types'

// Swedish wording of Pågår och klart: the tooltips of sidebar rows and list rows, the accessible labels of the
// marks, and the phase, estimate and time lines of the panel. Main writes the labels and phases themselves.

/** "2 pågår, 1 ny, 1 misslyckades": the accessible label of a mark. */
export function countsAria(c: WorkCounts): string {
  const parts: string[] = []
  if (c.running > 0) parts.push(`${c.running} pågår`)
  if (c.unseen > 0) parts.push(c.unseen === 1 ? '1 ny att titta på' : `${c.unseen} nya att titta på`)
  if (c.failed > 0) parts.push(`${c.failed} misslyckades`)
  return parts.join(', ')
}

/** What a place makes, for "2 tagningar genereras · 1 ny tagning". */
export type WorkNoun = 'video' | 'take' | 'transition' | 'edit' | 'voice' | 'picture'

const RUNNING: Record<WorkNoun, [one: string, many: (n: number) => string]> = {
  video: ['1 video genereras', (n) => `${n} videor genereras`],
  take: ['1 tagning genereras', (n) => `${n} tagningar genereras`],
  transition: ['1 övergång genereras', (n) => `${n} övergångar genereras`],
  edit: ['1 redigering pågår', (n) => `${n} redigeringar pågår`],
  voice: ['En röst skapas', (n) => `${n} röster skapas`],
  picture: ['En bild skapas', (n) => `${n} bilder skapas`]
}

const FRESH: Record<WorkNoun, [one: string, many: (n: number) => string]> = {
  video: ['1 ny video att titta på', (n) => `${n} nya videor att titta på`],
  take: ['1 ny tagning', (n) => `${n} nya tagningar`],
  transition: ['1 ny övergång', (n) => `${n} nya övergångar`],
  edit: ['1 ny version', (n) => `${n} nya versioner`],
  voice: ['1 ny röst', (n) => `${n} nya röster`],
  picture: ['1 ny bild', (n) => `${n} nya bilder`]
}

export function runningText(noun: WorkNoun, n: number): string {
  return n === 1 ? RUNNING[noun][0] : RUNNING[noun][1](n)
}

/** `watch` adds "att titta på" where the noun doesn't already say it (list rows). */
export function freshText(noun: WorkNoun, n: number, watch = false): string {
  const text = n === 1 ? FRESH[noun][0] : FRESH[noun][1](n)
  return watch && !text.endsWith('att titta på') ? `${text} att titta på` : text
}

export function failedText(n: number): string {
  return `${n} misslyckades`
}

/**
 * A list row's tooltip from its counts, e.g. "2 tagningar genereras · 1 ny tagning att titta på · 1 misslyckades".
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
 * "Export av ”Sommar”" → "Exporterar ”Sommar” 40 %", an import's file name → "Importerar IMG_2041.mov 30 %"; main's
 * other labels are used as they are.
 */
function runLine(w: RunningWork): string {
  const pct = w.progress !== undefined ? ` ${Math.round(w.progress * 100)} %` : ''
  if (w.kind === 'export') return `Exporterar ${w.label.replace(/^Export av /, '')}${pct}`
  if (w.kind === 'import') return `Importerar ${w.label}${pct}`
  if (w.kind === 'run') return w.label.replace(/^Generera saknade i /, 'Generera saknade pågår i ')
  return w.label
}

/** Running kinds that make one of the view's media (counted with its noun); the rest are named one by one. */
const MEDIA_KINDS = new Set<RunningWork['kind']>(['video', 'sending', 'edit-job', 'render', 'voice-design'])

/**
 * A sidebar row's status in words (its tooltip, the rail's second line and the button's accessible label), e.g.
 * Sekvenser "2 tagningar genereras · Exporterar ”Sommar” 40 % · 1 ny tagning · 1 misslyckades". Undefined when
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
  if (!parts.length && counts.running > 0) parts.push(`${counts.running} pågår`)

  const fresh = unseen.filter((w) => w.status === 'completed')
  const freshMedia = fresh.filter((w) => w.kind === 'video' || w.kind === 'version' || w.kind === 'voice').length
  const freshPictures = fresh.filter((w) => w.kind === 'still').length
  const freshExports = fresh.filter((w) => w.kind === 'export').length
  if (noun && freshMedia > 0) parts.push(freshText(noun, freshMedia))
  if (freshPictures > 0) parts.push(freshText('picture', freshPictures))
  if (freshExports > 0) parts.push(freshExports === 1 ? 'En film är exporterad' : `${freshExports} filmer är exporterade`)
  const listedFresh = freshMedia + freshPictures + freshExports
  if (counts.unseen > listedFresh) {
    const more = counts.unseen - listedFresh
    parts.push(listedFresh ? `${more} till att titta på` : more === 1 ? '1 ny att titta på' : `${more} nya att titta på`)
  }
  if (counts.failed > 0) parts.push(failedText(counts.failed))
  return parts.length ? parts.join(' · ') : undefined
}

// ── Times and estimates ──────────────────────────────────────────────────────

const clock = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit' })
const dayAndClock = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "14:32" today, "9 okt 14:32" before that. */
export function timeOfDay(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return (sameDay ? clock : dayAndClock).format(d).replace('.', '')
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
 * The estimate of a running item at `now`: "≈ 1 min kvar" from Venice's own timing (counted down between pushes),
 * "Snart klar" past it, or "1:12 · brukar ta ~3 min" while queued with only the typical time to go by.
 */
export function etaText(w: RunningWork, now: number): string | undefined {
  if (w.remainingMs !== undefined) {
    const left = w.remainingMs - Math.max(0, now - w.measuredAt)
    return left > 1000 ? `≈ ${aboutText(left)} kvar` : 'Snart klar'
  }
  if (w.typicalMs !== undefined && w.typicalMs > 0) {
    return `${elapsedText(now - w.startedAt)} · brukar ta ~${aboutText(w.typicalMs)}`
  }
  return undefined
}

/** A running row's right-hand side: main's phase, then the estimate, then who asked for it. */
export function runningMeta(w: RunningWork, now: number): string {
  const parts: string[] = []
  if (w.detail) parts.push(w.detail)
  else if (w.progress !== undefined) parts.push(`${Math.round(w.progress * 100)} %`)
  const eta = etaText(w, now)
  // "Snart klar" from main already says it.
  if (eta && !(eta === 'Snart klar' && w.detail === 'Snart klar')) parts.push(eta)
  if (w.via) parts.push(`via ${w.via}`)
  return parts.join(' · ')
}

/** "Klar 14:32", "Exporterad 13:58", "Misslyckades 14:30 – {fel}". */
export function finishedMeta(w: FinishedWork, now = Date.now()): string {
  const at = timeOfDay(w.finishedAt, now)
  const via = w.via ? ` · via ${w.via}` : ''
  if (w.status === 'failed') return `Misslyckades ${at}${w.error ? ` – ${w.error}` : ''}${via}`
  return `${w.kind === 'export' ? 'Exporterad' : 'Klar'} ${at}${via}`
}

/** The panel's group heading of a place: "Sekvenser", "Generera", "Redigera" … */
export const VIEW_LABEL: Record<WorkView, string> = {
  generate: 'Generera',
  sequences: 'Sekvenser',
  storyboards: 'Storyboards',
  editor: 'Redigera',
  characters: 'Karaktärer',
  environments: 'Miljöer',
  products: 'Produkter',
  outfits: 'Kläder',
  poses: 'Poser'
}
