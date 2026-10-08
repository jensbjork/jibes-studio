import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { paramsForSubmit } from '@shared/models'
import type { ComposedPrompt } from '@shared/prompt-compose'
import { canonicalizeParams } from '@shared/prompt-refs'
import type {
  ApprovalImageReference,
  ApprovalRequest,
  Generation,
  GenerationParams,
  SegmentFramePreview,
  SegmentImageSlot,
  Sequence,
  Still,
  StillParams,
  Storyboard,
  StoryboardTransition
} from '@shared/types'
import * as db from '../../db'
import { composeSubmission, prepareSubmission } from '../../jobs'
import { missingClipProblem, type MissingClip, type SubmitGuard } from '../../sequences'
import * as store from '../../sequence-store'
import { getImageSafeMode } from '../../settings'
import { planStill } from '../../stills'
import { ensureImagesExist } from '../../venice'
import { type MissingTransition } from '../../storyboards'
import type { ApprovalPlan } from '../approvals'
import { callService } from '../local-ipc'
import { boardImagePath, boardIndex, isStoryboardId, storyboardOfBoard, transitionPair } from '../storyboard-rows'
import {
  AssetIndex,
  StillIndex,
  asGenerated,
  blockingProblem,
  errorText,
  loadModels,
  localTime,
  q,
  readableRunError,
  requireLibrary
} from '../studio'
import { READ_ONLY, defineTool, priceValue, quote, readForm, usd, type ToolContext } from './kit'
import { editApprovalInfo } from './editor-paid'
import { assertNotRunning, continues, endsOnNext, isUsableTake, loadClip, loadSequence, selectedTake } from './sequences'
import {
  assertStoryboardIdle,
  loadBoard,
  loadStoryboard,
  loadTransition,
  missingImagesText,
  transitionDone,
  transitionLabel,
  transitionProblems
} from './storyboards'

// The paid tools never spend money themselves: each one checks the request, asks Venice for the price and
// creates an approval request that the user answers in Studio. Only their OK submits it (see approvals.ts).

const CHANGED =
  'har ändrats sedan agenten bad om lov, så förfrågan gäller inte längre. Be agenten fråga igen om det fortfarande ska genereras.'

/** A description appended to the prompt (or the prompt language, or which are switched off) changed meanwhile. */
const SENT_PROMPT_CHANGED = `Prompten som skickas – med beskrivningarna av referenserna – ${CHANGED}`

/**
 * Models without audio. For them a clip stored with "audio: false" (as agents saved clips before) and one with
 * no audio setting (as the form saves it) are the same generation; the key must not tell them apart, or merely
 * opening such a clip in Studio would make its pending request lapse.
 */
type SilentModels = ReadonlySet<string>

const MODELS_TIMEOUT_MS = 5000

/**
 * SilentModels from the model list (cached in main); empty when it can't be had in time. Loading the list also
 * makes main remember the models' prompt limits, which the descriptions appended to a prompt are fitted into.
 */
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

/** Matches no prompt a request was made with: without a library nothing can be composed (or compared). */
const NO_LIBRARY_PROMPT: ComposedPrompt = {
  prompt: '\u0000no-library',
  legend: '',
  entries: [],
  truncated: false,
  dropped: false
}

/**
 * The prompt a generation sends: the user's prompt with the References legend composed from the descriptions of
 * its references as they are in the database right now (as main composes it at submit). An approval holds on to
 * the text, so a description edited while the request waits – which would change what Venice gets – makes it
 * lapse.
 */
function sentPromptOf(params: GenerationParams): ComposedPrompt {
  try {
    return composeSubmission(paramsForSubmit(params))
  } catch {
    return NO_LIBRARY_PROMPT
  }
}

/** What the dialog shows besides params.prompt: the composed prompt and its legend, when something is appended. */
function composedFields(sent: ComposedPrompt): Pick<ApprovalPlan, 'composedPrompt' | 'descriptionLegend'> {
  return sent.legend ? { composedPrompt: sent.prompt, descriptionLegend: sent.legend } : {}
}

/** Compares what a generation would send, independent of key order and of fields that don't matter. */
function paramsKey(p: GenerationParams, silent?: SilentModels): string {
  const s = paramsForSubmit(p)
  return JSON.stringify([
    s.model,
    // The prompt as sent: the user's text plus the descriptions of its references (minus those switched off).
    sentPromptOf(s).prompt,
    s.negativePrompt ?? '',
    s.duration,
    s.resolution ?? '',
    s.aspectRatio ?? '',
    silent?.has(s.model) ? null : (s.audio ?? null),
    s.startImage ?? '',
    s.endImage ?? '',
    s.referenceImages ?? [],
    // The windows count: moving a voice's window changes what Venice hears.
    (s.referenceAudios ?? []).map((a) => [a.path, a.start ?? 0, a.length ?? null])
  ])
}

/** Which neighbours a clip takes its frames from: the previous clip's last one, the next clip's first one. */
interface Neighbours {
  /** The clip it continues from (continue_from_previous). */
  previousId?: string
  /** The clip whose first frame it ends on (end_from_next). */
  nextId?: string
  /**
   * With `pinned`: the frame each of them gives, as its selected take and the trim where it is cut ("<take>@<trim>").
   * A neighbour's other take or trim is another frame, which the user must have seen before it is paid for.
   */
  previousFrame?: string
  nextFrame?: string
}

/** A clip as it would be generated: its params, and which neighbours it takes its start and end frames from. */
function clipKey(params: GenerationParams, from: Neighbours, silent?: SilentModels): string {
  const generated = asGenerated(params, !!from.previousId, !!from.nextId)
  return [
    paramsKey(generated, silent),
    from.previousId ? `continues:${from.previousId}${from.previousFrame ? `:${from.previousFrame}` : ''}` : 'own',
    from.nextId ? `ends-on:${from.nextId}${from.nextFrame ? `:${from.nextFrame}` : ''}` : 'own-end'
  ].join('|')
}

/** "<take>@<trim>": the frame a neighbour gives (see Neighbours). */
const frameOf = (takeId: string | null | undefined, trim: number): string => `${takeId ?? 'none'}@${trim}`

/**
 * The neighbours a clip takes frames from, as its row and its sequence's rows say. `pinned` adds the frames they
 * give (one clip's request, whose frames the dialog shows); not for "generate all", which makes some of those
 * neighbours' takes itself.
 */
function rowNeighbours(rows: readonly store.SegmentRow[], index: number, pinned = false): Neighbours {
  const row = rows[index]
  const previous = index > 0 && row.continue_from_previous ? rows[index - 1] : undefined
  const next = index < rows.length - 1 && row.end_from_next ? rows[index + 1] : undefined
  return {
    previousId: previous?.id,
    nextId: next?.id,
    ...(pinned && previous ? { previousFrame: frameOf(previous.selected_generation_id, previous.trim_end) } : {}),
    ...(pinned && next ? { nextFrame: frameOf(next.selected_generation_id, next.trim_start) } : {})
  }
}

/** The neighbours of a loaded sequence's clip (see rowNeighbours for `pinned`). */
function clipNeighbours(sequence: Sequence, index: number, pinned = false): Neighbours {
  const previous = continues(sequence, index) ? sequence.segments[index - 1] : undefined
  const next = endsOnNext(sequence, index) ? sequence.segments[index + 1] : undefined
  return {
    previousId: previous?.id,
    nextId: next?.id,
    ...(pinned && previous ? { previousFrame: frameOf(previous.selectedGenerationId, previous.trimEnd) } : {}),
    ...(pinned && next ? { nextFrame: frameOf(next.selectedGenerationId, next.trimStart) } : {})
  }
}

/** The same key for a clip as the database has it right now; undefined when the clip is gone. */
function storedClipKey(segmentId: string, silent?: SilentModels, pinned = false): string | undefined {
  const row = store.getSegmentRow(segmentId)
  if (!row) return undefined
  const rows = store.listSegmentRows(row.sequence_id)
  const index = rows.findIndex((r) => r.id === row.id)
  return clipKey(store.parseParams(row.params), rowNeighbours(rows, index, pinned), silent)
}

/**
 * Which files the request's pictures and audio clips are (device, inode, size, modification time). A path names a
 * place, not a photo: renaming two assets can put another person's photo (or voice) where the approved one was.
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
  return JSON.stringify([
    id(params.startImage),
    id(params.endImage),
    (params.referenceImages ?? []).map(id),
    (params.referenceAudios ?? []).map((a) => id(a.path))
  ])
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

// ── Images (stills: board pictures and keyframes) ───────────────────────────

/** The reference pictures an image request asks for, in the order they are sent: stills, photos, asset covers. */
async function imageReferences(input: {
  reference_still_ids?: string[]
  reference_image_ids?: string[]
  reference_asset_ids?: string[]
}): Promise<ApprovalImageReference[]> {
  const stillIds = input.reference_still_ids ?? []
  const imageIds = input.reference_image_ids ?? []
  const assetIds = input.reference_asset_ids ?? []
  if (!stillIds.length && !imageIds.length && !assetIds.length) return []
  const [assets, stills] = await Promise.all([AssetIndex.load(), stillIds.length ? StillIndex.load() : undefined])
  const refs: ApprovalImageReference[] = []
  for (const id of stillIds) {
    const still = stills!.require(id)
    const what = still.prompt.trim() ? still.prompt.trim().replace(/\s+/g, ' ') : basename(still.path)
    refs.push({
      path: still.path,
      label: `Stillbild: ${what.length > 60 ? `${what.slice(0, 59)}…` : what}`,
      name: 'Stillbild',
      kind: 'still'
    })
  }
  for (const id of imageIds) {
    const photo = assets.requireImage(id)
    refs.push({
      path: photo.path,
      label: `${photo.asset.name} (foto ${photo.photoNumber})`,
      name: photo.asset.name,
      kind: photo.asset.kind
    })
  }
  for (const id of assetIds) {
    const asset = assets.require(id)
    const cover = asset.images[0]
    if (!cover) throw new Error(`${q(asset.name)} har inga bilder än. Användaren behöver lägga till bilder i Studio först.`)
    refs.push({ path: cover.path, label: `${asset.name} (foto 1)`, name: asset.name, kind: asset.kind })
  }
  return dedupeReferences(refs)
}

/** The references without repeats (the first place a picture has wins): the same picture twice adds nothing but cost. */
function dedupeReferences(refs: readonly ApprovalImageReference[]): ApprovalImageReference[] {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const key = r.path.normalize('NFC')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function excerptOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Reference paths carried along the renames made since `mark` (an asset renamed while the request waited). */
function followReferences(paths: readonly string[] | undefined, mark: number): string[] | undefined {
  if (!paths?.length) return undefined
  return db.followRewrites({ model: '', prompt: '', duration: '', referenceImages: [...paths] }, mark).referenceImages
}

/** The files of an image request's references, as imageIdentity has them for videos. */
function referenceIdentity(paths: readonly string[] | undefined): string {
  return imageIdentity({ model: '', prompt: '', duration: '', referenceImages: paths ? [...paths] : undefined })
}

const SLOT_WORD: Record<SegmentImageSlot, string> = { start: 'startbild', end: 'slutbild' }

// ── Storyboards: transitions and board pictures ──────────────────────────────

/** A path carried along the renames made since `mark` (a storyboard renamed, "Städa upp"). */
function followPath(path: string | undefined, mark: number): string | undefined {
  if (!path) return path
  return db.followRewrites({ model: '', prompt: '', duration: '', startImage: path }, mark).startImage
}

/**
 * A transition as the user approves it: the two boards it goes between, what is sent (both board pictures as
 * start and end image, prompt, model, options), which files the pictures are, and the prompt as sent.
 */
interface PinnedTransition {
  id: string
  storyboardId: string
  fromBoardId: string
  toBoardId: string
  params: GenerationParams
  key: string
  identity: string
  sent: string
}

function pinTransition(storyboard: Storyboard, t: StoryboardTransition, silent: SilentModels): PinnedTransition {
  return {
    id: t.id,
    storyboardId: storyboard.id,
    fromBoardId: t.fromBoardId,
    toBoardId: t.toBoardId,
    params: t.params,
    key: paramsKey(t.params, silent),
    // A path names a place, not a picture: the board pictures must stay the very files the user was shown.
    identity: imageIdentity(t.params),
    sent: sentPromptOf(t.params).prompt
  }
}

/**
 * Why the transition as the database has it right now is not the one the user approved, or undefined. Read
 * synchronously, so it can also run as the submit guard, on the very row the take is built from.
 */
function transitionChanged(pin: PinnedTransition, mark: number, silent: SilentModels): string | undefined {
  const row = store.getSegmentRow(pin.id)
  if (!row || row.sequence_id !== pin.storyboardId) {
    return 'Övergången finns inte längre (rutorna har flyttats eller tagits bort), så förfrågan gäller inte längre. Be agenten fråga igen om det fortfarande ska genereras.'
  }
  const pair = transitionPair(pin.id)
  if (pair?.from !== pin.fromBoardId || pair?.to !== pin.toBoardId || row.continue_from_previous || row.end_from_next) {
    return `Övergången går mellan andra rutor nu och ${CHANGED}`
  }
  const stored = store.parseParams(row.params)
  if (imageIdentity(stored) !== pin.identity) return `Bilderna i rutorna ${CHANGED}`
  if (paramsKey(stored, silent) !== paramsKey(db.followRewrites(pin.params, mark), silent)) return `Övergången ${CHANGED}`
  if (sentPromptOf(stored).prompt !== pin.sent) return SENT_PROMPT_CHANGED
  return undefined
}

/**
 * The transitions "Generera saknade" would pay for right now, as the storyboard service itself decides it: no
 * finished selected take, and none rendering or on its way to Venice. The run reads the same list as it goes.
 */
function transitionsToGenerate(storyboardId: string): Promise<MissingTransition[]> {
  return callService<MissingTransition[]>('storyboards:missing', storyboardId)
}

/**
 * Throws (in Swedish) unless the transition can be generated as it is: both boards have pictures, the storyboard
 * service sees no problem, and the params pass the same checks as every generation.
 */
function checkTransition(storyboard: Storyboard, index: number): void {
  const t = storyboard.transitions[index]
  const label = transitionLabel(storyboard, index)
  const what = label.charAt(0).toUpperCase() + label.slice(1)
  if (!t.ready) {
    throw new Error(
      `${what} kan inte genereras än: ${missingImagesText(storyboard, t)}. Lägg in bilderna först (request_image_generation med assign_to: {board_id}, eller update_board med image).`
    )
  }
  const problem = transitionProblems(t)[0]
  if (problem) throw new Error(`${what}: ${problem}`)
  ensureImagesExist(paramsForSubmit(t.params))
}

export function registerPaidTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'request_generation',
    {
      title: 'Request generation (paid, needs approval)',
      description:
        "💰 Asks the user to approve generating the current Generate form (as get_workspace shows it). Nothing is generated or paid for until they approve in Studio. The form is checked first (prompt, start image or references, @ImageN / @AudioN tokens); problems come back as an error and no request is made. Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval. The form is captured now: later changes to it don't change this request. The prompt is sent with the descriptions of its referenced assets appended (composed_prompt in get_workspace); the user approves exactly that text, and the request lapses if a description (or the prompt language) changes before they answer. Add a short note for the user (Swedish) saying what this generation is for.",
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
      const asked = paramsForSubmit(canonicalizeParams(state.params))
      const problem = blockingProblem(asked)
      if (problem) throw new Error(`Formuläret kan inte genereras: ${problem}`)
      ensureImagesExist(asked)
      // Audio clips measured now, as the submit will: a voice that turns out too short, too long or unreadable
      // is refused here instead of after the user has approved.
      const params = await prepareSubmission(asked).catch((err: unknown) => {
        throw new Error(`Formuläret kan inte genereras: ${errorText(err)}`)
      })
      const images = imageIdentity(params)
      // The model list too: main remembers the models' prompt limits from it, which the composed prompt is fitted into.
      const [price] = await Promise.all([quote(params), silentModels()])
      // What Venice will get: the prompt with the descriptions of its references as they are now. The user approves
      // exactly this text, so a description edited before they answer makes the request lapse.
      const sent = sentPromptOf(params)
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'generation',
        client: ctx.clientName(),
        note,
        params,
        ...composedFields(sent),
        priceUsd: price,
        fingerprint: `generation:${paramsKey(params)}`,
        paramsNow: () => db.followRewrites(params, mark),
        // Pictures renamed along with their asset while the request waited are followed to their new place,
        // but they must still be the very files the request was made with.
        verify: () => {
          const now = db.followRewrites(params, mark)
          if (imageIdentity(now) !== images) {
            throw new Error(`Bilderna eller ljudklippen i förfrågan ${CHANGED}`)
          }
          if (sentPromptOf(now).prompt !== sent.prompt) throw new Error(SENT_PROMPT_CHANGED)
        },
        // The approved text goes along, so what Venice gets is exactly what verify compared – not the prompt
        // composed again after the quote's round trip, from descriptions that may have been edited meanwhile.
        execute: async () => [
          (await callService<Generation>('video:generate', db.followRewrites(params, mark), sent.prompt)).id
        ]
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
        "💰 Asks the user to approve generating a new take of one sequence clip. Nothing is generated or paid for until they approve in Studio. The clip is checked first; a clip that continues from the previous one needs that clip's finished selected take, and one with end_from_next the next clip's (use request_generate_all to generate clips in order). The dialog shows the user the clip's start and end frames. Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval. If the clip – or the selected take or trim of a neighbour it takes a frame from, or a description appended to its prompt (composed_prompt in get_sequence) – is changed before the user approves, the request lapses. A newer request for the same clip replaces a pending older one.",
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
      const endFromNext = endsOnNext(sequence, index)
      const generated = asGenerated(segment.params, continuing, endFromNext)
      const problem = blockingProblem(generated, continuing, endFromNext)
      if (problem) throw new Error(`Klipp ${clip}: ${problem}`)
      if (continuing && !isUsableTake(selectedTake(sequence.segments[index - 1]))) {
        throw new Error(
          `Klipp ${clip} fortsätter från klipp ${index}, som behöver en färdig vald tagning först. Använd request_generate_all för att generera klippen i ordning.`
        )
      }
      if (endFromNext && !isUsableTake(selectedTake(sequence.segments[index + 1]))) {
        throw new Error(
          `Klipp ${clip} slutar på första bildrutan i klipp ${index + 2}, som behöver en färdig vald tagning först. Använd request_generate_all för att generera klippen i rätt ordning.`
        )
      }
      // The frames from the neighbours are checked the way the take will use them (a model without an end image,
      // a frame that can't be read …), so the user isn't asked to pay for a take that would be refused.
      if (continuing || endFromNext) {
        const preview = await callService<SegmentFramePreview>('segments:previewFrames', segment.id)
        if (preview.problems.length) throw new Error(`Klipp ${clip}: ${preview.problems[0]}`)
      }
      ensureImagesExist(paramsForSubmit(generated))
      if (!continuing && !endFromNext) {
        // Its audio clips are measured like the take's submit will, so a bad window is refused before approval.
        await prepareSubmission(generated).catch((err: unknown) => {
          throw new Error(`Klipp ${clip}: ${errorText(err)}`)
        })
      }
      const [price, silent] = await Promise.all([quote(generated), silentModels()])
      // Pinned to the neighbours' takes and trims too: the dialog shows the frames they give now.
      const neighbours = clipNeighbours(sequence, index, true)
      const key = clipKey(segment.params, neighbours, silent)
      // The prompt as it will be sent, with the descriptions of its references as they are now (what the user sees).
      const sent = sentPromptOf(generated)
      /** Why the clip as stored now isn't the one the user is shown, or undefined. */
      const changed = (): string | undefined => {
        const now = storedClipKey(segment.id, silent, true)
        if (!now) return 'Klippet finns inte längre.'
        const params = db.followRewrites(segment.params, mark)
        if (now === clipKey(params, neighbours, silent)) {
          // Both keys are built from today's descriptions; only the text kept from the request tells an edit apart.
          const prompt = sentPromptOf(asGenerated(params, continuing, endFromNext)).prompt
          return prompt === sent.prompt ? undefined : SENT_PROMPT_CHANGED
        }
        // The clip itself is as it was: a neighbour's other take or trim gives another frame.
        const same = { previousId: neighbours.previousId, nextId: neighbours.nextId }
        if (storedClipKey(segment.id, silent) === clipKey(params, same, silent)) {
          return `Bildrutan som klippet tar från ett grannklipp ${CHANGED}`
        }
        return `Klippet ${CHANGED}`
      }
      const guard: SubmitGuard = (id) => (id === segment.id ? changed() : 'Fel klipp.')
      const shown = paramsForSubmit(generated)
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'segment',
        client: ctx.clientName(),
        note,
        params: shown,
        paramsNow: () => db.followRewrites(shown, mark),
        ...composedFields(sent),
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
        "💰 Asks the user to approve generating every clip of a sequence that has no finished selected take, in an order that gives every clip the frames it needs (a continuation after the clip before it, a clip with end_from_next after the clip after it). Clips already rendering are waited for, not paid again. Every clip to generate is checked first; problems come back as an error naming the clip. price_usd is the sum over the clips. Returns immediately with {approval_id, status: \"pending\", price_usd, clip_numbers}; follow it with get_approval, then get_sequence. If the sequence's clips, or the descriptions appended to their prompts, change before the user approves, the request lapses.",
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
      if (blocked) throw new Error(missingClipProblem(blocked))
      const clips = missing.map(({ segmentId }) => {
        const index = sequence.segments.findIndex((s) => s.id === segmentId)
        if (index < 0) throw new Error('Sekvensen ändrades just nu. Försök igen.')
        const neighbours = clipNeighbours(sequence, index)
        const params = sequence.segments[index].params
        const generated = asGenerated(params, !!neighbours.previousId, !!neighbours.nextId)
        return { id: segmentId, clip: index + 1, params, generated, neighbours }
      })
      for (const c of clips) ensureImagesExist(paramsForSubmit(c.generated))
      // Each clip's audio is measured like its take's submit will: a voice that was shortened on disk (or can't
      // be read) is refused before approval, not after the run has paid for the clips before it.
      for (const c of clips) {
        if (c.neighbours.previousId || c.neighbours.nextId) continue
        await prepareSubmission(c.generated).catch((err: unknown) => {
          throw new Error(`Klipp ${c.clip}: ${errorText(err)}`)
        })
      }
      const [prices, silent] = await Promise.all([Promise.all(clips.map((c) => quote(c.generated))), silentModels()])
      const price = prices.every((p) => p !== undefined) ? prices.reduce<number>((sum, p) => sum + (p ?? 0), 0) : undefined
      const keys = clips.map((c) => `${c.id}:${clipKey(c.params, c.neighbours, silent)}`)
      const clipNumbers = clips.map((c) => c.clip)
      // Each clip's prompt as it will be sent, with the descriptions of its references as they are now.
      const composed = new Map(clips.map((c) => [c.id, sentPromptOf(c.generated)]))
      const sent = new Map([...composed].map(([id, c]) => [id, c.prompt]))
      const approved = new Map(clips.map((c) => [c.id, c]))
      const approvedKey = (c: (typeof clips)[number]): string =>
        clipKey(db.followRewrites(c.params, mark), c.neighbours, silent)
      /** The clip's prompt as it would be sent now differs from the one the user approved (a description changed). */
      const promptChanged = (c: (typeof clips)[number]): boolean =>
        sentPromptOf(asGenerated(db.followRewrites(c.params, mark), !!c.neighbours.previousId, !!c.neighbours.nextId))
          .prompt !== sent.get(c.id)
      // The run reads the sequence as it goes; this keeps it to the clips, and the settings, the user approved.
      const guard: SubmitGuard = (segmentId) => {
        const c = approved.get(segmentId)
        if (!c) {
          return 'Klippet ingick inte i agentens förfrågan som du godkände, så det genererades inte. Granska det och tryck ”Generera saknade” om det ska genereras.'
        }
        if (storedClipKey(segmentId, silent) !== approvedKey(c)) {
          return 'Klippet ändrades efter att du godkände agentens förfrågan, så det genererades inte. Granska det och tryck ”Generera saknade” om det ska genereras.'
        }
        if (promptChanged(c)) {
          return 'En beskrivning som läggs till i klippets prompt ändrades efter att du godkände agentens förfrågan, så klippet genererades inte. Granska det och tryck ”Generera saknade” om det ska genereras.'
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
        // The dialog compares them with the legends it composes now, so it says before the click what verify refuses.
        clipLegends: Object.fromEntries([...composed].map(([id, c]) => [id, c.legend])),
        priceUsd: price,
        fingerprint: `all:${sequence.id}:${keys.join(';')}`,
        target: `all:${sequence.id}`,
        verify: async () => {
          const ids = (await clipsToGenerate(sequence.id)).map((c) => c.segmentId)
          const then = clips.map((c) => `${c.id}:${approvedKey(c)}`)
          const now = ids.map((id) => `${id}:${storedClipKey(id, silent)}`)
          if (now.join(';') !== then.join(';')) throw new Error(`Sekvensen ${CHANGED}`)
          const edited = clips.find(promptChanged)
          if (edited) throw new Error(`Klipp ${edited.clip}: ${SENT_PROMPT_CHANGED}`)
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
    'request_transition_generation',
    {
      title: 'Request a storyboard transition (paid, needs approval)',
      description:
        "💰 Asks the user to approve generating a new take of one storyboard transition: the clip from one board's picture (its start image) to the next board's picture (its end image), with the transition's prompt, model, duration, resolution and audio. Nothing is generated or paid for until they approve in Studio; the dialog shows both pictures, the prompt and the price. Both boards need pictures and the prompt must be written (get_storyboard: ready). Returns immediately with {approval_id, status: \"pending\", price_usd}; follow it with get_approval, then get_storyboard / review_generation. If a board's picture or the transition changes (or the boards are moved apart) before the user approves, the request lapses. A newer request for the same transition replaces a pending older one. The new take becomes the transition's selected take when it has none that is usable; otherwise pick it with update_transition({selected_take_id}).",
      input: {
        transition_id: z.string(),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill generera en övergång'
    },
    async ({ transition_id, note }) => {
      const epoch = ctx.approvals.epoch()
      const mark = db.rewriteMark()
      const { storyboard, index, transition } = await loadTransition(transition_id)
      // The take would be refused (or paid for twice) while the storyboard's own run is making transitions.
      assertStoryboardIdle(storyboard)
      checkTransition(storyboard, index)
      const params = transition.params
      const [price, silent] = await Promise.all([quote(params), silentModels()])
      const pin = pinTransition(storyboard, transition, silent)
      const sent = sentPromptOf(params)
      // What the dialog shows: the two board pictures as start and end image, the prompt and the settings.
      const shown = paramsForSubmit(params)
      const label = transitionLabel(storyboard, index)
      const guard: SubmitGuard = (id) => (id === transition.id ? transitionChanged(pin, mark, silent) : 'Fel övergång.')
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'segment',
        client: ctx.clientName(),
        note,
        params: shown,
        paramsNow: () => db.followRewrites(shown, mark),
        ...composedFields(sent),
        sequenceId: storyboard.id,
        sequenceKind: 'storyboard',
        sequenceName: storyboard.name,
        segmentIds: [transition.id],
        clipNumbers: [index + 1],
        priceUsd: price,
        fingerprint: `transition:${transition.id}:${pin.key}:${pin.identity}:${pin.fromBoardId}:${pin.toBoardId}`,
        // The same target as a clip's request: a newer request for the transition replaces a pending older one.
        target: `segment:${transition.id}`,
        verify: () => {
          const problem = transitionChanged(pin, mark, silent)
          if (problem) throw new Error(problem)
        },
        // Checked again on the row the take is built from, right before it is sent.
        execute: async () => [(await callService<Generation>('transitions:generate', transition.id, guard)).id]
      })
      return {
        data: { ...pendingAnswer(request, reused), transition_number: index + 1 },
        approvalId: request.id,
        summary: `vill generera ${label} i ${q(storyboard.name)} (${usd(price)}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_generate_storyboard',
    {
      title: "Request generating a storyboard's missing transitions (paid, needs approval)",
      description:
        "💰 Asks the user to approve generating every transition of a storyboard that has no finished selected take (\"Generera saknade\"). Each transition only needs its two boards' pictures, so they are independent of each other. Every one of them must be ready – both boards with pictures, a prompt – or the request is refused naming the transition (generate the ready ones one by one with request_transition_generation instead). Transitions already rendering are not paid again. price_usd is the sum. Returns immediately with {approval_id, status: \"pending\", price_usd, transition_numbers}; follow it with get_approval, then get_storyboard. If a board's picture or one of the transitions changes before the user approves, the request lapses.",
      input: {
        storyboard_id: z.string(),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill generera saknade övergångar'
    },
    async ({ storyboard_id, note }) => {
      const epoch = ctx.approvals.epoch()
      const mark = db.rewriteMark()
      const storyboard = await loadStoryboard(storyboard_id)
      if (storyboard.running) throw new Error('”Generera saknade” pågår redan för storyboarden.')
      if (!storyboard.transitions.length) {
        throw new Error('Storyboarden har inga övergångar än: den behöver minst två rutor (add_board).')
      }
      const missing = (await transitionsToGenerate(storyboard.id)).map(({ transitionId }) => {
        const index = storyboard.transitions.findIndex((t) => t.id === transitionId)
        if (index < 0) throw new Error('Storyboarden ändrades just nu. Försök igen.')
        return { transition: storyboard.transitions[index], index }
      })
      if (!missing.length) {
        throw new Error(
          'Alla övergångar har redan en färdig vald tagning (eller håller på att genereras) – det finns inget att generera.'
        )
      }
      // The run refuses to start for the same reasons, so they are better heard now than after the user's OK.
      for (const { index } of missing) checkTransition(storyboard, index)
      const [prices, silent] = await Promise.all([
        Promise.all(missing.map(({ transition }) => quote(transition.params))),
        silentModels()
      ])
      const price = prices.every((p) => p !== undefined) ? prices.reduce<number>((sum, p) => sum + (p ?? 0), 0) : undefined
      const pins = new Map(missing.map(({ transition }) => [transition.id, pinTransition(storyboard, transition, silent)]))
      const numbers = missing.map(({ index }) => index + 1)
      const ids = missing.map(({ transition }) => transition.id)
      // The run reads the storyboard as it goes; this keeps it to the transitions, and the settings, the user approved.
      const guard: SubmitGuard = (segmentId) => {
        const pin = pins.get(segmentId)
        if (!pin) {
          return 'Övergången ingick inte i agentens förfrågan som du godkände, så den genererades inte. Granska den och tryck ”Generera saknade” om den ska genereras.'
        }
        const changed = transitionChanged(pin, mark, silent)
        return changed
          ? `Övergången ändrades efter att du godkände agentens förfrågan, så den genererades inte (${changed.replace(/\.$/, '')}). Granska den och tryck ”Generera saknade” om den ska genereras.`
          : undefined
      }
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'generate-all',
        client: ctx.clientName(),
        note,
        sequenceId: storyboard.id,
        sequenceKind: 'storyboard',
        sequenceName: storyboard.name,
        segmentIds: ids,
        clipNumbers: numbers,
        priceUsd: price,
        fingerprint: `storyboard-all:${storyboard.id}:${[...pins.values()].map((p) => `${p.id}:${p.key}:${p.identity}`).join(';')}`,
        target: `all:${storyboard.id}`,
        verify: async () => {
          const now = await callService<Storyboard>('storyboards:get', storyboard.id)
          if (now.running) throw new Error('”Generera saknade” pågår redan för storyboarden.')
          const still = (await transitionsToGenerate(storyboard.id)).map((m) => m.transitionId)
          if (still.join(';') !== ids.join(';')) {
            throw new Error(`Övergångarna som saknar en tagning ${CHANGED}`)
          }
          for (const pin of pins.values()) {
            const problem = transitionChanged(pin, mark, silent)
            if (problem) throw new Error(problem)
          }
        },
        execute: async () => {
          await callService('storyboards:generateAll', storyboard.id, guard)
          return []
        }
      })
      return {
        data: { ...pendingAnswer(request, reused), transition_numbers: numbers },
        approvalId: request.id,
        summary: `vill generera ${numbers.length === 1 ? '1 övergång' : `${numbers.length} övergångar`} i ${q(storyboard.name)} (${usd(price)}) – väntar på ditt OK`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'request_image_generation',
    {
      title: 'Request an image (paid, needs approval)',
      description:
        "💰 Asks the user to approve making one still picture with Venice's image models – typically a storyboard board's picture (a milestone of the film) or a sequence clip's start or end image. Cheap (about $0.06 with the default Seedream models) but paid, so nothing is generated until the user approves in Studio. With references it combines them into a new picture (an edit model, at most max_input_images – see list_image_models); without, it makes the picture from the prompt alone (a text-to-image model). References are sent in this order: the previous board's picture (previous_board_as_reference), reference_still_ids, reference_image_ids (library photos), then reference_asset_ids (each asset's cover photo); the first one is the base picture the model edits, so put the picture whose composition should be kept first. Write the prompt in English as one still frame: who and what, composition and framing, place, light, style; refer to references as \"image 1\", \"image 2\" … in that order, never with @ tokens. Left out: the default model for the case, the storyboard's or sequence's aspect ratio (the clip's with assign_to a clip), 1K and the model's default quality. The request is checked first (model, number of references, files, options) and priced; problems come back as an error. Returns {approval_id, status: \"pending\", price_usd}; follow it with get_approval, which gives the still_id once approved. Every result is saved as a still of its storyboard or sequence (with neither: in Referensbilder). assign_to: {board_id} also makes it that board's picture (replacing the one it has); assign_to: {segment_id, slot} makes it a sequence clip's start or end image (which switches the clip to image-to-video). Not while \"Generera saknade\" runs for that storyboard or sequence; if the board or clip is moved, removed or gets another picture (or the clip's slot starts or stops taking a neighbour's frame) before the user approves, the request lapses.",
      input: {
        prompt: z.string().min(1).max(4000).describe('English: one still frame – subject and moment, framing, place, light, style.'),
        storyboard_id: z
          .string()
          .optional()
          .describe("The storyboard whose stills get the picture; default the assign_to board's storyboard."),
        sequence_id: z
          .string()
          .optional()
          .describe("The sequence whose stills get the picture; default the assign_to clip's sequence."),
        model: z.string().optional().describe('An image model id from list_image_models; default Seedream.'),
        previous_board_as_reference: z
          .boolean()
          .optional()
          .describe(
            "With assign_to: {board_id}: send the previous board's picture as the first reference (the base picture), for visual continuity between milestones."
          ),
        reference_still_ids: z
          .array(z.string())
          .max(10)
          .optional()
          .describe('Stills (list_stills), e.g. an earlier board picture or keyframe.'),
        reference_image_ids: z
          .array(z.string())
          .max(10)
          .optional()
          .describe('Library photos by image_id (list_assets / get_asset).'),
        reference_asset_ids: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("Assets by id; each adds its cover photo (photo 1)."),
        aspect_ratio: z.string().optional().describe('e.g. "16:9"; must be one of the model\'s aspect_ratios.'),
        resolution: z.string().optional().describe('e.g. "1K"; one of the model\'s resolutions.'),
        quality: z.string().optional().describe("Only for models with qualities."),
        negative_prompt: z.string().max(1500).optional().describe('Text-to-image models only.'),
        assign_to: z
          .union([
            z.object({ board_id: z.string().describe('A board of a storyboard (get_storyboard).') }).strict(),
            z
              .object({
                segment_id: z.string(),
                slot: z.enum(['start', 'end']).describe('The clip\'s start image or its end image.')
              })
              .strict()
          ])
          .optional()
          .describe("Also put the still into this board (its picture) or this sequence clip's slot once it is made."),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      summary: () => 'vill skapa en bild'
    },
    async (input) => {
      const epoch = ctx.approvals.epoch()
      const mark = db.rewriteMark()
      requireLibrary()
      if (input.storyboard_id && input.sequence_id) throw new Error('Ange storyboard_id eller sequence_id, inte båda.')
      const boardAsked = input.assign_to && 'board_id' in input.assign_to ? input.assign_to.board_id : undefined
      const slotAsked = input.assign_to && 'segment_id' in input.assign_to ? input.assign_to : undefined
      if (input.previous_board_as_reference && !boardAsked) {
        throw new Error('previous_board_as_reference gäller bara tillsammans med assign_to: {board_id}.')
      }
      // A storyboard's id given as sequence_id is taken as meant.
      const ownerId = input.storyboard_id ?? input.sequence_id
      const ownerIsStoryboard = !!input.storyboard_id || (!!ownerId && isStoryboardId(ownerId))
      const board = boardAsked ? await loadBoard(boardAsked) : undefined
      const target = slotAsked ? await loadClip(slotAsked.segment_id) : undefined
      if (board && ownerId && ownerId !== board.storyboard.id) {
        throw new Error('Rutan i assign_to hör till en annan storyboard. Ange rutans egen storyboard, eller ingen.')
      }
      if (target && ownerId && target.sequence.id !== ownerId) {
        throw new Error('assign_to hör till en annan sekvens än sequence_id. Ange klippets egen sekvens, eller ingen.')
      }
      // The picture is put in after it is paid for, which "Generera saknade" would refuse meanwhile.
      if (target) assertNotRunning(target.sequence)
      if (board) assertStoryboardIdle(board.storyboard)
      const storyboard =
        board?.storyboard ?? (ownerId && ownerIsStoryboard && !target ? await loadStoryboard(ownerId) : undefined)
      const sequence =
        target?.sequence ?? (ownerId && !ownerIsStoryboard ? await loadSequence(ownerId) : undefined)

      // The previous board's picture first: the base picture the model keeps the composition and look of.
      const previous: ApprovalImageReference[] = []
      if (board && input.previous_board_as_reference) {
        if (board.index === 0) throw new Error('Ruta 1 har ingen föregående ruta att använda som referens.')
        const before = board.storyboard.boards[board.index - 1]
        if (!before.imagePath) {
          throw new Error(
            `Ruta ${board.index} har ingen bild än, så den kan inte bli referens. Skapa den först, eller låt bli previous_board_as_reference.`
          )
        }
        const [stills, assets] = await Promise.all([StillIndex.load(), AssetIndex.load()])
        const photo = assets.photo(before.imagePath)
        previous.push({
          path: before.imagePath,
          label: `Ruta ${board.index} (föregående bild)${before.note.trim() ? `: ${excerptOf(before.note, 50)}` : ''}`,
          name: `Ruta ${board.index}`,
          kind: photo ? photo.asset.kind : stills.atPath(before.imagePath) ? 'still' : undefined
        })
      }
      const references = dedupeReferences([...previous, ...(await imageReferences(input))])
      const asked: StillParams = {
        sequenceId: storyboard?.id ?? sequence?.id,
        prompt: input.prompt.replace(/\r\n?/g, '\n').trim(),
        model: input.model ?? '',
        negativePrompt: input.negative_prompt?.trim() || undefined,
        referenceImages: references.length ? references.map((r) => r.path) : undefined,
        aspectRatio: input.aspect_ratio?.trim().replace(/^(\d+)\s*[x/:]\s*(\d+)$/i, '$1:$2') || undefined,
        resolution: input.resolution?.trim() || undefined,
        quality: input.quality?.trim() || undefined
      }
      // Checked and filled in exactly as the window's dialog does it (model, references, options, price).
      let plan = await planStill(asked)
      const notes = [...plan.notes]
      // A board's picture should have its storyboard's format (a transition takes its format from its pictures), and
      // a keyframe its clip's (image-to-video takes the format from the start image).
      const wantedRatio = storyboard?.aspectRatio ?? target?.segment.params.aspectRatio
      if (!asked.aspectRatio && wantedRatio && plan.params.aspectRatio !== wantedRatio) {
        if (plan.model.aspectRatios.includes(wantedRatio)) {
          plan = await planStill({ ...asked, aspectRatio: wantedRatio })
          notes.splice(0, notes.length, ...plan.notes)
        } else if (storyboard) {
          notes.push(
            `${plan.model.name} kan inte göra bildformatet ${wantedRatio}, så bilden blir ${plan.params.aspectRatio ?? 'modellens standardformat'} – ett annat format än storyboardens.`
          )
        }
      }
      const params = plan.params
      const assignTo = target && slotAsked
        ? { segmentId: target.segment.id, slot: slotAsked.slot, clipNumber: target.index + 1 }
        : undefined
      // Whether the slot takes a neighbour's frame now: the picture replaces it (see the notes below).
      const slotWasAutomatic =
        !!assignTo && !!target && (assignTo.slot === 'start' ? continues : endsOnNext)(target.sequence, target.index)
      // A picture replaces an automatic frame from a neighbour; better said now than discovered later.
      if (assignTo?.slot === 'start' && target && continues(target.sequence, target.index)) {
        notes.push(
          `Klipp ${assignTo.clipNumber} börjar i dag på föregående klipps sista bildruta; bilden ersätter den och klippet slutar fortsätta från klipp ${assignTo.clipNumber - 1}.`
        )
      }
      if (assignTo?.slot === 'end' && target && endsOnNext(target.sequence, target.index)) {
        notes.push(
          `Klipp ${assignTo.clipNumber} slutar i dag på nästa klipps första bildruta; bilden ersätter den.`
        )
      }
      if (target && (target.segment.params.referenceImages?.length || target.segment.params.referenceAudios?.length)) {
        notes.push(
          `Klipp ${target.index + 1} använder i dag referenser. Med bilden genereras det bild-till-video: referenserna tas bort och prompten behöver beskriva rörelsen utan @-referenser (update_segment).`
        )
      }
      // The board as the user is shown it ("ruta N"), and the picture it has now, which the new one replaces.
      const boardShown = board
        ? { id: board.board.id, number: board.index + 1, imagePath: board.board.imagePath }
        : undefined
      if (boardShown?.imagePath) {
        notes.push(
          `Ruta ${boardShown.number} har redan en bild; den nya ersätter den (den gamla finns kvar bland storyboardens bilder).`
        )
      }
      const assignToBoard =
        boardShown && storyboard
          ? { boardId: boardShown.id, storyboardId: storyboard.id, boardNumber: boardShown.number }
          : undefined
      const identity = referenceIdentity(params.referenceImages)
      const owner = storyboard ?? sequence
      const { request, reused } = requestApproval(ctx, epoch, {
        kind: 'image',
        client: ctx.clientName(),
        note: input.note,
        image: { params, modelName: plan.model.name, references, assignTo, ...(assignToBoard ? { assignToBoard } : {}) },
        sequenceId: owner?.id,
        ...(storyboard ? { sequenceKind: 'storyboard' as const } : {}),
        sequenceName: owner?.name,
        segmentIds: assignTo ? [assignTo.segmentId] : undefined,
        clipNumbers: assignTo ? [assignTo.clipNumber] : undefined,
        priceUsd: plan.priceUsd,
        fingerprint: `image:${JSON.stringify([params, assignTo?.segmentId, assignTo?.slot, boardShown?.id, boardShown?.imagePath])}`,
        // A newer picture for the same slot or board replaces one still waiting.
        target: assignTo
          ? `image:${assignTo.segmentId}:${assignTo.slot}`
          : boardShown
            ? `image:board:${boardShown.id}`
            : undefined,
        verify: async () => {
          // A path names a place, not a picture: the references must still be the very files shown.
          if (referenceIdentity(followReferences(params.referenceImages, mark)) !== identity) {
            throw new Error(`Referensbilderna i förfrågan ${CHANGED}`)
          }
          if (boardShown && storyboard) {
            if (storyboardOfBoard(boardShown.id) !== storyboard.id) {
              throw new Error('Rutan som bilden skulle bli finns inte längre, så förfrågan gäller inte.')
            }
            // The user approves "ruta N" as the dialog names it: the board must still be there, with the picture
            // it had, so a picture the user put in meanwhile isn't replaced behind their back.
            const index = boardIndex(boardShown.id)
            if (index + 1 !== boardShown.number) {
              throw new Error(
                `Rutan som bilden skulle bli har flyttats (det var ruta ${boardShown.number}, nu ruta ${index + 1}), så förfrågan gäller inte längre. Be agenten fråga igen om bilden fortfarande ska skapas.`
              )
            }
            const now = await callService<Storyboard>('storyboards:get', storyboard.id)
            const imageNow = now.boards.find((b) => b.id === boardShown.id)?.imagePath
            if ((imageNow ?? '') !== (followPath(boardShown.imagePath, mark) ?? '')) {
              throw new Error(`Ruta ${boardShown.number} har fått en annan bild sedan agenten frågade, så förfrågan gäller inte längre.`)
            }
            if (now.running) {
              throw new Error(
                '”Generera saknade” pågår för storyboarden, så bilden kan inte sättas in nu och förfrågan gäller inte. Be agenten fråga igen när körningen är klar.'
              )
            }
            return
          }
          if (!assignTo) return
          const row = store.getSegmentRow(assignTo.segmentId)
          if (!row) throw new Error('Klippet som bilden skulle sättas i finns inte längre, så förfrågan gäller inte.')
          // The user approves "klipp N" as the dialog names it: the clip must still be there, as it was.
          const rows = store.listSegmentRows(row.sequence_id)
          const index = rows.findIndex((r) => r.id === row.id)
          if (index + 1 !== assignTo.clipNumber) {
            throw new Error(
              `Klippet som bilden skulle sättas i har flyttats (det var klipp ${assignTo.clipNumber}, nu klipp ${index + 1}), så förfrågan gäller inte längre. Be agenten fråga igen om bilden fortfarande ska skapas.`
            )
          }
          const automatic =
            assignTo.slot === 'start'
              ? index > 0 && !!row.continue_from_previous
              : index < rows.length - 1 && !!row.end_from_next
          if (automatic !== slotWasAutomatic) throw new Error(`Klipp ${assignTo.clipNumber} ${CHANGED}`)
          // Putting the picture into the clip would be refused after Venice was paid.
          if ((await callService<Sequence>('sequences:get', row.sequence_id)).running) {
            throw new Error(
              '”Generera saknade” pågår för sekvensen, så bilden kan inte sättas i klippet nu och förfrågan gäller inte. Be agenten fråga igen när körningen är klar.'
            )
          }
        },
        execute: async () => {
          const still = await callService<Still>('images:generate', {
            ...params,
            referenceImages: followReferences(params.referenceImages, mark)
          })
          if (boardShown) {
            // Checked again now that the picture is made, which takes a while: as verify says, a picture the user
            // put in meanwhile isn't replaced behind their back.
            if ((boardImagePath(boardShown.id) ?? '') !== (followPath(boardShown.imagePath, mark) ?? '')) {
              return {
                stillId: still.id,
                notice: `Bilden skapades och sparades bland storyboardens bilder, men ruta ${boardShown.number} fick en annan bild medan den skapades, så den nya sattes inte in där.`
              }
            }
            try {
              await callService<Storyboard>('boards:update', boardShown.id, { image: { kind: 'still', stillId: still.id } })
              return { stillId: still.id }
            } catch (err) {
              // Paid for and saved either way; only putting it into the board didn't work.
              return {
                stillId: still.id,
                notice: `Bilden skapades och sparades bland storyboardens bilder, men kunde inte bli bild för ruta ${boardShown.number}: ${errorText(err)}`
              }
            }
          }
          if (!assignTo) return { stillId: still.id }
          try {
            await callService<Sequence>('segments:setImage', assignTo.segmentId, assignTo.slot, {
              kind: 'still',
              stillId: still.id
            })
            return { stillId: still.id }
          } catch (err) {
            // Paid for and saved either way; only putting it into the clip didn't work.
            return {
              stillId: still.id,
              notice: `Bilden skapades och sparades bland sekvensens bilder, men kunde inte bli ${SLOT_WORD[assignTo.slot]} för klipp ${assignTo.clipNumber}: ${errorText(err)}`
            }
          }
        }
      })
      const where = boardShown
        ? ` till ruta ${boardShown.number} i ${q(storyboard!.name)}`
        : assignTo
          ? ` till klipp ${assignTo.clipNumber}${sequence ? ` i ${q(sequence.name)}` : ''}`
          : owner
            ? ` i ${q(owner.name)}`
            : ''
      return {
        data: {
          ...pendingAnswer(request, reused),
          model: params.model,
          ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
          ...(params.quality ? { quality: params.quality } : {}),
          // The user's "Säkert läge för bilder": Venice blurs adult content while it is on.
          safe_mode: getImageSafeMode(),
          references: references.map((r, i) => ({
            image: i + 1,
            what: r.label,
            ...(i === 0 ? { base: true } : {})
          })),
          ...(boardShown ? { assign_to: { board_id: boardShown.id, board_number: boardShown.number } } : {}),
          ...(assignTo
            ? { assign_to: { segment_id: assignTo.segmentId, clip_number: assignTo.clipNumber, slot: assignTo.slot } }
            : {}),
          ...(notes.length ? { notes } : {})
        },
        approvalId: request.id,
        summary: `vill skapa en bild${where} (${usd(plan.priceUsd)}) – väntar på ditt OK`
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
        "The state of an approval request: pending (the user hasn't answered), approved (with generation_ids – follow them with get_generation; for generate-all, follow the sequence with get_sequence, for generate-storyboard the storyboard with get_storyboard; for an image, the still_id – look at it with get_still – and assigned when it went into its board or clip; for an edit operation, the job's progress and then result_version – review it with review_generation; for a designed voice, the new Röst clip's audio_id once it is made), declined (with the user's reason if they gave one), expired (unanswered for 30 minutes, or replaced by a newer request) or failed (the error). Poll every 15–30 seconds while pending, and while an approved edit or voice job is still running.",
      input: { approval_id: z.string() },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'kollade svaret på en förfrågan'
    },
    async ({ approval_id }) => {
      const request = ctx.approvals.get(approval_id)
      if (!request) throw new Error('Förfrågan finns inte. Förfrågningar glöms när Studio startas om.')
      const storyboardId = request.sequenceKind === 'storyboard' ? request.sequenceId : undefined
      // A storyboard's transitions are segments to the approval store; the agent asked for transitions.
      const transitions = !!storyboardId && (request.kind === 'segment' || request.kind === 'generate-all')
      const board = request.image?.assignToBoard
      const data: Record<string, unknown> = {
        approval_id: request.id,
        status: request.status,
        kind: transitions ? (request.kind === 'segment' ? 'transition' : 'generate-storyboard') : request.kind,
        price_usd: priceValue(request.priceUsd),
        created: localTime(request.createdAt),
        ...(request.status === 'pending' ? { expires: localTime(request.expiresAt) } : {}),
        note: request.note,
        error: request.error,
        reason: request.reason,
        ...(storyboardId
          ? {
              storyboard_id: storyboardId,
              ...(transitions ? { transition_ids: request.segmentIds, transition_numbers: request.clipNumbers } : {})
            }
          : { sequence_id: request.sequenceId, clip_numbers: request.clipNumbers }),
        generation_ids: request.generationIds,
        ...(request.kind === 'image' && request.image?.assignTo
          ? {
              assign_to: {
                segment_id: request.image.assignTo.segmentId,
                clip_number: request.image.assignTo.clipNumber,
                slot: request.image.assignTo.slot
              }
            }
          : {}),
        ...(request.kind === 'image' && board ? { assign_to: { board_id: board.boardId, board_number: board.boardNumber } } : {}),
        ...(request.stillId ? { still_id: request.stillId } : {}),
        ...(request.notice ? { notice: request.notice } : {}),
        // Redigera's requests: the edit and version (or the character), the operation, and the job it started.
        ...(request.kind === 'edit' || request.kind === 'voice-design' ? await editApprovalInfo(request) : {})
      }
      if (request.status === 'approved') {
        if (request.stillId) {
          const still = await callService<Still>('stills:get', request.stillId).catch(() => undefined)
          data.still = still
            ? {
                still_id: still.id,
                file: basename(still.path),
                ...(still.sequenceId && isStoryboardId(still.sequenceId)
                  ? { storyboard_id: still.sequenceId }
                  : { sequence_id: still.sequenceId ?? null })
              }
            : { still_id: request.stillId, status: 'deleted' }
          if ((request.image?.assignTo || board) && !request.notice) data.assigned = true
        }
        if (request.generationIds?.length) {
          data.generations = request.generationIds.map((id) => {
            const g = db.getGeneration(id)
            return g ? { id, status: g.status, error: g.error } : { id, status: 'deleted' }
          })
        }
        if (request.kind === 'generate-all' && storyboardId) {
          const now = await callService<Storyboard>('storyboards:get', storyboardId).catch(() => undefined)
          if (now) {
            data.storyboard = {
              generate_all_running: now.running,
              last_run_error: readableRunError(now.runError),
              transitions_without_finished_take: now.transitions.flatMap((t, i) => (transitionDone(t) ? [] : [i + 1]))
            }
          }
        } else if (request.kind === 'generate-all' && request.sequenceId) {
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
