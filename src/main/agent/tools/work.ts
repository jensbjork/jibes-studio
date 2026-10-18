import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FinishedWork, RunningWork, WorkSummary, WorkView } from '@shared/types'
import { withoutLocalPaths } from '../../paths'
import { callService } from '../local-ipc'
import { localTime } from '../studio'
import { READ_ONLY, defineTool, type ToolContext } from './kit'

// What Studio is doing right now and what has finished that the user hasn't looked at yet ("Activity"), as
// the window's status panel shows it. Read-only: an agent can see what the user has seen but never mark anything
// seen. Ids only – never the absolute paths of thumbnails, videos or an import's files.

const VIEWS = [
  'generate',
  'media',
  'sequences',
  'storyboards',
  'editor',
  'characters',
  'environments',
  'products',
  'outfits',
  'poses'
] as const satisfies readonly WorkView[]

/** The library views, whose items belong to an asset. */
const ASSET_VIEWS: ReadonlySet<WorkView> = new Set(['characters', 'environments', 'products', 'outfits', 'poses'])

/** The part of a key after its prefix ("upload:<id>" → "<id>"), for the kinds whose key carries their id. */
function keyId(key: string, prefix: string): string | undefined {
  return key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1) : undefined
}

/** A sequence's or a storyboard's id and its clip's or transition's, named by what the item belongs to. */
function ownerIds(view: WorkView | undefined, ownerId: string | undefined, segmentId: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (view === 'storyboards') {
    if (ownerId) out.storyboard_id = ownerId
    if (segmentId) out.transition_id = segmentId
  } else if (view === 'sequences') {
    if (ownerId) out.sequence_id = ownerId
    if (segmentId) out.segment_id = segmentId
  } else if (view === 'editor') {
    if (ownerId) out.edit_id = ownerId
  } else if (view && ASSET_VIEWS.has(view) && ownerId) {
    out.asset_id = ownerId
  }
  return out
}

/** Seconds left now: the estimate counted down from when it was measured. */
function etaSeconds(w: RunningWork, now: number): number | undefined {
  if (w.remainingMs === undefined) return undefined
  return Math.max(0, Math.round((w.remainingMs - Math.max(0, now - w.measuredAt)) / 1000))
}

function runningInfo(w: RunningWork, now: number): Record<string, unknown> {
  const t = w.target
  const eta = etaSeconds(w, now)
  const jobId = t?.jobId ?? keyId(w.key, 'job')
  const approvalId = t?.approvalId ?? keyId(w.key, 'approval')
  const uploadId = keyId(w.key, 'upload')
  return {
    kind: w.kind,
    label: w.label,
    ...(w.detail ? { detail: w.detail } : {}),
    ...(w.progress !== undefined ? { progress: Math.round(w.progress * 100) / 100 } : {}),
    ...(eta !== undefined ? { eta_seconds: eta } : {}),
    ...(eta === undefined && w.typicalMs ? { usually_takes_seconds: Math.round(w.typicalMs / 1000) } : {}),
    started_at: localTime(w.startedAt),
    ...(w.via ? { via: w.via } : {}),
    ...(w.generationId ? { generation_id: w.generationId } : {}),
    ...ownerIds(w.view, w.ownerId, w.segmentId),
    ...(t?.boardId ? { board_id: t.boardId } : {}),
    ...(t?.editId ? { edit_id: t.editId } : {}),
    ...(t?.assetId ? { asset_id: t.assetId } : {}),
    ...(jobId ? { job_id: jobId } : {}),
    ...(approvalId ? { approval_id: approvalId } : {}),
    ...(uploadId ? { upload_id: uploadId } : {})
  }
}

function finishedInfo(w: FinishedWork): Record<string, unknown> {
  return {
    kind: w.kind,
    status: w.status,
    label: w.label,
    // A job's or a video's own error (not only the unseen row's) may quote a tool that names files by path.
    ...(w.error ? { error: withoutLocalPaths(w.error) } : {}),
    finished_at: localTime(w.finishedAt),
    ...(w.via ? { via: w.via } : {}),
    ...(w.generationId ? { generation_id: w.generationId } : {}),
    ...(w.stillId ? { still_id: w.stillId } : {}),
    ...(w.exportId ? { export_id: w.exportId } : {}),
    ...(w.audioId ? { audio_id: w.audioId } : {}),
    ...(w.jobId ? { job_id: w.jobId } : {}),
    ...(w.failureOf ? { failure_of: w.failureOf } : {}),
    ...ownerIds(w.view, w.ownerId, w.segmentId)
  }
}

export function registerWorkTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'get_work_status',
    {
      title: 'Get what is running and what is new',
      description:
        "What Studio is doing right now and what has finished that the user hasn't looked at yet – the window's \"Activity\". running: videos at Venice (queued or generating, with progress and eta_seconds or usually_takes_seconds), takes being sent, \"Generate missing\" runs (\"Clip 2 of 5\"), pictures being made, Editor jobs and renders, exports, imports of own clips, approved requests being carried out and your uploads – each with its label, phase (detail), when it started, the agent it was done for (via) and the ids to follow it with (generation_id, sequence_id, segment_id, storyboard_id, transition_id, edit_id, job_id, asset_id, upload_id). unseen (include_finished): finished videos, versions, pictures, exports and voices – and failures, with their error – that the user hasn't played or opened yet, newest first. counts: totals and per view (running, unseen, failed). view narrows it to one of Studio's views: \"generate\" is what Generate made this session (its list only shows this session's), \"media\" Media – pictures that belong to no sequence or storyboard and Generate's clips from an earlier session. Use it after an approval instead of polling every generation. Studio marks things seen when the user plays or opens them; you can read that but never mark anything seen. Free; changes nothing.",
      input: {
        view: z.enum(VIEWS).optional().describe('Only what counts under this view of Studio.'),
        include_finished: z
          .boolean()
          .default(true)
          .describe("Also list what finished (or failed) that the user hasn't looked at yet. Default true.")
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'checked what is running'
    },
    async ({ view, include_finished }) => {
      // Empty when no library is open; agents may always ask.
      const summary = await callService<WorkSummary>('work:summary')
      const now = Date.now()
      const running = summary.running.filter((w) => !view || w.view === view)
      const unseen = summary.unseen.filter((w) => !view || w.view === view)
      return {
        data: {
          ...(view ? { view } : {}),
          running: running.map((w) => runningInfo(w, now)),
          ...(include_finished
            ? {
                unseen: unseen.map(finishedInfo),
                // The list holds the newest 200; the counts are exact.
                ...(summary.unseen.length < summary.total.unseen + summary.total.failed
                  ? { note: 'Only the newest unseen items are listed; counts has the exact numbers.' }
                  : {})
              }
            : {}),
          counts: { total: summary.total, by_view: summary.byView }
        },
        summary: running.length
          ? `checked what is running (${running.length} ${running.length === 1 ? 'thing' : 'things'})`
          : 'checked what is running'
      }
    }
  )
}
