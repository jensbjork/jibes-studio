import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  continuationPlan,
  continuationProblem,
  droppedImagesNote,
  ownReferences,
  sendParams,
  type ChainClip,
  type ContinuationPlan
} from '@shared/continuation'
import {
  DEFAULT_PARAMS,
  PREFERRED,
  audioForModel,
  durationSeconds,
  endImageVariant,
  imageToVideoVariant,
  kindOfModelId,
  maxReferenceImages,
  pickOption,
  referenceToVideoVariant,
  supportsEndImage
} from '@shared/models'
import { generationTitle } from '@shared/generation-label'
import { explainedReferences } from '@shared/prompt-compose'
import {
  audioToken,
  findAudioTokens,
  findImageTokens,
  imageToken,
  validateGenerationParams,
  type PromptIssue
} from '@shared/prompt-refs'
import { reorderReferences } from '@shared/prompt-remap'
import type {
  ContinueMode,
  ExportSummary,
  Generation,
  GenerationParams,
  Segment,
  SegmentImageSlot,
  SegmentImageSource,
  SegmentPatch,
  Sequence,
  SequenceSummary,
  Storyboard,
  VideoModel,
  WorkSummary
} from '@shared/types'
import * as db from '../../db'
import * as store from '../../sequence-store'
import { composeTakePrompt, withoutReferenceTokens } from '../../sequences'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import {
  movedSummary,
  movedTokens,
  newOrder,
  referencesAnswer,
  reorderAnswer,
  unchanged,
  type MovedToken
} from '../reorder'
import {
  applySwap,
  planSwap,
  swapNotes,
  swapSummary,
  swappedInfo,
  swappedTokens,
  swapsNothing,
  unchangedNote,
  type ReadySwap,
  type SwapInput,
  type Swapped
} from '../swap'
import { isStoryboardId, sequenceKind, storyboardNotSequence } from '../storyboard-rows'
import {
  AssetIndex,
  StillIndex,
  applyOutfitWearers,
  audioTarget,
  audioTokenMap,
  blockingProblem,
  canonical,
  checkOutputOptions,
  checkPromptLength,
  descriptionInfo,
  errorText,
  imageRef,
  issueList,
  loadModels,
  localTime,
  modelForMode,
  modelsIfAvailable,
  normalizeAspectRatio,
  normalizeDuration,
  normalizeResolution,
  paramsInfo,
  q,
  readableRunError,
  requireLibrary,
  requireModel,
  resolveReferences,
  seconds,
  takesAudio,
  tokenMap,
  usableModels,
  type AudioInfo,
  type OutfitWearerInput,
  type ReferenceItem
} from '../studio'
import {
  READ_ONLY,
  WRITE,
  defineTool,
  excludedDescriptionsInput,
  includeDescriptionsInput,
  outfitWearersInput,
  referenceItem,
  type LabeledImage,
  type ToolContext,
  type ToolOutput
} from './kit'
import {
  URL_WAIT_MS,
  importAsStill,
  resolvePictureReferences,
  stageFiles,
  uploadSource,
  urlSource,
  type ReferenceInput
} from './sources'

// Sequences: films made of clips (segments), each with its own prompt and references – or its own start and end
// images (keyframes), or frames taken from its neighbours – and any number of takes. Storyboards are stored as
// sequences too (their transitions are segments), but they are a workflow of their own with their own tools
// (storyboards.ts): these tools refuse their ids and say where to go instead. They go straight to the sequence
// service; the window follows through its usual change events.

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

/** Ends on the next clip's first frame (never the last one). */
export function endsOnNext(sequence: Sequence, index: number): boolean {
  return index < sequence.segments.length - 1 && !!sequence.segments[index].endFromNext
}

/** A sequence (not a storyboard: those have their own tools, which the error names). */
export async function loadSequence(sequenceId: string): Promise<Sequence> {
  requireLibrary()
  if (isStoryboardId(sequenceId)) throw storyboardNotSequence('get_storyboard')
  return callService<Sequence>('sequences:get', sequenceId)
}

/** Says that a storyboard's transition was given to a tool for sequence clips. */
export function transitionNotClip(): Error {
  return new Error(
    'This is a transition in a storyboard, not a clip in a sequence. Use update_transition, preview_transition and request_transition_generation (get_storyboard lists the transitions).'
  )
}

/** The sequence a clip belongs to, and the clip's index in it (never a storyboard's transition). */
export async function loadClip(segmentId: string): Promise<{ sequence: Sequence; index: number; segment: Segment }> {
  requireLibrary()
  const row = store.getSegmentRow(segmentId)
  if (!row) throw new Error('The clip no longer exists.')
  if (isStoryboardId(row.sequence_id)) throw transitionNotClip()
  const sequence = await loadSequence(row.sequence_id)
  const index = sequence.segments.findIndex((s) => s.id === segmentId)
  if (index < 0) throw new Error('The clip no longer exists.')
  return { sequence, index, segment: sequence.segments[index] }
}

/**
 * Clips can't be changed by an agent while "Generate missing" runs for their sequence: the run re-reads the
 * clips at every step, so a clip added or rewritten meanwhile would be paid for without the user having seen it.
 */
export function assertNotRunning(sequence: Sequence): void {
  if (sequence.running) {
    throw new Error(
      `"Generate missing" is running for ${q(sequence.name)}. Wait until the run is done (or stop it with stop_generation_run) before you change the clips.`
    )
  }
}

/**
 * The params a take of the clip would be sent with now (frames from neighbours left out until it is made): a clip
 * that continues in reference mode with the references it carries (its own, or the clip's it continues from), one
 * that otherwise takes a neighbour's frame image-to-video without references (the shared continuation.ts rules).
 */
export function asSent(sequence: Sequence, index: number): GenerationParams {
  return sendParams(sequence.segments, index)
}

/** How the clip continues from the previous clip (continuation.ts), or undefined when it doesn't. */
export function continuationOf(sequence: Sequence, index: number): ContinuationPlan | undefined {
  return continuationPlan(sequence.segments, index)
}

/**
 * What stops the clip from being generated as it would be sent (`generated`, see asSent): a continuation
 * in reference mode is checked against the references it carries with the previous clip's last frame after them;
 * one sent exactly may name no references (and is told it can carry them instead, where it could).
 */
export function sendProblem(
  generated: GenerationParams,
  continuing: boolean,
  ending: boolean,
  plan: ContinuationPlan | undefined
): string | undefined {
  if (!plan) return blockingProblem(generated, continuing, ending)
  if (!generated.prompt.trim()) return 'The prompt is empty.'
  if (plan.mode === 'references') return continuationProblem(generated, plan)
  const problem = blockingProblem(generated, continuing, ending)
  // The continuation wording, with the way out reference mode offers where it applies.
  return problem?.startsWith('The clip continues from') ? (continuationProblem(generated, plan) ?? problem) : problem
}

/**
 * The prompt issues of the clip as it would be sent (with the carried references and the frame in reference mode). A
 * reference the References legend of its take's prompt explains (composeTakePrompt) isn't reported as unmentioned.
 */
function sendIssues(generated: GenerationParams, plan: ContinuationPlan | undefined): PromptIssue[] {
  const explained = explainedReferences(composeTakePrompt(generated, plan))
  const { prompt, negativePrompt } =
    plan?.mode === 'references'
      ? validateGenerationParams(
          { ...generated, referenceImages: plan.carried?.images ?? [] },
          { continuationFrame: true, explained }
        )
      : validateGenerationParams(generated, { explained })
  return [...prompt, ...negativePrompt]
}

/**
 * How a continuing clip is sent, as the tools show it: the choice (continue_mode), how it goes now (sent_as) and why
 * that differs, and in reference mode the references it carries (carried_references) with the frame's token.
 */
function continuationInfo(plan: ContinuationPlan, assets: AssetIndex): Record<string, unknown> {
  const dropped = droppedImagesNote(plan)
  return {
    continue_mode: plan.chosen,
    sent_as: plan.mode,
    ...(plan.applies ? {} : { continue_mode_applies: false }),
    ...(plan.note ? { continue_mode_note: plan.note } : {}),
    ...(plan.mode === 'references' && plan.carried
      ? {
          carried_references: {
            from_clip: plan.carried.fromClip,
            inherited: plan.carried.inherited,
            references: tokenMap(plan.images, assets),
            ...(plan.audios.length ? { audio_references: audioTokenMap(plan.audios, assets) } : {}),
            start_frame_token: imageToken(plan.frameToken ?? plan.images.length + 1),
            ...(dropped ? { not_sent: dropped } : {})
          }
        }
      : {})
  }
}

/**
 * What still stands in the way of the clip's start and end frames, without extracting anything: a neighbour
 * without a finished selected take, a keyframe whose file is gone. preview_segment_frames gives the full answer.
 */
function frameProblems(sequence: Sequence, index: number, generated: GenerationParams): string[] {
  const problems: string[] = []
  const missingTake = (i: number): boolean => !isUsableTake(selectedTake(sequence.segments[i]))
  if (continues(sequence, index) && missingTake(index - 1)) problems.push(`Clip ${index} has no finished selected take yet.`)
  if (endsOnNext(sequence, index) && missingTake(index + 1)) {
    problems.push(`Clip ${index + 2} has no finished selected take yet.`)
  }
  if (kindOfModelId(generated.model) === 'image-to-video') {
    if (generated.startImage && !existsSync(generated.startImage)) {
      problems.push(`The start image no longer exists: ${basename(generated.startImage)}.`)
    }
    if (generated.endImage && !existsSync(generated.endImage)) {
      problems.push(`The end image no longer exists: ${basename(generated.endImage)}.`)
    }
  }
  return problems
}

/** One clip as the tools show it, with its prompt as it would be sent (the descriptions of its references appended). */
export function clipInfo(
  sequence: Sequence,
  index: number,
  assets: AssetIndex,
  stills: StillIndex
): Record<string, unknown> {
  const segment = sequence.segments[index]
  const continuing = continues(sequence, index)
  const ending = endsOnNext(sequence, index)
  const plan = continuationOf(sequence, index)
  const generated = asSent(sequence, index)
  const problem = sendProblem(generated, continuing, ending, plan)
  const keyframed = kindOfModelId(generated.model) === 'image-to-video'
  const take = selectedTake(segment)
  const trimmed = segment.trimStart || segment.trimEnd
  const frames = frameProblems(sequence, index, generated)
  const references = plan?.mode === 'references'
  // In reference mode the prompt is sent with the instruction to start on the frame in front of it.
  const composed = references ? composeTakePrompt(generated, plan) : undefined
  return {
    segment_id: segment.id,
    clip_number: index + 1,
    notes: segment.notes ?? '',
    continue_from_previous: continuing,
    ...(plan ? continuationInfo(plan, assets) : {}),
    end_from_next: ending,
    ...paramsInfo(generated, assets),
    ...descriptionInfo(generated, assets),
    ...(composed ? { composed_prompt: composed.prompt, composed_characters: composed.prompt.length } : {}),
    start_image: continuing
      ? {
          kind: 'previous',
          from_clip: index,
          // Reference mode: the frame goes along as the last reference image, which the instruction names.
          ...(references ? { sent_as_reference: imageToken(plan.frameToken ?? 1) } : {})
        }
      : keyframed && generated.startImage
        ? imageRef(generated.startImage, assets, stills)
        : null,
    end_image: ending
      ? { kind: 'next', from_clip: index + 2 }
      : keyframed && generated.endImage
        ? imageRef(generated.endImage, assets, stills)
        : null,
    supports_end_image: supportsEndImage(generated.model),
    issues: issueList(sendIssues(generated, plan)),
    ready: !problem,
    ...(problem ? { blocking_problem: problem } : {}),
    ...(frames.length ? { frame_problems: frames } : {}),
    selected_take: take
      ? {
          generation_id: take.id,
          source: take.source ?? 'generated',
          ...(ownTake(take) ? { title: generationTitle(take) } : {}),
          status: take.status,
          error: take.error,
          video_seconds: take.videoDuration,
          ...(take.fileMissing ? { file_missing: true } : {})
        }
      : null,
    // The selected take is the user's own film (or a version made in the Editor), not a generation of the clip's
    // prompt: the clip needs no prompt to be in the cut, and the next clip can still continue from its last frame.
    ...(take && ownTake(take) ? { own_clip: true } : {}),
    take_count: segment.takes.length,
    ...(hasPendingTake(segment) ? { rendering: true } : {}),
    ...(trimmed ? { trim_start: segment.trimStart, trim_end: segment.trimEnd } : {})
  }
}

/** A take that Venice didn't make from the clip: an import (own clip) or a version from the Editor. */
export function ownTake(take: Generation): boolean {
  return !!take.source && take.source !== 'generated'
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

/** What a sequence's first clip (and an own clip added to it) starts from, as the tools show it. */
function defaultsInfo(sequence: Sequence): Record<string, unknown> {
  const d = sequence.defaults
  return {
    ...(d.model ? { model: d.model } : {}),
    ...(d.duration ? { duration: d.duration } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
    ...(d.aspectRatio ? { aspect_ratio: d.aspectRatio } : {}),
    ...(d.audio !== undefined ? { audio: d.audio } : {})
  }
}

export function sequenceInfo(sequence: Sequence, assets: AssetIndex, stills: StillIndex): Record<string, unknown> {
  const missing = sequence.segments.flatMap((s, i) => (isUsableTake(selectedTake(s)) ? [] : [i + 1]))
  return {
    sequence_id: sequence.id,
    name: sequence.name,
    clip_count: sequence.segments.length,
    cut_seconds: cutSeconds(sequence),
    clips_without_finished_take: missing,
    // "Export format": the exported film's height, or null = the first clip's own size (update_sequence sets it).
    export_height: sequence.exportHeight ?? null,
    defaults: defaultsInfo(sequence),
    generate_all_running: sequence.running,
    ...(sequence.runError ? { last_run_error: readableRunError(sequence.runError) } : {}),
    still_count: stills.stills.filter((s) => s.sequenceId === sequence.id).length,
    clips: sequence.segments.map((_, i) => clipInfo(sequence, i, assets, stills))
  }
}

// ── Start and end images ─────────────────────────────────────────────────────

/** What an agent can put into a start or end slot ({upload_id} / {url} become `file` before the checks). */
type SlotInput =
  | 'previous'
  | 'next'
  | null
  | { still_id: string }
  | { asset_image_id: string }
  | { generation_id: string; time: number }
  | { upload_id: string }
  | { url: string }

/** A slot input once its upload or URL is a staged file (copied in as a still of the sequence when it is set). */
type ResolvedSlotInput = Exclude<SlotInput, { upload_id: string } | { url: string }> | { file: string }

const slotInput = z
  .union([
    z.literal('previous'),
    z.literal('next'),
    z.null(),
    z.object({ still_id: z.string() }).strict(),
    z.object({ asset_image_id: z.string() }).strict(),
    z.object({ generation_id: z.string(), time: z.number().min(0) }).strict(),
    uploadSource,
    urlSource
  ])
  .optional()

/**
 * Uploads and URLs in the slot inputs as staged files, fetched before anything is checked or saved (a URL that
 * can't be had changes nothing). The service copies such a file into the sequence's stills when it sets the slot.
 */
async function resolveSlotFiles<T extends { start_image?: SlotInput; end_image?: SlotInput }>(
  ctx: ToolContext,
  input: T
): Promise<Omit<T, 'start_image' | 'end_image'> & { start_image?: ResolvedSlotInput; end_image?: ResolvedSlotInput }> {
  const deadline = Date.now() + URL_WAIT_MS
  const one = async (value: SlotInput | undefined): Promise<ResolvedSlotInput | undefined> => {
    if (value && typeof value === 'object' && ('upload_id' in value || 'url' in value)) {
      const [file] = await stageFiles(ctx, 'image', [value], deadline)
      return { file: file.path }
    }
    return value as ResolvedSlotInput | undefined
  }
  return { ...input, start_image: await one(input.start_image), end_image: await one(input.end_image) }
}

/** What happens to a slot: an explicit picture to put there after saving, or none. */
interface SlotPlan {
  /** Put this picture into the slot (segments:setImage) once the clip is saved. */
  set?: SegmentImageSource
  /** The picture the slot will have (kept or new), for the checks; '' for a frame that isn't extracted yet. */
  path?: string
}

/** "start image" / "end image", for messages about a slot. */
const SLOT_WORDS: Record<SegmentImageSlot, string> = { start: 'start image', end: 'end image' }

/**
 * The explicit picture a slot input names, checked before anything is saved (the still, the photo, the finished
 * clip and its file exist). Frames are only extracted when the clip is saved, so their path is ''.
 */
function explicitSource(
  value: Exclude<ResolvedSlotInput, 'previous' | 'next' | null>,
  assets: AssetIndex,
  stills: StillIndex
): { source: SegmentImageSource; path: string } {
  if ('file' in value) return { source: { kind: 'file', path: value.file }, path: value.file }
  if ('still_id' in value) {
    const still = stills.require(value.still_id)
    if (!existsSync(still.path)) throw new Error(`The still image ${basename(still.path)} is no longer on disk.`)
    return { source: { kind: 'still', stillId: still.id }, path: still.path }
  }
  if ('asset_image_id' in value) {
    const photo = assets.requireImage(value.asset_image_id)
    return { source: { kind: 'asset-image', imageId: photo.imageId }, path: photo.path }
  }
  const g = db.getGeneration(value.generation_id)
  if (!g) throw new Error(`There is no generation with id ${value.generation_id}.`)
  if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
    throw new Error('The generation has no finished video to take a frame from.')
  }
  return { source: { kind: 'frame', generationId: g.id, time: value.time }, path: '' }
}

/** The clip's explicit keyframe in a slot, as it is stored (only an image-to-video clip has one). */
function ownImage(params: GenerationParams, slot: SegmentImageSlot): string | undefined {
  if (kindOfModelId(params.model) !== 'image-to-video') return undefined
  return slot === 'start' ? params.startImage : params.endImage
}

interface SlotState {
  continuing: boolean
  ending: boolean
  /** How a continuing clip starts on the frame (continue_mode): with the references it carries, or exactly. */
  mode: ContinueMode
  start: SlotPlan
  end: SlotPlan
}

/**
 * Where a clip's start and end frames come from after the agent's change: the neighbours (continue_from_previous,
 * end_from_next, or "previous" / "next"), a picture (kept, or one of the slot inputs) or nothing. Throws on
 * inputs that contradict each other or the clip's place in the sequence.
 */
function slotState(
  input: {
    continue_from_previous?: boolean
    continue_mode?: ContinueMode
    end_from_next?: boolean
    start_image?: ResolvedSlotInput
    end_image?: ResolvedSlotInput
  },
  current: { continuing: boolean; ending: boolean; mode: ContinueMode; params: GenerationParams },
  place: { first: boolean; last: boolean },
  assets: AssetIndex,
  stills: StillIndex,
  defaultContinuing: boolean
): SlotState {
  const { start_image: start, end_image: end } = input
  if (start === 'next') {
    throw new Error('The start image can\'t come from the next clip. Did you mean end_image: "next"?')
  }
  if (end === 'previous') {
    throw new Error('The end image can\'t come from the previous clip. Did you mean start_image: "previous"?')
  }
  const startContinues = start === 'previous'
  const flagGiven = input.continue_from_previous !== undefined
  if (start !== undefined && flagGiven && startContinues !== input.continue_from_previous) {
    throw new Error('start_image and continue_from_previous contradict each other. Give only one of them.')
  }
  if (end !== undefined && input.end_from_next !== undefined && (end === 'next') !== input.end_from_next) {
    throw new Error('end_image and end_from_next contradict each other. Give only one of them.')
  }

  const continuing =
    start !== undefined
      ? start === 'previous'
      : (input.continue_from_previous ?? (current.continuing || defaultContinuing))
  const ending = end !== undefined ? end === 'next' : (input.end_from_next ?? current.ending)
  if (continuing && place.first) throw new Error('The first clip can\'t continue from a previous clip.')
  if (ending && place.last) throw new Error('The last clip has no next clip to take its end image from.')

  const plan = (slot: SegmentImageSlot, value: ResolvedSlotInput | undefined, automatic: boolean): SlotPlan => {
    if (automatic) return {}
    if (value === undefined) {
      const kept = ownImage(current.params, slot)
      return kept ? { path: kept } : {}
    }
    if (value === null || value === 'previous' || value === 'next') return {}
    const { source, path } = explicitSource(value, assets, stills)
    return { set: source, path }
  }
  return {
    continuing,
    ending,
    mode: input.continue_mode ?? current.mode,
    start: plan('start', start, continuing),
    end: plan('end', end, ending)
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
  include_descriptions?: boolean
  excluded_description_asset_ids?: string[]
  outfit_wearers?: OutfitWearerInput[]
}

interface ClipParams {
  /** As saved: explicit pictures that are set afterwards (segments:setImage) are not in it yet. */
  params: GenerationParams
  /** What was decided on the agent's behalf, e.g. a voice left out. */
  notes: string[]
  /** Audio asked for that didn't fit the model's limits. */
  skippedAudio: (AudioInfo & { reason: string })[]
}

/** Has @ImageN or @AudioN tokens. */
function hasTokens(text: string | undefined): boolean {
  return !!text && (findImageTokens(text).length > 0 || findAudioTokens(text).length > 0)
}

/** Where a clip sits among its sequence's clips, for the references a continuation carries from the clips before. */
interface ClipPlace {
  sequence: Sequence
  /** Its index once saved. */
  index: number
  /** A new clip inserted at `index` (add_segment), rather than the one there now (update_segment). */
  insert: boolean
}

/**
 * The params a clip gets from `base` (its current params, or what a new clip starts from) and the agent's
 * changes, checked the way Studio would generate it. A clip that continues from the previous clip in reference mode
 * (continue_mode "references", the default; not with an end frame of any kind) is generated reference-to-video with
 * the references it carries – the ones given here, its own, or those of the clip it continues from – and the previous
 * clip's last frame after them. A clip with any other start or end frame (a picture, a neighbour's frame) is
 * generated image-to-video – by a model that takes an end image when it has one – and takes no references. Throws
 * when the clip couldn't be generated as written, so nothing invalid is saved.
 */
async function clipParams(
  base: GenerationParams,
  input: ClipInput,
  slots: SlotState,
  assets: AssetIndex,
  clipNumber: number,
  place: ClipPlace
): Promise<ClipParams> {
  const { continuing, ending } = slots
  let models: VideoModel[] | undefined
  const getModels = async (): Promise<VideoModel[]> => (models ??= await loadModels())
  const notes: string[] = []

  let modelId = input.model ? requireModel(await getModels(), input.model).id : base.model
  // A continuation in reference mode, when the family has a reference-to-video model (else it continues exactly).
  let withReferences = continuing && !ending && slots.end.path === undefined && slots.mode === 'references'
  if (withReferences) {
    const variant = referenceToVideoVariant(modelId, usableModels(await getModels()).map((m) => m.id))
    if (variant) modelId = variant
    else {
      withReferences = false
      if (input.references?.length) {
        throw new Error(
          `Clip ${clipNumber}: ${modelId} has no model for references, so the clip can only continue with an exact start frame, without references. Choose a model for references (list_models) or remove references.`
        )
      }
      notes.push(`${modelId} has no model for references, so the clip continues with an exact start frame, without references.`)
    }
  }
  const keyframed =
    (continuing && !withReferences) || ending || slots.start.path !== undefined || slots.end.path !== undefined
  const needsEnd = ending || slots.end.path !== undefined
  if (keyframed && input.references?.length) {
    throw new Error(
      continuing
        ? ending || slots.end.path !== undefined
          ? `Clip ${clipNumber} continues from the previous clip and ends on an end image: it is generated image-to-video from both frames and takes no references. Remove references, or the end image (end_image: null / end_from_next: false).`
          : `Clip ${clipNumber} continues with an exact start frame (continue_mode "exact"): it is generated from the previous clip's last frame and takes no references. Remove references, or set continue_mode to "references".`
        : `Clip ${clipNumber} has a start or end image and is generated image-to-video, which takes no references. Remove references, or remove the images (start_image / end_image: null) to use references.`
    )
  }

  if (withReferences) {
    // Already the family's reference-to-video model (above).
  } else if (keyframed) {
    if (input.model && needsEnd && kindOfModelId(modelId) === 'image-to-video' && !supportsEndImage(modelId)) {
      throw new Error(
        `${modelId} can't take an end image. Choose an image-to-video model that can (e.g. Seedance), or remove the end image.`
      )
    }
    // As Studio does it when a slot gets a picture: the family's image-to-video model, one that takes an end
    // image when the clip has one.
    const ids = needsEnd ? usableModels(await getModels()).map((m) => m.id) : undefined
    modelId = needsEnd ? endImageVariant(modelId, ids) : imageToVideoVariant(modelId)
  } else if (kindOfModelId(modelId) === 'image-to-video' && !input.model) {
    // A new shot of its own without pictures: it takes references instead.
    modelId = modelForMode(await getModels(), modelId, 'reference-to-video')
  } else if (input.references?.length && kindOfModelId(modelId) !== 'reference-to-video') {
    if (input.model) {
      throw new Error(`References are only used in reference-to-video mode, but ${modelId} is ${kindOfModelId(modelId)}.`)
    }
    modelId = modelForMode(await getModels(), modelId, 'reference-to-video')
  } else if (kindOfModelId(modelId) === 'image-to-video') {
    throw new Error(
      `${modelId} is an image-to-video model and needs a start image: give start_image, or choose a model for references.`
    )
  }

  const duration = normalizeDuration(input.duration)
  const resolution = normalizeResolution(input.resolution)
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio)
  let prompt = input.prompt !== undefined ? (canonical(input.prompt) ?? '') : base.prompt
  let negativePrompt =
    input.negative_prompt !== undefined ? canonical(input.negative_prompt) || undefined : base.negativePrompt
  if (keyframed) {
    // A prompt the agent didn't rewrite loses its tokens the way Studio's own switch takes them out; one it
    // wrote now must be written for image-to-video (checked below).
    if (input.prompt === undefined && hasTokens(prompt)) {
      prompt = withoutReferenceTokens(prompt)
      notes.push(
        'The prompt no longer sends references, so its @ references were taken out. Consider rewriting it: describe in words what happens between the start and end images.'
      )
    }
    if (input.negative_prompt === undefined && hasTokens(negativePrompt)) {
      negativePrompt = withoutReferenceTokens(negativePrompt ?? '') || undefined
    }
  }
  const params: GenerationParams = {
    ...base,
    model: modelId,
    prompt,
    negativePrompt,
    duration: duration ?? base.duration,
    resolution: resolution ?? base.resolution,
    aspectRatio: aspectRatio ?? base.aspectRatio,
    audio: input.audio ?? base.audio
  }
  // Which descriptions of its references the clip appends to its prompt ("Include descriptions"); they travel
  // with the clip's settings, so a clip continuing from it, or a new one after it, starts from the same choice.
  if (input.include_descriptions !== undefined) params.includeDescriptions = input.include_descriptions
  if (input.excluded_description_asset_ids !== undefined) {
    const excluded = [...new Set(input.excluded_description_asset_ids.map((id) => assets.require(id.trim()).id))]
    params.excludedDescriptionAssetIds = excluded.length ? excluded : undefined
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

  let skippedAudio: ClipParams['skippedAudio'] = []
  if (withReferences) {
    // Its own references (given here, or kept); without any it carries those of the clip it continues from as they
    // are when its take is made. A new clip doesn't take the previous clip's as its own: it carries them.
    params.startImage = undefined
    params.endImage = undefined
    if (input.references !== undefined) {
      const resolved = resolveReferences(input.references, assets, audioTarget(modelId, models))
      params.referenceImages = resolved.paths.length ? resolved.paths : undefined
      params.referenceAudios = resolved.audios.length ? resolved.audios : undefined
      notes.push(...resolved.notes)
      skippedAudio = resolved.skippedAudio
    } else {
      // References it already sent in reference mode stay; ones left over from another mode go (as Studio does it).
      const own = place.insert ? undefined : ownReferences(base)
      params.referenceImages = own?.images.length ? own.images : undefined
      params.referenceAudios = own?.audios.length && takesAudio(modelId, models) ? own.audios : undefined
    }
    const max = maxReferenceImages(modelId)
    const count = params.referenceImages?.length ?? 0
    if (count > max) throw new Error(`Clip ${clipNumber} has ${count} reference images, but the model takes at most ${max}.`)
  } else if (keyframed) {
    if (base.referenceImages?.length || base.referenceAudios?.length) {
      notes.push(
        'The clip\'s references (images and voices) were removed: with a start or end image it is generated image-to-video, and the look comes from the images.'
      )
    }
    params.referenceImages = undefined
    params.referenceAudios = undefined
    // Neighbours' frames are taken when the take is generated; new pictures are put in once the clip is saved.
    params.startImage = continuing || slots.start.set ? undefined : slots.start.path
    params.endImage = ending || slots.end.set ? undefined : slots.end.path
  } else {
    params.startImage = undefined
    params.endImage = undefined
    if (input.references !== undefined) {
      const resolved = resolveReferences(input.references, assets, audioTarget(modelId, models))
      params.referenceImages = resolved.paths.length ? resolved.paths : undefined
      params.referenceAudios = resolved.audios.length ? resolved.audios : undefined
      notes.push(...resolved.notes)
      skippedAudio = resolved.skippedAudio
    } else if (params.referenceAudios?.length && !takesAudio(modelId, models)) {
      // Kept references meet a model that takes no audio: the voices would only be refused at generation.
      params.referenceAudios = undefined
      notes.push('The audio references were removed: the model takes no reference audio.')
    }
    if (kindOfModelId(modelId) === 'reference-to-video') {
      const max = maxReferenceImages(modelId)
      const count = params.referenceImages?.length ?? 0
      if (count > max) throw new Error(`Clip ${clipNumber} has ${count} reference images, but the model takes at most ${max}.`)
    }
  }

  // Checked as it will be generated, with the pictures that are put in after saving standing in their slots, and
  // among the clips it carries references from.
  const checked: GenerationParams = {
    ...params,
    startImage: slots.start.set ? slots.start.path || 'frame' : params.startImage,
    endImage: slots.end.set ? slots.end.path || 'frame' : params.endImage
  }
  const clip: ChainClip = { params: checked, continueFromPrevious: continuing, endFromNext: ending, continueMode: slots.mode }
  const clips: ChainClip[] = [...place.sequence.segments]
  clips.splice(place.index, place.insert ? 0 : 1, clip)
  const plan = continuationPlan(clips, place.index)
  const sent = sendParams(clips, place.index)
  const problem = sendProblem(sent, continuing, ending, plan)
  if (problem) throw new Error(`Clip ${clipNumber}: ${problem}${plan?.note && plan.applies ? ` (${plan.note})` : ''}`)
  // Who wears which outfit: the agent's choices, checked against the pictures the clip has or carries, and the
  // stored ones kept to those (a choice for an outfit that left is forgotten, as in Studio's form).
  try {
    const wearers = applyOutfitWearers(
      params.outfitWearers,
      input.outfit_wearers,
      [...(params.referenceImages ?? []), ...(sent.referenceImages ?? [])],
      assets
    )
    if (wearers) params.outfitWearers = wearers
    else delete params.outfitWearers
  } catch (err) {
    throw new Error(`Clip ${clipNumber}: ${errorText(err)}`)
  }
  if (plan?.mode === 'references') {
    const dropped = droppedImagesNote(plan)
    if (dropped) notes.push(dropped)
    if (plan.carried?.inherited) {
      notes.push(
        `The clip sends the references of clip ${plan.carried.fromClip} and the previous clip's last frame as ${imageToken(plan.frameToken ?? 1)}.`
      )
    }
  } else if (plan?.note && plan.applies && plan.chosen === 'references') {
    notes.push(plan.note)
  }
  return { params, notes, skippedAudio }
}

/**
 * Puts the new pictures into their slots once the clip is saved (Studio's own keyframe service: it copies a
 * frame into the sequence's stills, and keeps the clip image-to-video). Returns the clip as it is afterwards.
 */
async function applyImages(segmentId: string, slots: SlotState, clipNumber: number): Promise<Sequence | undefined> {
  let updated: Sequence | undefined
  for (const slot of ['start', 'end'] as const) {
    const source = slots[slot].set
    if (!source) continue
    try {
      updated = await callService<Sequence>('segments:setImage', segmentId, slot, source)
    } catch (err) {
      throw new Error(
        `Clip ${clipNumber} was saved, but its ${SLOT_WORDS[slot]} couldn't be set: ${errorText(err)} Try again with update_segment({${slot}_image}).`
      )
    }
  }
  return updated
}

/** A frame or a file becomes a new still when it is put into its slot, so the stills are read again afterwards. */
function savesFrame(slots: SlotState): boolean {
  const makesStill = (kind: SegmentImageSource['kind'] | undefined): boolean => kind === 'frame' || kind === 'file'
  return makesStill(slots.start.set?.kind) || makesStill(slots.end.set?.kind)
}

/**
 * A clip's input with what agents send resolved first: slot pictures from uploads or URLs as staged files, and
 * loose reference pictures (stills, uploads made stills in "Referensbilder") as files – so a clip never points into
 * the scratch folder.
 */
async function resolvedClipInput<
  T extends { start_image?: SlotInput; end_image?: SlotInput; references?: readonly ReferenceInput[] }
>(ctx: ToolContext, input: T) {
  const withSlots = await resolveSlotFiles(ctx, input)
  return {
    ...withSlots,
    references: input.references ? await resolvePictureReferences(ctx, input.references, true) : undefined
  }
}

/** The extras an agent should hear about after saving a clip. */
function clipNotes(result: ClipParams): Record<string, unknown> {
  return {
    ...(result.skippedAudio.length ? { not_added_audio: result.skippedAudio } : {}),
    ...(result.notes.length ? { notes: result.notes } : {})
  }
}

// ── Reordering and swapping a clip's references ──────────────────────────────

/**
 * Refuses to change the references of a clip that sends none of its own: one that continues exactly,
 * one that carries another clip's references (the message says which clip to change instead: `there`), and one with
 * a start or end image or none at all. `verb` is what can't be done ("reorder", "swap").
 */
function assertOwnClipReferences(
  sequence: Sequence,
  index: number,
  segment: Segment,
  verb: string,
  there: (fromClip: number) => string
): void {
  const clipNumber = index + 1
  if (continues(sequence, index)) {
    const plan = continuationOf(sequence, index)
    if (plan?.form !== 'reference-to-video') {
      throw new Error(
        `Clip ${clipNumber} continues with an exact start frame from the previous clip and sends no references, so there is nothing to ${verb}.`
      )
    }
    if (!ownReferences(segment.params)) {
      const from = plan.carried?.fromClip
      throw new Error(
        from
          ? `Clip ${clipNumber} has no references of its own – it sends the references of clip ${from}. ${there(from)}, or give the clip its own with update_segment({references}).`
          : `Clip ${clipNumber} has no references to ${verb}.`
      )
    }
  }
  if (endsOnNext(sequence, index) || kindOfModelId(segment.params.model) === 'image-to-video') {
    throw new Error(
      `Clip ${clipNumber} has a start or end image (image-to-video) and sends no references, so there is nothing to ${verb}.`
    )
  }
  if (kindOfModelId(segment.params.model) !== 'reference-to-video') {
    throw new Error(`Clip ${clipNumber} is text-to-video and has no references to ${verb}.`)
  }
}

/** Refuses to save a clip the user changed in Studio after it was read (`params`): their change is not written over. */
function assertClipUnchanged(segmentId: string, params: GenerationParams): void {
  const row = store.getSegmentRow(segmentId)
  if (!row) throw new Error('The clip no longer exists.')
  if (store.serializeParams(store.parseParams(row.params)) !== store.serializeParams(params)) {
    throw new Error(
      'The clip was changed in Studio while the change was being prepared, so nothing was saved. Read the clip again (get_sequence) and make the change again.'
    )
  }
}

/**
 * reorder_references for a sequence clip: its reference images and/or audio in the new order (see newOrder), with
 * every @ImageN / @AudioN token in its prompt and negative prompt renumbered by the shared reorderReferences (what
 * Studio's own drag and drop applies), saved through the sequence service in one change. Refused while "Generate
 * missing" runs, for a clip that sends no references, and when the clip changed in Studio meanwhile.
 */
export async function reorderClipReferences(
  segmentId: string,
  images: readonly string[] | undefined,
  audios: readonly string[] | undefined
): Promise<ToolOutput> {
  const { sequence, index, segment } = await loadClip(segmentId)
  assertNotRunning(sequence)
  const clipNumber = index + 1
  const where = `clip ${clipNumber}`
  assertOwnClipReferences(sequence, index, segment, 'reorder', () => 'Reorder them there')
  // The model list also makes main remember the models' prompt limits, which the descriptions are fitted into.
  const [assets] = await Promise.all([AssetIndex.load(), modelsIfAvailable()])
  const params = segment.params
  const paths = params.referenceImages ?? []
  const clips = params.referenceAudios ?? []
  const imageOrder = images?.length ? newOrder('image', images, paths, assets, where) : undefined
  const audioOrder = audios?.length ? newOrder('audio', audios, clips.map((a) => a.path), assets, where) : undefined
  type Moved = { images: MovedToken[]; audios: MovedToken[] }
  const answer = (p: GenerationParams, moved: Moved): Record<string, unknown> => ({
    target: { segment_id: segment.id },
    sequence_id: sequence.id,
    clip_number: clipNumber,
    ...reorderAnswer(p, assets, moved)
  })
  if ((!imageOrder || unchanged(imageOrder)) && (!audioOrder || unchanged(audioOrder))) {
    return {
      data: {
        ...answer(params, { images: [], audios: [] }),
        notes: ['The references were already in that order, so nothing changed.']
      },
      summary: `looked at the order of the references in clip ${clipNumber} (unchanged)`
    }
  }

  // The shared reorder the window's drag and drop applies: the list in the new order and both prompts' tokens
  // renumbered with it. Named by their tokens in today's order, so the result is the same as the window's.
  let next = params
  if (imageOrder) next = reorderReferences(next, 'image', imageOrder.map((i) => imageToken(i + 1)))
  if (audioOrder) next = reorderReferences(next, 'audio', audioOrder.map((i) => audioToken(i + 1)))
  // Built on the clip as it was read: a change the user saved meanwhile must not be written over.
  assertClipUnchanged(segment.id, params)
  const updated = await callService<Sequence>('segments:update', segment.id, { params: next } satisfies SegmentPatch)
  const saved = updated.segments.find((s) => s.id === segment.id)?.params ?? next
  const moved = {
    images: movedTokens('image', paths, saved.referenceImages ?? [], assets),
    audios: movedTokens('audio', clips.map((a) => a.path), (saved.referenceAudios ?? []).map((a) => a.path), assets)
  }
  return {
    data: answer(saved, moved),
    summary: `reordered the references in clip ${clipNumber} in ${q(sequence.name)}${movedSummary(moved)}`
  }
}

/**
 * swap_reference for a sequence clip: the picture in one place – or every place of one asset, with its voice – taken
 * by another (the shared swapReferenceImage / swapReferenceAsset, as a click on a thumbnail in the clip editor
 * does), no number changed, saved through the sequence service in one change; the clips that carry its references keep
 * their tokens (the service sees a swap in place). Refused like reorderClipReferences, and for a clip that carries
 * another clip's references the answer names that clip.
 */
export async function swapClipReference(ctx: ToolContext, segmentId: string, input: SwapInput): Promise<ToolOutput> {
  const { sequence, index, segment } = await loadClip(segmentId)
  assertNotRunning(sequence)
  const clipNumber = index + 1
  const where = `clip ${clipNumber}`
  assertOwnClipReferences(sequence, index, segment, 'swap', (from) => {
    const source = sequence.segments[from - 1]
    return `Swap the image there (swap_reference with target {segment_id: "${source?.id ?? ''}"}) – the clips that carry its references follow`
  })
  // The model list also makes main remember the models' prompt limits, which the descriptions are fitted into.
  const [assets] = await Promise.all([AssetIndex.load(), modelsIfAvailable()])
  const params = segment.params
  const paths = params.referenceImages ?? []
  const clips = params.referenceAudios ?? []
  // The previous clip's last frame goes after a continuing clip's references when it is sent; it is no reference here.
  const continuation = continues(sequence, index) ? continuationOf(sequence, index) : undefined
  const frame = continuation?.mode === 'references' ? continuation.frameToken : undefined
  const named = findImageTokens(input.image.trim())
  if (frame !== undefined && named.length === 1 && named[0].index === frame) {
    throw new Error(
      `@Image${frame} in clip ${clipNumber} is the previous clip's last frame, which Studio adds last when the clip is sent – it can't be swapped.`
    )
  }
  const asked = await planSwap(input, paths, assets, where)
  const answer = (p: GenerationParams, swapped: Swapped): Record<string, unknown> => ({
    target: { segment_id: segment.id },
    sequence_id: sequence.id,
    clip_number: clipNumber,
    ...referencesAnswer(p, assets, swappedInfo(swapped))
  })
  if (!('uploadId' in asked) && swapsNothing(asked, paths)) {
    return {
      data: { ...answer(params, { images: [], audios: [] }), notes: [unchangedNote(asked)] },
      summary: `looked at the references in clip ${clipNumber} (unchanged)`
    }
  }
  // Last: an upload becomes a still only once everything else is known to be right.
  const plan: ReadySwap =
    'uploadId' in asked
      ? { whole: false, place: asked.place, path: (await importAsStill(ctx, { upload_id: asked.uploadId })).path }
      : asked
  const result = applySwap(params, plan, assets.assets)
  // Built on the clip as it was read: a change the user saved meanwhile must not be written over.
  assertClipUnchanged(segment.id, params)
  const updated = await callService<Sequence>('segments:update', segment.id, {
    params: result.params
  } satisfies SegmentPatch)
  const saved = updated.segments.find((s) => s.id === segment.id)?.params ?? result.params
  const swapped = swappedTokens(
    { images: paths, audios: clips },
    { images: saved.referenceImages ?? [], audios: saved.referenceAudios ?? [] },
    assets
  )
  const notes = [...result.notes, ...swapNotes(params, saved, plan, swapped, assets)]
  return {
    data: { ...answer(saved, swapped), ...(notes.length ? { notes } : {}) },
    summary: swapSummary(plan, swapped, ` in clip ${clipNumber} in ${q(sequence.name)}`)
  }
}

const SLOT_HELP =
  ' {still_id} (a still, list_stills), {asset_image_id} (a library photo), {generation_id, time} (that frame of a finished clip, saved as a still of the sequence), {upload_id} or {url} (a picture you send: copied in as a still of the sequence), or null to clear it.'

const clipFields = {
  prompt: z
    .string()
    .describe(
      "What happens in the clip (see the guide). Tokens must match the references the clip sends: its own, or for a clip that continues in reference mode the ones it carries (get_sequence: carried_references); a clip with a start or end image of any other kind (image-to-video) takes no tokens – describe the motion between the pictures."
    ),
  negative_prompt: z.string().optional().describe('Empty string clears it.'),
  references: z
    .array(referenceItem)
    .optional()
    .describe(
      "The clip's own references, like set_references items: photos in @Image order and audio (characters' voices by default, with a model that takes audio) in @Audio order. Replaces the clip's references. A clip that continues in reference mode may have them (they replace the ones it would carry from the clip before; [] goes back to carrying those); not allowed on a clip sent image-to-video (an exact continuation, an end frame, a start or end image)."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "A model id from list_models. A clip that continues in reference mode uses that family's reference-to-video model; a clip with any other start or end image always uses its image-to-video model (one that takes an end image when it has one)."
    ),
  duration: z.string().optional().describe('e.g. "8s".'),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  audio: z.boolean().optional(),
  include_descriptions: includeDescriptionsInput,
  excluded_description_asset_ids: excludedDescriptionsInput,
  outfit_wearers: outfitWearersInput,
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe('"What happens": what happens in the shot, shown with the clip in Studio (any language). Not sent to Venice.'),
  continue_from_previous: z
    .boolean()
    .optional()
    .describe(
      "Start from the previous clip's last frame (same as start_image: \"previous\"); continue_mode decides how – by default with the references it carries and that frame as the last reference image."
    ),
  continue_mode: z
    .enum(['references', 'exact'])
    .optional()
    .describe(
      "How a continuing clip starts on the previous clip's last frame. \"references\" (default, recommended: keeps the characters): reference-to-video with the clip's own references – or, without any, those of the clip it continues from, up the chain – plus the frame as the last reference image (@Image{N+1}); Studio puts \"Start exactly on @Image{N+1} …\" in front of the prompt, so the first frame is close to the previous clip's last one but not guaranteed identical. Use the carried @Image / @Audio tokens in the prompt (get_sequence: carried_references). \"exact\": image-to-video from the frame itself (exact first frame), no references, no tokens. A clip that also ends on the next clip's first frame (end_from_next) or has an end image is always exact."
    ),
  end_from_next: z
    .boolean()
    .optional()
    .describe("End on the next clip's first frame (image-to-video with a model that takes an end image). Same as end_image: \"next\"."),
  start_image: slotInput.describe(`The clip's start image (first frame): "previous" (the previous clip's last frame),${SLOT_HELP}`),
  end_image: slotInput.describe(`The clip's end image (last frame): "next" (the next clip's first frame),${SLOT_HELP}`)
}

/**
 * add_segment with from_generation_id: a clip whose selected take is a finished video that already exists – the
 * user's own film, a version from the Editor, or another generation – the way "Add to sequence" makes one. The
 * sequence service seeds its settings like a new clip's (never from an import's empty params), so only the notes
 * go along; everything else is changed afterwards with update_segment.
 */
async function addClipFrom(
  sequence: Sequence,
  previous: Segment | undefined,
  generationId: string,
  notes: string | undefined,
  input: Record<string, unknown>,
  assets: AssetIndex,
  stills: StillIndex
): Promise<ToolOutput> {
  const extra = Object.entries(input).filter(([, v]) => v !== undefined).map(([k]) => k)
  if (extra.length) {
    throw new Error(
      `With from_generation_id the clip gets its video from there, so ${extra.join(', ')} can't be given at the same time. Add the clip first, then change it with update_segment.`
    )
  }
  const take = db.getGeneration(generationId)
  if (!take) throw new Error(`The generation ${generationId} doesn't exist (any more). list_generations lists the ones there are.`)
  if (take.status !== 'completed' || !take.filePath) {
    throw new Error('Only a finished video can become a clip in the sequence.')
  }
  if (take.fileMissing || !existsSync(take.filePath)) {
    throw new Error('The video file is no longer on disk (moved or deleted in Finder?).')
  }
  const before = new Set(sequence.segments.map((s) => s.id))
  const updated = await callService<Sequence>('segments:add', sequence.id, {
    afterSegmentId: previous?.id,
    fromGenerationId: take.id,
    notes: notes ?? ''
  })
  const index = updated.segments.findIndex((s) => !before.has(s.id))
  const title = generationTitle(take, 50)
  return {
    data: {
      ...(index >= 0 ? clipInfo(updated, index, assets, stills) : {}),
      clip_count: updated.segments.length,
      // `notes` is the clip's own "What happens" text here; this says what was done.
      note: `${ownTake(take) ? 'The video' : 'The generation'} ${q(title)} is the clip's selected take. The next clip can continue from its last frame (continue_from_previous).`
    },
    summary: `added ${q(title)} as clip ${index + 1} in ${q(updated.name)}`
  }
}

export function registerSequenceTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'list_sequences',
    {
      title: 'List sequences',
      description:
        "The user's sequences (films made of several clips), most recently changed first, with the number of clips and the length of the current cut in seconds. Storyboards are not sequences and are not listed here: list_storyboards lists them.",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listed the sequences'
    },
    async () => {
      requireLibrary()
      // The service lists sequences only; filtered here as well, so a storyboard never shows up as a sequence.
      const list = (await callService<SequenceSummary[]>('sequences:list')).filter((s) => !isStoryboardId(s.id))
      return {
        data: {
          sequences: list.map((s) => ({
            sequence_id: s.id,
            name: s.name,
            clip_count: s.segmentCount,
            cut_seconds: s.totalDuration,
            updated: localTime(s.updatedAt)
          })),
          note: 'Storyboards (milestone pictures with generated transitions between them) are listed by list_storyboards.'
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
        "One sequence with its clips in order (for a storyboard use get_storyboard). Each clip has its notes (\"What happens\"), prompt and settings, its own references as token maps (references for @ImageN, audio_references for @AudioN), its start_image and end_image ({kind: \"previous\"} = the previous clip's last frame, {kind: \"next\"} = the next clip's first frame, {kind: \"image\", still_id | asset_image_id, path} = a chosen picture, null = none), continue_from_previous / end_from_next – a continuing clip also has continue_mode (\"references\" or \"exact\"), sent_as (how it goes now; continue_mode_note says why it differs or doesn't apply) and in reference mode carried_references (from_clip, inherited, the references and audio_references it sends – its own, or those of the clip it continues from – and start_frame_token, the @Image token of the previous clip's last frame, sent after them; not_sent when a reference gives way for it), while references / composed_prompt show what is sent, the instruction to start on the frame included –, supports_end_image (whether its video model takes an end image), validation issues (ready: false means it can't be generated as it is), frame_problems (what still stops its automatic frames), composed_prompt (its prompt as it would be sent, with the descriptions of its referenced assets appended as a References legend) with description_entries, and its selected take (status, error, source; own_clip: true when it is the user's own film or a version from the Editor rather than a generation of the clip's prompt). The sequence's export_height is its Export format (null = the first clip's own size; update_sequence changes it), defaults what new clips start from. With include_thumbnails (default true) the poster frame of every finished selected take comes as an image, so you can check continuity across the cut; preview_segment_frames shows a clip's start and end images.",
      input: {
        sequence_id: z.string(),
        include_thumbnails: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'looked at a sequence'
    },
    async ({ sequence_id, include_thumbnails }) => {
      const sequence = await loadSequence(sequence_id)
      // The model list also makes main remember the models' prompt limits, which the descriptions are fitted into.
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load(), modelsIfAvailable()])
      const images: LabeledImage[] = []
      if (include_thumbnails) {
        for (const [i, segment] of sequence.segments.entries()) {
          const take = selectedTake(segment)
          if (!isUsableTake(take) || !take?.thumbPath) continue
          const image = await imageBlock(take.thumbPath)
          if (image) images.push({ label: `Clip ${i + 1} – selected take ${take.id} (poster frame)`, image })
        }
      }
      return {
        data: sequenceInfo(sequence, assets, stills),
        images,
        summary: `looked at the sequence ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'create_sequence',
    {
      title: 'Create sequence',
      description:
        'Creates an empty sequence (a film made of clips) with the default settings (Seedance 2.5, 8s, 480p, 16:9, audio). Add clips with add_segment, one per shot. To plan a film as milestone pictures with generated transitions between them, use create_storyboard instead.',
      input: { name: z.string().describe('e.g. "A walk on the beach".') },
      annotations: WRITE,
      summary: ({ name }) => `created the sequence ${q(name)}`
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
        "Adds a clip (a shot) to a sequence, at the end or after after_segment_id, with its notes (\"What happens\") and prompt – or, with from_generation_id, a clip whose selected take is a finished video that already exists (the user's own film, a version from the Editor). Settings you leave out come from the previous clip (or the sequence defaults for the first clip). continue_from_previous defaults to true when there is a previous clip and you pass neither references nor a start_image, otherwise false (pass it true together with references to give a continuing clip references of its own). A continuing clip starts from the previous clip's last frame. By default (continue_mode \"references\") it is sent reference-to-video with the references it carries – its own, or else those of the clip it continues from (up the chain) – plus that frame as the last reference image, which Studio's instruction in front of the prompt says to start on: use the carried @Image / @Audio tokens (get_sequence: carried_references) and describe what happens next. With continue_mode \"exact\" it is image-to-video from the frame and takes no references or tokens. A clip with a start_image and/or end_image (a still, a library photo, a frame of a finished clip, or \"next\" for the next clip's first frame) is image-to-video too: the look comes from the pictures. A clip without any of these is a new shot: give it references (its own @Image1… / @Audio1… numbering; characters' voices come along by default with a model that takes audio) unless it should reuse the previous clip's. The descriptions of its referenced assets are appended to its prompt when it is generated, with who wears each outfit (include_descriptions / excluded_description_asset_ids choose which, outfit_wearers who wears what; they carry over from the previous clip) – don't repeat them in the prompt. The clip is validated like a generation; problems are returned as an error and nothing is saved.",
      input: {
        sequence_id: z.string(),
        after_segment_id: z.string().optional().describe('Insert after this clip; at the end when left out.'),
        from_generation_id: z
          .string()
          .optional()
          .describe(
            "Make the clip from an existing finished video instead – the user's own clip (list_generations source \"import\"), a version from the Editor (source \"edit\") or any finished generation – as its selected take. Only notes may go along; the clip's settings start like a new clip's (change them later with update_segment), and it doesn't continue from the previous clip."
          ),
        ...clipFields,
        prompt: clipFields.prompt.optional().describe(`${clipFields.prompt.description} Required unless from_generation_id is given.`)
      },
      annotations: WRITE,
      summary: () => 'added a clip'
    },
    async ({ sequence_id, after_segment_id, from_generation_id, notes, ...raw }) => {
      const sequence = await loadSequence(sequence_id)
      assertNotRunning(sequence)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const afterIndex = after_segment_id
        ? sequence.segments.findIndex((s) => s.id === after_segment_id)
        : sequence.segments.length - 1
      if (after_segment_id && afterIndex < 0) throw new Error('after_segment_id is not a clip in this sequence.')
      const previous = afterIndex >= 0 ? sequence.segments[afterIndex] : undefined
      const clipNumber = afterIndex + 2
      if (from_generation_id) return addClipFrom(sequence, previous, from_generation_id, notes, raw, assets, stills)
      if (raw.prompt === undefined) {
        throw new Error('Give prompt (what happens in the clip), or from_generation_id for a finished video.')
      }
      const input = await resolvedClipInput(ctx, raw)
      const base: GenerationParams = previous
        ? { ...previous.params, prompt: '', startImage: undefined, endImage: undefined }
        : { ...DEFAULT_PARAMS, ...sequence.defaults, prompt: '' }
      // A new clip continues by default unless it is given what a shot of its own needs.
      const ownStart = input.start_image !== undefined && input.start_image !== 'previous'
      const ownShot = !!input.references?.length || ownStart
      const slots = slotState(
        input,
        { continuing: false, ending: false, mode: 'references', params: base },
        { first: !previous, last: afterIndex === sequence.segments.length - 1 },
        assets,
        stills,
        !!previous && !ownShot && input.continue_from_previous === undefined
      )
      const result = await clipParams(base, input, slots, assets, clipNumber, {
        sequence,
        index: afterIndex + 1,
        insert: true
      })

      const before = new Set(sequence.segments.map((s) => s.id))
      let updated = await callService<Sequence>('segments:add', sequence.id, {
        afterSegmentId: previous?.id,
        params: result.params,
        continueFromPrevious: slots.continuing,
        continueMode: slots.mode,
        endFromNext: slots.ending,
        notes: notes ?? ''
      })
      const added = updated.segments.find((s) => !before.has(s.id))
      if (added) updated = (await applyImages(added.id, slots, clipNumber)) ?? updated
      const index = added ? updated.segments.findIndex((s) => s.id === added.id) : -1
      const stillsNow = savesFrame(slots) ? await StillIndex.load() : stills
      return {
        data: {
          ...(index >= 0 ? clipInfo(updated, index, assets, stillsNow) : {}),
          clip_count: updated.segments.length,
          ...clipNotes(result)
        },
        summary: `added clip ${index + 1} to ${q(updated.name)}`
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
        "Changes a clip: only the fields you pass change. notes is the clip's \"What happens\" text. references replaces the clip's references (photos in @Image order, audio in @Audio order). start_image / end_image put a picture into the clip's start or end slot (a still, a library photo, a frame of a finished clip), make it automatic (\"previous\" / \"next\"), or clear it (null); any start or end image makes the clip image-to-video with its family's model (one that takes an end image when it has one) and drops its references – a prompt you don't rewrite loses its @ tokens, one you write must have none – except \"previous\" in reference mode: continue_mode \"references\" (the default) sends a continuing clip with the references it carries plus the previous clip's last frame, keeping its own references and tokens; \"exact\" makes it image-to-video from the frame (its tokens must go). Clearing every picture makes it a new shot that needs references (and switches it to the reference-to-video model unless you pass a model). selected_take_id selects which of the clip's finished takes is used in the cut (its takes are listed by get_generation's take_of and review_sequence; the old one stays and can be selected again) – a take selected again gets back the trims it last had. trim_start / trim_end trim the selected take (seconds cut off its start and its end; Studio keeps at least 0.2 s and says when it adjusted them). include_descriptions / excluded_description_asset_ids choose which descriptions of its referenced assets are appended to its prompt, outfit_wearers who wears each outfit (the legend says it); reorder_references({target: {segment_id}}) changes the order of its references and renumbers its tokens; swap_reference({target: {segment_id}}) swaps one of them (or a whole asset) for another, keeping every number. The clip is validated like a generation; problems are returned as an error and nothing is saved. Existing takes are kept.",
      input: {
        segment_id: z.string(),
        ...clipFields,
        prompt: clipFields.prompt.optional(),
        selected_take_id: z
          .string()
          .optional()
          .describe("One of the clip's finished takes (a generation_id) to use in the cut."),
        trim_start: z.number().min(0).optional().describe('Seconds cut off the start of the selected take in the cut.'),
        trim_end: z.number().min(0).optional().describe('Seconds cut off the end of the selected take in the cut.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a clip'
    },
    async ({ segment_id, notes, selected_take_id, trim_start, trim_end, ...raw }) => {
      const { sequence, index, segment } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const clipNumber = index + 1
      const touchesClip = Object.entries(raw).some(([, v]) => v !== undefined)
      const input = await resolvedClipInput(ctx, raw)
      let take: Generation | undefined
      if (selected_take_id !== undefined) {
        take = segment.takes.find((t) => t.id === selected_take_id)
        if (!take) throw new Error(`The take ${selected_take_id} doesn't belong to clip ${clipNumber}.`)
        if (!isUsableTake(take)) throw new Error('Only a finished take (with its video still there) can be selected for the clip.')
      }

      const slots = slotState(
        input,
        {
          continuing: continues(sequence, index),
          ending: endsOnNext(sequence, index),
          mode: segment.continueMode,
          params: segment.params
        },
        { first: index === 0, last: index === sequence.segments.length - 1 },
        assets,
        stills,
        false
      )
      const result = touchesClip
        ? await clipParams(segment.params, input, slots, assets, clipNumber, { sequence, index, insert: false })
        : undefined
      // The new params are built on the clip as it was read; whatever the user saved meanwhile would be written
      // over without a word. Compared right before the write (nothing can come in between). Notes and the
      // selected take are written as given, so only a change to the clip's settings matters.
      const row = store.getSegmentRow(segment.id)
      if (!row) throw new Error('The clip no longer exists.')
      if (
        result &&
        (store.serializeParams(store.parseParams(row.params)) !== store.serializeParams(segment.params) ||
          !!row.continue_from_previous !== segment.continueFromPrevious ||
          !!row.end_from_next !== segment.endFromNext ||
          store.continueModeOfRow(row) !== segment.continueMode)
      ) {
        throw new Error(
          'The clip was changed in Studio while the change was being prepared, so nothing was saved. Read the clip again (get_sequence) and make the change again.'
        )
      }
      const trims = trim_start !== undefined || trim_end !== undefined
      if (trims && !take && !isUsableTake(selectedTake(segment))) {
        throw new Error(
          `Clip ${clipNumber} has no finished selected take to trim. Select one with selected_take_id first.`
        )
      }
      const patch: SegmentPatch = {
        ...(result
          ? {
              params: result.params,
              continueFromPrevious: slots.continuing,
              endFromNext: slots.ending,
              ...(input.continue_mode !== undefined ? { continueMode: input.continue_mode } : {})
            }
          : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(take ? { selectedGenerationId: take.id } : {}),
        ...(trim_start !== undefined ? { trimStart: trim_start } : {}),
        ...(trim_end !== undefined ? { trimEnd: trim_end } : {})
      }
      let updated = Object.keys(patch).length
        ? await callService<Sequence>('segments:update', segment.id, patch)
        : sequence
      if (result) updated = (await applyImages(segment.id, slots, clipNumber)) ?? updated
      const at = updated.segments.findIndex((s) => s.id === segment.id)
      const stillsNow = savesFrame(slots) ? await StillIndex.load() : stills
      const saved = at >= 0 ? updated.segments[at] : undefined
      const trimNotes: string[] = []
      const kept = 'Studio keeps the trim within the take (at least 0.2 s left).'
      if (saved && trim_start !== undefined && Math.abs(saved.trimStart - trim_start) > 0.001) {
        trimNotes.push(`trim_start became ${seconds(saved.trimStart)} s – ${kept}`)
      }
      if (saved && trim_end !== undefined && Math.abs(saved.trimEnd - trim_end) > 0.001) {
        trimNotes.push(`trim_end became ${seconds(saved.trimEnd)} s – ${kept}`)
      }
      const what =
        !result && take && notes === undefined && !trims
          ? `selected a take for clip ${clipNumber}`
          : !result && trims && notes === undefined && !take
            ? `trimmed clip ${clipNumber}`
            : `changed clip ${clipNumber}`
      return {
        data: {
          ...(at >= 0 ? clipInfo(updated, at, assets, stillsNow) : { segment_id }),
          // The trims the cut uses now: a take chosen again gets back the trims it last had.
          ...(saved && (take || trims)
            ? { trim_start: seconds(saved.trimStart), trim_end: seconds(saved.trimEnd) }
            : {}),
          ...(result ? clipNotes(result) : {}),
          ...(trimNotes.length ? { trim_notes: trimNotes } : {})
        },
        summary: `${what} in ${q(sequence.name)}`
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
        'Moves a clip to another place in its sequence. to_clip_number is the 1-based number the clip should have afterwards (as Studio shows "Clip 1", "Clip 2" …). Whichever clip ends up first stops continuing from a previous clip, and whichever ends up last stops taking its end image from a next one.',
      input: {
        segment_id: z.string(),
        to_clip_number: z.number().int().min(1)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ to_clip_number }) => `moved a clip to place ${to_clip_number}`
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
            end_from_next: endsOnNext(updated, i),
            prompt: s.params.prompt
          }))
        },
        summary: `moved clip ${index + 1} to place ${Math.min(to_clip_number, updated.segments.length)} in ${q(sequence.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_sequence',
    {
      title: 'Update sequence',
      description:
        "Changes a sequence: its name (its folder follows), its defaults – the settings its first clip (and an own clip added to it) starts from: model (a reference-to-video or text-to-video model; a clip gets image-to-video from its own start image), duration, resolution, aspect_ratio, audio, checked against the model as Studio does, with what you leave out fitted to the model – and its Export format (export_height: 480, 720 or 1080 pixels high, or null for the first clip's own size), which decides the film's size when own clips and AI clips are mixed. Only the fields you pass change. Free.",
      input: {
        sequence_id: z.string(),
        name: z.string().min(1).max(120).optional(),
        defaults: z
          .object({
            model: z.string().optional(),
            duration: z.string().optional(),
            resolution: z.string().optional(),
            aspect_ratio: z.string().optional(),
            audio: z.boolean().optional()
          })
          .strict()
          .optional(),
        export_height: z
          .union([z.literal(480), z.literal(720), z.literal(1080), z.null()])
          .optional()
          .describe("480, 720, 1080, or null = Automatic (the first clip's own size).")
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a sequence'
    },
    async ({ sequence_id, name, defaults, export_height }) => {
      const sequence = await loadSequence(sequence_id)
      if (name === undefined && defaults === undefined && export_height === undefined) {
        throw new Error('Give name, defaults or export_height – otherwise there is nothing to change.')
      }
      const nextDefaults = defaults ? await checkedDefaults(sequence, defaults) : undefined
      const updated = await callService<Sequence>('sequences:update', sequence.id, {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(nextDefaults ? { defaults: nextDefaults } : {}),
        ...(export_height !== undefined ? { exportHeight: export_height } : {})
      })
      const what = [
        name !== undefined ? 'the name' : undefined,
        defaults ? 'the defaults' : undefined,
        export_height !== undefined ? 'the export format' : undefined
      ].filter((w): w is string => !!w)
      const said = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0]
      return {
        data: {
          sequence_id: updated.id,
          name: updated.name,
          defaults: defaultsInfo(updated),
          export_height: updated.exportHeight ?? null
        },
        summary: `changed ${said} of ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'export_film',
    {
      title: 'Export a film',
      description:
        "Exports a sequence (sequence_id) or a storyboard (storyboard_id) as one film – the selected takes back to back, trimmed, at its Export format – into its folder, exactly as Studio's Export does. Free and local (ffmpeg on this Mac); every clip (transition) needs a finished selected take. Waits up to wait_seconds (default 30): {status: \"done\", export_id, duration, cuts}, or {status: \"running\", progress} – then follow it with get_work_status or list_exports. An export already running for it answers running. Review the film with review_export({export_id}).",
      input: {
        sequence_id: z.string().optional(),
        storyboard_id: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(50).default(30)
      },
      annotations: WRITE,
      summary: () => 'exported a film'
    },
    async ({ sequence_id, storyboard_id, wait_seconds }) => {
      requireLibrary()
      if (!sequence_id === !storyboard_id) throw new Error('Give either sequence_id or storyboard_id.')
      const storyboard = !!storyboard_id
      const id = (storyboard_id ?? sequence_id)!
      const kind = sequenceKind(id)
      if (!kind) throw new Error(storyboard ? 'The storyboard doesn\'t exist (any more).' : 'The sequence doesn\'t exist (any more).')
      if (storyboard && kind !== 'storyboard') throw new Error('This is a sequence: export it with sequence_id.')
      if (!storyboard && kind === 'storyboard') throw storyboardNotSequence('export_film({storyboard_id})')
      const name = store.getSequenceRow(id)?.name ?? ''
      let run = exporting.get(id)
      if (!run) {
        const promise = callService<string>(storyboard ? 'storyboards:export' : 'sequences:export', id)
        run = { promise, startedAt: Date.now() }
        const started = run
        exporting.set(id, started)
        // Forgotten once it ends, however it ends (a rejection is the caller's to report, never unhandled here).
        void promise
          .then(
            () => undefined,
            () => undefined
          )
          .finally(() => {
            if (exporting.get(id) === started) exporting.delete(id)
          })
      }
      let path: string | undefined
      try {
        path = await Promise.race([run.promise, delay(wait_seconds * 1000).then(() => undefined)])
      } catch (err) {
        // The user (or another session) is exporting it right now: that export is followed instead.
        if (/already being exported/.test(errorText(err))) path = undefined
        else throw err
      }
      if (!path) {
        return {
          data: {
            status: 'running',
            ...(await exportProgress(id)),
            next: 'Follow it with get_work_status (or list_exports once it is done); the film lands in list_exports.'
          },
          summary: `is exporting the ${storyboard ? 'storyboard' : 'sequence'} ${q(name)}`
        }
      }
      const done = (await callService<ExportSummary[]>('exports:list')).find(
        (e) => e.path.normalize('NFC') === path!.normalize('NFC')
      )
      return {
        data: {
          status: 'done',
          ...(done ? { export_id: done.id } : {}),
          file: basename(path),
          ...(done?.duration !== undefined ? { duration: seconds(done.duration) } : {}),
          ...(done?.cuts ? { cuts: done.cuts.map(seconds) } : {}),
          next: done ? `Look at it with review_export({export_id: "${done.id}"}).` : 'list_exports lists it.'
        },
        summary: `exported the ${storyboard ? 'storyboard' : 'sequence'} ${q(name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'stop_generation_run',
    {
      title: 'Stop "Generate missing"',
      description:
        "Stops a running \"Generate missing\" (request_generate_all / request_generate_storyboard) for a sequence (sequence_id) or a storyboard (storyboard_id): no further clips are sent. Takes already at Venice keep going and land as usual (they are paid already). Free – it only saves money.",
      input: {
        sequence_id: z.string().optional(),
        storyboard_id: z.string().optional()
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'stopped Generate missing'
    },
    async ({ sequence_id, storyboard_id }) => {
      requireLibrary()
      if (!sequence_id === !storyboard_id) throw new Error('Give either sequence_id or storyboard_id.')
      const id = (storyboard_id ?? sequence_id)!
      const kind = sequenceKind(id)
      if (!kind) throw new Error(storyboard_id ? 'The storyboard doesn\'t exist (any more).' : 'The sequence doesn\'t exist (any more).')
      if (storyboard_id && kind !== 'storyboard') throw new Error('This is a sequence: give it as sequence_id.')
      if (sequence_id && kind === 'storyboard') throw storyboardNotSequence('stop_generation_run({storyboard_id})')
      const storyboard = kind === 'storyboard'
      const current = storyboard
        ? await callService<Storyboard>('storyboards:get', id)
        : await callService<Sequence>('sequences:get', id)
      if (!current.running) {
        return {
          data: { stopped: false, note: '"Generate missing" is not running there.' },
          summary: `tried to stop Generate missing in ${q(current.name)} (it wasn't running)`
        }
      }
      await callService(storyboard ? 'storyboards:stop' : 'sequences:stopGenerateAll', id)
      return {
        data: {
          stopped: true,
          note: 'No more clips are sent. Takes already at Venice keep going and land as usual.'
        },
        summary: `stopped Generate missing in ${q(current.name)}`
      }
    }
  )
}

// ── Sequence defaults and exports ────────────────────────────────────────────

/** Exports agents started, by sequence or storyboard id, so a second call follows the one running. */
const exporting = new Map<string, { promise: Promise<string>; startedAt: number }>()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** How far an export is, from Activity ({progress} 0–1), or {} when it can't be told. */
async function exportProgress(sequenceId: string): Promise<Record<string, unknown>> {
  try {
    const summary = await callService<WorkSummary>('work:summary')
    const running = summary.running.find((w) => w.key === `export:${sequenceId}`)
    return running?.progress !== undefined ? { progress: Math.round(running.progress * 100) / 100 } : {}
  } catch {
    return {}
  }
}

/**
 * A sequence's new defaults, checked the way a clip's settings are: the model must be usable (and not image-to-video,
 * which a first clip only gets from its own start image), the given options among the model's, and the options left
 * out fitted to the model as Studio's model switch fits them.
 */
async function checkedDefaults(
  sequence: Sequence,
  input: { model?: string; duration?: string; resolution?: string; aspect_ratio?: string; audio?: boolean }
): Promise<Partial<GenerationParams>> {
  const models = await loadModels()
  const base: GenerationParams = { ...DEFAULT_PARAMS, ...sequence.defaults, prompt: '' }
  const model = requireModel(models, input.model ?? base.model)
  if (kindOfModelId(model.id) === 'image-to-video') {
    throw new Error(
      `${model.id} is an image-to-video model. The default model for new clips must take references or text – a clip becomes image-to-video from its own start_image.`
    )
  }
  const duration = normalizeDuration(input.duration)
  const resolution = normalizeResolution(input.resolution)
  const aspectRatio = normalizeAspectRatio(input.aspect_ratio)
  checkOutputOptions(model, { duration, resolution, aspectRatio, audio: input.audio })
  const audio = audioForModel(model, input.audio ?? base.audio)
  return {
    model: model.id,
    duration: duration ?? pickOption(model.durations, base.duration, PREFERRED.durations) ?? base.duration,
    resolution: resolution ?? pickOption(model.resolutions, base.resolution, PREFERRED.resolutions),
    aspectRatio: aspectRatio ?? pickOption(model.aspectRatios, base.aspectRatio, PREFERRED.aspectRatios),
    audio: model.audio && !model.audioConfigurable ? true : audio
  }
}
