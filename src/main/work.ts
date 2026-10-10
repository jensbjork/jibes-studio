// "Pågår och klart": what Studio is doing right now and what finished that the user hasn't looked at yet, wherever it
// was started. One summary (WorkSummary) is built here from two halves and pushed whole to the windows as
// `work:change`:
// - running: videos at Venice (pending generations rows) and what only lives in the services' memory, read through
//   their small registries: takes and form generations on their way to Venice, "Generera saknade" runs, pictures
//   being made, Redigera's paid jobs and free renders, exports, imports of own clips, approved agent requests being
//   carried out and agents' uploads;
// - finished but not seen: the library's `unseen` table. A row is added where work finishes (a video settling, a
//   still saved, an export placed, a paid version or a designed voice written, a paid job or a picture, export or run
//   failing) and leaves only through the user's work:markSeen / work:markAllSeen, or with the item itself (its foreign
//   key cascades; an error-only row goes with its owner, see dropOrphans).
// Every item counts under one sidebar view and its owner (a sequence, storyboard, edit or asset) and clip, so the
// sidebar, the lists and the cards read their counts from the same summary. Agents may read it (get_work_status) but
// never mark anything seen. Building the summary (buildWorkSummary) is pure, so it is tested on its own.

import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { agentDisplayName } from '@shared/agent-name'
import { generationTitle } from '@shared/generation-label'
import {
  workKey,
  type ApprovalRequest,
  type FinishedWork,
  type Generation,
  type ImportTarget,
  type RunningWork,
  type SeenScope,
  type SegmentImageSlot,
  type UnseenRef,
  type WorkCounts,
  type WorkSummary,
  type WorkTarget,
  type WorkView
} from '@shared/types'
import type { ExecutingApproval } from './agent/approvals'
import { isAgentCall } from './agent/local-ipc'
import type { UploadWork } from './agent/uploads'
import * as db from './db'
import type { EditActiveWork } from './edit-ops'
import type { EditServiceHandle } from './edits'
import type { ImportService } from './imports'
import type { JobManager, SendingSubmit } from './jobs'
import { fromStoredPath } from './paths'
import type { SequenceActiveWork, SequenceService } from './sequences'
import { typicalStillMs, type StillWork } from './stills'
import type { StoryboardService } from './storyboards'

/** Said when an agent's call reaches what only the user may do (marking things seen). */
const USER_ONLY = 'Det här kan bara du göra i Studio.'

/** A structural change is pushed this long after the last one in a burst ("trailing")… */
const STRUCTURE_DEBOUNCE_MS = 120
/** …but a steady stream of changes never holds the push back longer than this. */
const STRUCTURE_MAX_WAIT_MS = 500
/** Progress alone (a percentage, a poll's timings) is pushed at most this often. */
const PROGRESS_INTERVAL_MS = 1000
/** How long "Markera alla som sedda" can be undone. */
const UNDO_MS = 10_000
/**
 * The summary lists at most this many finished items (the newest) in full; its counts are always exact, and the rest
 * come as small references (UnseenRef) so the window can still tell them apart and mark them seen.
 */
const MAX_LISTED = 200
/** An ffmpeg job says how long it has left once it is this far in… */
const ETA_MIN_FRACTION = 0.05
/** …and has run this long, so the first jumpy percentages don't make up a time. */
const ETA_MIN_ELAPSED_MS = 3000
/** The longest prompt excerpt in a label. */
const EXCERPT = 60

/** Broadcasts that never change what runs or what is new. */
const IGNORED = new Set([
  'work:change',
  'agent:activity',
  'agent:status',
  'agent:command',
  'settings:change',
  'review:change',
  'learnings:change'
])

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Names and places the labels need, read once per summary. Positions are 0-based, as stored. */
export interface WorkNames {
  sequences: Record<string, { name: string; kind: 'sequence' | 'storyboard' }>
  /** Clips and transitions. */
  segments: Record<string, { sequenceId: string; position: number }>
  boards: Record<string, { storyboardId: string; position: number }>
  edits: Record<string, { name: string }>
  assets: Record<string, { name: string; kind: string }>
}

/** A row of `unseen` joined with the item it is about (paths absolute). */
export interface UnseenJoinedRow {
  id: string
  createdAt: number
  error?: string
  label?: string
  context: db.UnseenContext
  generation?: Pick<Generation, 'id' | 'status' | 'source' | 'prompt' | 'createdAt'> &
    Partial<Pick<Generation, 'title' | 'segmentId' | 'editId' | 'filePath' | 'thumbPath' | 'error'>> & {
      /** A version's number and label (its recipe). */
      versionNumber?: number
      versionLabel?: string
    }
  still?: { id: string; sequenceId?: string; path: string; prompt: string; firstBoardId?: string }
  export?: { id: string; sequenceId?: string; path: string }
  audio?: { id: string; assetId: string; path: string }
  job?: { id: string; editId?: string; assetId?: string; status: string; error?: string; label: string }
}

/** A Venice generation still queued or processing. */
export type PendingRow = Pick<Generation, 'id' | 'status' | 'model' | 'prompt' | 'createdAt'> &
  Partial<Pick<Generation, 'segmentId' | 'editId' | 'averageExecutionTime' | 'executionDuration' | 'title'>> & {
    /** A picture it starts from (or its first reference), shown as its thumbnail. */
    thumbPath?: string
  }

/** What runs in memory, read from the services' registries (see WorkSources). */
export interface Registries {
  /** Takes on their way to Venice (the sequence service's, by clip). */
  clipSending: SequenceActiveWork['sending']
  /** Every submit on its way to Venice (the job manager's): form generations, clips' takes, edits' AI takes. */
  sending: SendingSubmit[]
  sequenceRuns: SequenceActiveWork['runs']
  storyboardRuns: { storyboardId: string; startedAt: number; total: number; sent: number; approved?: boolean }[]
  exports: SequenceActiveWork['exports']
  stills: StillWork[]
  editJobs: EditActiveWork['jobs']
  renders: EditActiveWork['renders']
  imports: { path: string; name: string; fraction: number; target: ImportTarget; startedAt: number }[]
  /** Approved agent requests being carried out right now. */
  executing: ExecutingApproval[]
  /** The agent requests the store remembers (any status): who asked for what an approval made. */
  approvals: ApprovalRequest[]
  uploads: UploadWork[]
  /** What a video of each model usually takes (ms), for the models of running videos. */
  typicalVideo: Record<string, number | undefined>
  /** What a picture of each model usually takes (ms), for the models of pictures being made. */
  typicalStill: Record<string, number | undefined>
  /** When each pending generation's last update arrived (its timings were measured then). */
  measuredAt: Record<string, number>
  /** Posters of generations that running work names (an edit job's base version). */
  posters: Record<string, string | undefined>
  names: WorkNames
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const percent = (fraction: number): number => Math.round(Math.min(1, Math.max(0, fraction)) * 100)

/** "”A woman walks along the pier…”": a generation's name in a label. */
function quoted(text: string): string {
  return `”${text}”`
}

/** The sidebar view of an asset kind (the renderer's View ids). */
export function assetView(kind: string | undefined): WorkView {
  switch (kind) {
    case 'environment':
      return 'environments'
    case 'product':
      return 'products'
    case 'outfit':
      return 'outfits'
    case 'pose':
      return 'poses'
    default:
      return 'characters'
  }
}

/** Where an item of a sequence or a storyboard goes: its view, owner, clip, label prefix and jump target. */
interface Place {
  view: WorkView
  ownerId?: string
  segmentId?: string
  target: WorkTarget
}

/** A clip of a sequence or a transition of a storyboard, with "Klipp 3 i ”Sommar”" / "Övergång 2 i ”Resa”". */
function segmentPlace(
  names: WorkNames,
  segmentId: string,
  extra: Partial<WorkTarget> = {}
): (Place & { label: string }) | undefined {
  const segment = names.segments[segmentId]
  const sequence = segment && names.sequences[segment.sequenceId]
  if (!segment || !sequence) return undefined
  const number = segment.position + 1
  if (sequence.kind === 'storyboard') {
    return {
      view: 'storyboards',
      ownerId: segment.sequenceId,
      segmentId,
      label: `Övergång ${number} i ”${sequence.name}”`,
      target: { view: 'storyboards', storyboardId: segment.sequenceId, transitionId: segmentId, ...extra }
    }
  }
  return {
    view: 'sequences',
    ownerId: segment.sequenceId,
    segmentId,
    label: `Klipp ${number} i ”${sequence.name}”`,
    target: { view: 'sequences', sequenceId: segment.sequenceId, segmentId, ...extra }
  }
}

/** A sequence or a storyboard as a whole (an export, a run). */
function sequencePlace(names: WorkNames, sequenceId: string | undefined, extra: Partial<WorkTarget> = {}): Place {
  const sequence = sequenceId ? names.sequences[sequenceId] : undefined
  if (sequence?.kind === 'storyboard') {
    return { view: 'storyboards', ownerId: sequenceId, target: { view: 'storyboards', storyboardId: sequenceId, ...extra } }
  }
  return {
    view: 'sequences',
    ...(sequenceId && sequence ? { ownerId: sequenceId } : {}),
    target: { view: 'sequences', ...(sequenceId && sequence ? { sequenceId } : {}), ...extra }
  }
}

/** A picture's place and label: "Bild till ruta 3 i ”Resa”", "Bild till klipp 2 i ”Sommar”", "Bild i ”…”", "Bild". */
function stillPlace(
  names: WorkNames,
  where: { sequenceId?: string; boardId?: string; segmentId?: string; slot?: SegmentImageSlot },
  extra: Partial<WorkTarget> = {}
): Place & { label: string } {
  const board = where.boardId ? names.boards[where.boardId] : undefined
  const boardOwner = board && names.sequences[board.storyboardId]
  if (board && boardOwner) {
    return {
      view: 'storyboards',
      ownerId: board.storyboardId,
      label: `Bild till ruta ${board.position + 1} i ”${boardOwner.name}”`,
      target: { view: 'storyboards', storyboardId: board.storyboardId, boardId: where.boardId, ...extra }
    }
  }
  const clip = where.segmentId ? names.segments[where.segmentId] : undefined
  const clipOwner = clip && names.sequences[clip.sequenceId]
  if (clip && clipOwner) {
    const storyboard = clipOwner.kind === 'storyboard'
    return {
      view: storyboard ? 'storyboards' : 'sequences',
      ownerId: clip.sequenceId,
      segmentId: where.segmentId,
      label: `Bild till ${storyboard ? 'övergång' : 'klipp'} ${clip.position + 1} i ”${clipOwner.name}”`,
      target: storyboard
        ? { view: 'storyboards', storyboardId: clip.sequenceId, transitionId: where.segmentId, ...extra }
        : { view: 'sequences', sequenceId: clip.sequenceId, segmentId: where.segmentId, ...extra }
    }
  }
  const sequence = where.sequenceId ? names.sequences[where.sequenceId] : undefined
  if (where.sequenceId && sequence) {
    return { ...sequencePlace(names, where.sequenceId, extra), label: `Bild i ”${sequence.name}”` }
  }
  return { view: 'generate', label: 'Bild', target: { view: 'generate', ...extra } }
}

/** An edit's name in a label ("”Intervju”"), or a stand-in when it is gone. */
function editName(names: WorkNames, editId: string | undefined): string {
  const edit = editId ? names.edits[editId] : undefined
  return edit ? quoted(edit.name) : 'Redigeringen'
}

/** The time an ffmpeg job has left, once it is far enough in to tell (elapsed × (1 − f) / f). */
function ffmpegRemaining(startedAt: number, fraction: number | undefined, now: number): number | undefined {
  const elapsed = now - startedAt
  if (fraction === undefined || fraction < ETA_MIN_FRACTION || elapsed < ETA_MIN_ELAPSED_MS) return undefined
  return Math.max(0, Math.round((elapsed * (1 - fraction)) / fraction))
}

/** "Del 2 av 3" from "del 2 av 3": a phase starts with a capital letter. */
function capitalized(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** A video at Venice: its phase, progress and what is left (as measured at `measuredAt`). */
function videoProgress(
  g: PendingRow,
  reg: Registries,
  now: number
): Pick<RunningWork, 'detail' | 'progress' | 'remainingMs' | 'typicalMs' | 'measuredAt'> {
  const typicalMs = reg.typicalVideo[g.model]
  const measuredAt = reg.measuredAt[g.id] ?? now
  if (g.status === 'queued') return { detail: 'I kö hos Venice', measuredAt, ...(typicalMs ? { typicalMs } : {}) }
  const avg = g.averageExecutionTime
  const exec = g.executionDuration
  if (avg && avg > 0 && typeof exec === 'number' && exec >= 0) {
    const progress = Math.min(0.97, exec / avg)
    return {
      detail: exec >= avg ? 'Snart klar' : `Genererar ${percent(progress)} %`,
      progress,
      remainingMs: Math.max(0, Math.round(avg - exec)),
      measuredAt,
      ...(typicalMs ? { typicalMs } : {})
    }
  }
  return { detail: 'Genererar', measuredAt, ...(typicalMs ? { typicalMs } : {}) }
}

/** What a running video has left from `now`: Venice's own estimate, else the typical time less what has passed. */
function videoLeft(g: PendingRow, reg: Registries, now: number): number | undefined {
  const p = videoProgress(g, reg, now)
  if (p.remainingMs !== undefined) return Math.max(0, p.remainingMs - (now - p.measuredAt))
  const typical = reg.typicalVideo[g.model]
  return typical ? Math.max(0, typical - (now - g.createdAt)) : undefined
}

// ── Running ──────────────────────────────────────────────────────────────────

/** The view an approved request being carried out counts under: where what it makes ends up. */
function approvalView(a: ExecutingApproval, request: ApprovalRequest | undefined, names: WorkNames): WorkView | undefined {
  switch (a.kind) {
    case 'generation':
      return 'generate'
    case 'segment':
    case 'generate-all':
      return sequencePlace(names, a.sequenceId).view
    case 'image':
      return a.sequenceId ? sequencePlace(names, a.sequenceId).view : 'generate'
    case 'edit':
      return 'editor'
    case 'voice-design':
      return assetView(request?.edit?.assetId ? names.assets[request.edit.assetId]?.kind : undefined)
    default:
      return undefined
  }
}

/**
 * Whether an approved request being carried out already shows as the work it started (its take on the way, its run,
 * its picture, its job): then that item carries the agent's name instead, and the request isn't counted twice.
 */
function covers(a: ExecutingApproval, request: ApprovalRequest | undefined, item: RunningWork): boolean {
  if (item.startedAt < a.startedAt - 1000) return false
  switch (a.kind) {
    case 'generation':
      return (item.kind === 'sending' || item.kind === 'video') && item.view === 'generate'
    case 'segment':
      return (item.kind === 'sending' || item.kind === 'video') && !!item.segmentId && !!a.segmentIds?.includes(item.segmentId)
    case 'generate-all':
      return item.kind === 'run' && item.ownerId === a.sequenceId
    case 'image':
      return item.kind === 'still' && (!a.sequenceId || item.ownerId === a.sequenceId)
    case 'edit':
      return item.kind === 'edit-job' && !!request?.edit?.editId && item.ownerId === request.edit.editId
    case 'voice-design':
      return item.kind === 'voice-design' && !!request?.edit?.assetId && item.ownerId === request.edit.assetId
    default:
      return false
  }
}

function runningItems(pending: readonly PendingRow[], reg: Registries, now: number): RunningWork[] {
  const { names } = reg
  const items: RunningWork[] = []
  // Edits' AI takes that a running picture job stands for (its row shows the take's progress).
  const jobTakes = new Map(reg.editJobs.filter((j) => j.takeId).map((j) => [j.takeId!, j]))
  const pendingById = new Map(pending.map((g) => [g.id, g]))

  // Videos at Venice.
  for (const g of pending) {
    if (jobTakes.has(g.id)) continue
    const progress = videoProgress(g, reg, now)
    const base = {
      key: workKey.generation(g.id),
      kind: 'video' as const,
      startedAt: g.createdAt,
      generationId: g.id,
      ...(g.thumbPath ? { thumbPath: g.thumbPath } : {}),
      ...progress
    }
    const place = g.segmentId ? segmentPlace(names, g.segmentId, { generationId: g.id }) : undefined
    if (place) {
      const { label, ...where } = place
      items.push({ ...base, ...where, label })
    } else if (g.editId) {
      items.push({
        ...base,
        view: 'editor',
        ownerId: g.editId,
        label: `${editName(names, g.editId)} – tagning`,
        target: { view: 'editor', editId: g.editId, generationId: g.id }
      })
    } else {
      items.push({
        ...base,
        view: 'generate',
        label: quoted(generationTitle(g, EXCERPT)),
        target: { view: 'generate', generationId: g.id }
      })
    }
  }

  // Takes and generations on their way to Venice. A clip's take is the sequence service's from its first step (frames,
  // quote); the job manager's own record of it would be the same take twice. An edit's AI take is its job's.
  const clipsSending = new Set(reg.clipSending.map((s) => s.segmentId))
  for (const s of reg.clipSending) {
    const place = segmentPlace(names, s.segmentId)
    if (!place) continue
    const { label, ...where } = place
    items.push({
      key: `send:${s.segmentId}`,
      kind: 'sending',
      ...where,
      label,
      detail: 'Skickas till Venice',
      startedAt: s.startedAt,
      measuredAt: now
    })
  }
  for (const s of reg.sending) {
    if (s.editId || (s.segmentId && clipsSending.has(s.segmentId))) continue
    const place = s.segmentId ? segmentPlace(names, s.segmentId) : undefined
    const typicalMs = reg.typicalVideo[s.model]
    const common = {
      key: `send:${s.token}`,
      kind: 'sending' as const,
      detail: 'Skickas till Venice',
      startedAt: s.startedAt,
      measuredAt: now,
      ...(typicalMs ? { typicalMs } : {})
    }
    if (place) {
      const { label, ...where } = place
      items.push({ ...common, ...where, label })
    } else {
      items.push({
        ...common,
        view: 'generate',
        label: quoted(generationTitle({ prompt: s.prompt }, EXCERPT)),
        target: { view: 'generate' }
      })
    }
  }

  // "Generera saknade".
  for (const run of reg.sequenceRuns) {
    const sequence = names.sequences[run.sequenceId]
    if (!sequence) continue
    const total = Math.max(run.total, run.done, 1)
    const current = Math.min(run.done + 1, total)
    // What the clip at Venice has left, and the clips after it at the time a video of its model usually takes.
    const take = run.currentSegmentId
      ? pending.find((g) => g.segmentId === run.currentSegmentId)
      : undefined
    const typical = take ? reg.typicalVideo[take.model] : undefined
    const left = take ? videoLeft(take, reg, now) : undefined
    const remainingMs =
      left !== undefined && typical ? left + Math.max(0, total - run.done - 1) * typical : undefined
    items.push({
      key: `run:${run.sequenceId}`,
      kind: 'run',
      ...sequencePlace(names, run.sequenceId),
      label: `Generera saknade i ”${sequence.name}”`,
      detail: `Klipp ${current} av ${total}`,
      startedAt: run.startedAt,
      progress: run.done / total,
      ...(remainingMs !== undefined ? { remainingMs } : {}),
      measuredAt: now
    })
  }
  for (const run of reg.storyboardRuns) {
    const storyboard = names.sequences[run.storyboardId]
    if (!storyboard) continue
    const total = Math.max(run.total, run.sent, 1)
    items.push({
      key: `run:${run.storyboardId}`,
      kind: 'run',
      ...sequencePlace(names, run.storyboardId),
      label: `Generera saknade i ”${storyboard.name}”`,
      detail: `Övergång ${Math.min(run.sent + 1, total)} av ${total}`,
      startedAt: run.startedAt,
      progress: run.sent / total,
      measuredAt: now
    })
  }

  // Pictures being made ("Skapa bild…", an agent's image request).
  for (const s of reg.stills) {
    const { label, ...where } = stillPlace(names, s)
    const typicalMs = reg.typicalStill[s.model]
    items.push({
      key: `still:${s.token}`,
      kind: 'still',
      ...where,
      label,
      detail: 'Skapar bilden…',
      startedAt: s.startedAt,
      measuredAt: now,
      ...(typicalMs ? { typicalMs } : {})
    })
  }

  // Redigera: paid jobs (and designed voices), free renders.
  for (const job of reg.editJobs) {
    const take = job.takeId ? pendingById.get(job.takeId) : undefined
    if (!job.editId && job.assetId) {
      const asset = names.assets[job.assetId]
      const view = assetView(asset?.kind)
      items.push({
        key: workKey.job(job.jobId),
        kind: 'voice-design',
        view,
        ownerId: job.assetId,
        label: asset ? `Ny röst till ”${asset.name}”` : 'Ny röst',
        detail: 'Skapar rösten…',
        startedAt: job.startedAt,
        measuredAt: now,
        target: { view, assetId: job.assetId, jobId: job.jobId }
      })
      continue
    }
    const fromTake = take ? videoProgress(take, reg, now) : undefined
    const progress = fromTake?.progress ?? job.fraction
    const detail =
      fromTake?.detail ??
      (job.currentStep ? capitalized(job.currentStep) : progress !== undefined ? `${percent(progress)} %` : undefined)
    const poster = job.baseId ? reg.posters[job.baseId] : undefined
    items.push({
      key: workKey.job(job.jobId),
      kind: 'edit-job',
      view: 'editor',
      ...(job.editId ? { ownerId: job.editId } : {}),
      label: `${editName(names, job.editId)} – ${job.label}`,
      ...(detail ? { detail } : {}),
      startedAt: job.startedAt,
      ...(progress !== undefined ? { progress } : {}),
      ...(fromTake?.remainingMs !== undefined ? { remainingMs: fromTake.remainingMs } : {}),
      ...(fromTake?.typicalMs ? { typicalMs: fromTake.typicalMs } : {}),
      measuredAt: fromTake?.measuredAt ?? now,
      ...(poster ? { thumbPath: poster } : {}),
      ...(job.takeId ? { generationId: job.takeId } : {}),
      target: { view: 'editor', ...(job.editId ? { editId: job.editId } : {}), jobId: job.jobId }
    })
  }
  for (const r of reg.renders) {
    const remainingMs = ffmpegRemaining(r.startedAt, r.fraction, now)
    items.push({
      key: `render:${r.token}`,
      kind: 'render',
      view: 'editor',
      ownerId: r.editId,
      label: `${editName(names, r.editId)} – ${r.label}`,
      detail: r.fraction > 0 ? `Skapar versionen ${percent(r.fraction)} %` : 'Skapar versionen…',
      startedAt: r.startedAt,
      progress: r.fraction,
      ...(remainingMs !== undefined ? { remainingMs } : {}),
      measuredAt: now,
      target: { view: 'editor', editId: r.editId }
    })
  }

  // Exports.
  for (const e of reg.exports) {
    const sequence = names.sequences[e.sequenceId]
    if (!sequence) continue
    const remainingMs = ffmpegRemaining(e.startedAt, e.progress, now)
    items.push({
      key: `export:${e.sequenceId}`,
      kind: 'export',
      ...sequencePlace(names, e.sequenceId),
      label: `Export av ”${sequence.name}”`,
      detail: `Exporterar ${percent(e.progress)} %`,
      startedAt: e.startedAt,
      progress: e.progress,
      ...(remainingMs !== undefined ? { remainingMs } : {}),
      measuredAt: now
    })
  }

  // Own clips being imported.
  for (const f of reg.imports) {
    const t = f.target
    // Into a clip, as new clips of a sequence, or into the clip feed (Generera).
    const where: Place = (t.kind === 'segment' ? segmentPlace(names, t.segmentId) : undefined) ??
      (t.kind === 'sequence' && names.sequences[t.sequenceId] ? sequencePlace(names, t.sequenceId) : undefined) ?? {
        view: 'generate',
        target: { view: 'generate' }
      }
    const remainingMs = ffmpegRemaining(f.startedAt, f.fraction, now)
    items.push({
      key: `import:${f.path}`,
      kind: 'import',
      view: where.view,
      ...(where.ownerId ? { ownerId: where.ownerId } : {}),
      ...(where.segmentId ? { segmentId: where.segmentId } : {}),
      label: f.name,
      detail: `Importerar ${percent(f.fraction)} %`,
      startedAt: f.startedAt,
      progress: f.fraction,
      ...(remainingMs !== undefined ? { remainingMs } : {}),
      measuredAt: now,
      target: where.target
    })
  }

  // Agents' uploads: shown in the panel and the totals only (they belong to no view until a tool uses them).
  for (const u of reg.uploads) {
    const fraction = u.bytes ? Math.min(1, u.received / u.bytes) : undefined
    const detail =
      u.status === 'checking'
        ? 'Kontrollerar…'
        : u.status === 'downloading'
          ? fraction !== undefined
            ? `Hämtar ${percent(fraction)} %`
            : 'Hämtar…'
          : fraction !== undefined
            ? `${percent(fraction)} %`
            : 'Tar emot…'
    items.push({
      key: `upload:${u.id}`,
      kind: 'upload',
      label: `${agentDisplayName(u.client)} laddar upp ${u.fileName}`,
      detail,
      startedAt: u.startedAt,
      ...(fraction !== undefined && u.status !== 'checking' ? { progress: fraction } : {}),
      measuredAt: now,
      via: u.client
    })
  }

  // What an approved request started (its videos, its Redigera job) carries the agent's name while it runs.
  const via = viaByKey(reg)
  for (const item of items) {
    const agent = via.get(item.key)
    if (agent) item.via ??= agent
  }

  // Approved agent requests being carried out: the work they started carries the agent's name; a request that shows
  // as nothing else yet (being checked, a delete being carried out) is listed as itself.
  const requests = new Map(reg.approvals.map((r) => [r.id, r]))
  for (const a of reg.executing) {
    const request = requests.get(a.id)
    const covered = items.filter((item) => item.kind !== 'approval' && covers(a, request, item))
    for (const item of covered) item.via ??= a.client
    if (covered.length) continue
    const view = approvalView(a, request, reg.names)
    items.push({
      key: `approval:${a.id}`,
      kind: 'approval',
      ...(view ? { view } : {}),
      ...(view && a.sequenceId && names.sequences[a.sequenceId] ? { ownerId: a.sequenceId } : {}),
      label: `${agentDisplayName(a.client)}: ${a.summary}`,
      detail: 'Genomförs…',
      startedAt: a.startedAt,
      measuredAt: now,
      via: a.client,
      target: { view: view ?? 'generate', approvalId: a.id }
    })
  }

  // Videos and runs of a sequence an approved "Generera saknade" started carry the agent's name too.
  for (const run of [...reg.sequenceRuns, ...reg.storyboardRuns]) {
    if (!run.approved) continue
    const sequenceId = 'sequenceId' in run ? run.sequenceId : run.storyboardId
    const request = [...reg.approvals]
      .reverse()
      .find((r) => r.kind === 'generate-all' && r.status === 'approved' && r.sequenceId === sequenceId)
    if (!request) continue
    for (const item of items) {
      if (item.ownerId !== sequenceId || item.startedAt < run.startedAt) continue
      if (item.kind === 'run' || item.kind === 'sending' || item.kind === 'video') item.via ??= request.client
    }
  }

  // Newest first.
  return items.sort((a, b) => b.startedAt - a.startedAt)
}

// ── Finished, not seen ───────────────────────────────────────────────────────

/** Who asked for what an approval made: the agent's name by item key. */
function viaByKey(reg: Pick<Registries, 'approvals'>): Map<string, string> {
  const via = new Map<string, string>()
  for (const r of reg.approvals) {
    if (r.status !== 'approved') continue
    for (const id of r.generationIds ?? []) via.set(workKey.generation(id), r.client)
    if (r.stillId) via.set(workKey.still(r.stillId), r.client)
    if (r.edit?.resultId) via.set(workKey.generation(r.edit.resultId), r.client)
    if (r.edit?.jobId) via.set(workKey.job(r.edit.jobId), r.client)
  }
  return via
}

/** A finished item and the row it comes from. */
interface FinishedEntry {
  item: FinishedWork
  rowId: string
}

function finishedItem(row: UnseenJoinedRow, names: WorkNames): FinishedWork | undefined {
  const finishedAt = row.createdAt
  const g = row.generation
  if (g) {
    const failed = g.status === 'failed'
    if (!failed && g.status !== 'completed') return undefined
    const common = {
      key: workKey.generation(g.id),
      status: failed ? ('failed' as const) : ('completed' as const),
      finishedAt,
      generationId: g.id,
      ...(failed ? { error: g.error || 'Genereringen misslyckades.' } : {}),
      ...(!failed && g.filePath ? { mediaPath: g.filePath } : {}),
      ...(g.thumbPath ? { thumbPath: g.thumbPath } : {})
    }
    if (g.source === 'edit' && g.editId) {
      const number = g.versionNumber ? ` v${g.versionNumber}` : ''
      const label = `${editName(names, g.editId)}${number}${g.versionLabel ? ` – ${g.versionLabel}` : ''}`
      return {
        ...common,
        kind: 'version',
        view: 'editor',
        ownerId: g.editId,
        label,
        target: { view: 'editor', editId: g.editId, versionId: g.id }
      }
    }
    const place = g.segmentId ? segmentPlace(names, g.segmentId, { generationId: g.id }) : undefined
    if (place) {
      const { label, ...where } = place
      return { ...common, kind: 'video', ...where, label }
    }
    if (g.editId) {
      return {
        ...common,
        kind: 'video',
        view: 'editor',
        ownerId: g.editId,
        label: `${editName(names, g.editId)} – tagning`,
        target: { view: 'editor', editId: g.editId, generationId: g.id }
      }
    }
    return {
      ...common,
      kind: 'video',
      view: 'generate',
      label: quoted(generationTitle(g, EXCERPT)),
      target: { view: 'generate', generationId: g.id }
    }
  }

  if (row.still) {
    const s = row.still
    const { label, ...where } = stillPlace(
      names,
      {
        sequenceId: s.sequenceId,
        boardId: row.context.boardId ?? s.firstBoardId,
        segmentId: row.context.segmentId,
        slot: row.context.slot
      },
      { stillId: s.id }
    )
    return {
      key: workKey.still(s.id),
      kind: 'still',
      status: 'completed',
      ...where,
      label,
      finishedAt,
      thumbPath: s.path,
      stillId: s.id,
      ...(row.context.workToken ? { workToken: row.context.workToken } : {})
    }
  }

  if (row.export) {
    const x = row.export
    const sequence = x.sequenceId ? names.sequences[x.sequenceId] : undefined
    const name = sequence?.name ?? basename(x.path, extname(x.path))
    return {
      key: workKey.export(x.id),
      kind: 'export',
      status: 'completed',
      ...sequencePlace(names, x.sequenceId, { exportId: x.id }),
      label: `Export av ”${name}”`,
      finishedAt,
      mediaPath: x.path,
      exportId: x.id
    }
  }

  if (row.audio) {
    const a = row.audio
    const asset = names.assets[a.assetId]
    const view = assetView(asset?.kind)
    return {
      key: workKey.audio(a.id),
      kind: 'voice',
      status: 'completed',
      view,
      ownerId: a.assetId,
      label: asset ? `Ny röst till ”${asset.name}”` : 'Ny röst',
      finishedAt,
      mediaPath: a.path,
      audioId: a.id,
      target: { view, assetId: a.assetId, audioId: a.id }
    }
  }

  if (row.job) {
    const j = row.job
    if (j.status !== 'failed') return undefined
    const common = {
      key: workKey.job(j.id),
      kind: 'job' as const,
      status: 'failed' as const,
      error: j.error || 'Jobbet misslyckades.',
      finishedAt,
      jobId: j.id
    }
    if (!j.editId) {
      // A voice design: the asset's. Its character deleted (asset_id set null) leaves nothing to show it on.
      if (!j.assetId) return undefined
      const asset = names.assets[j.assetId]
      const view = assetView(asset?.kind)
      return {
        ...common,
        view,
        ownerId: j.assetId,
        label: asset ? `Ny röst till ”${asset.name}”` : 'Ny röst',
        target: { view, assetId: j.assetId, jobId: j.id }
      }
    }
    return {
      ...common,
      view: 'editor',
      ...(j.editId ? { ownerId: j.editId } : {}),
      label: `${editName(names, j.editId)} – ${j.label}`,
      target: { view: 'editor', ...(j.editId ? { editId: j.editId } : {}), jobId: j.id }
    }
  }

  // A failure with no row of its own: a picture that wasn't made, an export or a run that stopped on a problem.
  if (!row.error || !row.label) return undefined
  const c = row.context
  const failureOf = c.failureOf
  const common = {
    key: workKey.row(row.id),
    kind: 'failure' as const,
    status: 'failed' as const,
    label: row.label,
    error: row.error,
    finishedAt,
    ...(failureOf ? { failureOf } : {}),
    ...(c.workToken ? { workToken: c.workToken } : {})
  }
  if (failureOf === 'still') {
    const { label: _label, ...where } = stillPlace(names, c)
    return { ...common, ...where }
  }
  if (c.assetId && !c.sequenceId) {
    const view = assetView(names.assets[c.assetId]?.kind)
    return { ...common, view, ownerId: c.assetId, target: { view, assetId: c.assetId } }
  }
  if (c.editId && !c.sequenceId) {
    return { ...common, view: 'editor', ownerId: c.editId, target: { view: 'editor', editId: c.editId } }
  }
  const sequenceId = c.sequenceId ?? c.storyboardId
  if (sequenceId) return { ...common, ...sequencePlace(names, sequenceId) }
  return { ...common, view: 'generate', target: { view: 'generate' } }
}

/** Every finished item of the rows, with who asked for it, newest first. */
function finishedEntries(rows: readonly UnseenJoinedRow[], reg: Pick<Registries, 'approvals' | 'names'>): FinishedEntry[] {
  const via = viaByKey(reg)
  const out: FinishedEntry[] = []
  for (const row of rows) {
    const item = finishedItem(row, reg.names)
    if (!item) continue
    const agent = via.get(item.key)
    out.push({ item: agent ? { ...item, via: agent } : item, rowId: row.id })
  }
  return out.sort((a, b) => b.item.finishedAt - a.item.finishedAt)
}

// ── Counting ─────────────────────────────────────────────────────────────────

const emptyCounts = (): WorkCounts => ({ running: 0, unseen: 0, failed: 0 })

/**
 * The summary, from the joined unseen rows, the pending generations and the registries (pure). Each item counts once:
 * under its view, its owner and its clip. A "Generera saknade" run is an umbrella over the takes it sends: it counts
 * only while none of them shows (between two clips, say), so a run of one clip at Venice reads "1", not "2".
 */
export function buildWorkSummary(
  rows: readonly UnseenJoinedRow[],
  pending: readonly PendingRow[],
  reg: Registries,
  now: number,
  revision: number
): WorkSummary {
  const running = runningItems(pending, reg, now)
  const finished = finishedEntries(rows, reg).map((e) => e.item)
  const byView: Partial<Record<WorkView, WorkCounts>> = {}
  const byOwner: Record<string, WorkCounts> = {}
  const total = emptyCounts()
  const bump = (item: { view?: WorkView; ownerId?: string; segmentId?: string }, field: keyof WorkCounts): void => {
    total[field]++
    if (item.view) (byView[item.view] ??= emptyCounts())[field]++
    for (const id of new Set([item.ownerId, item.segmentId])) if (id) (byOwner[id] ??= emptyCounts())[field]++
  }
  for (const item of running) {
    const umbrella =
      item.kind === 'run' &&
      running.some((other) => other !== item && other.ownerId === item.ownerId && (other.kind === 'sending' || other.kind === 'video'))
    if (!umbrella) bump(item, 'running')
  }
  for (const item of finished) bump(item, item.status === 'failed' ? 'failed' : 'unseen')
  // Past the listed ones, only what the window's seen rules need (the "Ny" marks, playing, a picture on screen).
  const more = finished.slice(MAX_LISTED).map(unseenRef)
  return { running, unseen: finished.slice(0, MAX_LISTED), more, byView, byOwner, total, revision }
}

/** An unseen item past the listed ones: its key, whether it failed, and the file that marks it seen. */
function unseenRef(w: FinishedWork): UnseenRef {
  return {
    key: w.key,
    ...(w.status === 'failed' ? { failed: true as const } : {}),
    ...(w.mediaPath ? { mediaPath: w.mediaPath } : {}),
    ...(w.kind === 'still' && w.thumbPath ? { picturePath: w.thumbPath } : {})
  }
}

/** A summary with nothing in it (no library open). */
function emptySummary(revision: number): WorkSummary {
  return { running: [], unseen: [], more: [], byView: {}, byOwner: {}, total: emptyCounts(), revision }
}

// ── Reading the library ──────────────────────────────────────────────────────

interface JoinedSqlRow {
  id: string
  generation_id: string | null
  still_id: string | null
  export_id: string | null
  audio_id: string | null
  job_id: string | null
  error: string | null
  label: string | null
  context: string
  created_at: number
  g_status: string | null
  g_source: string | null
  g_prompt: string | null
  g_title: string | null
  g_segment_id: string | null
  g_edit_id: string | null
  g_file_path: string | null
  g_thumb_path: string | null
  g_error: string | null
  g_recipe: string | null
  g_created_at: number | null
  s_sequence_id: string | null
  s_file_path: string | null
  s_prompt: string | null
  s_board_id: string | null
  x_sequence_id: string | null
  x_file_path: string | null
  a_asset_id: string | null
  a_file_path: string | null
  j_edit_id: string | null
  j_asset_id: string | null
  j_status: string | null
  j_error: string | null
  j_request: string | null
  j_op: string | null
}

function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' ? (value as T) : fallback
  } catch {
    return fallback
  }
}

/** Every unseen row with its item, paths made absolute. */
function readUnseen(): UnseenJoinedRow[] {
  const rows = db
    .getDb()
    .prepare(
      `SELECT u.id, u.generation_id, u.still_id, u.export_id, u.audio_id, u.job_id, u.error, u.label, u.context,
              u.created_at,
              g.status AS g_status, g.source AS g_source, g.prompt AS g_prompt, g.title AS g_title,
              g.segment_id AS g_segment_id, g.edit_id AS g_edit_id, g.file_path AS g_file_path,
              g.thumb_path AS g_thumb_path, g.error AS g_error, g.recipe AS g_recipe, g.created_at AS g_created_at,
              s.sequence_id AS s_sequence_id, s.file_path AS s_file_path, s.prompt AS s_prompt,
              CASE WHEN u.still_id IS NOT NULL THEN
                (SELECT b.id FROM storyboard_boards b WHERE b.still_id = s.id ORDER BY b.position LIMIT 1)
              END AS s_board_id,
              x.sequence_id AS x_sequence_id, x.file_path AS x_file_path,
              a.asset_id AS a_asset_id, a.file_path AS a_file_path,
              j.edit_id AS j_edit_id, j.asset_id AS j_asset_id, j.status AS j_status, j.error AS j_error,
              j.request AS j_request, j.op AS j_op
       FROM unseen u
       LEFT JOIN generations g ON g.id = u.generation_id
       LEFT JOIN stills s ON s.id = u.still_id
       LEFT JOIN exports x ON x.id = u.export_id
       LEFT JOIN asset_audio a ON a.id = u.audio_id
       LEFT JOIN media_jobs j ON j.id = u.job_id
       ORDER BY u.created_at DESC`
    )
    .all() as JoinedSqlRow[]
  return rows.map((r): UnseenJoinedRow => {
    const out: UnseenJoinedRow = {
      id: r.id,
      createdAt: r.created_at,
      ...(r.error ? { error: r.error } : {}),
      ...(r.label ? { label: r.label } : {}),
      context: parseJson<db.UnseenContext>(r.context, {})
    }
    if (r.generation_id && r.g_status) {
      const recipe = parseJson<{ number?: unknown; label?: unknown }>(r.g_recipe, {})
      out.generation = {
        id: r.generation_id,
        status: r.g_status as Generation['status'],
        source: (r.g_source ?? 'generated') as Generation['source'],
        prompt: r.g_prompt ?? '',
        createdAt: r.g_created_at ?? r.created_at,
        ...(r.g_title ? { title: r.g_title } : {}),
        ...(r.g_segment_id ? { segmentId: r.g_segment_id } : {}),
        ...(r.g_edit_id ? { editId: r.g_edit_id } : {}),
        ...(r.g_file_path ? { filePath: fromStoredPath(r.g_file_path) } : {}),
        ...(r.g_thumb_path ? { thumbPath: fromStoredPath(r.g_thumb_path) } : {}),
        ...(r.g_error ? { error: r.g_error } : {}),
        ...(typeof recipe.number === 'number' ? { versionNumber: recipe.number } : {}),
        ...(typeof recipe.label === 'string' && recipe.label ? { versionLabel: recipe.label } : {})
      }
    }
    if (r.still_id && r.s_file_path) {
      out.still = {
        id: r.still_id,
        ...(r.s_sequence_id ? { sequenceId: r.s_sequence_id } : {}),
        path: fromStoredPath(r.s_file_path),
        prompt: r.s_prompt ?? '',
        ...(r.s_board_id ? { firstBoardId: r.s_board_id } : {})
      }
    }
    if (r.export_id && r.x_file_path) {
      out.export = {
        id: r.export_id,
        ...(r.x_sequence_id ? { sequenceId: r.x_sequence_id } : {}),
        path: fromStoredPath(r.x_file_path)
      }
    }
    if (r.audio_id && r.a_asset_id && r.a_file_path) {
      out.audio = { id: r.audio_id, assetId: r.a_asset_id, path: fromStoredPath(r.a_file_path) }
    }
    if (r.job_id && r.j_status) {
      const request = parseJson<{ label?: unknown }>(r.j_request, {})
      out.job = {
        id: r.job_id,
        ...(r.j_edit_id ? { editId: r.j_edit_id } : {}),
        ...(r.j_asset_id ? { assetId: r.j_asset_id } : {}),
        status: r.j_status,
        ...(r.j_error ? { error: r.j_error } : {}),
        label: typeof request.label === 'string' && request.label ? request.label : (r.j_op ?? 'Jobb')
      }
    }
    return out
  })
}

/** The names and places labels need. */
function readNames(): WorkNames {
  const conn = db.getDb()
  const names: WorkNames = { sequences: {}, segments: {}, boards: {}, edits: {}, assets: {} }
  for (const r of conn.prepare('SELECT id, name, kind FROM sequences').all() as {
    id: string
    name: string
    kind: string
  }[]) {
    names.sequences[r.id] = { name: r.name, kind: r.kind === 'storyboard' ? 'storyboard' : 'sequence' }
  }
  for (const r of conn.prepare('SELECT id, sequence_id, position FROM segments').all() as {
    id: string
    sequence_id: string
    position: number
  }[]) {
    names.segments[r.id] = { sequenceId: r.sequence_id, position: r.position }
  }
  for (const r of conn.prepare('SELECT id, sequence_id, position FROM storyboard_boards').all() as {
    id: string
    sequence_id: string
    position: number
  }[]) {
    names.boards[r.id] = { storyboardId: r.sequence_id, position: r.position }
  }
  for (const r of conn.prepare('SELECT id, name FROM edits').all() as { id: string; name: string }[]) {
    names.edits[r.id] = { name: r.name }
  }
  for (const r of conn.prepare('SELECT id, name, kind FROM assets').all() as {
    id: string
    name: string
    kind: string
  }[]) {
    names.assets[r.id] = { name: r.name, kind: r.kind }
  }
  return names
}

/**
 * Upkeep before reading: an error-only row whose owner (sequence, storyboard, asset, edit) was deleted has no foreign
 * key to go with it, so it goes here; and a failed job that is running again ("Fortsätt") or done is no failure any
 * more.
 */
function dropOrphans(): void {
  const conn = db.getDb()
  const orphan = (key: string, table: string): string =>
    `(json_extract(context, '$.${key}') IS NOT NULL AND json_extract(context, '$.${key}') NOT IN (SELECT id FROM ${table}))`
  conn
    .prepare(
      `DELETE FROM unseen
       WHERE generation_id IS NULL AND still_id IS NULL AND export_id IS NULL AND audio_id IS NULL AND job_id IS NULL
         AND (${orphan('sequenceId', 'sequences')} OR ${orphan('storyboardId', 'sequences')}
              OR ${orphan('assetId', 'assets')} OR ${orphan('editId', 'edits')})`
    )
    .run()
  conn
    .prepare(
      `DELETE FROM unseen WHERE job_id IS NOT NULL AND job_id IN (SELECT id FROM media_jobs WHERE status != 'failed')`
    )
    .run()
  // A failed voice design whose character was deleted (its asset_id set null): about nothing that is left.
  conn
    .prepare(
      `DELETE FROM unseen WHERE job_id IS NOT NULL
         AND job_id IN (SELECT id FROM media_jobs WHERE edit_id IS NULL AND asset_id IS NULL)`
    )
    .run()
}

/** A picture a pending generation starts from (or its first reference): its thumbnail while it renders. */
function pendingRow(g: db.StoredGeneration): PendingRow {
  const picture = g.params?.startImage ?? g.params?.referenceImages?.[0]
  return {
    id: g.id,
    status: g.status,
    model: g.model,
    prompt: g.prompt,
    createdAt: g.createdAt,
    ...(g.title ? { title: g.title } : {}),
    ...(g.segmentId ? { segmentId: g.segmentId } : {}),
    ...(g.editId ? { editId: g.editId } : {}),
    ...(g.averageExecutionTime !== undefined ? { averageExecutionTime: g.averageExecutionTime } : {}),
    ...(g.executionDuration !== undefined ? { executionDuration: g.executionDuration } : {}),
    ...(picture ? { thumbPath: picture } : {})
  }
}

// ── The service ──────────────────────────────────────────────────────────────

/** Where the summary's running half comes from. Each accessor is read once per summary and must not throw. */
export interface WorkSources {
  jobs: JobManager
  sequences: () => SequenceService | undefined
  storyboards: () => StoryboardService | undefined
  edits: () => EditServiceHandle | undefined
  imports: () => ImportService | undefined
  /** stills.activeStills(). */
  stills: () => StillWork[]
  /** agent.approvals.executing() and the requests the store remembers (agent.approvals.list()). */
  approvals: () => { executing: ExecutingApproval[]; decided: ApprovalRequest[] }
  /** agent.uploads.active(). */
  uploads: () => UploadWork[]
  /** broadcast('work:change', summary) and the Dock badge. */
  send: (summary: WorkSummary) => void
}

/** A registry read that went wrong is logged and counts as nothing running there. */
function safely<T>(what: string, read: () => T, fallback: T): T {
  try {
    return read()
  } catch (err) {
    console.warn(`Reading ${what} for the status summary failed:`, err)
    return fallback
  }
}

/** The rows a "Markera alla som sedda" removed, kept for its Ångra. */
interface UndoEntry {
  rows: Record<string, unknown>[]
  timer: NodeJS.Timeout
}

export class WorkStatus {
  private revision = 0
  /** A structural push waits here (trailing debounce), since `structureSince`. */
  private structureTimer: NodeJS.Timeout | undefined
  private structureSince = 0
  private progressTimer: NodeJS.Timeout | undefined
  private lastPushAt = 0
  /** The last summary sent, without its revision and measuring times: an identical one isn't sent again. */
  private lastSent: string | undefined
  /** Pending generations' last known status, so a poll that only moved the timings is progress, not structure. */
  private readonly statuses = new Map<string, string>()
  /** When each pending generation's last update arrived. */
  private readonly measured = new Map<string, number>()
  private readonly undoable = new Map<string, UndoEntry>()

  constructor(private readonly src: WorkSources) {}

  /** The summary as it is now; an empty one while no library is open. Never throws. */
  summary(): WorkSummary {
    const revision = ++this.revision
    try {
      if (!db.isDbOpen()) return emptySummary(revision)
      dropOrphans()
      const rows = readUnseen()
      const pending = db.listPendingGenerations().map(pendingRow)
      return buildWorkSummary(rows, pending, this.registries(pending), Date.now(), revision)
    } catch (err) {
      console.warn('Building the status summary failed:', err)
      return emptySummary(revision)
    }
  }

  /** Everything in memory that runs, and what its labels and estimates need. */
  private registries(pending: readonly PendingRow[]): Registries {
    const sequences = safely('the sequences', () => this.src.sequences()?.activeWork(), undefined)
    const storyboardRuns = safely('the storyboards', () => this.src.storyboards()?.activeRuns() ?? [], [])
    const edits = safely('Redigera', () => this.src.edits()?.activeWork(), undefined)
    const stills = safely('the pictures', () => this.src.stills(), [])
    const approvals = safely('the agent requests', () => this.src.approvals(), { executing: [], decided: [] })
    const sending = safely('the submits', () => this.src.jobs.sending(), [])
    const typicalVideo: Record<string, number | undefined> = {}
    for (const model of new Set([...pending.map((g) => g.model), ...sending.map((s) => s.model)])) {
      typicalVideo[model] = safely('typical durations', () => this.src.jobs.typicalMs(model), undefined)
    }
    const typicalStill: Record<string, number | undefined> = {}
    for (const s of stills) typicalStill[s.model] = safely('typical durations', () => typicalStillMs(s.model), undefined)
    const posters: Record<string, string | undefined> = {}
    for (const job of edits?.jobs ?? []) {
      if (job.baseId) posters[job.baseId] = safely('a poster', () => db.getGeneration(job.baseId!)?.thumbPath, undefined)
    }
    const measuredAt: Record<string, number> = {}
    for (const g of pending) {
      const at = this.measured.get(g.id)
      if (at !== undefined) measuredAt[g.id] = at
    }
    return {
      clipSending: sequences?.sending ?? [],
      sending,
      sequenceRuns: sequences?.runs ?? [],
      storyboardRuns,
      exports: sequences?.exports ?? [],
      stills,
      editJobs: edits?.jobs ?? [],
      renders: edits?.renders ?? [],
      imports: safely('the imports', () => this.src.imports()?.active() ?? [], []),
      executing: approvals.executing,
      approvals: approvals.decided,
      uploads: safely('the uploads', () => this.src.uploads(), []),
      typicalVideo,
      typicalStill,
      measuredAt,
      posters,
      names: readNames()
    }
  }

  /** A broadcast went out (index.ts's broadcast()): what it says changed is pushed, debounced or throttled. */
  observe(channel: string, payload: unknown): void {
    try {
      if (IGNORED.has(channel)) return
      if (channel === 'generation:update') {
        const g = payload as Partial<Generation> | undefined
        if (g && typeof g.id === 'string') {
          const before = this.statuses.get(g.id)
          if (g.status === 'queued' || g.status === 'processing') {
            this.statuses.set(g.id, g.status)
            this.measured.set(g.id, Date.now())
            // Only a poll's timings moved.
            if (before === g.status) return this.touch('progress')
          } else {
            this.statuses.delete(g.id)
            this.measured.delete(g.id)
          }
        }
        return this.touch('structure')
      }
      if (channel === 'edit:progress' || channel === 'export:progress' || channel === 'import:progress') {
        const done = !!payload && typeof payload === 'object' && (payload as { done?: unknown }).done === true
        return this.touch(done ? 'structure' : 'progress')
      }
      this.touch('structure')
    } catch (err) {
      console.warn('Observing a change for the status summary failed:', err)
    }
  }

  /**
   * Something changed: 'structure' (started, settled, deleted, seen) is pushed 120 ms after a burst ends, at the latest
   * 500 ms after it began; 'progress' alone at most once a second.
   */
  touch(kind: 'structure' | 'progress'): void {
    const now = Date.now()
    if (kind === 'structure') {
      if (this.structureTimer) {
        // A steady stream doesn't hold the push back for ever.
        if (now - this.structureSince >= STRUCTURE_MAX_WAIT_MS) return
        clearTimeout(this.structureTimer)
      } else this.structureSince = now
      this.structureTimer = setTimeout(() => this.push(), STRUCTURE_DEBOUNCE_MS)
      return
    }
    if (this.structureTimer || this.progressTimer) return
    this.progressTimer = setTimeout(() => this.push(), Math.max(0, this.lastPushAt + PROGRESS_INTERVAL_MS - now))
  }

  /** Builds the summary and sends it, unless nothing in it changed since the last one sent. Never throws. */
  private push(): void {
    clearTimeout(this.structureTimer)
    clearTimeout(this.progressTimer)
    this.structureTimer = undefined
    this.progressTimer = undefined
    this.lastPushAt = Date.now()
    try {
      const summary = this.summary()
      const fingerprint = JSON.stringify({
        ...summary,
        revision: 0,
        running: summary.running.map(({ measuredAt: _measuredAt, ...item }) => item)
      })
      if (fingerprint === this.lastSent) return
      this.lastSent = fingerprint
      this.src.send(summary)
    } catch (err) {
      console.warn('Sending the status summary failed:', err)
    }
  }

  /** The user looked at these (work keys); their rows go and the summary is pushed. */
  markSeen(keys: readonly unknown[]): void {
    if (!db.isDbOpen() || !Array.isArray(keys)) return
    const columns: Record<string, string> = {
      gen: 'generation_id',
      still: 'still_id',
      export: 'export_id',
      audio: 'audio_id',
      job: 'job_id',
      unseen: 'id'
    }
    const conn = db.getDb()
    let removed = 0
    conn.transaction(() => {
      for (const key of keys) {
        if (typeof key !== 'string') continue
        const at = key.indexOf(':')
        const column = at > 0 ? columns[key.slice(0, at)] : undefined
        const id = at > 0 ? key.slice(at + 1) : ''
        if (!column || !id) continue
        removed += conn.prepare(`DELETE FROM unseen WHERE ${column} = ?`).run(id).changes
      }
    })()
    if (removed) this.touch('structure')
  }

  /**
   * "Markera alla som sedda": every finished item (or those of one view or one owner – a sequence, storyboard, edit or
   * asset, or a clip) is marked seen. The rows are kept for ten seconds, so Ångra can bring them back.
   */
  markAllSeen(scope?: SeenScope): { count: number; undoToken?: string } {
    if (!db.isDbOpen()) return { count: 0 }
    const view = scope && typeof scope.view === 'string' ? scope.view : undefined
    const ownerId = scope && typeof scope.ownerId === 'string' ? scope.ownerId : undefined
    dropOrphans()
    const approvals = safely('the agent requests', () => this.src.approvals().decided, [])
    const entries = finishedEntries(readUnseen(), { approvals, names: readNames() }).filter(
      ({ item }) =>
        (!view || item.view === view) && (!ownerId || item.ownerId === ownerId || item.segmentId === ownerId)
    )
    if (!entries.length) return { count: 0 }
    const conn = db.getDb()
    const ids = entries.map((e) => e.rowId)
    const rows: Record<string, unknown>[] = []
    conn.transaction(() => {
      const read = conn.prepare('SELECT * FROM unseen WHERE id = ?')
      const remove = conn.prepare('DELETE FROM unseen WHERE id = ?')
      for (const id of ids) {
        const row = read.get(id) as Record<string, unknown> | undefined
        if (!row) continue
        rows.push(row)
        remove.run(id)
      }
    })()
    const undoToken = randomUUID()
    const timer = setTimeout(() => this.undoable.delete(undoToken), UNDO_MS)
    timer.unref?.()
    this.undoable.set(undoToken, { rows, timer })
    this.touch('structure')
    return { count: rows.length, undoToken }
  }

  /** Ångra after "Markera alla som sedda": the rows come back where their item still exists. Returns how many. */
  undo(token: unknown): number {
    if (typeof token !== 'string') return 0
    const entry = this.undoable.get(token)
    if (!entry) return 0
    this.undoable.delete(token)
    clearTimeout(entry.timer)
    if (!db.isDbOpen()) return 0
    const insert = db.getDb().prepare(
      `INSERT OR IGNORE INTO unseen (id, generation_id, still_id, export_id, audio_id, job_id, error, label, context,
         created_at)
       VALUES (@id, @generation_id, @still_id, @export_id, @audio_id, @job_id, @error, @label, @context, @created_at)`
    )
    let restored = 0
    for (const row of entry.rows) {
      try {
        restored += insert.run(row).changes
      } catch {
        // Its item was deleted meanwhile (the foreign key): nothing to bring back.
      }
    }
    if (restored) this.touch('structure')
    return restored
  }

  /** A library was opened (or switched to): what was known of the previous one goes, and the windows get the new one. */
  reset(): void {
    this.statuses.clear()
    this.measured.clear()
    for (const entry of this.undoable.values()) clearTimeout(entry.timer)
    this.undoable.clear()
    this.lastSent = undefined
    this.touch('structure')
  }
}

/**
 * work:summary (agents may read it too), work:markSeen, work:markAllSeen and work:undoSeen. Marking things seen is the
 * user's alone (D13): an agent's call is refused, also behind the tool list, which has no such tool.
 */
export function registerWorkIpc(work: WorkStatus): void {
  const userOnly = (e: IpcMainInvokeEvent): void => {
    if (isAgentCall(e)) throw new Error(USER_ONLY)
  }
  ipcMain.handle('work:summary', () => work.summary())
  ipcMain.handle('work:markSeen', (e, keys: unknown) => {
    userOnly(e)
    work.markSeen(Array.isArray(keys) ? keys : [])
  })
  ipcMain.handle('work:markAllSeen', (e, scope?: unknown) => {
    userOnly(e)
    return work.markAllSeen(scope && typeof scope === 'object' ? (scope as SeenScope) : undefined)
  })
  ipcMain.handle('work:undoSeen', (e, token: unknown) => {
    userOnly(e)
    return work.undo(token)
  })
}
