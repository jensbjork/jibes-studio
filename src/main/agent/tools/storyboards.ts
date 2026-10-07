import { existsSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { kindOfModelId, supportsEndImage } from '@shared/models'
import { findAudioTokens, findImageTokens } from '@shared/prompt-refs'
import {
  STORYBOARD_ASPECT_RATIOS,
  type BoardImageSource,
  type Generation,
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
import { isUsableTake } from './sequences'

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
  if (!kind) throw new Error('Det finns ingen storyboard med det id:t. list_storyboards visar vilka som finns.')
  if (kind !== 'storyboard') {
    throw new Error('Det här är en sekvens, inte en storyboard. Använd get_sequence (list_sequences visar sekvenserna).')
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
      'Det här är ett klipp i en sekvens, inte en övergång i en storyboard. Använd update_segment och request_segment_generation (get_sequence visar klippen).'
    )
  }
  const storyboard = await callService<Storyboard>('storyboards:get', row.sequence_id)
  const index = storyboard.transitions.findIndex((t) => t.id === transitionId)
  if (index < 0) throw new Error(TRANSITION_GONE)
  return { storyboard, index, transition: storyboard.transitions[index] }
}

const TRANSITION_GONE =
  'Övergången finns inte längre (rutorna kan ha flyttats eller tagits bort). get_storyboard visar storyboardens övergångar som de är nu.'

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

const BOARD_GONE = 'Det finns ingen ruta med det id:t (längre). get_storyboard visar storyboardens rutor.'

/**
 * Nothing in a storyboard is changed by an agent while "Generera saknade" runs for it: the run reads the
 * transitions as it goes, so a change made meanwhile would be paid for without the user having seen it.
 */
export function assertStoryboardIdle(storyboard: Storyboard): void {
  if (storyboard.running) {
    throw new Error(
      `”Generera saknade” pågår för storyboarden ${q(storyboard.name)}. Vänta tills körningen är klar (eller be användaren stoppa den) innan du ändrar den.`
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

/** "övergång 2 (ruta 2 → 3)", for messages and the activity log. */
export function transitionLabel(storyboard: Storyboard, index: number): string {
  const { from, to } = boardNumbers(storyboard, storyboard.transitions[index])
  return `övergång ${index + 1} (ruta ${from || '?'} → ${to || '?'})`
}

/** The boards a transition needs a picture in, by number ("ruta 2 och 3"). */
export function missingImagesText(storyboard: Storyboard, t: StoryboardTransition): string {
  const empty = [t.fromBoardId, t.toBoardId]
    .map((id) => storyboard.boards.findIndex((b) => b.id === id))
    .filter((i) => i >= 0 && !storyboard.boards[i].imagePath)
    .map((i) => i + 1)
  if (!empty.length) return 'rutornas bilder saknas'
  return empty.length === 1 ? `ruta ${empty[0]} har ingen bild än` : `ruta ${empty[0]} och ${empty[1]} har inga bilder än`
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
 * What stops a transition from being generated as it stands (Swedish): the storyboard service's problems (a board
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
    selected_take: take
      ? {
          generation_id: take.id,
          status: take.status,
          ...(take.error ? { error: take.error } : {}),
          ...(take.videoDuration !== undefined ? { video_seconds: seconds(take.videoDuration) } : {}),
          ...(take.fileMissing ? { file_missing: true } : {}),
          ...(take.rating ? { rating: take.rating } : {}),
          // Made before a board's picture changed: it doesn't go from today's picture to today's picture.
          ...(t.staleTake ? { made_from_earlier_pictures: true } : {})
        }
      : null,
    takes: t.takes.slice(0, LISTED_TAKES).map((g) => ({
      generation_id: g.id,
      status: g.status,
      created: localTime(g.createdAt),
      ...(g.id === t.selectedGenerationId ? { selected: true } : {}),
      ...(g.rating ? { rating: g.rating } : {}),
      ...(g.reviewCount ? { review_count: g.reviewCount } : {})
    })),
    take_count: t.takes.length,
    ...(renderingTakeOf(t) ? { rendering: true } : {})
  }
}

/** The whole storyboard as the tools show it. */
export function storyboardInfo(storyboard: Storyboard, assets: AssetIndex, stills: StillIndex): Record<string, unknown> {
  const missing = storyboard.transitions.flatMap((t, i) => (transitionDone(t) ? [] : [i + 1]))
  return {
    storyboard_id: storyboard.id,
    name: storyboard.name,
    aspect_ratio: storyboard.aspectRatio,
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
    if (image) images.push({ label: `Board ${i + 1}${board.note.trim() ? ` – ”${excerpt(board.note, 80)}”` : ''}`, image })
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
  z.object({ generation_id: z.string(), time: z.number().min(0) }).strict()
])

type BoardImageInput = z.infer<typeof boardImageInput>

const BOARD_IMAGE_HELP =
  '{still_id} (a still, list_stills – e.g. one made with request_image_generation), {asset_image_id} (a library photo, used where it is) or {generation_id, time} (that frame of a finished clip – the frame review_generation and get_frames show for that time – saved as a still of the storyboard).'

/**
 * The picture an input names, checked before anything is changed (the still, the photo, the finished clip and
 * its file exist). A frame is named by the moment it starts, which is how the stills service picks it.
 */
async function boardImageSource(input: BoardImageInput, assets: AssetIndex, stills: StillIndex): Promise<BoardImageSource> {
  if ('still_id' in input) {
    const still = stills.require(input.still_id)
    if (!existsSync(still.path)) throw new Error('Stillbildens fil finns inte längre på disken.')
    return { kind: 'still', stillId: still.id }
  }
  if ('asset_image_id' in input) {
    const photo = assets.requireImage(input.asset_image_id)
    return { kind: 'asset-image', imageId: photo.imageId }
  }
  const g = db.getGeneration(input.generation_id)
  if (!g) throw new Error(`Det finns ingen generering med id ${input.generation_id}.`)
  if (g.status !== 'completed' || !g.filePath || !existsSync(g.filePath)) {
    throw new Error('Genereringen har ingen färdig video att ta en bildruta ur.')
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
    throw new Error(`Bildformatet ${ratio} går inte för en storyboard. Välj något av: ${STORYBOARD_ASPECT_RATIOS.join(', ')}.`)
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
  'Övergångar mellan rutor som inte längre ligger bredvid varandra togs bort. Deras tagningar finns kvar som vanliga genereringar (list_generations). Nya övergångar har tom prompt: skriv dem med update_transition.'

/** The transitions that touch a board, as the tools show them. */
function touching(storyboard: Storyboard, boardId: string): Record<string, unknown>[] {
  return storyboard.transitions.flatMap((t, i) =>
    t.fromBoardId === boardId || t.toBoardId === boardId ? [transitionInfo(storyboard, i)] : []
  )
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
      summary: () => 'listade alla storyboards'
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
        "One storyboard: its aspect ratio, its boards in order – each with its note (\"Vad visar bilden?\") and its picture (a still or a library photo, null for an empty board; aspect_mismatch when the picture's format differs from the storyboard's) – and its transitions: transition N goes from board N's picture to board N+1's picture. Each transition has its prompt (\"Vad händer?\": the motion from the first picture to the second), model (an image-to-video model that takes an end image), duration, resolution, audio, ready (both boards have pictures and it can be generated), problems, its takes (newest first) and selected take (made_from_earlier_pictures when a board's picture changed after it was made). With include_images (default true) the boards' pictures and the selected takes' poster frames come as images. Free; changes nothing.",
      input: {
        storyboard_id: z.string(),
        include_images: z.boolean().default(true)
      },
      annotations: { ...READ_ONLY, idempotentHint: true },
      summary: () => 'tittade på en storyboard'
    },
    async ({ storyboard_id, include_images }) => {
      const storyboard = await loadStoryboard(storyboard_id)
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const pictures = include_images ? await storyboardImages(storyboard) : { images: [] }
      return {
        data: { ...storyboardInfo(storyboard, assets, stills), ...(pictures.note ? { note: pictures.note } : {}) },
        images: pictures.images,
        summary: `tittade på storyboarden ${q(storyboard.name)}`
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
        `Creates a storyboard: a film planned as milestone pictures (boards) with a transition clip generated between every two neighbouring boards. It starts with two empty boards; board_notes sets the boards' notes in order ("Vad visar bilden?": what the picture shows – one milestone of the film each) and adds boards until there is one per note. aspect_ratio (default 16:9) is one of ${STORYBOARD_ASPECT_RATIOS.join(', ')}; the pictures are made in it. Next: a picture per board (request_image_generation with assign_to: {board_id}, or add_board / update_board with an existing picture), then a prompt per transition (update_transition).`,
      input: {
        name: z.string().min(1).max(120).describe('e.g. "Morgon vid havet".'),
        aspect_ratio: z.string().optional().describe(`One of ${STORYBOARD_ASPECT_RATIOS.join(', ')}; default 16:9.`),
        board_notes: z
          .array(z.string().max(2000))
          .max(40)
          .optional()
          .describe('One note per board, in order: what each milestone picture shows (any language).')
      },
      annotations: WRITE,
      summary: ({ name }) => `skapade storyboarden ${q(name)}`
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
        summary: `skapade storyboarden ${q(storyboard.name)} med ${storyboard.boards.length} rutor`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'update_storyboard',
    {
      title: 'Update storyboard',
      description: `Renames a storyboard (its folder follows) and/or changes its aspect ratio (${STORYBOARD_ASPECT_RATIOS.join(', ')}): new pictures are made in it; boards whose picture has another format are marked aspect_mismatch. Only the fields you pass change.`,
      input: {
        storyboard_id: z.string(),
        name: z.string().min(1).max(120).optional(),
        aspect_ratio: z.string().optional()
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: () => 'ändrade en storyboard'
    },
    async ({ storyboard_id, name, aspect_ratio }) => {
      const before = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(before)
      const ratio = storyboardRatio(aspect_ratio)
      if (name === undefined && ratio === undefined) throw new Error('Ange name eller aspect_ratio – annars finns inget att ändra.')
      const storyboard = await callService<Storyboard>('storyboards:update', before.id, {
        ...(name !== undefined ? { name } : {}),
        ...(ratio !== undefined ? { aspectRatio: ratio } : {})
      })
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const mismatched = storyboard.boards.flatMap((b, i) => (b.aspectMismatch ? [i + 1] : []))
      return {
        data: {
          storyboard_id: storyboard.id,
          name: storyboard.name,
          aspect_ratio: storyboard.aspectRatio,
          boards: storyboard.boards.map((_, i) => boardInfo(storyboard, i, assets, stills)),
          ...(mismatched.length
            ? { note: `Boards ${mismatched.join(', ')} have pictures of another format than ${storyboard.aspectRatio}.` }
            : {})
        },
        summary: `ändrade storyboarden ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'add_board',
    {
      title: 'Add board',
      description: `Adds a board (one milestone picture of the film) to a storyboard: at the end, or after after_board_id / before before_board_id. note says what the picture shows ("Vad visar bilden?"). image puts a picture in right away: ${BOARD_IMAGE_HELP} Leave it out to plan first and make the picture later (request_image_generation with assign_to: {board_id}). The transitions around the new board are created with empty prompts (write them with update_transition); a transition that went across the place where the board goes is replaced, and its takes return to the user's feed as ordinary generations.`,
      input: {
        storyboard_id: z.string(),
        after_board_id: z.string().optional(),
        before_board_id: z.string().optional(),
        note: z.string().max(2000).optional(),
        image: boardImageInput.optional().describe(`The board's picture: ${BOARD_IMAGE_HELP}`)
      },
      annotations: WRITE,
      summary: () => 'lade till en ruta'
    },
    async ({ storyboard_id, after_board_id, before_board_id, note, image }) => {
      const before = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(before)
      if (after_board_id && before_board_id) throw new Error('Ange after_board_id eller before_board_id, inte båda.')
      for (const id of [after_board_id, before_board_id]) {
        if (id && !before.boards.some((b) => b.id === id)) throw new Error('Den rutan finns inte i den här storyboarden.')
      }
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const source = image ? await boardImageSource(image, assets, stills) : undefined
      const storyboard = await callService<Storyboard>('boards:add', before.id, {
        ...(after_board_id ? { afterBoardId: after_board_id } : {}),
        ...(before_board_id ? { beforeBoardId: before_board_id } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(source ? { image: source } : {})
      })
      const known = new Set(before.boards.map((b) => b.id))
      const index = storyboard.boards.findIndex((b) => !known.has(b.id))
      // A frame becomes a new still when it is put in.
      const stillsNow = source?.kind === 'frame' ? await StillIndex.load() : stills
      const removed = removedTransitions(before, storyboard)
      return {
        data: {
          ...(index >= 0 ? boardInfo(storyboard, index, assets, stillsNow) : {}),
          board_count: storyboard.boards.length,
          ...(index >= 0 ? { transitions: touching(storyboard, storyboard.boards[index].id) } : {}),
          ...(removed.length ? { removed_transitions: removed, note: REMOVED_NOTE } : {})
        },
        summary: `lade till ruta ${index + 1} i ${q(storyboard.name)}`
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
      summary: () => 'ändrade en ruta'
    },
    async ({ board_id, note, image }) => {
      const { storyboard: before } = await loadBoard(board_id)
      assertStoryboardIdle(before)
      if (note === undefined && image === undefined) throw new Error('Ange note eller image – annars finns inget att ändra.')
      const [assets, stills] = await Promise.all([AssetIndex.load(), StillIndex.load()])
      const source = image ? await boardImageSource(image, assets, stills) : image
      const storyboard = await callService<Storyboard>('boards:update', board_id, {
        ...(note !== undefined ? { note } : {}),
        ...(source !== undefined ? { image: source } : {})
      })
      const index = storyboard.boards.findIndex((b) => b.id === board_id)
      const stillsNow = source?.kind === 'frame' ? await StillIndex.load() : stills
      return {
        data: {
          ...(index >= 0 ? boardInfo(storyboard, index, assets, stillsNow) : { board_id }),
          transitions: touching(storyboard, board_id)
        },
        summary: `ändrade ruta ${index + 1} i ${q(storyboard.name)}`
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
        'Moves a board to another place in its storyboard. to_board_number is the 1-based number it should have afterwards. Transitions between boards that are no longer neighbours are removed (their takes return to the user\'s feed as ordinary generations) and new ones, with empty prompts, join the new neighbours; transitions between boards that stay neighbours keep their prompt and takes.',
      input: {
        board_id: z.string(),
        to_board_number: z.number().int().min(1)
      },
      annotations: { ...WRITE, idempotentHint: true },
      summary: ({ to_board_number }) => `flyttade en ruta till plats ${to_board_number}`
    },
    async ({ board_id, to_board_number }) => {
      const { storyboard: before, index: from } = await loadBoard(board_id)
      assertStoryboardIdle(before)
      const to = Math.min(to_board_number, before.boards.length) - 1
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
        summary: `flyttade ruta ${from + 1} till plats ${storyboard.boards.findIndex((b) => b.id === board_id) + 1} i ${q(storyboard.name)}`
      }
    }
  )

  defineTool(
    server,
    ctx,
    'delete_board',
    {
      title: 'Delete board',
      description:
        "Removes a board from its storyboard. The transitions to and from it are removed (their takes return to the user's feed as ordinary generations) and its neighbours get a new transition between them, with an empty prompt. The board's picture stays among the storyboard's stills (or in the library, for a library photo).",
      input: { board_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      summary: () => 'tog bort en ruta'
    },
    async ({ board_id }) => {
      const { storyboard: before, index } = await loadBoard(board_id)
      assertStoryboardIdle(before)
      const storyboard = await callService<Storyboard>('boards:delete', board_id)
      const removed = removedTransitions(before, storyboard)
      return {
        data: {
          deleted: board_id,
          board_count: storyboard.boards.length,
          transition_count: storyboard.transitions.length,
          ...(removed.length ? { removed_transitions: removed, note: REMOVED_NOTE } : {})
        },
        summary: `tog bort ruta ${index + 1} i ${q(storyboard.name)}`
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
        "Changes a transition – the clip from one board's picture to the next board's picture. Only the fields you pass change. prompt (\"Vad händer?\") describes the motion that leads from the first picture to the second within the duration: who moves where, what the camera does; image-to-video, so no @ tokens – name people in words. model must be an image-to-video model that takes an end image (list_models; Seedance image-to-video by default). duration, resolution and audio must be ones the model offers. selected_take_id chooses which of its finished takes is the transition's take (in the preview, the export and a conversion to a sequence). negative_prompt: empty string clears it. Generating is request_transition_generation.",
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
      summary: () => 'ändrade en övergång'
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
            'En övergång genereras från två bilder (bild-till-video) och skickar inga referenser, så prompten kan inte ha @-referenser. Beskriv i ord vad som händer mellan bilderna.'
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
        if (!models) throw new Error('Modellistan kunde inte hämtas från Venice just nu, så modellen kan inte bytas. Försök igen om en stund.')
        const m = requireModel(models, model)
        if (kindOfModelId(m.id) !== 'image-to-video' || !supportsEndImage(m.id)) {
          const fitting = usableModels(models)
            .filter((x) => x.kind === 'image-to-video' && supportsEndImage(x.id))
            .map((x) => x.id)
          throw new Error(
            `${m.name} kan inte göra en övergång: den behöver vara en bild-till-video-modell som tar en slutbild.${fitting.length ? ` Välj någon av: ${fitting.join(', ')}.` : ''}`
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
        if (!take) throw new Error(`Tagningen ${selected_take_id} hör inte till ${transitionLabel(storyboard, index)}.`)
        if (!isUsableTake(take)) throw new Error('Bara en färdig tagning (med sin video kvar) kan väljas.')
        patch.selectedGenerationId = take.id
      }
      if (!Object.keys(patch).length) throw new Error('Ange något att ändra (prompt, duration, resolution, audio, model eller selected_take_id).')
      if (outputGiven && !listed) {
        notes.push('Modellistan kunde inte hämtas, så längd, upplösning och ljud kontrolleras först när övergången genereras.')
      }
      const updated = await callService<Storyboard>('transitions:update', transition.id, patch)
      const at = updated.transitions.findIndex((t) => t.id === transition.id)
      const label = at >= 0 ? transitionLabel(updated, at) : transitionLabel(storyboard, index)
      const what = Object.keys(patch).length === 1 && patch.selectedGenerationId ? 'valde en tagning för' : 'ändrade'
      return {
        data: {
          ...(at >= 0 ? transitionInfo(updated, at) : { transition_id }),
          ...(notes.length ? { notes } : {})
        },
        summary: `${what} ${label} i ${q(updated.name)}`
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
      summary: () => 'tittade på en övergång'
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
            label: `${which}: board ${number}${board.note.trim() ? ` – ”${excerpt(board.note, 120)}”` : ''}`,
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
        summary: `tittade på ${transitionLabel(storyboard, index)} i ${q(storyboard.name)}${transition.ready ? ` (${usd(price)})` : ''}`
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
        "Makes a new ordinary sequence from a storyboard, named \"<storyboard> (sekvens)\": one clip per transition, in order, each with the transition's selected take as its take (the same settings), so the user can go on editing the film in Sekvenser (trims, more clips, continuations). The storyboard itself stays as it is. Free. Returns the new sequence (see get_sequence).",
      input: { storyboard_id: z.string() },
      annotations: WRITE,
      summary: () => 'gjorde om en storyboard till en sekvens'
    },
    async ({ storyboard_id }) => {
      const storyboard = await loadStoryboard(storyboard_id)
      assertStoryboardIdle(storyboard)
      if (!storyboard.transitions.length) {
        throw new Error('Storyboarden har inga övergångar än (den behöver minst två rutor), så det finns inget att göra en sekvens av.')
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
        summary: `gjorde om storyboarden ${q(storyboard.name)} till sekvensen ${q(sequence.name)}`
      }
    }
  )
}
