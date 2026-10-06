import { statSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { paramsForSubmit } from '@shared/models'
import { canonicalizeParams } from '@shared/prompt-refs'
import type { ApprovalRequest, Generation, GenerationParams, Sequence } from '@shared/types'
import * as db from '../../db'
import type { MissingClip, SubmitGuard } from '../../sequences'
import * as store from '../../sequence-store'
import { ensureImagesExist } from '../../venice'
import type { ApprovalPlan } from '../approvals'
import { callService } from '../local-ipc'
import { asGenerated, blockingProblem, loadModels, localTime, q, readableRunError, requireLibrary } from '../studio'
import { READ_ONLY, defineTool, priceValue, quote, readForm, usd, type ToolContext } from './kit'
import { continues, isUsableTake, loadClip, loadSequence, selectedTake } from './sequences'

// The paid tools never spend money themselves: each one checks the request, asks Venice for the price and
// creates an approval request that the user answers in Studio. Only their OK submits it (see approvals.ts).

const CHANGED =
  'har ändrats sedan agenten bad om lov, så förfrågan gäller inte längre. Be agenten fråga igen om det fortfarande ska genereras.'

/**
 * Models without audio. For them a clip stored with "audio: false" (as agents saved clips before) and one with
 * no audio setting (as the form saves it) are the same generation; the key must not tell them apart, or merely
 * opening such a clip in Studio would make its pending request lapse.
 */
type SilentModels = ReadonlySet<string>

const MODELS_TIMEOUT_MS = 5000

/** SilentModels from the model list (cached in main); empty when it can't be had in time. */
async function silentModels(): Promise<SilentModels> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MODELS_TIMEOUT_MS)
  })
  try {
    const models = await Promise.race([loadModels().catch(() => undefined), timeout])
    return new Set((models ?? []).filter((m) => !m.audio).map((m) => m.id))
  } finally {
    clearTimeout(timer)
  }
}

/** Compares what a generation would send, independent of key order and of fields that don't matter. */
function paramsKey(p: GenerationParams, silent?: SilentModels): string {
  const s = paramsForSubmit(p)
  return JSON.stringify([
    s.model,
    s.prompt,
    s.negativePrompt ?? '',
    s.duration,
    s.resolution ?? '',
    s.aspectRatio ?? '',
    silent?.has(s.model) ? null : (s.audio ?? null),
    s.startImage ?? '',
    s.endImage ?? '',
    s.referenceImages ?? []
  ])
}

/** A clip as it would be generated: its params, whether it continues and from which clip. */
function clipKey(
  params: GenerationParams,
  continuing: boolean,
  previousId: string | undefined,
  silent?: SilentModels
): string {
  return `${paramsKey(asGenerated(params, continuing), silent)}|${continuing ? `continues:${previousId}` : 'own'}`
}

/** The same key for a clip as the database has it right now; undefined when the clip is gone. */
function storedClipKey(segmentId: string, silent?: SilentModels): string | undefined {
  const row = store.getSegmentRow(segmentId)
  if (!row) return undefined
  const rows = store.listSegmentRows(row.sequence_id)
  const index = rows.findIndex((r) => r.id === row.id)
  const continuing = index > 0 && !!row.continue_from_previous
  return clipKey(store.parseParams(row.params), continuing, continuing ? rows[index - 1].id : undefined, silent)
}

/**
 * Which files the request's pictures are (device, inode, size, modification time). A path names a place, not a
 * photo: renaming two assets can put another person's photo where the approved one was.
 */
function imageIdentity(params: GenerationParams): string {
  const id = (path: string | undefined): string => {
    if (!path) return ''
    try {
      const s = statSync(path)
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
    } catch {
      return 'missing'
    }
  }
  return JSON.stringify([id(params.startImage), id(params.endImage), (params.referenceImages ?? []).map(id)])
}

/**
 * Creates the approval request, unless the agent's session ended or every pending request lapsed (the
 * connection was switched off, the token or the library changed) while this call was preparing it.
 */
function requestApproval(
  ctx: ToolContext,
  epoch: number,
  plan: Omit<ApprovalPlan, 'epoch'>
): ReturnType<ToolContext['approvals']['create']> {
  if (!ctx.connected()) throw new Error('Agentanslutningen är stängd, så förfrågan skickades inte till användaren.')
  return ctx.approvals.create({ ...plan, epoch })
}

/**
 * The clips "generate all" would pay for right now, as the sequence service itself decides it: no finished
 * selected take, none rendering and none on its way to Venice. The run checks the same list before it starts.
 */
function clipsToGenerate(sequenceId: string): Promise<MissingClip[]> {
  return callService<MissingClip[]>('sequences:missingClips', sequenceId)
}

function pendingAnswer(request: ApprovalRequest, reused: boolean): Record<string, unknown> {
  return {
    approval_id: request.id,
    status: request.status,
    price_usd: priceValue(request.priceUsd),
    expires: localTime(request.expiresAt),
    ...(reused ? { reused: true } : {}),
    message: reused
      ? 'An identical request is already waiting for the user; this is that one.'
      : 'Waiting for the user to approve it in Studio. Tell them briefly what is waiting, then poll get_approval every 15–30 seconds.'
  }
}

export function registerPaidTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'request_generation',
    {
      title: 'Request generation (paid, needs approval)',
      description:
        "💰 Asks the user to approve generating the current Generate form (as get_workspace shows it). Nothing is generated or paid for until they approve in Studio. The form is checked first (prompt, start image or references, @ImageN tokens); problems come back as an error and no request is made. Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval. The form is captured now: later changes to it don't change this request. Add a short note for the user (Swedish) saying what this generation is for.",
      input: { note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill generera'
    },
    async ({ note }) => {
      const epoch = ctx.approvals.epoch()
      // Before the read: renames from here on are followed (see db.followRewrites).
      const mark = db.rewriteMark()
      requireLibrary()
      const state = await readForm(ctx)
      const params = paramsForSubmit(canonicalizeParams(state.params))
      const problem = blockingProblem(params)
      if (problem) throw new Error(`Formuläret kan inte genereras: ${problem}`)
      ensureImagesExist(params)
      const images = imageIdentity(params)
      const price = await quote(params)
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'generation',
        client: ctx.clientName(),
        note,
        params,
        priceUsd: price,
        fingerprint: `generation:${paramsKey(params)}`,
        // Pictures renamed along with their asset while the request waited are followed to their new place,
        // but they must still be the very files the request was made with.
        verify: () => {
          if (imageIdentity(db.followRewrites(params, mark)) !== images) {
            throw new Error(`Bilderna i förfrågan ${CHANGED}`)
          }
        },
        execute: async () => [(await callService<Generation>('video:generate', db.followRewrites(params, mark))).id]
      })
      return {
        data: pendingAnswer(request, reused),
        approvalId: request.id,
        summary: `vill generera (${usd(price)}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_segment_generation',
    {
      title: 'Request clip generation (paid, needs approval)',
      description:
        "💰 Asks the user to approve generating a new take of one sequence clip. Nothing is generated or paid for until they approve in Studio. The clip is checked first; a clip that continues from the previous one needs that clip's finished selected take (use request_generate_all to generate clips in order). Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval. If the clip is changed before the user approves, the request lapses. A newer request for the same clip replaces a pending older one.",
      input: {
        segment_id: z.string(),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill generera ett klipp'
    },
    async ({ segment_id, note }) => {
      const epoch = ctx.approvals.epoch()
      const mark = db.rewriteMark()
      const { sequence, index, segment } = await loadClip(segment_id)
      const clip = index + 1
      const continuing = continues(sequence, index)
      const generated = asGenerated(segment.params, continuing)
      const problem = blockingProblem(generated, continuing)
      if (problem) throw new Error(`Klipp ${clip}: ${problem}`)
      if (continuing && !isUsableTake(selectedTake(sequence.segments[index - 1]))) {
        throw new Error(
          `Klipp ${clip} fortsätter från klipp ${index}, som behöver en färdig vald tagning först. Använd request_generate_all för att generera klippen i ordning.`
        )
      }
      if (!continuing) ensureImagesExist(paramsForSubmit(generated))
      const [price, silent] = await Promise.all([quote(generated), silentModels()])
      const previousId = continuing ? sequence.segments[index - 1].id : undefined
      const key = clipKey(segment.params, continuing, previousId, silent)
      /** Why the clip as stored now isn't the one the user is shown, or undefined. */
      const changed = (): string | undefined => {
        const now = storedClipKey(segment.id, silent)
        if (!now) return 'Klippet finns inte längre.'
        const then = clipKey(db.followRewrites(segment.params, mark), continuing, previousId, silent)
        return now === then ? undefined : `Klippet ${CHANGED}`
      }
      const guard: SubmitGuard = (id) => (id === segment.id ? changed() : 'Fel klipp.')
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'segment',
        client: ctx.clientName(),
        note,
        params: paramsForSubmit(generated),
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        segmentIds: [segment.id],
        clipNumbers: [clip],
        priceUsd: price,
        fingerprint: `segment:${segment.id}:${key}`,
        target: `segment:${segment.id}`,
        verify: () => {
          const problem = changed()
          if (problem) throw new Error(problem)
        },
        // Checked again on the row the take is built from: a change landing while the take waits for the file
        // queue must not be paid for either.
        execute: async () => [(await callService<Generation>('segments:generate', segment.id, guard)).id]
      })
      return {
        data: { ...pendingAnswer(request, reused), clip_number: clip },
        approvalId: request.id,
        summary: `vill generera klipp ${clip} i ${q(sequence.name)} (${usd(price)}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_generate_all',
    {
      title: 'Request generating all missing clips (paid, needs approval)',
      description:
        "💰 Asks the user to approve generating every clip of a sequence that has no finished selected take, in order, each waiting for the one before (so continuation clips get their start frame). Clips already rendering are waited for, not paid again. Every clip to generate is checked first; problems come back as an error naming the clip. price_usd is the sum over the clips. Returns immediately with {approval_id, status: \"pending\", price_usd, clip_numbers}; follow it with get_approval, then get_sequence. If the sequence's clips change before the user approves, the request lapses.",
      input: {
        sequence_id: z.string(),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill generera saknade klipp'
    },
    async ({ sequence_id, note }) => {
      const epoch = ctx.approvals.epoch()
      const mark = db.rewriteMark()
      const sequence = await loadSequence(sequence_id)
      if (sequence.running) throw new Error('”Generera saknade” pågår redan för sekvensen.')
      if (!sequence.segments.length) throw new Error('Sekvensen har inga klipp.')
      const missing = await clipsToGenerate(sequence.id)
      if (!missing.length) {
        throw new Error('Alla klipp har redan en färdig vald tagning (eller håller på att genereras) – det finns inget att generera.')
      }
      // The run refuses to start for the same reason, so it is better heard now than after the user's OK.
      const blocked = missing.find((c) => c.problem)
      if (blocked) throw new Error(`Klipp ${blocked.clip}: ${blocked.problem}`)
      const clips = missing.map(({ segmentId }) => {
        const index = sequence.segments.findIndex((s) => s.id === segmentId)
        if (index < 0) throw new Error('Sekvensen ändrades just nu. Försök igen.')
        const continuing = continues(sequence, index)
        const previousId = continuing ? sequence.segments[index - 1].id : undefined
        return { id: segmentId, clip: index + 1, params: sequence.segments[index].params, continuing, previousId }
      })
      for (const c of clips) if (!c.continuing) ensureImagesExist(paramsForSubmit(c.params))
      const [prices, silent] = await Promise.all([
        Promise.all(clips.map((c) => quote(asGenerated(c.params, c.continuing)))),
        silentModels()
      ])
      const price = prices.every((p) => p !== undefined) ? prices.reduce<number>((sum, p) => sum + (p ?? 0), 0) : undefined
      const keys = clips.map((c) => `${c.id}:${clipKey(c.params, c.continuing, c.previousId, silent)}`)
      const clipNumbers = clips.map((c) => c.clip)
      const approved = new Map(clips.map((c) => [c.id, c]))
      const approvedKey = (c: (typeof clips)[number]): string =>
        clipKey(db.followRewrites(c.params, mark), c.continuing, c.previousId, silent)
      // The run reads the sequence as it goes; this keeps it to the clips, and the settings, the user approved.
      const guard: SubmitGuard = (segmentId) => {
        const c = approved.get(segmentId)
        if (!c) {
          return 'Klippet ingick inte i agentens förfrågan som du godkände, så det genererades inte. Granska det och tryck ”Generera saknade” om det ska genereras.'
        }
        if (storedClipKey(segmentId, silent) !== approvedKey(c)) {
          return 'Klippet ändrades efter att du godkände agentens förfrågan, så det genererades inte. Granska det och tryck ”Generera saknade” om det ska genereras.'
        }
        return undefined
      }
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'generate-all',
        client: ctx.clientName(),
        note,
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        segmentIds: clips.map((c) => c.id),
        clipNumbers,
        priceUsd: price,
        fingerprint: `all:${sequence.id}:${keys.join(';')}`,
        target: `all:${sequence.id}`,
        verify: async () => {
          const ids = (await clipsToGenerate(sequence.id)).map((c) => c.segmentId)
          const then = clips.map((c) => `${c.id}:${approvedKey(c)}`)
          const now = ids.map((id) => `${id}:${storedClipKey(id, silent)}`)
          if (now.join(';') !== then.join(';')) throw new Error(`Sekvensen ${CHANGED}`)
        },
        execute: async () => {
          await callService('sequences:generateAll', sequence.id, guard)
          return []
        }
      })
      return {
        data: { ...pendingAnswer(request, reused), clip_numbers: clipNumbers },
        approvalId: request.id,
        summary: `vill generera ${clips.length === 1 ? '1 klipp' : `${clips.length} klipp`} i ${q(sequence.name)} (${usd(price)}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_approval',
    {
      title: 'Get approval status',
      description:
        "The state of an approval request: pending (the user hasn't answered), approved (with generation_ids – follow them with get_generation; for generate-all, follow the sequence with get_sequence), declined (with the user's reason if they gave one), expired (unanswered for 30 minutes, or replaced by a newer request) or failed (the error). Poll every 15–30 seconds while pending.",
      input: { approval_id: z.string() },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'kollade svaret på en förfrågan'
    },
    async ({ approval_id }) => {
      const request = ctx.approvals.get(approval_id)
      if (!request) throw new Error('Förfrågan finns inte. Förfrågningar glöms när Studio startas om.')
      const data: Record<string, unknown> = {
        approval_id: request.id,
        status: request.status,
        kind: request.kind,
        price_usd: priceValue(request.priceUsd),
        created: localTime(request.createdAt),
        ...(request.status === 'pending' ? { expires: localTime(request.expiresAt) } : {}),
        note: request.note,
        error: request.error,
        reason: request.reason,
        sequence_id: request.sequenceId,
        clip_numbers: request.clipNumbers,
        generation_ids: request.generationIds
      }
      if (request.status === 'approved') {
        if (request.generationIds?.length) {
          data.generations = request.generationIds.map((id) => {
            const g = db.getGeneration(id)
            return g ? { id, status: g.status, error: g.error } : { id, status: 'deleted' }
          })
        }
        if (request.kind === 'generate-all' && request.sequenceId) {
          const sequence = await callService<Sequence>('sequences:get', request.sequenceId).catch(() => undefined)
          if (sequence) {
            data.sequence = {
              generate_all_running: sequence.running,
              last_run_error: readableRunError(sequence.runError),
              clips_without_finished_take: sequence.segments.flatMap((s, i) =>
                isUsableTake(selectedTake(s)) ? [] : [i + 1]
              )
            }
          }
        }
      }
      return { data, approvalId: request.id }
    }
  )
}
