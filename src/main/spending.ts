import { ipcMain } from 'electron'
import { roundUsd, type SpentSoFar } from '@shared/budget'
import type { SpendingSummary } from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import * as db from './db'
import { requestedByLedger } from './requested-by'
import { getBudget, setBudget } from './settings'

// Spending (Settings → Spending, get_spending, the budget check): what the library's database records as paid, summed
// per local day, kind, place and who asked. What counts:
//  - a generated video (source 'generated': Generate, sequence clips, storyboard transitions, the Editor's picture
//    operations) that completed, at its quote, on the day it completed. A failed one counts nothing: the services don't
//    charge for a generation that fails. One still rendering is on its way (pendingUsd), not spent;
//  - a generated still at its cost, on the day it was made (a failed picture leaves no row);
//  - an Editor sound job, a transcription (an edit's, or a song's: placed on its sequence) or a voice design at the
//    cost its sent parts added up to (media_jobs.cost, which grows as each part is sent, failed or stopped jobs
//    included), on the day the job was started; the rest of a running job's quote is on its way. A picture
//    operation's cost is its take's (a video above), never its job's.
// Edit media and transcripts repeat their job's cost and are left out. Whatever is deleted (a take, an edit with its
// jobs) drops out of the history; the service's own account is the record of what was billed.

type SpendKind = 'video' | 'image' | 'editor' | 'voice' | 'transcript'

const KIND_LABELS: Record<SpendKind, string> = {
  video: 'Videos',
  image: 'Images',
  editor: 'Editor jobs',
  voice: 'Voices',
  transcript: 'Transcripts'
}

/** The Editor's picture operations: paid through their take (a generation), never through the job's own cost. */
const PICTURE_OPS = "('regenerate', 'prompt-edit', 'extend', 'upscale', 'lip-sync')"

/** Where something paid was made. */
type Place =
  | { kind: 'generate' }
  | { kind: 'sequence' | 'storyboard'; id: string; name: string }
  | { kind: 'edit'; id: string; name: string }
  | { kind: 'voices' }

interface Spend {
  id: string
  at: number
  usd: number
  kind: SpendKind
  place: Place
}

const DAYS = 30

/** Local midnight `back` days before `now`'s day. */
function dayStart(now: Date, back = 0): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime()
}

function monthStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

/** 'YYYY-MM-DD' in local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function sequencePlace(id: string | null, name: string | null, kind: string | null): Place {
  if (!id || name === null) return { kind: 'generate' }
  return { kind: kind === 'storyboard' ? 'storyboard' : 'sequence', id, name }
}

/** Everything recorded as paid since `since` (ms). */
function spendsSince(since: number): Spend[] {
  const conn = db.getDb()
  const out: Spend[] = []

  const videos = conn
    .prepare(
      `SELECT g.id, COALESCE(g.completed_at, g.created_at) AS at, g.quote AS usd, g.edit_id, e.name AS edit_name,
         s.id AS seq_id, s.name AS seq_name, s.kind AS seq_kind
       FROM generations g
       LEFT JOIN segments sg ON sg.id = g.segment_id
       LEFT JOIN sequences s ON s.id = sg.sequence_id
       LEFT JOIN edits e ON e.id = g.edit_id
       WHERE g.source = 'generated' AND g.status = 'completed' AND g.quote > 0
         AND COALESCE(g.completed_at, g.created_at) >= ?`
    )
    .all(since) as {
    id: string
    at: number
    usd: number
    edit_id: string | null
    edit_name: string | null
    seq_id: string | null
    seq_name: string | null
    seq_kind: string | null
  }[]
  for (const r of videos) {
    // An Editor take is the edit's (its picture operation); an edit that is gone leaves it a plain video.
    const place: Place =
      r.edit_id && r.edit_name !== null
        ? { kind: 'edit', id: r.edit_id, name: r.edit_name }
        : sequencePlace(r.seq_id, r.seq_name, r.seq_kind)
    out.push({ id: r.id, at: r.at, usd: r.usd, kind: r.edit_id ? 'editor' : 'video', place })
  }

  const stills = conn
    .prepare(
      `SELECT st.id, st.created_at AS at, st.cost AS usd, s.id AS seq_id, s.name AS seq_name, s.kind AS seq_kind
       FROM stills st LEFT JOIN sequences s ON s.id = st.sequence_id
       WHERE st.source = 'generated' AND st.cost > 0 AND st.created_at >= ?`
    )
    .all(since) as { id: string; at: number; usd: number; seq_id: string | null; seq_name: string | null; seq_kind: string | null }[]
  for (const r of stills) {
    out.push({ id: r.id, at: r.at, usd: r.usd, kind: 'image', place: sequencePlace(r.seq_id, r.seq_name, r.seq_kind) })
  }

  // A song's lyrics (main/song.ts) are a transcription without an edit: the sequence is in its request.
  const jobs = conn
    .prepare(
      `SELECT j.id, j.created_at AS at, j.cost AS usd, j.op, j.edit_id, e.name AS edit_name,
         s.id AS seq_id, s.name AS seq_name, s.kind AS seq_kind
       FROM media_jobs j LEFT JOIN edits e ON e.id = j.edit_id
       LEFT JOIN sequences s ON j.edit_id IS NULL AND j.op = 'transcribe'
         AND s.id = json_extract(CASE WHEN json_valid(j.request) THEN j.request END, '$.sequenceId')
       WHERE j.cost > 0 AND j.op NOT IN ${PICTURE_OPS} AND j.created_at >= ?`
    )
    .all(since) as {
    id: string
    at: number
    usd: number
    op: string
    edit_id: string | null
    edit_name: string | null
    seq_id: string | null
    seq_name: string | null
    seq_kind: string | null
  }[]
  for (const r of jobs) {
    const kind: SpendKind = r.op === 'design-voice' ? 'voice' : r.op === 'transcribe' ? 'transcript' : 'editor'
    const place: Place =
      r.edit_id && r.edit_name !== null
        ? { kind: 'edit', id: r.edit_id, name: r.edit_name }
        : r.seq_id
          ? sequencePlace(r.seq_id, r.seq_name, r.seq_kind)
          : { kind: 'voices' }
    out.push({ id: r.id, at: r.at, usd: r.usd, kind, place })
  }
  return out
}

/** On its way: videos at their service with a quote, and what running Editor jobs and voice designs have to send. */
function pendingUsd(): number {
  const conn = db.getDb()
  const videos = conn
    .prepare(
      `SELECT COALESCE(SUM(quote), 0) FROM generations
       WHERE source = 'generated' AND status IN ('queued', 'processing') AND quote > 0`
    )
    .pluck()
    .get() as number
  const jobs = conn
    .prepare(
      `SELECT COALESCE(SUM(MAX(quote - cost, 0)), 0) FROM media_jobs
       WHERE status = 'running' AND quote > 0 AND op NOT IN ${PICTURE_OPS}`
    )
    .pluck()
    .get() as number
  return videos + jobs
}

/** Today's and this month's spending and what is on its way, for the budget check (zero without a library). */
export function spentSoFar(now = new Date()): SpentSoFar {
  if (!db.isDbOpen()) return { todayUsd: 0, monthUsd: 0, pendingUsd: 0 }
  const today = dayStart(now)
  let todayUsd = 0
  let monthUsd = 0
  for (const s of spendsSince(monthStart(now))) {
    monthUsd += s.usd
    if (s.at >= today) todayUsd += s.usd
  }
  return { todayUsd: roundUsd(todayUsd), monthUsd: roundUsd(monthUsd), pendingUsd: roundUsd(pendingUsd()) }
}

function placeKey(p: Place): string {
  return p.kind === 'generate' || p.kind === 'voices' ? p.kind : `${p.kind}:${p.id}`
}

function placeEntry(p: Place, usd: number): SpendingSummary['byPlace'][number] {
  switch (p.kind) {
    case 'generate':
      return { label: 'Generate', usd }
    case 'voices':
      return { label: 'Character voices', usd }
    case 'sequence':
      return { label: p.name, usd, sequenceId: p.id }
    case 'storyboard':
      return { label: p.name, usd, storyboardId: p.id }
    case 'edit':
      return { label: p.name, usd, editId: p.id }
  }
}

function add<K>(map: Map<K, number>, key: K, usd: number): void {
  map.set(key, (map.get(key) ?? 0) + usd)
}

/** The whole overview: today, this month, the last 30 days, and this month by kind, place and who asked. */
export function spendingSummary(now = new Date()): SpendingSummary {
  const budget = getBudget()
  const empty: SpendingSummary = {
    todayUsd: 0,
    monthUsd: 0,
    budget,
    days: Array.from({ length: DAYS }, (_, i) => ({ day: dayKey(dayStart(now, DAYS - 1 - i)), usd: 0 })),
    last30Usd: 0,
    byKind: [],
    byPlace: [],
    byWho: [],
    pendingUsd: 0
  }
  if (!db.isDbOpen()) return empty

  const today = dayStart(now)
  const month = monthStart(now)
  const first = dayStart(now, DAYS - 1)
  const spends = spendsSince(Math.min(first, month))
  const who = requestedByLedger()

  const perDay = new Map<string, number>()
  const kinds = new Map<SpendKind, number>()
  const places = new Map<string, { place: Place; usd: number }>()
  const people = new Map<string, number>()
  let todayUsd = 0
  let monthUsd = 0
  let last30Usd = 0
  for (const s of spends) {
    if (s.at >= first) {
      add(perDay, dayKey(s.at), s.usd)
      last30Usd += s.usd
    }
    if (s.at >= today) todayUsd += s.usd
    if (s.at < month) continue
    monthUsd += s.usd
    add(kinds, s.kind, s.usd)
    const key = placeKey(s.place)
    const entry = places.get(key) ?? { place: s.place, usd: 0 }
    entry.usd += s.usd
    places.set(key, entry)
    add(people, who.get(s.id) ?? 'user', s.usd)
  }

  const byDesc = <T extends { usd: number }>(a: T, b: T): number => b.usd - a.usd
  return {
    ...empty,
    todayUsd: roundUsd(todayUsd),
    monthUsd: roundUsd(monthUsd),
    days: empty.days.map((d) => ({ day: d.day, usd: roundUsd(perDay.get(d.day) ?? 0) })),
    last30Usd: roundUsd(last30Usd),
    byKind: [...kinds]
      .map(([kind, usd]) => ({ kind, label: KIND_LABELS[kind], usd: roundUsd(usd) }))
      .filter((k) => k.usd > 0)
      .sort(byDesc),
    byPlace: [...places.values()]
      .map((e) => placeEntry(e.place, roundUsd(e.usd)))
      .filter((p) => p.usd > 0)
      .sort(byDesc),
    // The user first, then each agent, most first.
    byWho: [...people]
      .map(([name, usd]) => ({ who: name, usd: roundUsd(usd) }))
      .filter((w) => w.usd > 0)
      .sort((a, b) => (a.who === 'user' ? -1 : b.who === 'user' ? 1 : b.usd - a.usd)),
    pendingUsd: roundUsd(pendingUsd())
  }
}

/**
 * `spending:get` (the window and get_spending) and `settings:setBudget` (the user only: an agent never changes the
 * budget). `changed` runs after the budget is saved, so every view showing settings follows.
 */
export function registerSpendingIpc(changed: () => void): void {
  ipcMain.handle('spending:get', () => spendingSummary())
  ipcMain.handle('settings:setBudget', (e, budget: unknown) => {
    if (isAgentCall(e)) throw new Error('Only you can do this in Studio.')
    setBudget(budget)
    changed()
  })
}
