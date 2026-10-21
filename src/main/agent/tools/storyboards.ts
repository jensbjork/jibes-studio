import { existsSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { effectiveDirectorId } from '@shared/direction'
import { kindOfModelId, supportsEndImage } from '@shared/models'
import { findAudioTokens, findImageTokens } from '@shared/prompt-refs'
import {
  STORYBOARD_ASPECT_RATIOS,
  type BoardImageSource,
  type Generation,
  type GenerationParams,
  type Sequence,
  type Storyboard,
  type StoryboardBoard,
  type StoryboardSummary,
  type StoryboardTransition,
  type TransitionPatch,
  type VideoModel
} from '@shared/types'
import * as db from '../../db'
import { frameStartAtOrAfter } from '../../ffmpeg'
import { composeSubmission } from '../../jobs'
import { isLibraryReady } from '../../paths'
import * as store from '../../sequence-store'
import { imageBlock } from '../images'
import { callService } from '../local-ipc'
import { isStoryboardId, sequenceKind, storyboardOfBoard } from '../storyboard-rows'
import {
  AssetIndex,
  StillIndex,
  blockingProblem,
  canonical,
  checkOutputOptions,
  checkPromptLength,
  imageRef,
  localTime,
  modelsIfAvailable,
  normalizeAspectRatio,
  normalizeDuration,
  normalizeResolution,
  q,
  readableRunError,
  requireLibrary,
  requireModel,
  seconds,
  usableModels
} from '../studio'
import { READ_ONLY, WRITE, defineTool, priceValue, quote, usd, type LabeledImage, type ToolContext } from './kit'
import { clipDirectorInfo, directorInput, directorRef } from './directors'
import { isUsableTake } from './sequences'
import { URL_WAIT_MS, stageFiles, uploadSource, urlSource } from './sources'

// Storyboards: a film planned as milestone pictures. A storyboard is an ordered list of boards – one picture
// each (made with request_image_generation, a still, a library photo or a frame of a clip) with a short note –
// and between every two neighbouring boards a transition: the video clip that goes from the first board's
// picture to the second's (image-to-video with a start and an end image). Transitions are kept in step with the
// boards by the storyboard service; these tools only go through it, like the window does.

// ── Loading ──────────────────────────────────────────────────────────────────

/** A storyboard by id; a sequence id is answered with a pointer to the sequence tools. */
export async function loadStoryboard(storyboardId: string): Promise<Storyboard> {
  requireLibrary()
  const kind = sequenceKind(storyboardId)
  if (!kind) throw new Error('There is no storyboard with that id. list_storyboards lists the ones there are.')
  if (kind !== 'storyboard') {
    throw new Error('This is a sequence, not a storyboard. Use get_sequence (list_sequences lists the sequences).')
  }
  return callService<Storyboard>('storyboards:get', storyboardId)
}

/** A transition (a segment of a storyboard) with its storyboard and its 0-based place. */
export async function loadTransition(
  transitionId: string
): Promise<{ storyboard: Storyboard; index: number; transition: StoryboardTransition }> {
  requireLibrary()
  const row = store.getSegmentRow(transitionId)
  if (!row) throw new Error(TRANSITION_GONE)
  if (!isStoryboardId(row.sequence_id)) {
    throw new Error(
      'This is a clip in a sequence, not a transition in a storyboard. Use update_segment and request_segment_generation (get_sequence lists the clips).'
    )
  }
  const storyboard = await callService<Storyboard>('storyboards:get', row.sequence_id)
  const index = storyboard.transitions.findIndex((t) => t.id === transitionId)
  if (index < 0) throw new Error(TRANSITION_GONE)
  return { storyboard, index, transition: storyboard.transitions[index] }
}

const TRANSITION_GONE =
  'The transition no longer exists (the boards may have been moved or removed). get_storyboard shows the storyboard\'s transitions as they are now.'

/** A board with its storyboard and its 0-based place. */
export async function loadBoard(
  boardId: string
): Promise<{ storyboard: Storyboard; index: number; board: StoryboardBoard }> {
  requireLibrary()
  const storyboardId = storyboardOfBoard(boardId)
  if (!storyboardId) throw new Error(BOARD_GONE)
  const storyboard = await callService<Storyboard>('storyboards:get', storyboardId)
  const index = storyboard.boards.findIndex((b) => b.id === boardId)
  if (index < 0) throw new Error(BOARD_GONE)
  return { storyboard, index, board: storyboard.boards[index] }
}

const BOARD_GONE = 'There is no board with that id (any more). get_storyboard shows the storyboard\'s boards.'

/**
 * Nothing in a storyboard is changed by an agent while "Generate missing" runs for it: the run reads the
 * transitions as it goes, so a change made meanwhile would be paid for without the user having seen it.
 */
export function assertStoryboardIdle(storyboard: Storyboard): void {
  if (storyboard.running) {
    throw new Error(
      `"Generate missing" is running for the storyboard ${q(storyboard.name)}. Wait until the run is done (or stop it with stop_generation_run) before you change it.`
    )
  }
}

// ── How the tools show a storyboard ──────────────────────────────────────────

/** A transition's selected take, when it has one. */
export function selectedTakeOf(t: StoryboardTransition): Generation | undefined {
  return t.selectedGenerationId ? t.takes.find((g) => g.id === t.selectedGenerationId) : undefined
}

/** A take of the transition is queued or rendering. */
export function renderingTakeOf(t: StoryboardTransition): boolean {
  return t.takes.some((g) => g.status === 'queued' || g.status === 'processing')
}

/** Done: the transition has a finished selected take whose video is still there. */
export const transitionDone = (t: StoryboardTransition): boolean => isUsableTake(selectedTakeOf(t))

/** The 1-based numbers of the two boards a transition goes between (0 when a board can't be found). */
export function boardNumbers(storyboard: Storyboard, t: StoryboardTransition): { from: number; to: number } {
  return {
    from: storyboard.boards.findIndex((b) => b.id === t.fromBoardId) + 1,
    to: storyboard.boards.findIndex((b) => b.id === t.toBoardId) + 1
  }
}

/** "transition 2 (board 2 → 3)", for messages and the activity log. */
export function transitionLabel(storyboard: Storyboard, index: number): string {
  const { from, to } = boardNumbers(storyboard, storyboard.transitions[index])
  return `transition ${index + 1} (board ${from || '?'} → ${to || '?'})`
}

/** The boards a transition needs a picture in, by number ("boards 2 and 3 have no pictures yet"). */
export function missingImagesText(storyboard: Storyboard, t: StoryboardTransition): string {
  const empty = [t.fromBoardId, t.toBoardId]
    .map((id) => storyboard.boards.findIndex((b) => b.id === id))
    .filter((i) => i >= 0 && !storyboard.boards[i].imagePath)
    .map((i) => i + 1)
  if (!empty.length) return 'the boards\' pictures are missing'
  return empty.length === 1 ? `board ${empty[0]} has no picture yet` : `boards ${empty[0]} and ${empty[1]} have no pictures yet`
}

/** A board's picture as the tools show it: which still or library photo it is, or that the file is gone. */
function boardImage(path: string | undefined, assets: AssetIndex, stills: StillIndex): Record<string, unknown> | null {
  if (!path) return null
  const ref = imageRef(path, assets, stills)
  // Always a picture; `kind` only tells a clip's chosen image from its neighbours' frames.
  delete ref.kind
  return existsSync(path) ? ref : { ...ref, missing: true }
}

export function boardInfo(
  storyboard: Storyboard,
  index: number,
  assets: AssetIndex,
  stills: StillIndex
): Record<string, unknown> {
  const board = storyboard.boards[index]
  return {
    board_id: board.id,
    board_number: index + 1,
    note: board.note,
    image: boardImage(board.imagePath, assets, stills),
    ...(board.aspectMismatch
      ? { aspect_mismatch: `The picture's format differs from the storyboard's (${storyboard.aspectRatio}); the transitions from and to it get the picture's format.` }
      : {})
  }
}

/** A board as a transition names it. */
function boardRef(storyboard: Storyboard, boardId: string): Record<string, unknown> {
  const index = storyboard.boards.findIndex((b) => b.id === boardId)
  const board = storyboard.boards[index]
  return board
    ? { board_id: board.id, board_number: index + 1, note: board.note, has_image: !!board.imagePath }
    : { board_id: boardId, missing: true }
}

/** How many of a transition's takes are listed (newest first); the rest are counted. */
const LISTED_TAKES = 8

/**
 * What stops a transition from being generated as it stands: the storyboard service's problems (a board
 * without a picture, no prompt, a model without an end image …), else the checks every generation gets.
 */
export function transitionProblems(t: StoryboardTransition): string[] {
  if (t.problems.length) return t.problems
  const problem = blockingProblem(t.params)
  return problem ? [problem] : []
}

export function transitionInfo(storyboard: Storyboard, index: number): Record<string, unknown> {
  const t = storyboard.transitions[index]
  const p = t.params
  const take = selectedTakeOf(t)
  const problems = transitionProblems(t)
  return {
    transition_id: t.id,
    transition_number: index + 1,
    from_board: boardRef(storyboard, t.fromBoardId),
    to_board: boardRef(storyboard, t.toBoardId),
    // Can be generated now: both boards have pictures and nothing else stands in the way.
    ready: t.ready && !problems.length,
    ...(problems.length ? { problems } : {}),
    prompt: p.prompt,
    ...(p.negativePrompt ? { negative_prompt: p.negativePrompt } : {}),
    model: p.model,
    duration: p.duration,
    resolution: p.resolution,
    ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
    audio: p.audio,
    // Directed by the storyboard's director (none of its own): the prompt as it is sent, with its Direction section.
    ...transitionDirection(storyboard, p),
    selected_take: take
      ? {
          generation_id: take.id,
          status: take.status,
          ...(take.error ? { error: take.error } : {}),
          ...(take.videoDuration !== undefined ? { video_seconds: seconds(take.videoDuration) } : {}),
          ...(take.fileMissing ? { file_missing: true } : {}),
          // The user's grade: -1 = thumbs down, 1–3 = stars.
          ...(take.rating !== undefined ? { rating: take.rating } : {}),
          // Made before a board's picture changed: it doesn't go from today's picture to today's picture.
          ...(t.staleTake ? { made_from_earlier_pictures: true } : {})
        }
      : null,
    takes: t.takes.slice(0, LISTED_TAKES).map((g) => ({
      generation_id: g.id,
      status: g.status,
      created: localTime(g.createdAt),
      ...(g.id === t.selectedGenerationId ? { selected: true } : {}),
      ...(g.rating !== undefined ? { rating: g.rating } : {}),
      ...(g.reviewCount ? { review_count: g.reviewCount } : {})
    })),
    take_count: t.takes.length,
    ...(renderingTakeOf(t) ? { rendering: true } : {})
  }
}

/**
 * Who directs a transition (the storyboard's director, unless it chose its own or none) and, when one does, the prompt
 * it is sent with: the Direction section after it (composed_prompt) and what of the director goes along (direction).
 */
function transitionDirection(storyboard: Storyboard, p: GenerationParams): Record<string, unknown> {
  const info = clipDirectorInfo(p.director, storyboard.director)
  const id = effectiveDirectorId(p.director, storyboard.director)
  if (!id || !isLibraryReady()) return info
  const sent = composeSubmission({ ...p, director: id })
  return {
    ...info,
    composed_prompt: sent.prompt,
    ...(sent.direction?.notes.length ? { direction_notes: sent.direction.notes } : {})
  }
}

/** The whole storyboard as the tools show it. */
export function storyboardInfo(storyboard: Storyboard, assets: AssetIndex, stills: StillIndex): Record<string, unknown> {
  const missing = storyboard.transitions.flatMap((t, i) => (transitionDone(t) ? [] : [i + 1]))
  return {
    storyboard_id: storyboard.id,
    name: storyboard.name,
    aspect_ratio: storyboard.aspectRatio,
    // Directs every transition and the pictures made for its boards (update_storyboard director).
    director: directorRef(storyboard.director),
    board_count: storyboard.boards.length,
    transition_count: storyboard.transitions.length,
    transitions_done: storyboard.transitions.length - missing.length,
    transitions_without_finished_take: missing,
    generate_all_running: storyboard.running,
    ...(storyboard.runError ? { last_run_error: readableRunError(storyboard.runError) } : {}),
    still_count: stills.stills.filter((s) => s.sequenceId === storyboard.id).length,
    updated: localTime(storyboard.updatedAt),
    boards: storyboard.boards.map((_, i) => boardInfo(storyboard, i, assets, stills)),
    transitions: storyboard.transitions.map((_, i) => transitionInfo(storyboard, i))
  }
}

/** How many pictures get_storyboard sends of each kind, and how big. */
const MAX_BOARD_IMAGES = 16
const MAX_TAKE_POSTERS = 16
const THUMB_SIDE = 384

/** The boards' pictures and the selected takes' poster frames, labelled, for get_storyboard. */
async function storyboardImages(storyboard: Storyboard): Promise<{ images: LabeledImage[]; note?: string }> {
  const images: LabeledImage[] = []
  for (const [i, board] of storyboard.boards.slice(0, MAX_BOARD_IMAGES).entries()) {
    if (!board.imagePath) continue
    const image = await imageBlock(board.imagePath, THUMB_SIDE)
    if (image) images.push({ label: `Board ${i + 1}${board.note.trim() ? ` – "${excerpt(board.note, 80)}"` : ''}`, image })
  }
  for (const [i, t] of storyboard.transitions.slice(0, MAX_TAKE_POSTERS).entries()) {
    const take = selectedTakeOf(t)
    if (!isUsableTake(take) || !take?.thumbPath) continue
    const image = await imageBlock(take.thumbPath, THUMB_SIDE)
    const { from, to } = boardNumbers(storyboard, t)
    if (image) images.push({ label: `Transition ${i + 1} (board ${from} → ${to}) – selected take ${take.id} (poster frame)`, image })
  }
  const more = storyboard.boards.length > MAX_BOARD_IMAGES || storyboard.transitions.length > MAX_TAKE_POSTERS
  return { images, ...(more ? { note: `Pictures of the first ${MAX_BOARD_IMAGES} boards and transitions only; preview_transition shows any transition.` } : {}) }
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A board's picture as an agent names it. */
const boardImageInput = z.union([
  z.object({ still_id: z.string() }).strict(),
  z.object({ asset_image_id: z.string() }).strict(),
  z.object({ generation_id: z.string(), time: z.number().min(0) }).strict(),
  uploadSource,
  urlSource
])

type BoardImageInput = z.infer<typeof boardImageInput>

const BOARD_IMAGE_HELP =
  '{still_id} (a still, list_stills – e.g. one made with request_image_generation), {asset_image_id} (a library photo, used where it is), {generation_id, time} (that frame of a finished clip – the frame review_generation and get_frames show for that time – saved as a still of the storyboard), or {upload_id} / {url} (a picture you send, copied in as a still of the storyboard).'

/**
 * The picture an input names, checked before anything is changed (the still, the photo, the finished clip and
 * its file exist; an upload ready, a URL fetched). A frame is named by the moment it starts, which is how the stills
 * service picks it. An upload or URL becomes a file the service copies into the storyboard's stills.
 */
async function boardImageSource(
  ctx: ToolContext,
  input: BoardImageInput,
  assets: AssetIndex,
  stills: StillIndex
): Promise<BoardImageSource> {
  if ('upload_id' in input || 'url' in input) {
    const [file] = await stageFiles(ctx, 'image', [input], Date.now() + URL_WAIT_MS)
    return { kind: 'file', path: file.path }
  }
  if ('still_id' in input) {
    const still = stills.require(input.still_id)
    if (!existsSync(still.path)) throw new Error('The still image\'s file is no longer on disk.')
    return { kind: 'still', stillId: still.id }
  }
  if ('asset_image_id' in input) {
    const photo = assets.requireImage(input.asset_image_id)
    return { kind: 'asset-image', imageId: photo.imageId }
  }
  const g = db.getGeneration(input.generation_id)
  if (!g) throw new Error(`There is no generation with id ${input.generation_id}.`)
  if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
    throw new Error('The generation has no finished video to take a frame from.')
  }
  // Agents see frames by input seeking (the first frame at or after a time); the stills service saves the frame a
  // paused player shows. Asked for the moment that frame starts, it saves the frame the agent looked at.
  const at = await frameStartAtOrAfter(g.filePath, input.time)
  return { kind: 'frame', generationId: g.id, time: at }
}

/** "16x9", "16/9" → "16:9", checked against the storyboard formats. */
function storyboardRatio(value: string | undefined): string | undefined {
  const ratio = normalizeAspectRatio(value)
  if (ratio === undefined || ratio === '') return undefined
  if (!(STORYBOARD_ASPECT_RATIOS as readonly string[]).includes(ratio)) {
    throw new Error(`The aspect ratio ${ratio} doesn't work for a storyboard. Choose one of: ${STORYBOARD_ASPECT_RATIOS.join(', ')}.`)
  }
  return ratio
}

/** Has @ImageN or @AudioN tokens (or near misses that would be read as them). */
function hasTokens(text: string): boolean {
  return findImageTokens(text).length > 0 || findAudioTokens(text).length > 0
}

/** Transitions that were in `before` and aren't in `after`, with how many takes went back to the feed. */
function removedTransitions(before: Storyboard, after: Storyboard): Record<string, unknown>[] {
  const kept = new Set(after.transitions.map((t) => t.id))
  return before.transitions.flatMap((t, i) =>
    kept.has(t.id)
      ? []
      : [{ transition_id: t.id, was: `transition ${i + 1}`, takes_returned_to_feed: t.takes.length }]
  )
}

const REMOVED_NOTE =
  'Transitions between boards that are no longer next to each other were removed. Their takes are still there as ordinary generations (list_generations). New transitions have an empty prompt: write them with update_transition.'

/** The transitions that touch a board, as the tools show them. */
function touching(storyboard: Storyboard, boardId: string): Record<string, unknown>[] {
  return storyboard.transitions.flatMap((t, i) =>
    t.fromBoardId === boardId || t.toBoardId === boardId ? [transitionInfo(storyboard, i)] : []
  )
}

/** What boards:moveLoss says a move would remove (B's read-only half of moveBoard). */
interface MoveLoss {
  transitions: { id: string; number: number; prompt: string; takeCount: number; selected: boolean }[]
}

/** A transition worth keeping: it has a prompt, a negative prompt or takes. Removing it needs the user's OK. */
function valuable(t: StoryboardTransition): boolean {
  return t.params.prompt.trim() !== '' || !!t.params.negativePrompt?.trim() || t.takes.length > 0
}

/**
 * The transition a new board put after `afterId` (or before `beforeId`) would replace: the one between the two
 * boards it lands between, with their 1-based numbers. Undefined when it lands at an end (nothing is replaced).
 */
function transitionReplacedBy(
  storyboard: Storyboard,
  afterId: string | undefined,
  beforeId: string | undefined
): { transition: StoryboardTransition; number: number; from: number; to: number } | undefined {
  const boards = storyboard.boards
  let left: number
  if (afterId) left = boards.findIndex((b) => b.id === afterId)
  else if (beforeId) left = boards.findIndex((b) => b.id === beforeId) - 1
  else return undefined
  if (left < 0 || left + 1 >= boards.length) return undefined
  const a = boards[left]
  const b = boards[left + 1]
  const index = storyboard.transitions.findIndex((t) => t.fromBoardId === a.id && t.toBoardId === b.id)
  if (index < 0) return undefined
  return { transition: storyboard.transitions[index], number: index + 1, from: left + 1, to: left + 2 }
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function registerStoryboardTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'list_storyboards',
    {
      title: 'List storyboards',
      description:
        "The user's storyboards, most recently changed first: films planned as milestone pictures (boards) with a generated transition clip between every two neighbouring boards. Each with its number of boards and transitions and how many transitions have a finished selected take. Storyboards are separate from sequences (list_sequences).",
      input: {},
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'listed all storyboards'
    },
    async () => {
      requireLibrary()
      const list = await callService<StoryboardSummary[]>('storyboards:list')
      return {
        data: {
          storyboards: list.map((s) => ({
            storyboard_id: s.id,
            name: s.name,
            board_count: s.boardCount,
            transition_count: s.transitionCount,
            transitions_done: s.doneCount,
            updated: localTime(s.updatedAt)
          }))
        }
      }
    }
  )

  defineTool(
    server,
    ctx,
    'get_storyboard',
    {
      title: 'Get storyboard',
      description:
        "One storyboard: its aspect ratio, its boards in order – each with its note (\"What does the image show?\") and its picture (a still or a library photo, null for an empty board; aspect_mismatch when the picture's format differs from the storyboard's) – and its transitions: transition N goes from board N's picture to board N+1's picture. Each transition has its prompt (\"What happens?\": the motion from the first picture to the second), model (an image-to-video model that takes an end image), duration, resolution, audio, ready (both boards have pictures and it can be generated), problems, its takes (newest first) and selected take (made_from_earlier_pictures when a board's picture changed after it was made). With include_images (default true) the boards' pictures and the selected takes' poster frames come as images. Free; changes nothing.",
      input: {
        storyboard_id: z.string(),
        include_images: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'looked at a storyboard'
    },
    async ({ storyboard_id, include_images }) => {
      const storyboard = await loadStoryboard(storyboard_id)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const pictures = include_images ? await storyboardImages(storyboard) : { images: [] }
      return {
        data: { ...storyboardInfo(storyboard, assets, stills), ...(pictures.note ? { note: pictures.note } : {}) },
        images: pictures.images,
        summary: `looked at the storyboard ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'create_storyboard',
    {
      title: 'Create storyboard',
      description:
        `Creates a storyboard: a film planned as milestone pictures (boards) with a transition clip generated between every two neighbouring boards. It starts with two empty boards; board_notes sets the boards' notes in order ("What does the image show?": what the picture shows – one milestone of the film each) and adds boards until there is one per note. aspect_ratio (default 16:9) is one of ${STORYBOARD_ASPECT_RATIOS.join(', ')}; the pictures are made in it. Next: a picture per board (request_image_generation with assign_to: {board_id}, or add_board / update_board with an existing picture), then a prompt per transition (update_transition).`,
      input: {
        name: z.string().min(1).max(120).describe('e.g. "Morning by the sea".'),
        aspect_ratio: z.string().optional().describe(`One of ${STORYBOARD_ASPECT_RATIOS.join(', ')}; default 16:9.`),
        board_notes: z
          .array(z.string().max(2000))
          .max(40)
          .optional()
          .describe('One note per board, in order: what each milestone picture shows (any language).')
      },
      annotations: WRITE,
      summary: ({ name }) => `created the storyboard ${q(name)}`
    },
    async ({ name, aspect_ratio, board_notes }) => {
      requireLibrary()
      const ratio = storyboardRatio(aspect_ratio)
      let storyboard = await callService<Storyboard>('storyboards:create', name, ratio)
      const notes = board_notes ?? []
      for (const [i, note] of notes.entries()) {
        const existing = storyboard.boards[i]
        if (existing) {
          if (note.trim()) storyboard = await callService<Storyboard>('boards:update', existing.id, { note })
        } else {
          const last = storyboard.boards[storyboard.boards.length - 1]
          storyboard = await callService<Storyboard>('boards:add', storyboard.id, { afterBoardId: last?.id, note })
        }
      }
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      return {
        data: {
          ...storyboardInfo(storyboard, assets, stills),
          next: 'Make a picture for each board (request_image_generation with assign_to: {board_id}), then write each transition\'s prompt (update_transition).'
        },
        summary: `created the storyboard ${q(storyboard.name)} with ${storyboard.boards.length} ${storyboard.boards.length === 1 ? 'board' : 'boards'}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_storyboard',
    {
      title: 'Update storyboard',
      description: `Renames a storyboard (its folder follows), changes its aspect ratio (${STORYBOARD_ASPECT_RATIOS.join(', ')}): new pictures are made in it; boards whose picture has another format are marked aspect_mismatch – and/or its director (list_directors; null for none), which directs every transition (its Direction section after the prompt, its avoid in the negative prompt) and the pictures made for its boards (request_image_generation with storyboard_id: its look, light and framing as text); choosing one also applies its defaults where they fit (an end-image model, the resolution, its aspect ratio). Existing transitions keep their settings. Only the fields you pass change.`,
      input: {
        storyboard_id: z.string(),
        name: z.string().min(1).max(120).optional(),
        aspect_ratio: z.string().optional(),
        director: z.string().nullable().optional().describe('A director_id (list_directors), or null for none.')
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a storyboard'
    },
    async ({ storyboard_id, name, aspect_ratio, director }) => {
      const before = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(before)
      const ratio = storyboardRatio(aspect_ratio)
      const chosen = directorInput(director)
      if (name === undefined && ratio === undefined && chosen === undefined) {
        throw new Error('Give name, aspect_ratio or director – otherwise there is nothing to change.')
      }
      const storyboard = await callService<Storyboard>('storyboards:update', before.id, {
        ...(name !== undefined ? { name } : {}),
        ...(ratio !== undefined ? { aspectRatio: ratio } : {}),
        ...(chosen !== undefined ? { director: chosen } : {})
      })
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const mismatched = storyboard.boards.flatMap((b, i) => (b.aspectMismatch ? [i + 1] : []))
      return {
        data: {
          storyboard_id: storyboard.id,
          name: storyboard.name,
          aspect_ratio: storyboard.aspectRatio,
          director: directorRef(storyboard.director),
          boards: storyboard.boards.map((_, i) => boardInfo(storyboard, i, assets, stills)),
          ...(mismatched.length
            ? { note: `Boards ${mismatched.join(', ')} have pictures of another format than ${storyboard.aspectRatio}.` }
            : {})
        },
        summary: `changed the storyboard ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_board',
    {
      title: 'Add board',
      description: `Adds a board (one milestone picture of the film) to a storyboard: at the end, or after after_board_id / before before_board_id. note says what the picture shows ("What does the image show?"). image puts a picture in right away: ${BOARD_IMAGE_HELP} Leave it out to plan first and make the picture later (request_image_generation with assign_to: {board_id}). The transitions around the new board are created with empty prompts (write them with update_transition). Adding at the end never removes anything. A board put between two boards replaces the transition between them: that is refused when the transition has a prompt or takes (nothing is added) – add the board last and ask the user to move it there with request_delete({items: [{board_move: {board_id, to_board_number}}]}); an empty transition is simply replaced.`,
      input: {
        storyboard_id: z.string(),
        after_board_id: z.string().optional(),
        before_board_id: z.string().optional(),
        note: z.string().max(2000).optional(),
        image: boardImageInput.optional().describe(`The board's picture: ${BOARD_IMAGE_HELP}`)
      },
      annotations: WRITE,
      summary: () => 'added a board'
    },
    async ({ storyboard_id, after_board_id, before_board_id, note, image }) => {
      const before = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(before)
      if (after_board_id && before_board_id) throw new Error('Give after_board_id or before_board_id, not both.')
      for (const id of [after_board_id, before_board_id]) {
        if (id && !before.boards.some((b) => b.id === id)) throw new Error('That board isn\'t in this storyboard.')
      }
      // Between two boards, the transition between them goes: never one with a prompt or takes without the user's OK.
      const lost = transitionReplacedBy(before, after_board_id, before_board_id)
      if (lost && valuable(lost.transition)) {
        throw new Error(
          `The board would land between boards ${lost.from} and ${lost.to}, and transition ${lost.number}, which has a prompt or takes, would then go. Add the board last and ask for permission to move it there with request_delete {board_move: {board_id: <the new board's id>, to_board_number: ${lost.to}}}.`
        )
      }
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const source = image ? await boardImageSource(ctx, image, assets, stills) : undefined
      const storyboard = await callService<Storyboard>('boards:add', before.id, {
        ...(after_board_id ? { afterBoardId: after_board_id } : {}),
        ...(before_board_id ? { beforeBoardId: before_board_id } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(source ? { image: source } : {})
      })
      const known = new Set(before.boards.map((b) => b.id))
      const index = storyboard.boards.findIndex((b) => !known.has(b.id))
      // A frame or a file becomes a new still when it is put in.
      const stillsNow = source?.kind === 'frame' || source?.kind === 'file' ? await StillIndex.load() : stills
      const removed = removedTransitions(before, storyboard)
      return {
        data: {
          ...(index >= 0 ? boardInfo(storyboard, index, assets, stillsNow) : {}),
          board_count: storyboard.boards.length,
          ...(index >= 0 ? { transitions: touching(storyboard, storyboard.boards[index].id) } : {}),
          ...(removed.length ? { removed_transitions: removed, note: REMOVED_NOTE } : {})
        },
        summary: `added board ${index + 1} to ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_board',
    {
      title: 'Update board',
      description: `Changes a board: its note and/or its picture (${BOARD_IMAGE_HELP} null empties the board). Only the fields you pass change. The two transitions next to the board then go from or to the new picture; their takes are kept, and a selected take made from the old picture is marked made_from_earlier_pictures in get_storyboard (a finished take made from the new picture then replaces it as the selected take by itself). To make a new picture for the board, use request_image_generation with assign_to: {board_id}.`,
      input: {
        board_id: z.string(),
        note: z.string().max(2000).optional(),
        image: boardImageInput.nullable().optional().describe(`The board's picture: ${BOARD_IMAGE_HELP} null empties it.`)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a board'
    },
    async ({ board_id, note, image }) => {
      const { storyboard: before } = await loadBoard(board_id)
      assertStoryboardIdle(before)
      if (note === undefined && image === undefined) throw new Error('Give note or image – otherwise there is nothing to change.')
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const source = image ? await boardImageSource(ctx, image, assets, stills) : image
      const storyboard = await callService<Storyboard>('boards:update', board_id, {
        ...(note !== undefined ? { note } : {}),
        ...(source !== undefined ? { image: source } : {})
      })
      const index = storyboard.boards.findIndex((b) => b.id === board_id)
      const stillsNow = source?.kind === 'frame' || source?.kind === 'file' ? await StillIndex.load() : stills
      return {
        data: {
          ...(index >= 0 ? boardInfo(storyboard, index, assets, stillsNow) : { board_id }),
          transitions: touching(storyboard, board_id)
        },
        summary: `changed board ${index + 1} in ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'move_board',
    {
      title: 'Move board',
      description:
        'Moves a board to another place in its storyboard. to_board_number is the 1-based number it should have afterwards. Transitions between boards that are no longer neighbours go and new ones, with empty prompts, join the new neighbours; transitions between boards that stay neighbours keep their prompt and takes. A move that would remove a transition with a prompt or takes is refused: ask the user with request_delete({items: [{board_move: {board_id, to_board_number}}]}) – they approve it in Studio. Moves that only drop empty transitions go ahead.',
      input: {
        board_id: z.string(),
        to_board_number: z.number().int().min(1)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ to_board_number }) => `moved a board to place ${to_board_number}`
    },
    async ({ board_id, to_board_number }) => {
      const { storyboard: before, index: from } = await loadBoard(board_id)
      assertStoryboardIdle(before)
      const to = Math.min(to_board_number, before.boards.length) - 1
      if (to !== from) {
        // What the move would remove, computed the way the move itself does it.
        const loss = await callService<MoveLoss>('boards:moveLoss', board_id, to)
        const lost = loss.transitions.filter((t) => {
          const known = before.transitions.find((x) => x.id === t.id)
          return t.prompt.trim() !== '' || t.takeCount > 0 || !!known?.params.negativePrompt?.trim()
        })
        if (lost.length) {
          const numbers = lost.map((t) => t.number)
          const which =
            numbers.length === 1
              ? `transition ${numbers[0]}`
              : `transitions ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
          throw new Error(
            `The move removes ${which}, with a prompt or takes. Ask for permission with request_delete {board_move: {board_id: "${board_id}", to_board_number: ${to + 1}}}.`
          )
        }
      }
      const storyboard = to === from ? before : await callService<Storyboard>('boards:move', board_id, to)
      const removed = removedTransitions(before, storyboard)
      return {
        data: {
          boards: storyboard.boards.map((b, i) => ({ board_id: b.id, board_number: i + 1, note: b.note })),
          transitions: storyboard.transitions.map((t, i) => {
            const { from: a, to: b } = boardNumbers(storyboard, t)
            return { transition_id: t.id, transition_number: i + 1, from_board: a, to_board: b, prompt: t.params.prompt }
          }),
          ...(removed.length ? { removed_transitions: removed, note: REMOVED_NOTE } : {})
        },
        summary: `moved board ${from + 1} to place ${storyboard.boards.findIndex((b) => b.id === board_id) + 1} in ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_transition',
    {
      title: 'Update transition',
      description:
        "Changes a transition – the clip from one board's picture to the next board's picture. Only the fields you pass change. prompt (\"What happens?\") describes the motion that leads from the first picture to the second within the duration: who moves where, what the camera does; image-to-video, so no @ tokens – name people in words. model must be an image-to-video model that takes an end image (list_models; Seedance image-to-video by default). duration, resolution and audio must be ones the model offers. selected_take_id chooses which of its finished takes is the transition's take (in the preview, the export and a conversion to a sequence). negative_prompt: empty string clears it. Generating is request_transition_generation.",
      input: {
        transition_id: z.string(),
        prompt: z.string().max(4000).optional(),
        negative_prompt: z.string().max(1500).optional(),
        duration: z.string().optional().describe('e.g. "5s".'),
        resolution: z.string().optional().describe('e.g. "480p".'),
        audio: z.boolean().optional(),
        model: z.string().optional(),
        selected_take_id: z.string().optional().describe("One of the transition's finished takes (a generation_id).")
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'changed a transition'
    },
    async ({ transition_id, prompt, negative_prompt, duration, resolution, audio, model, selected_take_id }) => {
      const { storyboard, index, transition } = await loadTransition(transition_id)
      assertStoryboardIdle(storyboard)
      const patch: TransitionPatch = {}
      const notes: string[] = []
      if (prompt !== undefined) {
        const text = canonical(prompt) ?? ''
        if (hasTokens(text)) {
          throw new Error(
            'A transition is generated from two images (image-to-video) and sends no references, so the prompt can\'t have @ references. Describe in words what happens between the images.'
          )
        }
        patch.prompt = text
      }
      if (negative_prompt !== undefined) patch.negativePrompt = canonical(negative_prompt) ?? ''
      const wanted = {
        duration: normalizeDuration(duration),
        resolution: normalizeResolution(resolution),
        audio
      }
      const outputGiven = wanted.duration !== undefined || wanted.resolution !== undefined || audio !== undefined
      let models: VideoModel[] | undefined
      if (model !== undefined || outputGiven || patch.prompt !== undefined) models = await modelsIfAvailable()
      if (model !== undefined) {
        if (!models) throw new Error('The model list couldn\'t be fetched from Venice right now, so the model can\'t be changed. Try again in a while.')
        const m = requireModel(models, model)
        if (kindOfModelId(m.id) !== 'image-to-video' || !supportsEndImage(m.id)) {
          const fitting = usableModels(models)
            .filter((x) => x.kind === 'image-to-video' && supportsEndImage(x.id))
            .map((x) => x.id)
          throw new Error(
            `${m.name} can't make a transition: it must be an image-to-video model that takes an end image.${fitting.length ? ` Choose one of: ${fitting.join(', ')}.` : ''}`
          )
        }
        patch.model = m.id
      }
      const modelId = patch.model ?? transition.params.model
      const listed = models ? usableModels(models).find((m) => m.id === modelId) : undefined
      if (listed && outputGiven) checkOutputOptions(listed, wanted)
      if (listed && patch.prompt !== undefined) checkPromptLength(listed, patch.prompt)
      if (wanted.duration !== undefined) patch.duration = wanted.duration
      if (wanted.resolution !== undefined) patch.resolution = wanted.resolution
      if (audio !== undefined) patch.audio = audio
      if (selected_take_id !== undefined) {
        const take = transition.takes.find((g) => g.id === selected_take_id)
        if (!take) throw new Error(`The take ${selected_take_id} doesn't belong to ${transitionLabel(storyboard, index)}.`)
        if (!isUsableTake(take)) throw new Error('Only a finished take (with its video still there) can be selected.')
        patch.selectedGenerationId = take.id
      }
      if (!Object.keys(patch).length) throw new Error('Give something to change (prompt, duration, resolution, audio, model or selected_take_id).')
      if (outputGiven && !listed) {
        notes.push('The model list couldn\'t be fetched, so length, resolution and sound are only checked when the transition is generated.')
      }
      const updated = await callService<Storyboard>('transitions:update', transition.id, patch)
      const at = updated.transitions.findIndex((t) => t.id === transition.id)
      const label = at >= 0 ? transitionLabel(updated, at) : transitionLabel(storyboard, index)
      const what = Object.keys(patch).length === 1 && patch.selectedGenerationId ? 'selected a take for' : 'changed'
      return {
        data: {
          ...(at >= 0 ? transitionInfo(updated, at) : { transition_id }),
          ...(notes.length ? { notes } : {})
        },
        summary: `${what} ${label} in ${q(updated.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'preview_transition',
    {
      title: 'Preview a transition',
      description:
        "The two pictures a transition is generated between – its start (the first board's picture) and its end (the next board's picture) – as images, with the boards' notes, the transition's prompt and settings, whether it can be generated (ready, problems) and its price. Look at both pictures before you write the prompt: it should describe how the first becomes the second. Free; changes nothing.",
      input: { transition_id: z.string() },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'looked at a transition'
    },
    async ({ transition_id }) => {
      const { storyboard, index, transition } = await loadTransition(transition_id)
      const images: LabeledImage[] = []
      const { from, to } = boardNumbers(storyboard, transition)
      const side = async (which: 'Start' | 'End', boardId: string, number: number): Promise<Record<string, unknown>> => {
        const board = storyboard.boards.find((b) => b.id === boardId)
        if (!board?.imagePath) return { board_number: number, image: null, note: board?.note ?? '' }
        const image = await imageBlock(board.imagePath)
        if (image) {
          images.push({
            label: `${which}: board ${number}${board.note.trim() ? ` – "${excerpt(board.note, 120)}"` : ''}`,
            image
          })
        }
        return { board_number: number, note: board.note, ...(image ? {} : { picture_note: 'The picture could not be read.' }) }
      }
      const start = await side('Start', transition.fromBoardId, from)
      const end = await side('End', transition.toBoardId, to)
      const price = transition.ready ? await quote(transition.params) : undefined
      return {
        data: {
          ...transitionInfo(storyboard, index),
          start,
          end,
          ...(transition.ready ? { price_usd: priceValue(price) } : {})
        },
        images,
        summary: `looked at ${transitionLabel(storyboard, index)} in ${q(storyboard.name)}${transition.ready ? ` (${usd(price)})` : ''}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'convert_storyboard_to_sequence',
    {
      title: 'Convert storyboard to a sequence',
      description:
        "Makes a new ordinary sequence from a storyboard, named after it: one clip per transition, in order, each with the transition's selected take as its take (the same settings), so the user can go on editing the film in Sequences (trims, more clips, continuations). The storyboard itself stays as it is. Free. Returns the new sequence (see get_sequence).",
      input: { storyboard_id: z.string() },
      annotations: WRITE,
      summary: () => 'turned a storyboard into a sequence'
    },
    async ({ storyboard_id }) => {
      const storyboard = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(storyboard)
      if (!storyboard.transitions.length) {
        throw new Error('The storyboard has no transitions yet (it needs at least two boards), so there is nothing to make a sequence of.')
      }
      const { sequenceId } = await callService<{ sequenceId: string }>('storyboards:toSequence', storyboard.id)
      const sequence = await callService<Sequence>('sequences:get', sequenceId)
      const withoutTake = sequence.segments.flatMap((s, i) =>
        isUsableTake(s.selectedGenerationId ? s.takes.find((t) => t.id === s.selectedGenerationId) : undefined) ? [] : [i + 1]
      )
      return {
        data: {
          sequence_id: sequence.id,
          name: sequence.name,
          clip_count: sequence.segments.length,
          ...(withoutTake.length ? { clips_without_finished_take: withoutTake } : {}),
          next: 'get_sequence shows the clips; the sequence tools (update_segment, add_segment …) work on it.'
        },
        summary: `turned the storyboard ${q(storyboard.name)} into the sequence ${q(sequence.name)}`
      }
    }
  )
}
