import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ImportResult, ImportTarget, VideoFileInfo, WorkSummary } from '@shared/types'
import * as db from '../../db'
import { callService } from '../local-ipc'
import { errorText, localTime, q, requireLibrary, seconds } from '../studio'
import { READ_ONLY, WRITE, defineTool, type ToolContext } from './kit'

// Own clips from agents: video uploads imported into Egna klipp exactly as the user's own drop imports them – into the
// feed, as new clips of a sequence, or as a (selected) take of a clip – with the import's own checks and working
// copies. An import of large files can take minutes, so the tool answers after wait_seconds with an import_id that
// get_import follows and cancel_import stops (the user's ✕ on a file card, per file).

/** How long an import's outcome is kept for get_import. */
const KEEP_MS = 2 * 60 * 60 * 1000
/** cancel_import waits this long for the import to wind down, to say how many files it stopped. */
const CANCEL_SETTLE_MS = 5000

interface ImportFile {
  uploadId: string
  name: string
  /** The staged file: never shown to the agent. */
  path: string
}

interface ImportRun {
  id: string
  client: string
  files: ImportFile[]
  startedAt: number
  promise: Promise<ImportResult>
  result?: ImportResult
  error?: string
  finishedAt?: number
}

/** Imports agents started, by import_id; shared by every session (an import outlives the call that began it). */
const runs = new Map<string, ImportRun>()

function sweep(): void {
  const cutoff = Date.now() - KEEP_MS
  for (const [id, run] of runs) if (run.finishedAt !== undefined && run.finishedAt < cutoff) runs.delete(id)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The run's outcome once it is in, or undefined after `ms`. */
async function settled(run: ImportRun, ms: number): Promise<boolean> {
  if (run.finishedAt !== undefined) return true
  await Promise.race([
    run.promise.then(
      () => undefined,
      () => undefined
    ),
    delay(ms)
  ])
  return run.finishedAt !== undefined
}

/** Each file's share done, from Pågår och klart (the import reports per file); undefined when it can't be read. */
async function fractions(run: ImportRun): Promise<Map<string, number> | undefined> {
  try {
    const summary = await callService<WorkSummary>('work:summary')
    const byKey = new Map(summary.running.map((w) => [w.key, w.progress ?? 0]))
    return new Map(run.files.map((f) => [f.path, byKey.get(`import:${f.path}`) ?? 0]))
  } catch {
    return undefined
  }
}

/** How one file of a finished import ended, by upload id and name (never the staged path). */
interface FileOutcome {
  upload_id: string
  file_name: string
  status: 'imported' | 'failed' | 'cancelled'
  generation_id?: string
  error?: string
}

/**
 * Each file's outcome. The result lists the errors by file and the clips in the order of the files; a file stopped
 * by cancel_import is in neither. With none stopped the clips match the other files in order; otherwise a clip is
 * matched by the file name its import recorded.
 */
function outcomes(run: ImportRun, result: ImportResult): FileOutcome[] {
  const errors = new Map(result.errors.map((e) => [e.path, e.message]))
  const imported = run.files.filter((f) => !errors.has(f.path))
  const stopped = imported.length - result.generationIds.length
  const byName = new Map<string, string>()
  if (stopped > 0) {
    for (const id of result.generationIds) {
      const name = db.getGeneration(id)?.recipe?.import?.name
      if (name) byName.set(name, id)
    }
  }
  let next = 0
  return run.files.map((f) => {
    const base = { upload_id: f.uploadId, file_name: f.name }
    const error = errors.get(f.path)
    if (error) return { ...base, status: 'failed', error }
    const id = stopped > 0 ? byName.get(basename(f.path)) : result.generationIds[next++]
    return id ? { ...base, status: 'imported', generation_id: id } : { ...base, status: 'cancelled' }
  })
}

function doneInfo(run: ImportRun, result: ImportResult): Record<string, unknown> {
  const files = outcomes(run, result)
  const errors = files
    .filter((f) => f.status === 'failed')
    .map((f) => ({ upload_id: f.upload_id, file_name: f.file_name, message: f.error }))
  const cancelled = files.filter((f) => f.status === 'cancelled').length
  return {
    status: 'done',
    import_id: run.id,
    generation_ids: result.generationIds,
    ...(result.sequenceId ? { sequence_id: result.sequenceId } : {}),
    ...(result.segmentIds ? { segment_ids: result.segmentIds } : {}),
    files,
    ...(errors.length ? { errors } : {}),
    ...(cancelled ? { cancelled } : {}),
    note: result.generationIds.length
      ? 'The clips are in Egna klipp (list_generations({source: "import"})). Discard large video uploads now (discard_upload) unless you need them again.'
      : 'Nothing was imported; files says why.'
  }
}

const fit = z
  .enum(['pad', 'crop'])
  .optional()
  .describe(
    'When the film\'s shape differs from the sequence\'s: "pad" (default) keeps all of it with bars; "crop" fills the frame.'
  )

const targetInput = z.union([
  z.object({ feed: z.literal(true) }).strict(),
  z
    .object({
      sequence_id: z.string(),
      after_segment_id: z.string().optional().describe('New clips go after this clip; at the end when left out.'),
      fit
    })
    .strict(),
  z
    .object({ segment_id: z.string().describe('Each file becomes a take of this clip (the last one selected).'), fit })
    .strict()
])

export function registerImportTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'import_own_clips',
    {
      title: 'Import own clips',
      description:
        'Imports video uploads (begin_upload with kind "video") as the user\'s own clips (Egna klipp), exactly as the user\'s own drop does: target {feed: true} only adds them to the clip feed; {sequence_id, after_segment_id?, fit?} adds one new clip per file (in name order) to a sequence; {segment_id, fit?} adds each as a take of that clip, the last one selected. Not into storyboards. Studio checks every file first (working_copy_reasons says why a working copy is made: HDR, 10-bit, 4K → 1080p, rotation, variable frame rate…); a file imported before is used again. Free and local. Answers when done within wait_seconds ({status: "done", generation_ids, segment_ids, errors}), else {status: "running", import_id} – follow it with get_import, stop it with cancel_import. Discard large uploads (discard_upload) once done.',
      input: {
        upload_ids: z.array(z.string()).min(1).max(10).describe('Ready video uploads, one own clip each.'),
        target: targetInput,
        wait_seconds: z.number().int().min(0).max(50).default(30)
      },
      annotations: WRITE,
      summary: ({ upload_ids }) =>
        `importerade ${upload_ids.length === 1 ? 'ett eget klipp' : `${upload_ids.length} egna klipp`}`
    },
    async ({ upload_ids, target, wait_seconds }) => {
      requireLibrary()
      sweep()
      const ids = [...new Set(upload_ids)]
      const files: ImportFile[] = ids.map((id) => {
        const e = ctx.uploads.resolve(id, 'video')
        return { uploadId: e.id, name: e.fileName, path: e.path }
      })
      const paths = files.map((f) => f.path)
      const importTarget: ImportTarget =
        'feed' in target
          ? { kind: 'feed' }
          : 'sequence_id' in target
            ? {
                kind: 'sequence',
                sequenceId: target.sequence_id,
                ...(target.after_segment_id ? { afterSegmentId: target.after_segment_id } : {}),
                ...(target.fit ? { fit: target.fit } : {})
              }
            : { kind: 'segment', segmentId: target.segment_id, ...(target.fit ? { fit: target.fit } : {}) }
      // The import's own look at the files first: what it refuses, and why it makes working copies.
      const inspected = await callService<VideoFileInfo[]>('imports:inspect', paths)
      const byPath = new Map(inspected.map((i) => [i.path, i]))
      const refused = files.filter((f) => byPath.get(f.path)?.ok === false)
      if (refused.length === files.length) {
        throw new Error(
          refused
            .map((f) => `${f.name}: ${byPath.get(f.path)?.error?.replace(/^[^:]*:\s*/, '') ?? 'kan inte importeras'}`)
            .join(' ')
        )
      }
      const run: ImportRun = {
        id: randomUUID(),
        client: ctx.clientName(),
        files,
        startedAt: Date.now(),
        promise: callService<ImportResult>('imports:import', paths, importTarget)
      }
      run.promise.then(
        (result) => {
          run.result = result
          run.finishedAt = Date.now()
        },
        (err: unknown) => {
          run.error = errorText(err)
          run.finishedAt = Date.now()
        }
      )
      runs.set(run.id, run)
      const checked = files.map((f) => {
        const info = byPath.get(f.path)
        return {
          upload_id: f.uploadId,
          file_name: f.name,
          ...(info?.ok
            ? {
                seconds: info.duration !== undefined ? seconds(info.duration) : undefined,
                ...(info.workingCopy.length ? { working_copy_reasons: info.workingCopy } : {}),
                ...(info.duplicateOf ? { imported_before_as: info.duplicateOf } : {})
              }
            : { refused: info?.error?.replace(/^[^:]*:\s*/, '') })
        }
      })
      const names = files.length === 1 ? q(files[0].name) : `${files.length} filer`
      if (await settled(run, wait_seconds * 1000)) {
        if (run.error) throw new Error(run.error)
        const done = doneInfo(run, run.result!)
        const outcome = new Map((done.files as FileOutcome[]).map((f) => [f.upload_id, f]))
        return {
          data: { ...done, files: checked.map((c) => ({ ...c, ...outcome.get(c.upload_id) })) },
          summary: `importerade ${names} som egna klipp`
        }
      }
      return {
        data: {
          status: 'running',
          import_id: run.id,
          files: checked,
          next: 'Follow it with get_import({import_id}); cancel_import stops it.'
        },
        summary: `började importera ${names} som egna klipp`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_import',
    {
      title: 'Get import',
      description:
        "How an import_own_clips import is going: status (running, done or failed), each file's progress (fraction 0–1) and error, and once done the generation_ids (the own clips), segment_ids (the clips or takes in the sequence) and errors. Kept for two hours.",
      input: { import_id: z.string() },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'följde en import'
    },
    async ({ import_id }) => {
      sweep()
      const run = runs.get(import_id)
      if (!run) throw new Error('Det finns ingen import med det id:t (de sparas i två timmar).')
      if (run.error) return { data: { status: 'failed', import_id: run.id, error: run.error } }
      if (run.result) return { data: { ...doneInfo(run, run.result), finished: localTime(run.finishedAt) } }
      const shares = await fractions(run)
      return {
        data: {
          status: 'running',
          import_id: run.id,
          started: localTime(run.startedAt),
          files: run.files.map((f) => ({
            upload_id: f.uploadId,
            file_name: f.name,
            ...(shares ? { fraction: Math.round((shares.get(f.path) ?? 0) * 100) / 100 } : {})
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'cancel_import',
    {
      title: 'Cancel import',
      description:
        'Stops an import_own_clips import that is still running, like the ✕ on a file card in Studio: every file not imported yet is stopped (the half-made file removed) or skipped. Files already imported stay in the library. Answers how many files were stopped.',
      input: { import_id: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'avbröt en import'
    },
    async ({ import_id }) => {
      sweep()
      const run = runs.get(import_id)
      if (!run) throw new Error('Det finns ingen import med det id:t (de sparas i två timmar).')
      if (run.finishedAt !== undefined) {
        return {
          data: {
            import_id,
            cancelled: 0,
            status: run.error ? 'failed' : 'done',
            note: 'The import had already ended.'
          }
        }
      }
      for (const f of run.files) await callService('imports:cancel', f.path)
      const ended = await settled(run, CANCEL_SETTLE_MS)
      if (ended && run.result) {
        const done = doneInfo(run, run.result)
        return {
          data: { ...done, cancelled: (done.cancelled as number | undefined) ?? 0 },
          summary: 'avbröt en import'
        }
      }
      return {
        data: {
          import_id,
          status: ended ? 'failed' : 'running',
          ...(run.error ? { error: run.error } : {}),
          note: ended ? 'The import ended with an error.' : 'Stopping: follow it with get_import.'
        },
        summary: 'avbröt en import'
      }
    }
  )
}
