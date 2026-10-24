// Storyboards: a film planned as milestones — one image per board, each with a short note — and the
// transitions between them: the clip that goes from one board's image to the next one's (`image_url` →
// `end_image_url`).
// It is a workflow of its own next to Sequences, but underneath a storyboard is a row of `sequences` of kind
// 'storyboard' whose segments are its transitions, so takes, folders (Storyboards/<name>/Transitions/ and Images/),
// approvals and the export are the sequence service's. What is its own lives here: the boards, keeping one
// transition between every two adjacent boards (syncTransitions), the transitions' settings, "Generate missing"
// (each transition is independent, so they are sent one after another without waiting for each to render), the
// export's dedupe rule and "Convert to sequence".

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  audioForModel,
  DEFAULT_MODEL,
  DEFAULT_PARAMS,
  endImageVariant,
  kindOfModelId,
  paramsForSubmit,
  pickOption,
  PREFERRED,
  supportsEndImage
} from '@shared/models'
import { isVeniceGeneration } from '@shared/generation-label'
import { blockingPromptError } from '@shared/prompt-refs'
import { activeProvider, providerName } from '@shared/provider'
import {
  DEFAULT_STORYBOARD_ASPECT_RATIO,
  STORYBOARD_ASPECT_RATIOS,
  type BoardImageSource,
  type Generation,
  type GenerationParams,
  type Storyboard,
  type StoryboardBoard,
  type StoryboardSummary,
  type StoryboardTransition,
  type TransitionPatch,
  type VideoModel
} from '@shared/types'
import { isAgentCall } from './agent/local-ipc'
import { assertRunWithinBudget, confirmedOf, quoteTotal, runConfirmed } from './budget'
import * as db from './db'
import { checkedDirectorId, libraryDirector } from './directors'
import { probe } from './ffmpeg'
import { ratioOf } from './images'
import { jpegOrientation } from './input-image'
import { fromStoredPath, toStoredPath } from './paths'
import { repeatsBoardImage } from './sequence-export'
import * as store from './sequence-store'
import {
  isCancelledSubmit,
  runFailureText,
  type SequenceService,
  type StillsAccess,
  type SubmitGuard
} from './sequences'
import { assertAgentFiles } from './upload-paths'
import { sendOptionsOf, type SendOptions } from './variants'

// The formats a storyboard can have live in the shared types (the window offers them too); re-exported for main.
export { DEFAULT_STORYBOARD_ASPECT_RATIO, STORYBOARD_ASPECT_RATIOS }

/**
 * What a new transition is made with: Seedance's image-to-video model, which takes a start and an end image, a
 * 5-second clip at 480p with sound. No aspect ratio: a clip from a picture takes the picture's shape. A storyboard
 * keeps these as its `defaults` and remembers the settings last chosen for a transition there, so the next new
 * transition gets them too.
 */
export const TRANSITION_DEFAULTS: Readonly<Partial<GenerationParams>> = {
  model: DEFAULT_MODEL['image-to-video'],
  duration: '5s',
  resolution: '480p',
  audio: true
}

/** How far a board image's shape may be from the storyboard's before the board says so (image models round). */
const ASPECT_TOLERANCE = 0.03

/** How long changing a transition's model waits for the model list before it goes by the model id alone. */
const MODELS_TIMEOUT_MS = 5000

/** Image files a board takes. */
const IMAGE_FILE = /\.(jpe?g|png|webp)$/i

const STORYBOARD_GONE = 'The storyboard no longer exists.'
const BOARD_GONE = 'The board no longer exists.'
const TRANSITION_GONE = 'The transition no longer exists – the boards around it may have changed.'
const NOT_A_TRANSITION =
  'This is a clip in a sequence, not a transition in a storyboard. Change it under Sequences.'

// ── Rows ─────────────────────────────────────────────────────────────────────

/** A row of storyboard_boards (image_path in stored form). */
export interface BoardRow {
  id: string
  sequence_id: string
  position: number
  image_path: string | null
  still_id: string | null
  note: string
  created_at: number
  updated_at: number
}

const conn = (): ReturnType<typeof db.getDb> => db.getDb()

/** The storyboard's boards in order. */
export function listBoardRows(storyboardId: string): BoardRow[] {
  return conn()
    .prepare('SELECT * FROM storyboard_boards WHERE sequence_id = ? ORDER BY position, created_at, id')
    .all(storyboardId) as BoardRow[]
}

export function getBoardRow(id: string): BoardRow | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return conn().prepare('SELECT * FROM storyboard_boards WHERE id = ?').get(id) as BoardRow | undefined
}

function requireBoardRow(id: string): BoardRow {
  const row = getBoardRow(id)
  if (!row) throw new Error(BOARD_GONE)
  return row
}

/** A storyboard (not a sequence). */
export function requireStoryboardRow(id: string): store.SequenceRow {
  const row = typeof id === 'string' ? store.getSequenceRow(id) : undefined
  if (!row) throw new Error(STORYBOARD_GONE)
  if (store.kindOf(row) !== 'storyboard') throw new Error(store.IS_SEQUENCE)
  return row
}

/** A transition: a segment of a storyboard. */
export function requireTransitionRow(id: string): { row: store.SegmentRow; storyboard: store.SequenceRow } {
  const row = typeof id === 'string' ? store.getSegmentRow(id) : undefined
  if (!row) throw new Error(TRANSITION_GONE)
  const storyboard = store.getSequenceRow(row.sequence_id)
  if (!storyboard) throw new Error(STORYBOARD_GONE)
  if (store.kindOf(storyboard) !== 'storyboard') throw new Error(NOT_A_TRANSITION)
  return { row, storyboard }
}

/** The storyboard's aspect ratio (16:9 for a row without one). */
function aspectOf(row: store.SequenceRow): string {
  return row.aspect_ratio || DEFAULT_STORYBOARD_ASPECT_RATIO
}

function checkAspectRatio(value: unknown): string {
  const ratio = typeof value === 'string' ? value.trim() : ''
  if (!(STORYBOARD_ASPECT_RATIOS as readonly string[]).includes(ratio)) {
    throw new Error(`Choose an aspect ratio: ${STORYBOARD_ASPECT_RATIOS.join(', ')}.`)
  }
  return ratio
}

const cleanNote = (value: unknown): string => (typeof value === 'string' ? value : '')

const boardImage = (row: Pick<BoardRow, 'image_path'> | undefined): string | undefined =>
  row?.image_path ? fromStoredPath(row.image_path) : undefined

/** Two picture paths name the same file (letter case and Unicode form ignored, like the disk). */
function samePicture(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()
}

/** Writes positions 0..n−1 in the given order. */
function renumberBoards(orderedIds: readonly string[]): void {
  const update = conn().prepare('UPDATE storyboard_boards SET position = ? WHERE id = ? AND position != ?')
  orderedIds.forEach((id, i) => update.run(i, id, i))
}

function insertBoard(storyboardId: string, position: number, fields: { note?: string; image?: ResolvedImage }): string {
  const id = randomUUID()
  const now = Date.now()
  conn()
    .prepare(
      `INSERT INTO storyboard_boards (id, sequence_id, position, image_path, still_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      storyboardId,
      position,
      fields.image ? toStoredPath(fields.image.path) : null,
      fields.image?.stillId ?? null,
      cleanNote(fields.note),
      now,
      now
    )
  return id
}

// ── Transitions ──────────────────────────────────────────────────────────────

/**
 * A transition's params with its two board images: generated image-to-video by a model that takes an end image, so
 * there are no reference images or audio to send. Everything else (prompt, duration, resolution, audio, model) is
 * the transition's own.
 */
function withBoardImages(
  params: GenerationParams,
  startImage: string | undefined,
  endImage: string | undefined
): GenerationParams {
  const model =
    supportsEndImage(params.model) && kindOfModelId(params.model) === 'image-to-video'
      ? params.model
      : endImageVariant(params.model)
  return { ...params, model, startImage, endImage, referenceImages: undefined, referenceAudios: undefined }
}

/** The params a new transition of this storyboard starts with (its remembered defaults). */
function newTransitionParams(storyboard: store.SequenceRow): GenerationParams {
  return store.sanitizeParams({ ...TRANSITION_DEFAULTS, ...store.parseDefaults(storyboard.defaults), prompt: '' })
}

const pairKey = (from: string, to: string): string => `${from}→${to}`

/**
 * The storyboard's board ids in the order moving `board` to `toIndex` gives (0-based, clamped; anything but a number
 * leaves it where it is). moveBoard writes this order; moveLoss reads what it would remove.
 */
function movedOrder(boards: readonly BoardRow[], board: BoardRow, toIndex: unknown): string[] {
  const order = boards.map((b) => b.id).filter((id) => id !== board.id)
  const wanted = typeof toIndex === 'number' && Number.isFinite(toIndex) ? Math.round(toIndex) : board.position
  order.splice(Math.min(Math.max(0, wanted), order.length), 0, board.id)
  return order
}

/**
 * The storyboard's transitions whose two boards would no longer be neighbours with the boards in `order` (what
 * syncTransitions then deletes, with their prompt and settings; their takes become ordinary generations). Read-only.
 */
function transitionsLostIn(storyboardId: string, order: readonly string[]): LostTransition[] {
  const kept = new Set(order.slice(1).map((to, i) => pairKey(order[i], to)))
  const takes = conn().prepare('SELECT COUNT(*) FROM generations WHERE segment_id = ?').pluck()
  return store.listSegmentRows(storyboardId).flatMap((row, i): LostTransition[] => {
    if (!row.from_board_id || !row.to_board_id || kept.has(pairKey(row.from_board_id, row.to_board_id))) return []
    const params = store.parseParams(row.params)
    return [
      {
        id: row.id,
        number: i + 1,
        prompt: params.prompt,
        ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
        takeCount: takes.get(row.id) as number,
        selected: !!row.selected_generation_id
      }
    ]
  })
}

/**
 * An agent never removes a transition with a prompt, a negative prompt or takes on its own: a board put between two
 * boards or moved elsewhere that would drop one is refused (the user approves such a move through request_delete,
 * whose call isn't an agent's). The tools check first; this check runs inside the change's transaction, so a prompt
 * the user writes in between can't slip through.
 */
function refuseAgentLoss(lost: readonly LostTransition[], caller: Caller): void {
  if (!caller.byAgent) return
  const numbers = lost
    .filter((t) => t.prompt.trim() !== '' || !!t.negativePrompt?.trim() || t.takeCount > 0)
    .map((t) => t.number)
  if (!numbers.length) return
  const which =
    numbers.length === 1
      ? `transition ${numbers[0]}`
      : `transitions ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
  throw new Error(
    `The change removes ${which} with a prompt or takes. Ask for permission with request_delete {board_move: …}, or add the board last.`
  )
}

/**
 * Brings the storyboard's transitions in step with its boards, in one transaction: for every two adjacent boards
 * (b_i, b_i+1) the transition with exactly that pair is kept (with its prompt, settings and takes) or a new one is
 * made with the storyboard's defaults; positions follow the boards; each transition's start and end image are its
 * boards' images. Transitions between boards that are no longer adjacent (a board moved, deleted or put in between)
 * are deleted, and so are their rows' links to their takes: the ids of those takes are returned, for the caller to
 * free them with the usual rules once the transaction is done (SequenceService.freeTakes: their videos go back to
 * Generations; generations are never deleted). Called after every change to the boards.
 */
export function syncTransitions(storyboardId: string): string[] {
  const sql = conn()
  return sql.transaction((): string[] => {
    const storyboard = requireStoryboardRow(storyboardId)
    const boards = listBoardRows(storyboardId)
    renumberBoards(boards.map((b) => b.id))
    const segments = store.listSegmentRows(storyboardId)
    const byPair = new Map<string, store.SegmentRow>()
    for (const segment of segments) {
      if (!segment.from_board_id || !segment.to_board_id) continue
      const key = pairKey(segment.from_board_id, segment.to_board_id)
      // Two for the same pair can't be made here; should a database have them, the oldest is the one kept.
      if (!byPair.has(key)) byPair.set(key, segment)
    }

    const kept = new Set<string>()
    const update = sql.prepare(
      `UPDATE segments SET params = ?, position = ?, continue_from_previous = 0, end_from_next = 0 WHERE id = ?`
    )
    const insert = sql.prepare(
      `INSERT INTO segments (id, sequence_id, position, params, continue_from_previous, end_from_next, notes,
         selected_generation_id, created_at, from_board_id, to_board_id)
       VALUES (?, ?, ?, ?, 0, 0, '', NULL, ?, ?, ?)`
    )
    const now = Date.now()
    for (let i = 0; i + 1 < boards.length; i++) {
      const from = boards[i]
      const to = boards[i + 1]
      const existing = byPair.get(pairKey(from.id, to.id))
      if (existing) {
        kept.add(existing.id)
        const params = store.serializeParams(
          withBoardImages(store.parseParams(existing.params), boardImage(from), boardImage(to))
        )
        const unchanged =
          params === existing.params &&
          existing.position === i &&
          !existing.continue_from_previous &&
          !existing.end_from_next
        if (!unchanged) update.run(params, i, existing.id)
      } else {
        const id = randomUUID()
        const params = withBoardImages(newTransitionParams(storyboard), boardImage(from), boardImage(to))
        insert.run(id, storyboardId, i, store.serializeParams(params), now + i, from.id, to.id)
        kept.add(id)
      }
    }

    const removed = segments.filter((s) => !kept.has(s.id)).map((s) => s.id)
    if (!removed.length) return []
    // Read before the rows go: once the FK has nulled segment_id, nothing says these videos were takes here.
    const freed = store.takeIdsForSegments(removed)
    const remove = sql.prepare('DELETE FROM segments WHERE id = ?')
    for (const id of removed) remove.run(id)
    return freed
  })()
}

/** Ids from IPC: the guard only ever comes from an approval in this process (an IPC message can't carry one). */
function asGuard(value: unknown): SubmitGuard | undefined {
  return typeof value === 'function' ? (value as SubmitGuard) : undefined
}

// ── Picture sizes ────────────────────────────────────────────────────────────

/** Bytes read from the start of a picture: enough for every header, EXIF block included. */
const HEADER_BYTES = 512 * 1024

const sizeCache = new Map<string, { key: string; size?: { width: number; height: number } }>()
const SIZE_CACHE_LIMIT = 500

/**
 * Width and height of a JPEG, PNG or WebP picture as Studio's views show it (a JPEG turned by its EXIF
 * orientation), read from its header and cached by the file's size and change time. Undefined when it can't be
 * told (no file, another format).
 */
export function imageSize(path: string): { width: number; height: number } | undefined {
  let key: string
  try {
    const info = statSync(path)
    key = `${info.size}:${info.mtimeMs}`
  } catch {
    return undefined
  }
  const cached = sizeCache.get(path)
  if (cached?.key === key) return cached.size
  let size: { width: number; height: number } | undefined
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_BYTES)
      const read = readSync(fd, buffer, 0, HEADER_BYTES, 0)
      size = headerSize(buffer.subarray(0, read))
    } finally {
      closeSync(fd)
    }
  } catch {
    size = undefined
  }
  if (sizeCache.size >= SIZE_CACHE_LIMIT) sizeCache.delete(sizeCache.keys().next().value!)
  sizeCache.set(path, { key, size })
  return size
}

/** The size in a picture's header bytes (see imageSize). */
export function headerSize(bytes: Buffer): { width: number; height: number } | undefined {
  const ok = (width: number, height: number): { width: number; height: number } | undefined =>
    width > 0 && height > 0 ? { width, height } : undefined
  // PNG: the IHDR chunk comes first.
  const png = bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47
  if (png && bytes.subarray(12, 16).toString('latin1') === 'IHDR') {
    return ok(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    const chunk = bytes.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8 ') return ok(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21)
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return ok(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
    return undefined
  }
  // JPEG: the first start-of-frame segment, turned by the EXIF orientation.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return undefined
      const marker = bytes[at + 1]
      if (marker === 0xff) {
        at++
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2
        continue
      }
      if (marker === 0xda || marker === 0xd9) return undefined
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        const height = bytes.readUInt16BE(at + 5)
        const width = bytes.readUInt16BE(at + 7)
        return jpegOrientation(bytes) >= 5 ? ok(height, width) : ok(width, height)
      }
      at += 2 + bytes.readUInt16BE(at + 2)
    }
  }
  return undefined
}

/** The picture's shape differs from the aspect ratio by more than the tolerance (unknown sizes never do). */
function aspectMismatch(path: string, aspectRatio: string): boolean {
  const wanted = ratioOf(aspectRatio)
  const size = imageSize(path)
  if (!wanted || !size) return false
  return Math.abs(size.width / size.height / wanted - 1) > ASPECT_TOLERANCE
}

// ── The service ──────────────────────────────────────────────────────────────

/** A picture a board gets: its file, and the still it is when it is one. */
interface ResolvedImage {
  path: string
  stillId?: string
}

/** What the storyboard service needs. */
export interface StoryboardDeps {
  /** Runs the storyboard's takes, folders and export (it is a sequence of kind 'storyboard'). */
  sequences: SequenceService
  /** A storyboard, its boards, transitions or takes changed (broadcast as 'storyboard:change'). */
  notify: (storyboardId: string) => void
  /** Turns picked files and frames into stills of the storyboard (stills.ts). */
  stills: StillsAccess
  /** The video model list (cached in main), for a transition's model and its options. */
  models?: () => Promise<VideoModel[]>
  /** A "Generate missing" run started or stopped: the status summary (work.ts) reads activeRuns() again. */
  workChanged?: () => void
}

/** A transition a board move would remove (StoryboardService.moveLoss), with what goes with it. */
export interface LostTransition {
  id: string
  /** 1-based, as Studio shows it ("Transition 2"). */
  number: number
  prompt: string
  /** Its negative prompt, when it has one (also lost with it). */
  negativePrompt?: string
  takeCount: number
  /** One of its takes is selected (the transition has a take in the film). */
  selected: boolean
}

/** Where a new board goes and what it starts with (StudioApi.addBoard). */
interface BoardInit {
  afterBoardId?: string
  beforeBoardId?: string
  note?: unknown
  image?: BoardImageSource
}

/** Who asked for a change. */
interface Caller {
  /** An agent's tool call (see isAgentCall), not the user in a window. */
  byAgent?: boolean
}

/** One "Generate missing" run. A new run gets a new object, so a superseded loop can tell. */
interface Run {
  running: boolean
  stopped: boolean
  error?: string
  /** Set for a run the user approved through an agent: every take it pays for is checked against the approval. */
  guard?: SubmitGuard
  startedAt: number
  /** Transitions missing a take when it started (more may be found as it goes). */
  total: number
  /** Transitions it has sent to Venice. */
  sent: number
}

/** A transition "Generate missing" would pay for (also what an agent's approval for it shows). */
export interface MissingTransition {
  transitionId: string
  /** 1-based, as Studio shows it ("Transition 2"). */
  number: number
  /** What its take would be sent with. */
  params: GenerationParams
  /** Why it can't be generated as it stands. */
  problem?: string
}

export class StoryboardService {
  private readonly runs = new Map<string, Run>()
  /** Runs whose loop hasn't returned yet; a stopped run's loop may still be sending its current take. */
  private readonly loops = new Set<Run>()

  constructor(private readonly deps: StoryboardDeps) {}

  /** Tells the status summary that a run started or stopped; never throws into the run. */
  private workChanged(): void {
    try {
      this.deps.workChanged?.()
    } catch (err) {
      console.warn('Announcing a change of running work failed:', err)
    }
  }

  /**
   * "Generate missing" runs going on now, for the status summary (work.ts): `sent` of `total` transitions are at
   * Venice. `approved`: started by an agent's request the user approved.
   */
  activeRuns(): { storyboardId: string; startedAt: number; total: number; sent: number; approved?: boolean }[] {
    return [...this.runs]
      .filter(([, run]) => run.running)
      .map(([storyboardId, run]) => ({
        storyboardId,
        startedAt: run.startedAt,
        total: Math.max(run.total, run.sent),
        sent: run.sent,
        ...(run.guard ? { approved: true } : {})
      }))
  }

  /** Why the library can't be switched or tidied right now, or undefined. */
  isBusy(): string | undefined {
    if (this.loops.size || [...this.runs.values()].some((r) => r.running)) {
      return '“Generate missing” is running for a storyboard.'
    }
    return undefined
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  list(): StoryboardSummary[] {
    const rows = conn()
      .prepare(`SELECT * FROM sequences WHERE kind = 'storyboard' ORDER BY updated_at DESC`)
      .all() as store.SequenceRow[]
    if (!rows.length) return []
    const boards = conn()
      .prepare(
        `SELECT b.sequence_id, b.image_path FROM storyboard_boards b JOIN sequences q ON q.id = b.sequence_id
         WHERE q.kind = 'storyboard' ORDER BY b.sequence_id, b.position, b.created_at, b.id`
      )
      .all() as { sequence_id: string; image_path: string | null }[]
    const transitions = conn()
      .prepare(
        `SELECT s.sequence_id, g.status, g.file_path FROM segments s JOIN sequences q ON q.id = s.sequence_id
         LEFT JOIN generations g ON g.id = s.selected_generation_id WHERE q.kind = 'storyboard'`
      )
      .all() as { sequence_id: string; status: string | null; file_path: string | null }[]
    return rows.map((row) => {
      const own = boards.filter((b) => b.sequence_id === row.id)
      const steps = transitions.filter((t) => t.sequence_id === row.id)
      const cover = own.find((b) => b.image_path)?.image_path
      const done = steps.filter((t) => t.status === 'completed' && t.file_path && existsSync(fromStoredPath(t.file_path)))
      return {
        id: row.id,
        name: row.name,
        boardCount: own.length,
        transitionCount: steps.length,
        doneCount: done.length,
        coverPath: cover ? fromStoredPath(cover) : undefined,
        updatedAt: row.updated_at
      }
    })
  }

  get(id: string): Storyboard {
    const row = requireStoryboardRow(id)
    const run = this.runs.get(id)
    const aspectRatio = aspectOf(row)
    const director = store.parseDirector(row.defaults)
    const boardRows = listBoardRows(id)
    const boards: StoryboardBoard[] = boardRows.map((b, i) => {
      const imagePath = boardImage(b)
      return {
        id: b.id,
        position: i,
        ...(imagePath ? { imagePath } : {}),
        ...(b.still_id ? { stillId: b.still_id } : {}),
        note: b.note ?? '',
        ...(imagePath && aspectMismatch(imagePath, aspectRatio) ? { aspectMismatch: true } : {})
      }
    })
    const byId = new Map(boards.map((b) => [b.id, b]))
    // The segments with their takes (and the user's grades on them), as the sequence editor gets them.
    const loaded = store.loadSequence(id, { running: false })
    const rows = store.listSegmentRows(id)
    const transitions = loaded.segments.map((segment, i): StoryboardTransition => {
      const segmentRow = rows.find((r) => r.id === segment.id)
      const from = segmentRow?.from_board_id ? byId.get(segmentRow.from_board_id) : undefined
      const to = segmentRow?.to_board_id ? byId.get(segmentRow.to_board_id) : undefined
      const selected = segment.takes.find((t) => t.id === segment.selectedGenerationId)
      const stale =
        !!selected &&
        (!samePicture(selected.params.startImage, from?.imagePath) ||
          !samePicture(selected.params.endImage, to?.imagePath))
      return {
        id: segment.id,
        position: i,
        fromBoardId: from?.id ?? segmentRow?.from_board_id ?? '',
        toBoardId: to?.id ?? segmentRow?.to_board_id ?? '',
        params: segment.params,
        ...(segment.selectedGenerationId ? { selectedGenerationId: segment.selectedGenerationId } : {}),
        takes: segment.takes,
        ready: !!from?.imagePath && !!to?.imagePath,
        ...(stale ? { staleTake: true } : {}),
        problems: transitionProblems(segment.params, from, to)
      }
    })
    return {
      id: row.id,
      name: row.name,
      aspectRatio,
      boards,
      transitions,
      ...(director ? { director } : {}),
      running: run?.running ?? false,
      ...(run?.error ? { runError: run.error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  // ── Storyboards ────────────────────────────────────────────────────────────

  /** A new storyboard with its folder (Storyboards/<name>/Transitions) and two empty boards, so one transition. */
  async create(name: unknown, aspectRatio?: unknown): Promise<Storyboard> {
    const aspect =
      aspectRatio === undefined || aspectRatio === null ? DEFAULT_STORYBOARD_ASPECT_RATIO : checkAspectRatio(aspectRatio)
    const id = await this.deps.sequences.createRow(typeof name === 'string' ? name : '', {
      kind: 'storyboard',
      defaults: { ...TRANSITION_DEFAULTS },
      aspectRatio: aspect,
      inTransaction: (id) => {
        insertBoard(id, 0, {})
        insertBoard(id, 1, {})
        syncTransitions(id)
      }
    })
    return this.get(id)
  }

  async update(
    id: string,
    patch: { name?: unknown; aspectRatio?: unknown; director?: unknown },
    caller: Caller = {}
  ): Promise<Storyboard> {
    patch = patch ?? {}
    requireStoryboardRow(id)
    this.refuseWhileRunning(id, caller)
    let aspect = patch.aspectRatio === undefined ? undefined : checkAspectRatio(patch.aspectRatio)
    // A director chosen now: its transitions' defaults (an end-image model, the resolution) and its aspect ratio, each
    // only when it can be had; existing transitions keep their settings.
    const director = patch.director === undefined ? undefined : checkedDirectorId(patch.director)
    const before = store.parseDirector(requireStoryboardRow(id).defaults)
    if (director !== undefined && director !== before) {
      const wanted = director ? libraryDirector(director)?.direction.defaults : undefined
      const models = wanted?.model || wanted?.resolution ? await this.modelList() : undefined
      const row = requireStoryboardRow(id)
      this.refuseWhileRunning(id, caller)
      const defaults = { ...TRANSITION_DEFAULTS, ...store.parseDefaults(row.defaults) }
      const model = wanted?.model ? models?.find((m) => m.id === wanted.model) : undefined
      if (model && supportsEndImage(model.id) && kindOfModelId(model.id) === 'image-to-video') {
        Object.assign(defaults, fitToModel({ ...defaults, model: model.id } as GenerationParams, aspectOf(row), model))
      }
      const info = models?.find((m) => m.id === defaults.model)
      if (wanted?.resolution && info?.resolutions.includes(wanted.resolution)) defaults.resolution = wanted.resolution
      const { director: _, ...rest } = JSON.parse(store.withStoredExtras(defaults, row.defaults)) as Record<string, unknown>
      conn()
        .prepare('UPDATE sequences SET defaults = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(director ? { ...rest, director } : rest), Date.now(), id)
      if (
        aspect === undefined &&
        wanted?.aspectRatio &&
        wanted.aspectRatio !== aspectOf(row) &&
        (STORYBOARD_ASPECT_RATIOS as readonly string[]).includes(wanted.aspectRatio)
      ) {
        aspect = wanted.aspectRatio
      }
    }
    if (aspect !== undefined) {
      const models = await this.modelList()
      requireStoryboardRow(id)
      this.refuseWhileRunning(id, caller)
      conn().transaction(() => {
        conn().prepare('UPDATE sequences SET aspect_ratio = ?, updated_at = ? WHERE id = ?').run(aspect, Date.now(), id)
        // A model with formats of its own (most take the picture's) follows the storyboard's.
        for (const row of store.listSegmentRows(id)) {
          const params = store.parseParams(row.params)
          const fitted = fitAspect(params, aspect, models)
          const json = store.serializeParams(fitted)
          if (json !== row.params) conn().prepare('UPDATE segments SET params = ? WHERE id = ?').run(json, row.id)
        }
      })()
    }
    // The name goes through the sequence service, which renames the folder (now, or once nothing writes into it).
    if (patch.name !== undefined) {
      await this.deps.sequences.update(id, { name: typeof patch.name === 'string' ? patch.name : '' })
    }
    this.changed(id)
    return this.get(id)
  }

  /**
   * Deletes the storyboard: its takes become ordinary generations (videos back to Generations), stills that
   * generations, clips or other boards still use are kept in Reference images, the rest go to the Trash; exports stay.
   */
  async delete(id: string): Promise<void> {
    const row = typeof id === 'string' ? store.getSequenceRow(id) : undefined
    if (!row) return
    if (store.kindOf(row) !== 'storyboard') throw new Error(store.IS_SEQUENCE)
    this.stop(id, false)
    this.runs.delete(id)
    await this.deps.sequences.delete(id)
    this.deps.notify(id)
  }

  // ── Boards ─────────────────────────────────────────────────────────────────

  async addBoard(storyboardId: string, init: BoardInit = {}, caller: Caller = {}): Promise<Storyboard> {
    init = init ?? {}
    requireStoryboardRow(storyboardId)
    this.refuseWhileRunning(storyboardId, caller)
    // The anchor is checked before a file is copied or a frame saved for a board that couldn't be placed.
    this.insertIndex(storyboardId, init)
    const mark = db.rewriteMark()
    const image = init.image ? await this.resolveImage(storyboardId, init.image) : undefined

    requireStoryboardRow(storyboardId)
    this.refuseWhileRunning(storyboardId, caller)
    const placed = image && { ...image, path: followImage(image.path, mark) }
    const freed = conn().transaction(() => {
      const index = this.insertIndex(storyboardId, init)
      const order = listBoardRows(storyboardId).map((b) => b.id)
      // A board put between two boards replaces the transition between them (checked before anything is written).
      refuseAgentLoss(transitionsLostIn(storyboardId, order.toSpliced(index, 0, '')), caller)
      order.splice(index, 0, insertBoard(storyboardId, order.length, { note: cleanNote(init.note), image: placed }))
      renumberBoards(order)
      return syncTransitions(storyboardId)
    })()
    return this.settle(storyboardId, freed)
  }

  /** Where a new board goes: after or before the named board, else at the end. */
  private insertIndex(storyboardId: string, init: { afterBoardId?: string; beforeBoardId?: string }): number {
    const boards = listBoardRows(storyboardId)
    const anchor = init.afterBoardId ?? init.beforeBoardId
    if (!anchor) return boards.length
    const i = boards.findIndex((b) => b.id === anchor)
    if (i < 0) throw new Error(BOARD_GONE)
    return init.afterBoardId ? i + 1 : i
  }

  /** A new note and/or image (null empties the board); the neighbouring transitions get the new image. */
  async updateBoard(
    boardId: string,
    patch: { note?: unknown; image?: BoardImageSource | null },
    caller: Caller = {}
  ): Promise<Storyboard> {
    patch = patch ?? {}
    const before = requireBoardRow(boardId)
    this.refuseWhileRunning(before.sequence_id, caller)
    const mark = db.rewriteMark()
    const image = patch.image ? await this.resolveImage(before.sequence_id, patch.image) : undefined

    const board = requireBoardRow(boardId)
    this.refuseWhileRunning(board.sequence_id, caller)
    const freed = conn().transaction(() => {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.note !== undefined) {
        sets.push('note = ?')
        values.push(cleanNote(patch.note))
      }
      if (patch.image === null) {
        sets.push('image_path = NULL', 'still_id = NULL')
      } else if (image) {
        sets.push('image_path = ?', 'still_id = ?')
        values.push(toStoredPath(followImage(image.path, mark)), image.stillId ?? null)
      }
      if (!sets.length) return []
      conn()
        .prepare(`UPDATE storyboard_boards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, Date.now(), board.id)
      return syncTransitions(board.sequence_id)
    })()
    return this.settle(board.sequence_id, freed)
  }

  /** Moves the board to `toIndex`; transitions between boards no longer adjacent go, new pairs get new ones. */
  async moveBoard(boardId: string, toIndex: unknown, caller: Caller = {}): Promise<Storyboard> {
    const board = requireBoardRow(boardId)
    this.refuseWhileRunning(board.sequence_id, caller)
    const freed = conn().transaction(() => {
      const order = movedOrder(listBoardRows(board.sequence_id), board, toIndex)
      refuseAgentLoss(transitionsLostIn(board.sequence_id, order), caller)
      renumberBoards(order)
      return syncTransitions(board.sequence_id)
    })()
    return this.settle(board.sequence_id, freed)
  }

  /**
   * The transitions moving the board to `toIndex` would remove, without moving it: those between boards that would no
   * longer be neighbours (syncTransitions deletes them, with their prompt and settings; their takes become ordinary
   * generations). Read-only; an agent's move_board and a delete approval's board move ask it first.
   */
  moveLoss(boardId: string, toIndex: unknown): { transitions: LostTransition[] } {
    const board = requireBoardRow(boardId)
    return { transitions: transitionsLostIn(board.sequence_id, movedOrder(listBoardRows(board.sequence_id), board, toIndex)) }
  }

  /** Removes the board; one transition between its neighbours replaces its two. Its picture stays a still. */
  async deleteBoard(boardId: string, caller: Caller = {}): Promise<Storyboard> {
    const board = requireBoardRow(boardId)
    this.refuseWhileRunning(board.sequence_id, caller)
    const freed = conn().transaction(() => {
      conn().prepare('DELETE FROM storyboard_boards WHERE id = ?').run(board.id)
      return syncTransitions(board.sequence_id)
    })()
    return this.settle(board.sequence_id, freed)
  }

  /**
   * The picture for a board: a library photo or a still where it is, a file or a frame as a new still of the
   * storyboard (in Storyboards/<name>/Images/). Plain errors.
   */
  private async resolveImage(storyboardId: string, source: BoardImageSource): Promise<ResolvedImage> {
    if (!source || typeof source !== 'object') throw new Error('Unknown kind of image.')
    let image: ResolvedImage
    switch (source.kind) {
      case 'asset-image': {
        const id = typeof source.imageId === 'string' ? source.imageId : ''
        const stored = conn().prepare('SELECT file_path FROM asset_images WHERE id = ?').pluck().get(id) as
          | string
          | undefined
        if (!stored) throw new Error('The image no longer exists in the library.')
        image = { path: fromStoredPath(stored) }
        break
      }
      case 'still': {
        const still = store.getStillRow(source.stillId)
        if (!still) throw new Error('The still image no longer exists.')
        image = { path: fromStoredPath(still.file_path), stillId: still.id }
        break
      }
      case 'file': {
        if (typeof source.path !== 'string' || !source.path) throw new Error('Choose an image.')
        if (!IMAGE_FILE.test(source.path)) throw new Error('Choose a JPG, PNG or WebP image.')
        if (!existsSync(source.path) || !statSync(source.path).isFile()) {
          throw new Error(`The image does not exist: ${basename(source.path)}.`)
        }
        const still = await this.deps.stills.importFile(source.path, storyboardId)
        image = { path: still.path, stillId: still.id }
        break
      }
      case 'frame': {
        if (typeof source.time !== 'number' || !Number.isFinite(source.time) || source.time < 0) {
          throw new Error('Invalid time for the frame.')
        }
        if (typeof source.generationId !== 'string' || !db.getGeneration(source.generationId)) {
          throw new Error('The clip no longer exists.')
        }
        const still = await this.deps.stills.saveFrame(source.generationId, source.time, storyboardId)
        image = { path: still.path, stillId: still.id }
        break
      }
      default:
        throw new Error('Unknown kind of image.')
    }
    if (!IMAGE_FILE.test(image.path)) throw new Error('Only JPG, PNG or WebP images can become a board.')
    if (!existsSync(image.path)) throw new Error(`The image no longer exists: ${basename(image.path)}.`)
    return image
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  /**
   * Changes a transition's prompt and settings, or which take is selected. A model must take an end image; the
   * other options are fitted to it (the model list decides, when it can be had). The settings chosen become the
   * storyboard's defaults for transitions made later.
   */
  async updateTransition(transitionId: string, patch: TransitionPatch, caller: Caller = {}): Promise<Storyboard> {
    patch = patch ?? {}
    const first = requireTransitionRow(transitionId)
    this.refuseWhileRunning(first.storyboard.id, caller)
    const model = patch.model === undefined ? undefined : checkTransitionModel(patch.model)
    const touchesOptions =
      model !== undefined || patch.duration !== undefined || patch.resolution !== undefined || patch.audio !== undefined
    const models = touchesOptions ? await this.modelList() : undefined
    if (model && models && !models.some((m) => m.id === model)) {
      throw new Error(`${providerName(activeProvider())} has no video model called ${model}. Choose another model.`)
    }

    // Read again after the wait: the boards (and with them this transition) may have changed.
    const { row, storyboard } = requireTransitionRow(transitionId)
    this.refuseWhileRunning(storyboard.id, caller)
    const current = store.parseParams(row.params)
    let params: GenerationParams = { ...current }
    if (patch.prompt !== undefined) params.prompt = typeof patch.prompt === 'string' ? patch.prompt : ''
    if (patch.negativePrompt !== undefined) {
      const negative = typeof patch.negativePrompt === 'string' ? patch.negativePrompt : ''
      params.negativePrompt = negative || undefined
    }
    if (model !== undefined) params.model = model
    const info = models?.find((m) => m.id === params.model)
    if (patch.duration !== undefined) {
      params.duration = checkOption(patch.duration, info?.durations, info?.name, 'the length')
    }
    if (patch.resolution !== undefined) {
      params.resolution = checkOption(patch.resolution, info?.resolutions, info?.name, 'the resolution')
    }
    if (patch.audio !== undefined) {
      if (typeof patch.audio !== 'boolean') throw new Error('Sound must be on or off.')
      params.audio = patch.audio
    }
    if (model !== undefined && model !== current.model) params = fitToModel(params, aspectOf(storyboard), info)

    let selection: string | null | undefined
    if (patch.selectedGenerationId === null) selection = null
    else if (patch.selectedGenerationId !== undefined) {
      const wanted = patch.selectedGenerationId
      const take = typeof wanted === 'string' ? db.getGeneration(wanted) : undefined
      if (!take) throw new Error('The take no longer exists.')
      // Its own takes, or a generation that belongs to no clip (picked from the feed), as for sequence clips.
      if (take.segmentId && take.segmentId !== row.id) {
        throw new Error('The take belongs to another transition or clip.')
      }
      // A transition goes from one board's picture to the next: an own film or a version from the Editor was made from
      // neither, so it can't stand in for one (sequences take them as clips of their own).
      if (!isVeniceGeneration(take)) {
        throw new Error('Own clips and versions from the Editor cannot be chosen for a transition. Put them in a sequence.')
      }
      selection = take.id
    }

    const json = store.serializeParams(params)
    conn().transaction(() => {
      if (json !== row.params) conn().prepare('UPDATE segments SET params = ? WHERE id = ?').run(json, row.id)
      if (touchesOptions) {
        const { model: m, duration, resolution, audio } = params
        const defaults = {
          ...store.parseDefaults(storyboard.defaults),
          ...store.pickDefaults({ model: m, duration, resolution, audio })
        }
        // Its director (and anything else the defaults hold besides the settings) stays.
        conn()
          .prepare('UPDATE sequences SET defaults = ? WHERE id = ?')
          .run(store.withStoredExtras(defaults, storyboard.defaults), storyboard.id)
      }
    })()
    // Selecting goes through the sequence service: trims, and a generation from the feed moving into the folder.
    if (selection !== undefined) await this.deps.sequences.updateSegment(row.id, { selectedGenerationId: selection })
    this.changed(storyboard.id)
    return this.get(storyboard.id)
  }

  /**
   * Queues a new take of the transition (paid) – or several, `variants` (see SequenceService.generateSegment);
   * resolves with the first. Refused, before anything is paid for, when it can't be made.
   */
  async generateTransition(transitionId: string, guard?: SubmitGuard, variants?: SendOptions): Promise<Generation> {
    const { row, storyboard } = requireTransitionRow(transitionId)
    const problem = this.problemsOf(storyboard.id, row.id)[0]
    if (problem) throw new Error(problem)
    if (this.deps.sequences.isSubmitting(row.id)) {
      throw new Error(
        `A take of the transition is already being sent to ${providerName(activeProvider())}. Wait until it shows among the takes.`
      )
    }
    return this.deps.sequences.generateSegment(row.id, this.transitionGuard(storyboard.id, guard), undefined, variants)
  }

  /**
   * The submit guard every take of a transition is sent with (see SubmitGuard): the transition is checked again on
   * the very database state the take is built from. A take waits before that read (for the file queue, the model
   * list), and a board emptied meanwhile would otherwise be paid for without its picture – the sequence service's
   * own check only asks for a start image. `approved`: an agent approval's guard, checked first.
   */
  private transitionGuard(storyboardId: string, approved?: SubmitGuard): SubmitGuard {
    return (segmentId) => approved?.(segmentId) || this.problemsOf(storyboardId, segmentId)[0]
  }

  /** Why the transition can't be generated as it stands, read from the database now. */
  private problemsOf(storyboardId: string, transitionId: string): string[] {
    const row = store.requireSegmentRow(transitionId)
    const boards = new Map(listBoardRows(storyboardId).map((b, i) => [b.id, { ...b, number: i + 1 }]))
    const from = row.from_board_id ? boards.get(row.from_board_id) : undefined
    const to = row.to_board_id ? boards.get(row.to_board_id) : undefined
    const asBoard = (b: typeof from): Pick<StoryboardBoard, 'id' | 'position' | 'imagePath'> | undefined =>
      b && { id: b.id, position: b.number - 1, imagePath: boardImage(b) }
    return transitionProblems(store.parseParams(row.params), asBoard(from), asBoard(to))
  }

  /**
   * The transitions "Generate missing" would pay for if it started now, in order: each without a finished selected
   * take that isn't already on its way to Venice or rendering, with what it would be sent with and, when it can't be
   * sent as it stands, why not.
   */
  missingTransitions(storyboardId: string): MissingTransition[] {
    requireStoryboardRow(storyboardId)
    return store.listSegmentRows(storyboardId).flatMap((row, i): MissingTransition[] => {
      if (store.isUsable(store.selectedTake(row)) || this.deps.sequences.takeInFlight(row.id)) return []
      const problem = this.problemsOf(storyboardId, row.id)[0]
      return [
        {
          transitionId: row.id,
          number: i + 1,
          params: paramsForSubmit(store.parseParams(row.params)),
          ...(problem ? { problem } : {})
        }
      ]
    })
  }

  /**
   * "Generate missing": sends every missing transition to Venice, one after another (each waits only until Venice
   * has the job: transitions don't depend on each other's takes). Nothing is paid for while any of them can't be
   * sent as it stands. `guard`: for a run the user approved through an agent (see SubmitGuard).
   */
  start(storyboardId: string, guard?: SubmitGuard): void {
    requireStoryboardRow(storyboardId)
    if (this.runs.get(storyboardId)?.running) return
    // "Transition 1 of 3" from the first summary on: the transitions missing now (the loop recounts as it goes).
    const total = this.missingTransitions(storyboardId).length
    const run: Run = { running: true, stopped: false, guard, startedAt: Date.now(), total, sent: 0 }
    this.runs.set(storyboardId, run)
    this.deps.notify(storyboardId)
    this.workChanged()
    void this.runLoop(storyboardId, run)
  }

  /** Ends the run for the UI at once; a take already on its way is called off before Venice is paid. */
  stop(storyboardId: string, notify = true): void {
    const run = this.runs.get(storyboardId)
    if (!run?.running) return
    run.stopped = true
    run.running = false
    if (notify) this.deps.notify(storyboardId)
    this.workChanged()
  }

  /**
   * A run that stopped on a problem keeps it in memory only (shown while the storyboard is open); nobody awaits a run,
   * so the problem is also recorded as a failure the user hasn't seen. A run the user stopped leaves nothing.
   */
  private recordRunFailure(storyboardId: string, run: Run): void {
    if (!run.error || run.stopped) return
    try {
      const row = store.getSequenceRow(storyboardId)
      if (!row) return
      db.addUnseen({
        error: runFailureText(run.error, 'storyboard'),
        label: `Generate missing in “${row.name}”`,
        context: { sequenceId: storyboardId, storyboardId, failureOf: 'run' }
      })
    } catch (err) {
      console.warn('Could not record a failed generate-all run:', err)
    }
  }

  private async runLoop(storyboardId: string, run: Run): Promise<void> {
    this.loops.add(run)
    let number = 0
    try {
      // A take being moved is briefly missing from its recorded path; don't take it for a missing transition.
      await this.deps.sequences.whenFilesSettled()
      if (run.stopped || !store.getSequenceRow(storyboardId)) return
      const missing = this.missingTransitions(storyboardId)
      run.total = missing.length
      const blocked = missing.find((m) => m.problem)
      if (blocked) {
        run.error = `Transition ${blocked.number}: ${blocked.problem}`
        return
      }
      // Re-read every step: the user may change boards and transitions while this runs.
      const sent = new Set<string>()
      while (!run.stopped && store.getSequenceRow(storyboardId)) {
        const left = this.missingTransitions(storyboardId).filter((m) => !sent.has(m.transitionId))
        // "Transition 2 of 5": sent so far and still missing now (transitions may be added meanwhile).
        run.total = run.sent + left.length
        const next = left[0]
        if (!next) break
        number = next.number
        if (next.problem) {
          run.error = `Transition ${next.number}: ${next.problem}`
          break
        }
        sent.add(next.transitionId)
        await this.deps.sequences.generateSegment(
          next.transitionId,
          this.transitionGuard(storyboardId, run.guard),
          () => run.stopped
        )
        run.sent++
      }
    } catch (err) {
      if (!isCancelledSubmit(err) && !run.stopped) {
        // Consent errors stay raw ("Transition 2: NEEDS_CONSENT:{…}") so the view can ask and start again.
        const text = err instanceof Error ? err.message : String(err)
        run.error = number ? `Transition ${number}: ${text}` : text
      }
    } finally {
      this.loops.delete(run)
      const wasRunning = run.running
      run.running = false
      try {
        // Recorded before the view hears of the end, so the summary read with it has the failure.
        if (this.runs.get(storyboardId) === run) this.recordRunFailure(storyboardId, run)
        if (wasRunning && this.runs.get(storyboardId) === run && store.getSequenceRow(storyboardId)) {
          this.deps.notify(storyboardId)
        }
      } catch (err) {
        console.warn('Could not report the end of a storyboard run', err)
      }
      this.workChanged()
    }
  }

  // ── Export and "Convert to sequence" ─────────────────────────────────────

  /**
   * Renders the selected takes into Storyboards/<name>/ (see SequenceService.export, which also records where the
   * transitions meet in the film, its cuts); resolves the film's path. A storyboard has no Exportformat: the film
   * keeps the first transition's size.
   */
  export(storyboardId: string): Promise<string> {
    requireStoryboardRow(storyboardId)
    return this.deps.sequences.export(storyboardId)
  }

  /**
   * A new sequence "<name> (sequence)" with one clip per transition: the transition's params (its two board images as
   * the clip's start and end image, prompt, model, duration …), the boards' notes, and a copy of its selected take,
   * selected (copied, so the storyboard keeps its own). Where the storyboard's export drops a transition's first
   * frame (it repeats the board the previous one ended on), the clip starts half a frame in, so the sequence's film
   * cuts the same way. The storyboard is left as it is.
   */
  async convertToSequence(storyboardId: string): Promise<{ sequenceId: string }> {
    // Takes on their way into the storyboard's folder are copied from where they end up.
    await this.deps.sequences.whenFilesSettled()
    const storyboard = this.get(storyboardId)
    if (!storyboard.transitions.length) {
      throw new Error('The storyboard has no transitions to make clips of yet. Add at least two boards.')
    }
    const notes = new Map(storyboard.boards.map((b) => [b.id, b.note.trim()]))
    const clipIds: string[] = []
    const now = Date.now()
    const sequenceId = await this.deps.sequences.createRow(`${storyboard.name} (sequence)`, {
      kind: 'sequence',
      defaults: store.pickDefaults({ ...DEFAULT_PARAMS, aspectRatio: storyboard.aspectRatio }),
      inTransaction: (id) => {
        const insert = conn().prepare(
          `INSERT INTO segments (id, sequence_id, position, params, continue_from_previous, end_from_next, notes,
             selected_generation_id, created_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)`
        )
        storyboard.transitions.forEach((t, i) => {
          const clipId = randomUUID()
          clipIds.push(clipId)
          const clipNote = clipNotes(notes.get(t.fromBoardId), notes.get(t.toBoardId))
          insert.run(clipId, id, i, store.serializeParams(t.params), clipNote, now + i)
        })
      }
    })

    const selected = storyboard.transitions.map((t) => t.takes.find((g) => g.id === t.selectedGenerationId))
    const usable = selected.map((g) => (g && store.isUsable(g) ? g : undefined))
    for (const [i, take] of usable.entries()) {
      if (!take) continue
      const previous = i > 0 ? usable[i - 1] : undefined
      const trimStart = previous && repeatsBoardImage(take, previous) ? await halfFrame(take.filePath) : 0
      try {
        await this.deps.sequences.copyTake(take.id, clipIds[i], trimStart)
      } catch (err) {
        // The clip still gets the take, selected where it is (it stays the storyboard's).
        console.warn(`Could not copy take ${take.id} into the new sequence; selecting it where it is:`, err)
        await this.deps.sequences
          .updateSegment(clipIds[i], { selectedGenerationId: take.id, trimStart })
          .catch((e: unknown) => console.warn(`Could not select take ${take.id} in the new sequence:`, e))
      }
    }
    return { sequenceId }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * An agent may not change a storyboard's boards or transitions while "Generate missing" sends them: the run reads
   * them as it goes, so a transition changed meanwhile would be paid for without the user having seen it.
   */
  private refuseWhileRunning(storyboardId: string, caller: Caller): void {
    if (!caller.byAgent || !this.runs.get(storyboardId)?.running) return
    throw new Error(
      '“Generate missing” is running for the storyboard. Wait until it is done (or stop it with stop_generation_run) ' +
        'before you change boards or transitions.'
    )
  }

  /** After a change to the boards: freed takes go back to Generations, and the views hear about it. */
  private async settle(storyboardId: string, freed: readonly string[]): Promise<Storyboard> {
    this.changed(storyboardId)
    if (freed.length) {
      await this.deps.sequences.freeTakes(freed)
      this.deps.notify(storyboardId)
    }
    return this.get(storyboardId)
  }

  private changed(storyboardId: string): void {
    if (!store.getSequenceRow(storyboardId)) return
    store.touchSequence(storyboardId)
    this.deps.notify(storyboardId)
  }

  /** The video model list, or undefined when it can't be had in time (offline, say). Never rejects. */
  private async modelList(): Promise<VideoModel[] | undefined> {
    const load = this.deps.models
    if (!load) return undefined
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), MODELS_TIMEOUT_MS)
    })
    try {
      return await Promise.race([load().catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Why a transition can't be generated as it stands, in the order they matter. */
function transitionProblems(
  params: GenerationParams,
  from: Pick<StoryboardBoard, 'position' | 'imagePath'> | undefined,
  to: Pick<StoryboardBoard, 'position' | 'imagePath'> | undefined
): string[] {
  const problems: string[] = []
  const note = (problem: string | undefined): void => {
    if (problem && !problems.includes(problem)) problems.push(problem)
  }
  for (const board of [from, to]) {
    if (!board) continue
    const number = board.position + 1
    if (!board.imagePath) note(`Board ${number} has no image.`)
    else if (!existsSync(board.imagePath)) {
      note(`The image on board ${number} no longer exists: ${basename(board.imagePath)}.`)
    }
  }
  if (!from || !to) note(TRANSITION_GONE)
  if (!params.prompt.trim()) note('Write what happens in the transition.')
  if (!supportsEndImage(params.model) || kindOfModelId(params.model) !== 'image-to-video') {
    note(
      `The model ${params.model} cannot go from one image to another. Choose a model that takes both a start and an end image.`
    )
  }
  note(blockingPromptError(params))
  return problems
}

/** A model for a transition: an image-to-video model that takes an end image. */
function checkTransitionModel(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('Choose a model.')
  if (!supportsEndImage(id) || kindOfModelId(id) !== 'image-to-video') {
    throw new Error(
      `${id} cannot go from one image to another. Choose an image-to-video model that takes both a start and ` +
        'an end image (Seedance, for example).'
    )
  }
  return id
}

/** A duration or resolution the model offers (any, without the model list). */
function checkOption(
  value: unknown,
  options: readonly string[] | undefined,
  model: string | undefined,
  what: string
): string {
  const option = typeof value === 'string' ? value.trim() : ''
  if (!option) throw new Error(`Choose ${what}.`)
  if (options?.length && !options.includes(option)) {
    throw new Error(`${model ?? 'The model'} doesn't have ${what} ${option}. Choose one of: ${options.join(', ')}.`)
  }
  return option
}

/**
 * Params just switched to another model, with the options that model offers: the duration and resolution kept
 * where it has them, the audio setting as the form sets it, and a format only for a model that has formats of its
 * own (the storyboard's, or the nearest it has); most image-to-video models take the picture's shape.
 */
function fitToModel(params: GenerationParams, aspectRatio: string, info: VideoModel | undefined): GenerationParams {
  if (!info) return params
  return {
    ...params,
    duration: pickOption(info.durations, params.duration, ['5s', ...PREFERRED.durations]) ?? params.duration,
    resolution: pickOption(info.resolutions, params.resolution, PREFERRED.resolutions),
    aspectRatio: pickOption(info.aspectRatios, aspectRatio, ['adaptive', 'auto', ...PREFERRED.aspectRatios]),
    audio: audioForModel(info, params.audio)
  }
}

/** The transition's format after the storyboard's changed: only a model with formats of its own takes one. */
function fitAspect(
  params: GenerationParams,
  aspectRatio: string,
  models: readonly VideoModel[] | undefined
): GenerationParams {
  const info = models?.find((m) => m.id === params.model)
  if (!info) return params
  return { ...params, aspectRatio: pickOption(info.aspectRatios, aspectRatio, ['adaptive', 'auto']) }
}

/** A clip's "What happens" from the notes of the boards it goes between. */
function clipNotes(from: string | undefined, to: string | undefined): string {
  const lines: string[] = []
  if (from) lines.push(`From: ${from}`)
  if (to) lines.push(`To: ${to}`)
  return lines.join('\n')
}

/** Half a frame of the video, in seconds: a start trim that skips exactly its first frame (24 fps when unknown). */
async function halfFrame(path: string): Promise<number> {
  const fps = await probe(path).then(
    (info) => (info.fps > 0 ? info.fps : 24),
    () => 24
  )
  return 0.5 / fps
}

/**
 * A picture path held across an await, carried along the stored-path rewrites made since `mark` (the storyboard's
 * folder renamed while a file was copied in), so a board is never written pointing where the file was.
 */
function followImage(path: string, mark: number): string {
  return db.followRewrites({ model: '', prompt: '', duration: '', startImage: path }, mark).startImage ?? path
}

/** Who made an IPC call. */
const callerOf = (e: IpcMainInvokeEvent): Caller => ({ byAgent: isAgentCall(e) })

/** A board picture given as a file: an agent's must be one it uploaded or one the library records. */
function guardImageFile(e: IpcMainInvokeEvent, image: unknown): void {
  if (image && typeof image === 'object' && (image as { kind?: unknown }).kind === 'file') {
    assertAgentFiles(e, [(image as { path?: unknown }).path])
  }
}

/**
 * Registers the storyboard IPC handlers and returns the service behind them. 'transitions:generate' (after its
 * GenerateOptions) and 'storyboards:generateAll' take an approval's submit guard as an extra argument (in-process
 * calls only), and 'storyboards:missing' (not part of StudioApi) tells the agent connection what "Generate missing"
 * would pay for.
 */
export function registerStoryboardIpc(deps: StoryboardDeps): StoryboardService {
  const s = new StoryboardService(deps)
  ipcMain.handle('storyboards:list', () => s.list())
  ipcMain.handle('storyboards:get', (_e, id: string) => s.get(id))
  ipcMain.handle('storyboards:create', (_e, name: unknown, aspectRatio?: unknown) => s.create(name, aspectRatio))
  ipcMain.handle('storyboards:update', (e, id: string, patch: { name?: unknown; aspectRatio?: unknown; director?: unknown }) =>
    s.update(id, patch ?? {}, callerOf(e))
  )
  ipcMain.handle('storyboards:delete', (_e, id: string) => s.delete(id))

  // A picture file from an agent is an upload staged in the library or a file the library records, never its own path.
  ipcMain.handle('boards:add', (e, storyboardId: string, init?: BoardInit) => {
    guardImageFile(e, init?.image)
    return s.addBoard(storyboardId, init ?? {}, callerOf(e))
  })
  ipcMain.handle('boards:update', (e, boardId: string, patch: { note?: unknown; image?: BoardImageSource | null }) => {
    guardImageFile(e, patch?.image)
    return s.updateBoard(boardId, patch ?? {}, callerOf(e))
  })
  ipcMain.handle('boards:move', (e, boardId: string, toIndex: unknown) => s.moveBoard(boardId, toIndex, callerOf(e)))
  // Read-only, not part of StudioApi: what a move would remove (agents' move_board and delete approvals ask it).
  ipcMain.handle('boards:moveLoss', (_e, boardId: string, toIndex: unknown) => s.moveLoss(boardId, toIndex))
  ipcMain.handle('boards:delete', (e, boardId: string) => s.deleteBoard(boardId, callerOf(e)))

  ipcMain.handle('transitions:update', (e, transitionId: string, patch: TransitionPatch) =>
    s.updateTransition(transitionId, patch ?? {}, callerOf(e))
  )
  // `opts`: GenerateOptions (the variants, the over-budget confirmation); the guard comes from an approval only.
  ipcMain.handle('transitions:generate', (_e, transitionId: string, opts?: unknown, guard?: unknown) =>
    s.generateTransition(transitionId, asGuard(guard), sendOptionsOf(opts))
  )
  // `opts`: {confirmOverBudget} from the window, after the guard an approval in this process passes. Checked against the
  // budget once, with every missing transition's price, before the run starts; what it then sends isn't asked about
  // again (runConfirmed). A run that can't start as the transitions stand is left to say so itself.
  ipcMain.handle('storyboards:generateAll', async (_e, storyboardId: string, guard?: unknown, opts?: unknown) => {
    const missing = s.missingTransitions(storyboardId)
    if (missing.length && !missing.some((m) => m.problem)) {
      const prices = (): Promise<number | undefined> =>
        quoteTotal(
          missing.map((m) => m.params),
          (p) => deps.sequences.quoteTake(p)
        )
      await assertRunWithinBudget(prices, confirmedOf(opts))
    }
    runConfirmed(() => s.start(storyboardId, asGuard(guard)))
  })
  ipcMain.handle('storyboards:missing', (_e, storyboardId: string) => s.missingTransitions(storyboardId))
  ipcMain.handle('storyboards:stop', (_e, storyboardId: string) => s.stop(storyboardId))
  ipcMain.handle('storyboards:export', (_e, storyboardId: string) => s.export(storyboardId))
  ipcMain.handle('storyboards:toSequence', (_e, storyboardId: string) => s.convertToSequence(storyboardId))
  return s
}
