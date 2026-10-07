import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
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
  supportsEndImage
} from '@shared/models'
import { audioToken, findAudioTokens, findImageTokens, imageToken } from '@shared/prompt-refs'
import { reorderReferences } from '@shared/prompt-remap'
import type {
  Generation,
  GenerationParams,
  Segment,
  SegmentImageSlot,
  SegmentImageSource,
  SegmentPatch,
  Sequence,
  SequenceSummary,
  VideoModel
} from '@shared/types'
import * as db from '../../db'
import * as store from '../../sequence-store'
import { withoutReferenceTokens } from '../../sequences'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { movedSummary, movedTokens, newOrder, reorderAnswer, unchanged, type MovedToken } from '../reorder'
import {
  AssetIndex,
  StillIndex,
  asGenerated,
  audioTarget,
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
  promptIssues,
  q,
  readableRunError,
  requireLibrary,
  requireModel,
  resolveReferences,
  takesAudio,
  usableModels,
  type AudioInfo,
  type ReferenceItem
} from '../studio'
import {
  READ_ONLY,
  WRITE,
  defineTool,
  excludedDescriptionsInput,
  includeDescriptionsInput,
  referenceItem,
  type LabeledImage,
  type ToolContext,
  type ToolOutput
} from './kit'

// Sequences: films made of clips (segments), each with its own prompt and references – or its own start and end
// images (keyframes), or frames taken from its neighbours – and any number of takes. In Studio's Storyboard view
// each clip is a panel with its keyframes and notes. These tools go straight to the sequence service; the window
// follows through its usual change events.

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
export function assertNotRunning(sequence: Sequence): void {
  if (sequence.running) {
    throw new Error(
      `”Generera saknade” pågår för ${q(sequence.name)}. Vänta tills körningen är klar (eller be användaren stoppa den) innan du ändrar klippen.`
    )
  }
}

/** The params a take of the clip would be sent with now (frames from neighbours left out until it is made). */
export function asSent(sequence: Sequence, index: number): GenerationParams {
  return asGenerated(sequence.segments[index].params, continues(sequence, index), endsOnNext(sequence, index))
}

/**
 * What still stands in the way of the clip's start and end frames, without extracting anything: a neighbour
 * without a finished selected take, a keyframe whose file is gone. preview_segment_frames gives the full answer.
 */
function frameProblems(sequence: Sequence, index: number, generated: GenerationParams): string[] {
  const problems: string[] = []
  const missingTake = (i: number): boolean => !isUsableTake(selectedTake(sequence.segments[i]))
  if (continues(sequence, index) && missingTake(index - 1)) problems.push(`Klipp ${index} har ingen färdig vald tagning än.`)
  if (endsOnNext(sequence, index) && missingTake(index + 1)) {
    problems.push(`Klipp ${index + 2} har ingen färdig vald tagning än.`)
  }
  if (kindOfModelId(generated.model) === 'image-to-video') {
    if (generated.startImage && !existsSync(generated.startImage)) {
      problems.push(`Startbilden finns inte längre: ${basename(generated.startImage)}.`)
    }
    if (generated.endImage && !existsSync(generated.endImage)) {
      problems.push(`Slutbilden finns inte längre: ${basename(generated.endImage)}.`)
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
  const generated = asGenerated(segment.params, continuing, ending)
  const problem = blockingProblem(generated, continuing, ending)
  const keyframed = kindOfModelId(generated.model) === 'image-to-video'
  const take = selectedTake(segment)
  const trimmed = segment.trimStart || segment.trimEnd
  const frames = frameProblems(sequence, index, generated)
  return {
    segment_id: segment.id,
    clip_number: index + 1,
    notes: segment.notes ?? '',
    continue_from_previous: continuing,
    end_from_next: ending,
    ...paramsInfo(generated, assets),
    ...descriptionInfo(generated, assets),
    start_image: continuing
      ? { kind: 'previous', from_clip: index }
      : keyframed && generated.startImage
        ? imageRef(generated.startImage, assets, stills)
        : null,
    end_image: ending
      ? { kind: 'next', from_clip: index + 2 }
      : keyframed && generated.endImage
        ? imageRef(generated.endImage, assets, stills)
        : null,
    supports_end_image: supportsEndImage(generated.model),
    issues: issueList(promptIssues(generated)),
    ready: !problem,
    ...(problem ? { blocking_problem: problem } : {}),
    ...(frames.length ? { frame_problems: frames } : {}),
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

export function sequenceInfo(sequence: Sequence, assets: AssetIndex, stills: StillIndex): Record<string, unknown> {
  const missing = sequence.segments.flatMap((s, i) => (isUsableTake(selectedTake(s)) ? [] : [i + 1]))
  return {
    sequence_id: sequence.id,
    name: sequence.name,
    clip_count: sequence.segments.length,
    cut_seconds: cutSeconds(sequence),
    clips_without_finished_take: missing,
    generate_all_running: sequence.running,
    ...(sequence.runError ? { last_run_error: readableRunError(sequence.runError) } : {}),
    still_count: stills.stills.filter((s) => s.sequenceId === sequence.id).length,
    clips: sequence.segments.map((_, i) => clipInfo(sequence, i, assets, stills))
  }
}

// ── Start and end images ─────────────────────────────────────────────────────

/** What an agent can put into a start or end slot. */
type SlotInput =
  | 'previous'
  | 'next'
  | null
  | { still_id: string }
  | { asset_image_id: string }
  | { generation_id: string; time: number }

const slotInput = z
  .union([
    z.literal('previous'),
    z.literal('next'),
    z.null(),
    z.object({ still_id: z.string() }).strict(),
    z.object({ asset_image_id: z.string() }).strict(),
    z.object({ generation_id: z.string(), time: z.number().min(0) }).strict()
  ])
  .optional()

/** What happens to a slot: an explicit picture to put there after saving, or none. */
interface SlotPlan {
  /** Put this picture into the slot (segments:setImage) once the clip is saved. */
  set?: SegmentImageSource
  /** The picture the slot will have (kept or new), for the checks; '' for a frame that isn't extracted yet. */
  path?: string
}

/** "startbild" / "slutbild", for messages about a slot. */
const SLOT_SV: Record<SegmentImageSlot, string> = { start: 'startbild', end: 'slutbild' }

/**
 * The explicit picture a slot input names, checked before anything is saved (the still, the photo, the finished
 * clip and its file exist). Frames are only extracted when the clip is saved, so their path is ''.
 */
function explicitSource(
  value: Exclude<SlotInput, 'previous' | 'next' | null>,
  assets: AssetIndex,
  stills: StillIndex
): { source: SegmentImageSource; path: string } {
  if ('still_id' in value) {
    const still = stills.require(value.still_id)
    if (!existsSync(still.path)) throw new Error(`Stillbilden ${basename(still.path)} finns inte längre på disken.`)
    return { source: { kind: 'still', stillId: still.id }, path: still.path }
  }
  if ('asset_image_id' in value) {
    const photo = assets.requireImage(value.asset_image_id)
    return { source: { kind: 'asset-image', imageId: photo.imageId }, path: photo.path }
  }
  const g = db.getGeneration(value.generation_id)
  if (!g) throw new Error(`Det finns ingen generering med id ${value.generation_id}.`)
  if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
    throw new Error('Genereringen har ingen färdig video att ta en bildruta ur.')
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
  start: SlotPlan
  end: SlotPlan
}

/**
 * Where a clip's start and end frames come from after the agent's change: the neighbours (continue_from_previous,
 * end_from_next, or "previous" / "next"), a picture (kept, or one of the slot inputs) or nothing. Throws (in
 * Swedish) on inputs that contradict each other or the clip's place in the sequence.
 */
function slotState(
  input: {
    continue_from_previous?: boolean
    end_from_next?: boolean
    start_image?: SlotInput
    end_image?: SlotInput
  },
  current: { continuing: boolean; ending: boolean; params: GenerationParams },
  place: { first: boolean; last: boolean },
  assets: AssetIndex,
  stills: StillIndex,
  defaultContinuing: boolean
): SlotState {
  const { start_image: start, end_image: end } = input
  if (start === 'next') {
    throw new Error('Startbilden kan inte komma från nästa klipp. Menade du end_image: "next"?')
  }
  if (end === 'previous') {
    throw new Error('Slutbilden kan inte komma från föregående klipp. Menade du start_image: "previous"?')
  }
  const startContinues = start === 'previous'
  const flagGiven = input.continue_from_previous !== undefined
  if (start !== undefined && flagGiven && startContinues !== input.continue_from_previous) {
    throw new Error('start_image och continue_from_previous säger emot varandra. Ange bara det ena.')
  }
  if (end !== undefined && input.end_from_next !== undefined && (end === 'next') !== input.end_from_next) {
    throw new Error('end_image och end_from_next säger emot varandra. Ange bara det ena.')
  }

  const continuing =
    start !== undefined
      ? start === 'previous'
      : (input.continue_from_previous ?? (current.continuing || defaultContinuing))
  const ending = end !== undefined ? end === 'next' : (input.end_from_next ?? current.ending)
  if (continuing && place.first) throw new Error('Det första klippet kan inte fortsätta från ett föregående klipp.')
  if (ending && place.last) throw new Error('Det sista klippet har inget nästa klipp att ta sin slutbild från.')

  const plan = (slot: SegmentImageSlot, value: SlotInput | undefined, automatic: boolean): SlotPlan => {
    if (automatic) return {}
    if (value === undefined) {
      const kept = ownImage(current.params, slot)
      return kept ? { path: kept } : {}
    }
    if (value === null || value === 'previous' || value === 'next') return {}
    const { source, path } = explicitSource(value, assets, stills)
    return { set: source, path }
  }
  return { continuing, ending, start: plan('start', start, continuing), end: plan('end', end, ending) }
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
}

interface ClipParams {
  /** As saved: explicit pictures that are set afterwards (segments:setImage) are not in it yet. */
  params: GenerationParams
  /** What was decided on the agent's behalf (Swedish), e.g. a voice left out. */
  notes: string[]
  /** Audio asked for that didn't fit the model's limits. */
  skippedAudio: (AudioInfo & { reason: string })[]
}

/** Has @ImageN or @AudioN tokens. */
function hasTokens(text: string | undefined): boolean {
  return !!text && (findImageTokens(text).length > 0 || findAudioTokens(text).length > 0)
}

/**
 * The params a clip gets from `base` (its current params, or what a new clip starts from) and the agent's
 * changes, checked the way Studio would generate it. A clip with a start or end frame of any kind (a picture or
 * a neighbour's frame) is generated image-to-video – by a model that takes an end image when it has one – and
 * takes no references. Throws (in Swedish) when the clip couldn't be generated as written, so nothing invalid is
 * saved.
 */
async function clipParams(
  base: GenerationParams,
  input: ClipInput,
  slots: SlotState,
  assets: AssetIndex,
  clipNumber: number
): Promise<ClipParams> {
  const { continuing, ending } = slots
  const keyframed = continuing || ending || slots.start.path !== undefined || slots.end.path !== undefined
  const needsEnd = ending || slots.end.path !== undefined
  if (keyframed && input.references?.length) {
    throw new Error(
      continuing
        ? `Klipp ${clipNumber} fortsätter från föregående klipp: det genereras från dess sista bildruta och tar inga referenser. Ta bort references eller sätt continue_from_previous till false.`
        : `Klipp ${clipNumber} har en start- eller slutbild och genereras bild-till-video, som inte tar referenser. Ta bort references, eller ta bort bilderna (start_image / end_image: null) för att använda referenser.`
    )
  }
  let models: VideoModel[] | undefined
  const getModels = async (): Promise<VideoModel[]> => (models ??= await loadModels())

  let modelId = input.model ? requireModel(await getModels(), input.model).id : base.model
  if (keyframed) {
    if (input.model && needsEnd && kindOfModelId(modelId) === 'image-to-video' && !supportsEndImage(modelId)) {
      throw new Error(
        `${modelId} kan inte ta en slutbild. Välj en bild-till-video-modell som kan det (t.ex. Seedance), eller ta bort slutbilden.`
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
      throw new Error(`Referenser används bara i läget reference-to-video, men ${modelId} är ${kindOfModelId(modelId)}.`)
    }
    modelId = modelForMode(await getModels(), modelId, 'reference-to-video')
  } else if (kindOfModelId(modelId) === 'image-to-video') {
    throw new Error(
      `${modelId} är en bild-till-video-modell och behöver en startbild: ange start_image, eller välj en modell för referenser.`
    )
  }

  const notes: string[] = []
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
        'Prompten skickar inga referenser längre, så @-referenserna togs bort ur den. Skriv gärna om den: beskriv i ord vad som händer mellan start- och slutbilden.'
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
  // Which descriptions of its references the clip appends to its prompt ("Ta med beskrivningar"); they travel
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
  if (keyframed) {
    if (base.referenceImages?.length || base.referenceAudios?.length) {
      notes.push(
        'Klippets referenser (bilder och röster) togs bort: med start- eller slutbild genereras det bild-till-video, och utseendet kommer från bilderna.'
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
      notes.push('Ljudreferenserna togs bort: modellen tar inte emot ljudreferenser.')
    }
    if (kindOfModelId(modelId) === 'reference-to-video') {
      const max = maxReferenceImages(modelId)
      const count = params.referenceImages?.length ?? 0
      if (count > max) throw new Error(`Klipp ${clipNumber} har ${count} referensbilder, men modellen tar högst ${max}.`)
    }
  }

  // Checked as it will be generated, with the pictures that are put in after saving standing in their slots.
  const checked: GenerationParams = {
    ...params,
    startImage: slots.start.set ? slots.start.path || 'frame' : params.startImage,
    endImage: slots.end.set ? slots.end.path || 'frame' : params.endImage
  }
  const problem = blockingProblem(asGenerated(checked, continuing, ending), continuing, ending)
  if (problem) throw new Error(`Klipp ${clipNumber}: ${problem}`)
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
        `Klipp ${clipNumber} sparades, men ${SLOT_SV[slot]}en kunde inte sättas: ${errorText(err)} Försök igen med update_segment({${slot}_image}).`
      )
    }
  }
  return updated
}

/** A frame becomes a new still when it is put into its slot, so the stills are read again afterwards. */
function savesFrame(slots: SlotState): boolean {
  return slots.start.set?.kind === 'frame' || slots.end.set?.kind === 'frame'
}

/** The extras an agent should hear about after saving a clip. */
function clipNotes(result: ClipParams): Record<string, unknown> {
  return {
    ...(result.skippedAudio.length ? { not_added_audio: result.skippedAudio } : {}),
    ...(result.notes.length ? { notes: result.notes } : {})
  }
}

// ── Reordering a clip's references ───────────────────────────────────────────

/**
 * reorder_references for a sequence clip: its reference images and/or audio in the new order (see newOrder), with
 * every @ImageN / @AudioN token in its prompt and negative prompt renumbered by the shared reorderReferences (what
 * Studio's own drag and drop applies), saved through the sequence service in one change. Refused while "Generera
 * saknade" runs, for a clip that sends no references, and when the clip changed in Studio meanwhile.
 */
export async function reorderClipReferences(
  segmentId: string,
  images: readonly string[] | undefined,
  audios: readonly string[] | undefined
): Promise<ToolOutput> {
  const { sequence, index, segment } = await loadClip(segmentId)
  assertNotRunning(sequence)
  const clipNumber = index + 1
  const where = `klipp ${clipNumber}`
  if (continues(sequence, index)) {
    throw new Error(
      `Klipp ${clipNumber} fortsätter från föregående klipp och skickar inga referenser, så det finns inget att ordna om.`
    )
  }
  if (endsOnNext(sequence, index) || kindOfModelId(segment.params.model) === 'image-to-video') {
    throw new Error(
      `Klipp ${clipNumber} har en start- eller slutbild (bild-till-video) och skickar inga referenser, så det finns inget att ordna om.`
    )
  }
  if (kindOfModelId(segment.params.model) !== 'reference-to-video') {
    throw new Error(`Klipp ${clipNumber} är text-till-video och har inga referenser att ordna om.`)
  }
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
        notes: ['Referenserna låg redan i den ordningen, så inget ändrades.']
      },
      summary: `tittade på ordningen på referenserna i klipp ${clipNumber} (oförändrad)`
    }
  }

  // The shared reorder the window's drag and drop applies: the list in the new order and both prompts' tokens
  // renumbered with it. Named by their tokens in today's order, so the result is the same as the window's.
  let next = params
  if (imageOrder) next = reorderReferences(next, 'image', imageOrder.map((i) => imageToken(i + 1)))
  if (audioOrder) next = reorderReferences(next, 'audio', audioOrder.map((i) => audioToken(i + 1)))
  // Built on the clip as it was read: a change the user saved meanwhile must not be written over.
  const row = store.getSegmentRow(segment.id)
  if (!row) throw new Error('Klippet finns inte längre.')
  if (store.serializeParams(store.parseParams(row.params)) !== store.serializeParams(params)) {
    throw new Error(
      'Klippet ändrades i Studio medan ändringen förbereddes, så inget sparades. Läs klippet igen (get_sequence) och gör ändringen på nytt.'
    )
  }
  const updated = await callService<Sequence>('segments:update', segment.id, { params: next } satisfies SegmentPatch)
  const saved = updated.segments.find((s) => s.id === segment.id)?.params ?? next
  const moved = {
    images: movedTokens('image', paths, saved.referenceImages ?? [], assets),
    audios: movedTokens('audio', clips.map((a) => a.path), (saved.referenceAudios ?? []).map((a) => a.path), assets)
  }
  return {
    data: answer(saved, moved),
    summary: `ändrade ordningen på referenserna i klipp ${clipNumber} i ${q(sequence.name)}${movedSummary(moved)}`
  }
}

const SLOT_HELP =
  ' {still_id} (a still, list_stills), {asset_image_id} (a library photo), {generation_id, time} (that frame of a finished clip, saved as a still), or null to clear it.'

const clipFields = {
  prompt: z
    .string()
    .describe(
      "What happens in the clip (see the guide). Tokens must match this clip's own references; a clip with a start or end image (image-to-video) takes no tokens – describe the motion between the pictures."
    ),
  negative_prompt: z.string().optional().describe('Empty string clears it.'),
  references: z
    .array(referenceItem)
    .optional()
    .describe(
      "The clip's own references, like set_references items: photos in @Image order and audio (characters' voices by default, with a model that takes audio) in @Audio order. Replaces the clip's references. Not allowed on a clip with a start or end image of any kind (image-to-video)."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "A model id from list_models. A clip with a start or end image always uses that family's image-to-video model (one that takes an end image when it has one)."
    ),
  duration: z.string().optional().describe('e.g. "8s".'),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  audio: z.boolean().optional(),
  include_descriptions: includeDescriptionsInput,
  excluded_description_asset_ids: excludedDescriptionsInput,
  notes: z
    .string()
    .max(4000)
    .optional()
    .describe('"Vad händer": what happens in the shot, for the storyboard panel (any language). Not sent to Venice.'),
  continue_from_previous: z
    .boolean()
    .optional()
    .describe("Start from the previous clip's last frame (image-to-video, no references, no tokens). Same as start_image: \"previous\"."),
  end_from_next: z
    .boolean()
    .optional()
    .describe("End on the next clip's first frame (image-to-video with a model that takes an end image). Same as end_image: \"next\"."),
  start_image: slotInput.describe(`The clip's start image (first frame): "previous" (the previous clip's last frame),${SLOT_HELP}`),
  end_image: slotInput.describe(`The clip's end image (last frame): "next" (the next clip's first frame),${SLOT_HELP}`)
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
        "One sequence with its clips in order – the panels of its storyboard. Each clip has its notes (\"Vad händer\"), prompt and settings, its own references as token maps (references for @ImageN, audio_references for @AudioN), its start_image and end_image ({kind: \"previous\"} = the previous clip's last frame, {kind: \"next\"} = the next clip's first frame, {kind: \"image\", still_id | asset_image_id, path} = a chosen picture, null = none), continue_from_previous / end_from_next, supports_end_image (whether its video model takes an end image), validation issues (ready: false means it can't be generated as it is), frame_problems (what still stops its automatic frames), composed_prompt (its prompt as it would be sent, with the descriptions of its referenced assets appended as a References legend) with description_entries, and its selected take (status, error). With include_thumbnails (default true) the poster frame of every finished selected take comes as an image, so you can check continuity across the cut; preview_segment_frames shows a clip's start and end images.",
      input: {
        sequence_id: z.string(),
        include_thumbnails: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en sekvens'
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
        summary: `tittade på sekvensen ${q(sequence.name)}`
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
        'Creates an empty sequence (a film made of clips) with the default settings (Seedance 2.5, 8s, 480p, 16:9, audio). Add clips with add_segment – one per storyboard panel.',
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
        "Adds a clip (a storyboard panel) to a sequence, at the end or after after_segment_id, with its notes (\"Vad händer\") and prompt. Settings you leave out come from the previous clip (or the sequence defaults for the first clip). continue_from_previous defaults to true when there is a previous clip and you pass neither references nor a start_image, otherwise false. A continuing clip starts from the previous clip's last frame: it is image-to-video and takes no references or tokens – describe what happens next. A clip with a start_image and/or end_image (a still, a library photo, a frame of a finished clip, or \"next\" for the next clip's first frame) is image-to-video too: the look comes from the pictures. A clip without any of these is a new shot: give it references (its own @Image1… / @Audio1… numbering; characters' voices come along by default with a model that takes audio) unless it should reuse the previous clip's. The descriptions of its referenced assets are appended to its prompt when it is generated (include_descriptions / excluded_description_asset_ids choose which; they carry over from the previous clip) – don't repeat them in the prompt. The clip is validated like a generation; problems are returned as an error and nothing is saved.",
      input: {
        sequence_id: z.string(),
        after_segment_id: z.string().optional().describe('Insert after this clip; at the end when left out.'),
        ...clipFields
      },
      annotations: WRITE,
      summary: () => 'lade till ett klipp'
    },
    async ({ sequence_id, after_segment_id, notes, ...input }) => {
      const sequence = await loadSequence(sequence_id)
      assertNotRunning(sequence)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const afterIndex = after_segment_id
        ? sequence.segments.findIndex((s) => s.id === after_segment_id)
        : sequence.segments.length - 1
      if (after_segment_id && afterIndex < 0) throw new Error('after_segment_id är inget klipp i den här sekvensen.')
      const previous = afterIndex >= 0 ? sequence.segments[afterIndex] : undefined
      const clipNumber = afterIndex + 2
      const base: GenerationParams = previous
        ? { ...previous.params, prompt: '', startImage: undefined, endImage: undefined }
        : { ...DEFAULT_PARAMS, ...sequence.defaults, prompt: '' }
      // A new clip continues by default unless it is given what a shot of its own needs.
      const ownStart = input.start_image !== undefined && input.start_image !== 'previous'
      const ownShot = !!input.references?.length || ownStart
      const slots = slotState(
        input,
        { continuing: false, ending: false, params: base },
        { first: !previous, last: afterIndex === sequence.segments.length - 1 },
        assets,
        stills,
        !!previous && !ownShot && input.continue_from_previous === undefined
      )
      const result = await clipParams(base, input, slots, assets, clipNumber)

      const before = new Set(sequence.segments.map((s) => s.id))
      let updated = await callService<Sequence>('segments:add', sequence.id, {
        afterSegmentId: previous?.id,
        params: result.params,
        continueFromPrevious: slots.continuing,
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
        "Changes a clip (a storyboard panel): only the fields you pass change. notes is the panel's \"Vad händer\" text. references replaces the clip's references (photos in @Image order, audio in @Audio order). start_image / end_image put a picture into the clip's start or end slot (a still, a library photo, a frame of a finished clip), make it automatic (\"previous\" / \"next\"), or clear it (null); any start or end image makes the clip image-to-video with its family's model (one that takes an end image when it has one) and drops its references – a prompt you don't rewrite loses its @ tokens, one you write must have none. Clearing every picture makes it a new shot that needs references (and switches it to the reference-to-video model unless you pass a model). selected_take_id selects which of the clip's finished takes is used in the cut (its takes are listed by get_generation's take_of and review_sequence; the old one stays and can be selected again). include_descriptions / excluded_description_asset_ids choose which descriptions of its referenced assets are appended to its prompt; reorder_references({target: {segment_id}}) changes the order of its references and renumbers its tokens. The clip is validated like a generation; problems are returned as an error and nothing is saved. Existing takes are kept.",
      input: {
        segment_id: z.string(),
        ...clipFields,
        prompt: clipFields.prompt.optional(),
        selected_take_id: z
          .string()
          .optional()
          .describe("One of the clip's finished takes (a generation_id) to use in the cut.")
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade ett klipp'
    },
    async ({ segment_id, notes, selected_take_id, ...input }) => {
      const { sequence, index, segment } = await loadClip(segment_id)
      assertNotRunning(sequence)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const clipNumber = index + 1
      const touchesClip = Object.entries(input).some(([, v]) => v !== undefined)
      let take: Generation | undefined
      if (selected_take_id !== undefined) {
        take = segment.takes.find((t) => t.id === selected_take_id)
        if (!take) throw new Error(`Tagningen ${selected_take_id} hör inte till klipp ${clipNumber}.`)
        if (!isUsableTake(take)) throw new Error('Bara en färdig tagning (med sin video kvar) kan väljas till klippet.')
      }

      const slots = slotState(
        input,
        { continuing: continues(sequence, index), ending: endsOnNext(sequence, index), params: segment.params },
        { first: index === 0, last: index === sequence.segments.length - 1 },
        assets,
        stills,
        false
      )
      const result = touchesClip ? await clipParams(segment.params, input, slots, assets, clipNumber) : undefined
      // The new params are built on the clip as it was read; whatever the user saved meanwhile would be written
      // over without a word. Compared right before the write (nothing can come in between). Notes and the
      // selected take are written as given, so only a change to the clip's settings matters.
      const row = store.getSegmentRow(segment.id)
      if (!row) throw new Error('Klippet finns inte längre.')
      if (
        result &&
        (store.serializeParams(store.parseParams(row.params)) !== store.serializeParams(segment.params) ||
          !!row.continue_from_previous !== segment.continueFromPrevious ||
          !!row.end_from_next !== segment.endFromNext)
      ) {
        throw new Error(
          'Klippet ändrades i Studio medan ändringen förbereddes, så inget sparades. Läs klippet igen (get_sequence) och gör ändringen på nytt.'
        )
      }
      const patch: SegmentPatch = {
        ...(result ? { params: result.params, continueFromPrevious: slots.continuing, endFromNext: slots.ending } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(take ? { selectedGenerationId: take.id } : {})
      }
      let updated = Object.keys(patch).length
        ? await callService<Sequence>('segments:update', segment.id, patch)
        : sequence
      if (result) updated = (await applyImages(segment.id, slots, clipNumber)) ?? updated
      const at = updated.segments.findIndex((s) => s.id === segment.id)
      const stillsNow = savesFrame(slots) ? await StillIndex.load() : stills
      const what =
        !result && take && notes === undefined ? `valde en tagning för klipp ${clipNumber}` : `ändrade klipp ${clipNumber}`
      return {
        data: {
          ...(at >= 0 ? clipInfo(updated, at, assets, stillsNow) : { segment_id }),
          ...(result ? clipNotes(result) : {})
        },
        summary: `${what} i ${q(sequence.name)}`
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
        "Removes a clip from its sequence. Its takes are not deleted: their videos become ordinary generations in the user's feed. A clip that continued from the deleted one now continues from the clip before it, and one that ended on its first frame now ends on the clip after it.",
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
        'Moves a clip to another place in its sequence. to_clip_number is the 1-based number the clip should have afterwards (as Studio shows "Klipp 1", "Klipp 2" …). Whichever clip ends up first stops continuing from a previous clip, and whichever ends up last stops taking its end image from a next one.',
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
            end_from_next: endsOnNext(updated, i),
            prompt: s.params.prompt
          }))
        },
        summary: `flyttade klipp ${index + 1} till plats ${Math.min(to_clip_number, updated.segments.length)} i ${q(sequence.name)}`
      }
    }
  )
}
