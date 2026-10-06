import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  DEFAULT_PARAMS,
  PREFERRED,
  audioForModel,
  durationSeconds,
  imageToVideoVariant,
  kindOfModelId,
  maxReferenceImages,
  pickOption
} from '@shared/models'
import type { Generation, GenerationParams, Segment, Sequence, SequenceSummary, VideoModel } from '@shared/types'
import * as store from '../../sequence-store'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import {
  AssetIndex,
  asGenerated,
  blockingProblem,
  canonical,
  checkOutputOptions,
  checkPromptLength,
  issueList,
  loadModels,
  localTime,
  modelForMode,
  normalizeAspectRatio,
  normalizeDuration,
  normalizeResolution,
  paramsInfo,
  promptIssues,
  q,
  readableRunError,
  referencePaths,
  requireLibrary,
  requireModel,
  usableModels,
  type ReferenceItem
} from '../studio'
import { READ_ONLY, WRITE, defineTool, type LabeledImage, type ToolContext } from './kit'

// Sequences: films made of clips (segments), each with its own prompt and references and any number of takes.
// These tools go straight to the sequence service; the window follows through its usual change events.

/** A completed take whose video is still there: something the cut (and a continuation clip) can use. */
export function isUsableTake(take: Generation | undefined): boolean {
  return take?.status === 'completed' && !!take.filePath && !take.fileMissing
}

export function selectedTake(segment: Segment): Generation | undefined {
  return segment.selectedGenerationId ? segment.takes.find((t) => t.id === segment.selectedGenerationId) : undefined
}

export function hasPendingTake(segment: Segment): boolean {
  return segment.takes.some((t) => t.status === 'queued' || t.status === 'processing')
}

/** Continues from the previous clip (never the first one). */
export function continues(sequence: Sequence, index: number): boolean {
  return index > 0 && sequence.segments[index].continueFromPrevious
}

export async function loadSequence(sequenceId: string): Promise<Sequence> {
  requireLibrary()
  return callService<Sequence>('sequences:get', sequenceId)
}

/** The sequence a clip belongs to, and the clip's index in it. */
export async function loadClip(segmentId: string): Promise<{ sequence: Sequence; index: number; segment: Segment }> {
  requireLibrary()
  const row = store.getSegmentRow(segmentId)
  if (!row) throw new Error('Klippet finns inte längre.')
  const sequence = await loadSequence(row.sequence_id)
  const index = sequence.segments.findIndex((s) => s.id === segmentId)
  if (index < 0) throw new Error('Klippet finns inte längre.')
  return { sequence, index, segment: sequence.segments[index] }
}

/**
 * Clips can't be changed by an agent while "Generera saknade" runs for their sequence: the run re-reads the
 * clips at every step, so a clip added or rewritten meanwhile would be paid for without the user having seen it.
 */
function assertNotRunning(sequence: Sequence): void {
  if (sequence.running) {
    throw new Error(
      `”Generera saknade” pågår för ${q(sequence.name)}. Vänta tills körningen är klar (eller be användaren stoppa den) innan du ändrar klippen.`
    )
  }
}

/** One clip as the tools show it. */
export function clipInfo(sequence: Sequence, index: number, assets: AssetIndex): Record<string, unknown> {
  const segment = sequence.segments[index]
  const continuing = continues(sequence, index)
  const generated = asGenerated(segment.params, continuing)
  const problem = blockingProblem(generated, continuing)
  const take = selectedTake(segment)
  const trimmed = segment.trimStart || segment.trimEnd
  return {
    segment_id: segment.id,
    clip_number: index + 1,
    continue_from_previous: continuing,
    ...paramsInfo(generated, assets),
    ...(continuing ? { start_image: { last_frame_of_clip: index } } : {}),
    issues: issueList(promptIssues(generated)),
    ready: !problem,
    ...(problem ? { blocking_problem: problem } : {}),
    selected_take: take
      ? {
          generation_id: take.id,
          status: take.status,
          error: take.error,
          video_seconds: take.videoDuration,
          ...(take.fileMissing ? { file_missing: true } : {})
        }
      : null,
    take_count: segment.takes.length,
    ...(hasPendingTake(segment) ? { rendering: true } : {}),
    ...(trimmed ? { trim_start: segment.trimStart, trim_end: segment.trimEnd } : {})
  }
}

/** Seconds of the cut: the selected finished takes after trims. */
function cutSeconds(sequence: Sequence): number {
  let total = 0
  for (const segment of sequence.segments) {
    const take = selectedTake(segment)
    if (!isUsableTake(take)) continue
    const length = take!.videoDuration ?? durationSeconds(take!.params.duration)
    total += Math.max(0, length - segment.trimStart - segment.trimEnd)
  }
  return Math.round(total * 10) / 10
}

export function sequenceInfo(sequence: Sequence, assets: AssetIndex): Record<string, unknown> {
  const missing = sequence.segments.flatMap((s, i) => (isUsableTake(selectedTake(s)) ? [] : [i + 1]))
  return {
    sequence_id: sequence.id,
    name: sequence.name,
    clip_count: sequence.segments.length,
    cut_seconds: cutSeconds(sequence),
    clips_without_finished_take: missing,
    generate_all_running: sequence.running,
    ...(sequence.runError ? { last_run_error: readableRunError(sequence.runError) } : {}),
    clips: sequence.segments.map((_, i) => clipInfo(sequence, i, assets))
  }
}

// ── Building a clip's settings ───────────────────────────────────────────────

interface ClipInput {
  prompt?: string
  negative_prompt?: string
  references?: ReferenceItem[]
  model?: string
  duration?: string
  resolution?: string
  aspect_ratio?: string
  audio?: boolean
}

/**
 * The params a clip gets from `base` (its current params, or what a new clip starts from) and the agent's
 * changes, checked the way Studio would generate it. Throws (in Swedish) when the clip couldn't be generated
 * as written, so nothing invalid is saved.
 */
async function clipParams(
  base: GenerationParams,
  input: ClipInput,
  continuing: boolean,
  assets: AssetIndex,
  clipNumber: number
): Promise<GenerationParams> {
  if (continuing && input.references?.length) {
    throw new Error(
      `Klipp ${clipNumber} fortsätter från föregående klipp: det genereras från dess sista bildruta och tar inga referensbilder. Ta bort references eller sätt continue_from_previous till false.`
    )
  }
  let models: VideoModel[] | undefined
  const getModels = async (): Promise<VideoModel[]> => (models ??= await loadModels())

  let modelId = input.model ? requireModel(await getModels(), input.model).id : base.model
  if (continuing) {
    modelId = imageToVideoVariant(modelId)
  } else if (kindOfModelId(modelId) === 'image-to-video' && !input.model) {
    // A new shot of its own: Studio has no start image for it, so it takes references instead.
    modelId = modelForMode(await getModels(), modelId, 'reference-to-video')
  } else if (input.references?.length && kindOfModelId(modelId) !== 'reference-to-video') {
    if (input.model) {
      throw new Error(`Referensbilder används bara i läget reference-to-video, men ${modelId} är ${kindOfModelId(modelId)}.`)
    }
    modelId = modelForMode(await getModels(), modelId, 'reference-to-video')
  }

  const duration = normalizeDuration(input.duration)
  const resolution = normalizeResolution(input.resolution)
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio)
  const params: GenerationParams = {
    ...base,
    model: modelId,
    prompt: input.prompt !== undefined ? (canonical(input.prompt) ?? '') : base.prompt,
    negativePrompt:
      input.negative_prompt !== undefined ? canonical(input.negative_prompt) || undefined : base.negativePrompt,
    duration: duration ?? base.duration,
    resolution: resolution ?? base.resolution,
    aspectRatio: aspectRatio ?? base.aspectRatio,
    audio: input.audio ?? base.audio
  }

  const changedModel = modelId !== base.model
  const optionsGiven =
    duration !== undefined || resolution !== undefined || aspectRatio !== undefined || input.audio !== undefined
  if (changedModel || optionsGiven) {
    const model = usableModels(await getModels()).find((m) => m.id === modelId)
    if (model) {
      checkOutputOptions(model, { duration, resolution, aspectRatio, audio: input.audio })
      // Whatever wasn't chosen follows the model, the way Studio's model switch does it.
      params.duration = pickOption(model.durations, params.duration, PREFERRED.durations) ?? params.duration
      params.resolution = pickOption(model.resolutions, params.resolution, PREFERRED.resolutions)
      params.aspectRatio = pickOption(model.aspectRatios, params.aspectRatio, PREFERRED.aspectRatios)
      // As the form does it (audioForModel), so opening the clip in Studio changes nothing.
      params.audio = audioForModel(model, params.audio)
      if (model.audio && !model.audioConfigurable) params.audio = true
      checkPromptLength(model, params.prompt)
    }
  }

  if (continuing) {
    // The start frame comes from the previous clip when the take is generated.
    params.startImage = undefined
    params.endImage = undefined
    params.referenceImages = undefined
  } else if (input.references !== undefined) {
    const paths = referencePaths(input.references, assets)
    params.referenceImages = paths.length ? paths : undefined
  }
  if (kindOfModelId(modelId) === 'reference-to-video') {
    const max = maxReferenceImages(modelId)
    const count = params.referenceImages?.length ?? 0
    if (count > max) throw new Error(`Klipp ${clipNumber} har ${count} referensbilder, men modellen tar högst ${max}.`)
  }

  const problem = blockingProblem(asGenerated(params, continuing), continuing)
  if (problem) throw new Error(`Klipp ${clipNumber}: ${problem}`)
  return params
}

const clipFields = {
  prompt: z.string().describe("What happens in the clip (see the guide). Tokens must match this clip's own references."),
  negative_prompt: z.string().optional().describe('Empty string clears it.'),
  references: z
    .array(
      z.object({
        asset_id: z.string(),
        image_ids: z.array(z.string()).optional().describe("Only these photos, in this order. All the asset's photos when left out.")
      })
    )
    .optional()
    .describe("The clip's own reference images, in @Image order (replaces the clip's references). Not allowed on a continuing clip."),
  model: z.string().optional().describe('A model id from list_models. A continuing clip always uses the image-to-video model of that family.'),
  duration: z.string().optional().describe('e.g. "8s".'),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  audio: z.boolean().optional(),
  continue_from_previous: z
    .boolean()
    .optional()
    .describe("Start from the previous clip's last frame (image-to-video, no references, no tokens).")
}

export function registerSequenceTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'list_sequences',
    {
      title: 'List sequences',
      description:
        "The user's sequences (films made of several clips), most recently changed first, with the number of clips and the length of the current cut in seconds.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listade sekvenserna'
    },
    async () => {
      requireLibrary()
      const list = await callService<SequenceSummary[]>('sequences:list')
      return {
        data: {
          sequences: list.map((s) => ({
            sequence_id: s.id,
            name: s.name,
            clip_count: s.segmentCount,
            cut_seconds: s.totalDuration,
            updated: localTime(s.updatedAt)
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_sequence',
    {
      title: 'Get sequence',
      description:
        "One sequence with its clips in order. Each clip has its prompt and settings, its own reference images as a token map, whether it continues from the previous clip, validation issues (ready: false means it can't be generated as it is), and its selected take (status, error). With include_thumbnails (default true) the poster frame of every finished selected take comes as an image, so you can check continuity across the cut.",
      input: {
        sequence_id: z.string(),
        include_thumbnails: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en sekvens'
    },
    async ({ sequence_id, include_thumbnails }) => {
      const sequence = await loadSequence(sequence_id)
      const assets = await AssetIndex.load()
      const images: LabeledImage[] = []
      if (include_thumbnails) {
        for (const [i, segment] of sequence.segments.entries()) {
          const take = selectedTake(segment)
          if (!isUsableTake(take) || !take?.thumbPath) continue
          const image = await imageBlock(take.thumbPath)
          if (image) images.push({ label: `Clip ${i + 1} – selected take ${take.id} (poster frame)`, image })
        }
      }
      return { data: sequenceInfo(sequence, assets), images, summary: `tittade på sekvensen ${q(sequence.name)}` }
    }
  )

  defineTool(
    server,
    ctx,
    'create_sequence',
    {
      title: 'Create sequence',
      description:
        'Creates an empty sequence (a film made of clips) with the default settings (Seedance 2.5, 8s, 480p, 16:9, audio). Add clips with add_segment.',
      input: { name: z.string().describe('e.g. "Promenad på stranden".') },
      annotations: WRITE,
      summary: ({ name }) => `skapade sekvensen ${q(name)}`
    },
    async ({ name }) => {
      requireLibrary()
      const sequence = await callService<Sequence>('sequences:create', name)
      return { data: { sequence_id: sequence.id, name: sequence.name } }
    }
  )

  defineTool(
    server,
    ctx,
    'add_segment',
    {
      title: 'Add clip to sequence',
      description:
        "Adds a clip to a sequence, at the end or after after_segment_id. Settings you leave out come from the previous clip (or the sequence defaults for the first clip). continue_from_previous defaults to true when there is a previous clip and you pass no references, otherwise false. A continuing clip starts from the previous clip's last frame: it is image-to-video and takes no references or tokens – describe what happens next. A clip that doesn't continue is a new shot: give it references (its own @Image1… numbering) unless it should reuse the previous clip's. The clip is validated like a generation; problems are returned as an error and nothing is saved.",
      input: {
        sequence_id: z.string(),
        after_segment_id: z.string().optional().describe('Insert after this clip; at the end when left out.'),
        ...clipFields
      },
      annotations: WRITE,
      summary: () => 'lade till ett klipp'
    },
    async ({ sequence_id, after_segment_id, continue_from_previous, ...input }) => {
      const sequence = await loadSequence(sequence_id)
      assertNotRunning(sequence)
      const assets = await AssetIndex.load()
      const afterIndex = after_segment_id
        ? sequence.segments.findIndex((s) => s.id === after_segment_id)
        : sequence.segments.length - 1
      if (after_segment_id && afterIndex < 0) throw new Error('after_segment_id är inget klipp i den här sekvensen.')
      const previous = afterIndex >= 0 ? sequence.segments[afterIndex] : undefined
      if (continue_from_previous && !previous) {
        throw new Error('Det första klippet kan inte fortsätta från ett föregående klipp.')
      }
      const continuing = !!previous && (continue_from_previous ?? !input.references?.length)
      const base: GenerationParams = previous
        ? { ...previous.params, prompt: '' }
        : { ...DEFAULT_PARAMS, ...sequence.defaults, prompt: '' }
      const clipNumber = afterIndex + 2
      const params = await clipParams(base, input, continuing, assets, clipNumber)

      const before = new Set(sequence.segments.map((s) => s.id))
      const updated = await callService<Sequence>('segments:add', sequence.id, {
        afterSegmentId: previous?.id,
        params,
        continueFromPrevious: continuing
      })
      const index = updated.segments.findIndex((s) => !before.has(s.id))
      return {
        data: { ...(index >= 0 ? clipInfo(updated, index, assets) : {}), clip_count: updated.segments.length },
        summary: `lade till klipp ${index + 1} i ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_segment',
    {
      title: 'Update clip',
      description:
        "Changes a clip: only the fields you pass change. references replaces the clip's reference images (in @Image order). Switching continue_from_previous off makes it a new shot that needs references (and switches it to the reference-to-video model unless you pass a model); switching it on drops its references. The clip is validated like a generation; problems are returned as an error and nothing is saved. Existing takes are kept.",
      input: {
        segment_id: z.string(),
        ...clipFields,
        prompt: clipFields.prompt.optional()
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade ett klipp'
    },
    async ({ segment_id, continue_from_previous, ...input }) => {
      const { sequence, index, segment } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const assets = await AssetIndex.load()
      if (continue_from_previous && index === 0) {
        throw new Error('Det första klippet kan inte fortsätta från ett föregående klipp.')
      }
      const continuing = continue_from_previous ?? continues(sequence, index)
      const params = await clipParams(segment.params, input, continuing, assets, index + 1)
      // The new params are built on the clip as it was read; whatever the user saved meanwhile would be written
      // over without a word. Compared right before the write (nothing can come in between).
      const row = store.getSegmentRow(segment.id)
      if (!row) throw new Error('Klippet finns inte längre.')
      if (
        store.serializeParams(store.parseParams(row.params)) !== store.serializeParams(segment.params) ||
        !!row.continue_from_previous !== segment.continueFromPrevious
      ) {
        throw new Error(
          'Klippet ändrades i Studio medan ändringen förbereddes, så inget sparades. Läs klippet igen (get_sequence) och gör ändringen på nytt.'
        )
      }
      const updated = await callService<Sequence>('segments:update', segment.id, {
        params,
        continueFromPrevious: continuing
      })
      const at = updated.segments.findIndex((s) => s.id === segment.id)
      return {
        data: at >= 0 ? clipInfo(updated, at, assets) : { segment_id },
        summary: `ändrade klipp ${index + 1} i ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'delete_segment',
    {
      title: 'Delete clip',
      description:
        "Removes a clip from its sequence. Its takes are not deleted: their videos become ordinary generations in the user's feed. A clip that continued from the deleted one now continues from the clip before it.",
      input: { segment_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      summary: () => 'tog bort ett klipp'
    },
    async ({ segment_id }) => {
      const { sequence, index } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const updated = await callService<Sequence>('segments:delete', segment_id)
      return {
        data: { deleted: segment_id, clip_count: updated.segments.length },
        summary: `tog bort klipp ${index + 1} i ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'move_segment',
    {
      title: 'Move clip',
      description:
        'Moves a clip to another place in its sequence. to_clip_number is the 1-based number the clip should have afterwards (as Studio shows "Klipp 1", "Klipp 2" …). Whichever clip ends up first stops continuing from a previous clip.',
      input: {
        segment_id: z.string(),
        to_clip_number: z.number().int().min(1)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ to_clip_number }) => `flyttade ett klipp till plats ${to_clip_number}`
    },
    async ({ segment_id, to_clip_number }) => {
      const { sequence, index } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const updated = await callService<Sequence>('segments:move', segment_id, to_clip_number - 1)
      return {
        data: {
          clips: updated.segments.map((s, i) => ({
            segment_id: s.id,
            clip_number: i + 1,
            continue_from_previous: continues(updated, i),
            prompt: s.params.prompt
          }))
        },
        summary: `flyttade klipp ${index + 1} till plats ${Math.min(to_clip_number, updated.segments.length)} i ${q(sequence.name)}`
      }
    }
  )
}
