import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { generationTitle } from '@shared/generation-label'
import { agentInSentence } from '@shared/agent-name'
import { ratingLabel } from '@shared/rating'
import type {
  ApprovalDeleteItem,
  ApprovalDeleteRequest,
  ApprovalRequest,
  AssetKind,
  DeleteTargetKind,
  Edit,
  Sequence,
  Storyboard
} from '@shared/types'
import * as db from '../../db'
import { ASSET_FOLDERS, fromStoredPath, isAssetKind } from '../../paths'
import { TRASH } from '../../platform'
import * as store from '../../sequence-store'
import { ApprovalLapsed, type ApprovalOutcome, type ApprovalPlan } from '../approvals'
import { callApproved, callService } from '../local-ipc'
import { errorText, localTime, q, requireLibrary } from '../studio'
import { defineTool, type ToolContext } from './kit'

// Removing things is never an agent's own call. request_delete plans every item the agent names – what it is, what
// else changes with it, what goes to the Trash – refuses what Studio or the user's rules wouldn't allow, and creates
// one approval request of kind 'delete'. Only the user's OK in Studio removes anything: then every item is checked
// again (verify: anything changed since and the whole request lapses) and removed through the window's own handlers,
// with the user's authority (callApproved), in an order where nothing is removed before what depends on it.

/** At most this many items in one request. */
const MAX_ITEMS = 50

/** "The character", "The product" …: an asset of a kind, in a label. */
const THE: Record<AssetKind, string> = {
  character: 'The character',
  environment: 'The environment',
  product: 'The product',
  outfit: 'The outfit',
  pose: 'The pose'
}

/** The group heading of each kind in the dialog. */
const KIND_GROUP: Record<AssetKind, string> = {
  character: 'Characters',
  environment: 'Environments',
  product: 'Products',
  outfit: 'Outfits',
  pose: 'Poses'
}

/**
 * The order the items are removed in: nothing is removed before what depends on it is gone (a photo before its
 * asset, a take before its clip, a clip before its sequence, a version before its edit), so every step meets the
 * library as its handler expects it.
 */
const EXECUTE_ORDER: readonly DeleteTargetKind[] = [
  'asset-image',
  'asset-audio',
  'review',
  'take',
  'generation',
  'still',
  'segment',
  'board-move',
  'board',
  'version',
  'prune-versions',
  'asset',
  'prompt',
  'learning',
  'sequence',
  'storyboard',
  'edit'
]

const USER_REVIEW = 'The user\'s own review (rating, note, tags) is only changed by the user.'
const USER_LEARNING = 'The learning is the user\'s – only the user removes it.'
const TRANSITION_AS_CLIP = 'Transitions are removed with their boards – ask for {board_id} or a move.'
const ONE_MOVE = 'One move per storyboard and request – ask for the next one when this one is done.'
const MOVE_REMOVES_NOTHING = 'The move removes nothing – use move_board.'
const MOVE_WITH_BOARDS =
  'Ask for the move in a request of its own – boards of the same storyboard are removed in this one, and then the places don\'t match.'

/** Why the whole request lapses: something it would remove changed after the agent asked. */
const changed = (label: string): string =>
  `Something to be deleted has changed since the agent asked (${label}). Ask the agent to ask again.`

// ── Words ────────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:02" today, "6 Oct 14:02" another day: when a take was made, as Studio shows it. */
function clock(ms: number): string {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString() ? time : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`
}

/** "1 photo", "3 photos". */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "1 take becomes an ordinary clip in Media", "3 takes become …". */
const takesToMedia = (n: number): string =>
  `${count(n, 'take', 'takes')} ${n === 1 ? 'becomes an ordinary clip' : 'become ordinary clips'} in Media`

/** "Anna", "Anna and Erik", "Anna, Erik and Sara". */
function andList(parts: readonly string[]): string {
  const list = parts.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** One line, at most `max` characters ("…"). */
function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

const lowerFirst = (text: string): string => text.charAt(0).toLocaleLowerCase('en') + text.slice(1)

/** "350 kB", "12 MB", "1.2 GB", as Studio shows sizes. */
function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB']
  ]
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size
      const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1)
      return `${text} ${unit}`
    }
  }
  return `${Math.max(0, Math.round(bytes))} bytes`
}

/** "$0.42". */
const usd = (v: number): string => `$${v.toFixed(v < 0.1 ? 3 : 2)}`

// ── Reading the library ──────────────────────────────────────────────────────

const sql = (): ReturnType<typeof db.getDb> => db.getDb()

function row<T>(query: string, ...args: unknown[]): T | undefined {
  return sql().prepare(query).get(...args) as T | undefined
}

function rows<T>(query: string, ...args: unknown[]): T[] {
  return sql().prepare(query).all(...args) as T[]
}

function exists(query: string, ...args: unknown[]): boolean {
  return !!sql().prepare(query).get(...args)
}

/** Which file a path is (device, inode, size, modification time): a path names a place, not a file. */
function fileIdentity(path: string | undefined): string {
  if (!path) return 'none'
  try {
    const s = statSync(path)
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * Whether a library file of an asset (its stored path) is used by anything but the asset row that holds it: as a
 * start, end or reference picture or a reference sound of a generation, a clip or a still, or as a board's picture.
 * Such a file is kept in "Referensbilder" when its photo or sound clip goes (assets.ts keepUsedFile). The params are
 * JSON, so the path is matched as a whole JSON string (quotes included), letter case ignored like the disk.
 */
function usedOutsideAsset(stored: string): boolean {
  if (
    exists(
      `SELECT 1 FROM generations WHERE file_path = @p COLLATE NOCASE OR original_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM stills WHERE file_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM storyboard_boards WHERE image_path = @p COLLATE NOCASE
       UNION ALL SELECT 1 FROM edit_media WHERE file_path = @p COLLATE NOCASE
       LIMIT 1`,
      { p: stored }
    )
  ) {
    return true
  }
  return exists(
    `SELECT 1 FROM generations WHERE instr(studio_fold(params), studio_fold(@n)) > 0
     UNION ALL SELECT 1 FROM segments WHERE instr(studio_fold(params), studio_fold(@n)) > 0
     UNION ALL SELECT 1 FROM stills WHERE instr(studio_fold(params), studio_fold(@n)) > 0
     LIMIT 1`,
    { n: JSON.stringify(stored) }
  )
}

/** Sequence clips that use a picture (stored path) as their start or end image. */
function clipsUsing(stored: string): number {
  return (
    row<{ n: number }>(
      'SELECT COUNT(*) AS n FROM segments WHERE from_board_id IS NULL AND instr(studio_fold(params), studio_fold(?)) > 0',
      JSON.stringify(stored)
    )?.n ?? 0
  )
}

/**
 * What one planning or checking pass reads through the window's own handlers, each at most once: a request's items
 * often share their sequence, storyboard or edit.
 */
class Reader {
  private readonly sequences = new Map<string, Promise<Sequence | undefined>>()
  private readonly storyboards = new Map<string, Promise<Storyboard | undefined>>()
  private readonly edits = new Map<string, Promise<Edit | undefined>>()

  sequence(id: string): Promise<Sequence | undefined> {
    return once(this.sequences, id, () => callService<Sequence>('sequences:get', id))
  }

  storyboard(id: string): Promise<Storyboard | undefined> {
    return once(this.storyboards, id, () => callService<Storyboard>('storyboards:get', id))
  }

  edit(id: string): Promise<Edit | undefined> {
    return once(this.edits, id, () => callService<Edit>('edits:get', id))
  }
}

function once<T>(cache: Map<string, Promise<T | undefined>>, id: string, load: () => Promise<T>): Promise<T | undefined> {
  let p = cache.get(id)
  if (!p) {
    p = load().catch(() => undefined)
    cache.set(id, p)
  }
  return p
}

/** The Editor's own rule for removing a generation or a version (null: nothing stands in the way). */
async function deleteRefusal(generationId: string): Promise<string | undefined> {
  return (await callService<string | null>('edits:deleteRefusal', generationId)) ?? undefined
}

// ── Items ────────────────────────────────────────────────────────────────────

/** An item as the agent names it. */
const deleteItem = z.union([
  z.object({ asset_id: z.string().min(1) }).strict(),
  z.object({ asset_image_id: z.string().min(1).describe('A photo of an asset (image_ids from get_asset).') }).strict(),
  z.object({ asset_audio_id: z.string().min(1).describe('A sound clip of an asset (audio from get_asset).') }).strict(),
  z.object({ prompt_id: z.string().min(1) }).strict(),
  z.object({ learning_id: z.string().min(1) }).strict(),
  z.object({ review_id: z.string().min(1) }).strict(),
  z.object({ sequence_id: z.string().min(1) }).strict(),
  z.object({ segment_id: z.string().min(1).describe('A sequence clip; a storyboard transition goes with its boards.') }).strict(),
  z.object({ storyboard_id: z.string().min(1) }).strict(),
  z.object({ board_id: z.string().min(1) }).strict(),
  z
    .object({
      board_move: z
        .object({
          board_id: z.string().min(1),
          to_board_number: z.number().int().min(1).describe('The 1-based place the board moves to.')
        })
        .strict()
    })
    .strict(),
  z.object({ generation_id: z.string().min(1).describe('A video: its row and its file.') }).strict(),
  z
    .object({
      take: z
        .object({
          generation_id: z.string().min(1),
          segment_id: z.string().min(1).describe('The clip or transition the take is taken off (the video stays).')
        })
        .strict()
    })
    .strict(),
  z.object({ still_id: z.string().min(1) }).strict(),
  z.object({ edit_id: z.string().min(1) }).strict(),
  z.object({ version_id: z.string().min(1).describe('A version of an edit in the Editor.') }).strict(),
  z.object({ prune_versions_of: z.string().min(1).describe("An edit_id: the Editor's \"Clean up versions\".") }).strict()
])

type DeleteInput = z.infer<typeof deleteItem>

/** One item as Studio plans it: what the dialog shows, how it is checked again, and how it is removed. */
interface Planned {
  /** What the item removes, the same way every time: duplicates fold together and other requests are compared. */
  key: string
  /** What the agent asked, for the reports. */
  input: DeleteInput
  item: ApprovalDeleteItem
  /** Keys of items whose removal removes this one too (it is folded into them when they are in the request). */
  within: string[]
  /** The sequence, storyboard, edit or asset it belongs to, for the request's summary ("… in “Sommar”"). */
  owner?: string
  /** A container's words for the second question, e.g. "the sequence “Sommar” with 8 clips". */
  phrase?: string
  /** A board or a board move: the storyboard (one move per storyboard; no move next to removed boards). */
  storyboardId?: string
  /** What stands in the way now; checked when planning and again on the user's OK. */
  refusal: (r: Reader) => Promise<string | undefined>
  /** The state the user approves; anything else on the user's OK and the request lapses. */
  snapshot: (r: Reader) => Promise<string>
  /** Still there to be removed (else its outcome is 'gone'). */
  present: () => boolean
  /** Removes it, with the user's authority. */
  run: () => Promise<unknown>
}

/** A refusal at planning: the item can't be asked for at all. */
const refuse = (message: string): never => {
  throw new Error(message)
}

const none = async (): Promise<undefined> => undefined

/** The key of an item, as the request stores it (versions are generations, so they fold with them). */
export function deleteKey(item: Pick<ApprovalDeleteItem, 'kind' | 'id' | 'segmentId'>): string {
  switch (item.kind) {
    case 'version':
      return `generation:${item.id}`
    case 'take':
      return `take:${item.id}:${item.segmentId ?? ''}`
    case 'prune-versions':
      return `prune:${item.id}`
    default:
      return `${item.kind}:${item.id}`
  }
}

function planned(input: DeleteInput, item: ApprovalDeleteItem, rest: Omit<Planned, 'key' | 'input' | 'item'>): Planned {
  return { key: deleteKey(item), input, item, ...rest }
}

interface AssetRow {
  id: string
  kind: string
  name: string
  folder: string | null
  updated_at: number
}

interface FileRow {
  id: string
  asset_id: string
  file_path: string
  position: number
}

const assetRow = (id: string): AssetRow | undefined =>
  row<AssetRow>('SELECT id, kind, name, folder, updated_at FROM assets WHERE id = ?', id)
const imageRows = (assetId: string): FileRow[] =>
  rows<FileRow>(
    'SELECT id, asset_id, file_path, position FROM asset_images WHERE asset_id = ? ORDER BY position, created_at',
    assetId
  )
const audioRows = (assetId: string): (FileRow & { clone_consent_at: number | null })[] =>
  rows(
    'SELECT id, asset_id, file_path, position, clone_consent_at FROM asset_audio WHERE asset_id = ? ORDER BY position, created_at',
    assetId
  )
const kindOf = (kind: string): AssetKind | undefined => (isAssetKind(kind) ? kind : undefined)
const theOf = (kind: string): string => (isAssetKind(kind) ? THE[kind] : 'The asset')

async function planAsset(input: DeleteInput, id: string): Promise<Planned> {
  const asset = assetRow(id) ?? refuse(`There is no character, environment, product, outfit or pose with id ${id}.`)
  const kind = kindOf(asset.kind)
  const images = imageRows(id)
  const audio = audioRows(id)
  const usedImages = images.filter((f) => usedOutsideAsset(f.file_path)).length
  const usedAudio = audio.filter((f) => usedOutsideAsset(f.file_path)).length
  const wearers = rows<{ name: string }>(
    "SELECT name FROM assets WHERE kind = 'character' AND default_outfit_id = ? ORDER BY name",
    id
  ).map((w) => w.name)
  const files = (photos: number, clips: number): string =>
    andList([photos ? count(photos, 'photo', 'photos') : '', clips ? count(clips, 'sound clip', 'sound clips') : ''])
  const effects: string[] = []
  if (usedImages || usedAudio) {
    effects.push(
      `${files(usedImages, usedAudio)} ${usedImages + usedAudio === 1 ? 'is' : 'are'} used by clips and kept in “Referensbilder”`
    )
  }
  const trashed = images.length + audio.length - usedImages - usedAudio
  const folder = kind && asset.folder ? ` ${ASSET_FOLDERS[kind]}/${asset.folder}` : ''
  effects.push(
    trashed
      ? `${files(images.length - usedImages, audio.length - usedAudio)} ${trashed === 1 ? 'is' : 'are'} moved to ${TRASH} with the folder${folder}`
      : `The folder${folder} is moved to ${TRASH}`
  )
  if (wearers.length) effects.push(`${andList(wearers)} ${wearers.length === 1 ? 'has' : 'have'} it as default outfit – that is removed`)
  const label = `${theOf(asset.kind)} ${q(asset.name)}`
  return planned(
    input,
    {
      kind: 'asset',
      id,
      label,
      group: kind ? KIND_GROUP[kind] : 'Assets',
      ...(images[0] ? { preview: fromStoredPath(images[0].file_path) } : {}),
      ...(kind ? { assetKind: kind } : {}),
      effects,
      trash: { files: trashed },
      container: true
    },
    {
      within: [],
      owner: asset.name,
      phrase: `${lowerFirst(label)}${images.length ? ` with ${count(images.length, 'photo', 'photos')}` : ''}`,
      // A voice being designed for the character is put into it once made: it would have nowhere to go.
      refusal: async () =>
        exists("SELECT 1 FROM media_jobs WHERE asset_id = ? AND status = 'running'", id)
          ? `A voice is being created for ${q(asset.name)} right now. Wait until it is done.`
          : undefined,
      snapshot: async () => {
        const now = assetRow(id)
        return JSON.stringify(
          now
            ? [
                now.updated_at,
                now.name,
                // Ids, not paths: "Tidy up" may move the files without changing what is removed.
                imageRows(id).map((f) => f.id),
                audioRows(id).map((f) => f.id),
                rows("SELECT id FROM assets WHERE default_outfit_id = ? ORDER BY id", id)
              ]
            : 'gone'
        )
      },
      present: () => !!assetRow(id),
      run: () => callApproved('assets:delete', id)
    }
  )
}

async function planAssetFile(input: DeleteInput, id: string, audio: boolean): Promise<Planned> {
  const table = audio ? 'asset_audio' : 'asset_images'
  const file =
    row<FileRow & { name: string; kind: string; clone_consent_at?: number | null; duration?: number }>(
      `SELECT f.id, f.asset_id, f.file_path, f.position, a.name, a.kind${audio ? ', f.clone_consent_at, f.duration' : ''}
       FROM ${table} f JOIN assets a ON a.id = f.asset_id WHERE f.id = ?`,
      id
    ) ?? refuse(audio ? `There is no sound clip with id ${id}.` : `There is no photo with id ${id}.`)
  const siblings = audio ? audioRows(file.asset_id) : imageRows(file.asset_id)
  const number = siblings.findIndex((f) => f.id === id) + 1
  const used = usedOutsideAsset(file.file_path)
  const kind = kindOf(file.kind)
  const effects = [
    used
      ? `The ${audio ? 'sound clip' : 'photo'} is used by clips and kept in “Referensbilder”`
      : `The file is moved to ${TRASH}`
  ]
  if (number === 1 && siblings.length > 1) {
    effects.push(
      audio
        ? `Sound clip 2 becomes the ${kind === 'character' ? 'voice' : 'sound'} that comes with ${lowerFirst(theOf(file.kind))}`
        : 'Photo 2 becomes the cover'
    )
  }
  if (audio && file.clone_consent_at) effects.push('Your OK to clone the voice goes with it')
  return planned(
    input,
    {
      kind: audio ? 'asset-audio' : 'asset-image',
      id,
      label: `${audio ? 'Sound clip' : 'Photo'} ${number} of ${q(file.name)}`,
      group: audio ? 'Sound clips' : 'Photos',
      // A sound clip is told by its file and length, and can be played in the dialog: its number alone doesn't
      // say which recording goes.
      ...(audio
        ? { sound: { path: fromStoredPath(file.file_path), duration: file.duration ?? 0 } }
        : { preview: fromStoredPath(file.file_path) }),
      ...(kind ? { assetKind: kind } : {}),
      effects,
      trash: { files: used ? 0 : 1 }
    },
    {
      within: [`asset:${file.asset_id}`],
      owner: file.name,
      refusal: none,
      // The file by identity (renaming the asset moves it unchanged), its number and its asset's name (the label).
      snapshot: async () => {
        const now = row<FileRow & { name: string }>(
          `SELECT f.id, f.asset_id, f.file_path, f.position, a.name FROM ${table} f JOIN assets a ON a.id = f.asset_id
           WHERE f.id = ?`,
          id
        )
        const order = now ? (audio ? audioRows(now.asset_id) : imageRows(now.asset_id)).map((f) => f.id) : []
        return JSON.stringify(
          now
            ? [now.asset_id, now.name, fileIdentity(fromStoredPath(now.file_path)), order.indexOf(id), order.length]
            : 'gone'
        )
      },
      present: () => exists(`SELECT 1 FROM ${table} WHERE id = ?`, id),
      run: () => callApproved(audio ? 'assets:removeAudio' : 'assets:removeImage', id)
    }
  )
}

interface PromptRow {
  title: string
  body: string
  negative_prompt: string | null
  tags: string
  favorite: number
}

async function planPrompt(input: DeleteInput, id: string): Promise<Planned> {
  const read = (): PromptRow | undefined =>
    row<PromptRow>('SELECT title, body, negative_prompt, tags, favorite FROM prompts WHERE id = ?', id)
  const prompt = read() ?? refuse(`There is no saved prompt with id ${id}.`)
  return planned(
    input,
    {
      kind: 'prompt',
      id,
      label: `The prompt ${q(excerpt(prompt.title, 60))}`,
      group: 'Prompts',
      text: excerpt(prompt.body, 200),
      effects: []
    },
    {
      within: [],
      refusal: none,
      // Its content, not updated_at: using a prompt in Generate (prompts:markUsed) touches that without changing it.
      snapshot: async () => {
        const now = read()
        return JSON.stringify(now ? [now.title, now.body, now.negative_prompt, now.tags, now.favorite] : 'gone')
      },
      present: () => !!read(),
      run: () => callApproved('prompts:delete', id)
    }
  )
}

interface LearningRow {
  title: string
  insight: string
  author: string
  pinned: number
  updated_at: number
}

async function planLearning(input: DeleteInput, id: string): Promise<Planned> {
  const read = (): LearningRow | undefined =>
    row<LearningRow>('SELECT title, insight, author, pinned, updated_at FROM learnings WHERE id = ?', id)
  const learning = read() ?? refuse(`There is no learning with id ${id}.`)
  return planned(
    input,
    {
      kind: 'learning',
      id,
      label: `The learning ${q(excerpt(learning.title, 60))} (by ${learning.author})`,
      group: 'Learnings',
      text: excerpt(learning.insight, 200),
      effects: []
    },
    {
      within: [],
      // One the user wrote or edited (saveLearning makes it theirs) or pinned is the user's to keep (D10).
      refusal: async () => {
        const now = read()
        return now && (now.author === 'user' || now.pinned) ? USER_LEARNING : undefined
      },
      snapshot: async () => {
        const now = read()
        return JSON.stringify(now ? [now.updated_at, now.author, now.pinned] : 'gone')
      },
      present: () => !!read(),
      run: () => callApproved('learnings:delete', id)
    }
  )
}

interface ReviewRow {
  generation_id: string
  author: string
  rating: number | null
  note: string
  updated_at: number
}

async function planReview(input: DeleteInput, id: string): Promise<Planned> {
  const read = (): ReviewRow | undefined =>
    row<ReviewRow>('SELECT generation_id, author, rating, note, updated_at FROM generation_reviews WHERE id = ?', id)
  const review = read() ?? refuse(`There is no review with id ${id}.`)
  const g = db.getGeneration(review.generation_id)
  // The grade as the approval shows it: "Thumbs down", "2 stars".
  const what = review.rating ? `${ratingLabel(review.rating)}${review.note.trim() ? ' · ' : ''}` : ''
  return planned(
    input,
    {
      kind: 'review',
      id,
      label: `The review by ${review.author === 'user' ? 'the user' : agentInSentence(review.author)} of ${q(g ? generationTitle(g, 40) : 'a video')}`,
      group: 'Reviews',
      ...(g?.thumbPath ? { preview: g.thumbPath } : {}),
      text: excerpt(`${what}${review.note}`, 200),
      effects: []
    },
    {
      within: [`generation:${review.generation_id}`],
      refusal: async () => (read()?.author === 'user' ? USER_REVIEW : undefined),
      snapshot: async () => {
        const now = read()
        return JSON.stringify(now ? [now.updated_at, now.author] : 'gone')
      },
      present: () => !!read(),
      run: () => callApproved('reviews:delete', id)
    }
  )
}

const RUNNING = (name: string): string =>
  `“Generate missing” is running in ${q(name)} – wait until the run is done or stop it.`

/**
 * RUNNING when "Generate missing" (or a storyboard's run) goes on in any of these sequences or storyboards (ids),
 * else undefined. A run re-reads which clips are missing at every step, so a take or video removed under it would be
 * generated again – paid, and not what the user approved.
 */
async function runningIn(sequenceIds: Iterable<string>, r: Reader): Promise<string | undefined> {
  for (const id of new Set(sequenceIds)) {
    const seq = store.getSequenceRow(id)
    if (!seq) continue
    const now = store.kindOf(seq) === 'storyboard' ? await r.storyboard(id) : await r.sequence(id)
    if (now?.running) return RUNNING(seq.name)
  }
  return undefined
}

/** How many takes the segments have (the videos that become ordinary generations with them). */
const takeCount = (segmentIds: readonly string[]): number => store.takeIdsForSegments([...segmentIds]).length

async function planSequence(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const seqRow = store.getSequenceRow(id) ?? refuse(`There is no sequence with id ${id}.`)
  if (store.kindOf(seqRow) === 'storyboard') return planStoryboard(input, id, r)
  const sequence = (await r.sequence(id)) ?? refuse(`The sequence ${q(seqRow.name)} couldn't be read.`)
  const segmentIds = store.listSegmentRows(id).map((s) => s.id)
  const takes = takeCount(segmentIds)
  const stills = store.listStillRows(id).length
  const exported = row<{ n: number }>('SELECT COUNT(*) AS n FROM exports WHERE sequence_id = ?', id)?.n ?? 0
  const effects: string[] = []
  if (takes) effects.push(takesToMedia(takes))
  if (stills) {
    effects.push(
      `${count(stills, 'still image', 'still images')} ${stills === 1 ? 'is' : 'are'} moved to ${TRASH} – whatever is used elsewhere is kept in “Referensbilder”`
    )
  }
  if (exported) effects.push(exported === 1 ? 'The exported film stays' : 'The exported films stay')
  const clips = count(segmentIds.length, 'clip', 'clips')
  const firstTake = sequence.segments.map((s) => s.takes.find((t) => t.id === s.selectedGenerationId)).find(Boolean)
  return planned(
    input,
    {
      kind: 'sequence',
      id,
      label: `The sequence ${q(seqRow.name)} (${clips})`,
      group: 'Sequences',
      ...(firstTake?.thumbPath ? { preview: firstTake.thumbPath } : {}),
      effects,
      trash: { files: stills },
      container: true
    },
    {
      within: [],
      owner: seqRow.name,
      phrase: `the sequence ${q(seqRow.name)} with ${clips}`,
      refusal: async (rr) => ((await rr.sequence(id))?.running ? RUNNING(seqRow.name) : undefined),
      snapshot: async () => {
        const now = store.getSequenceRow(id)
        const ids = store.listSegmentRows(id).map((s) => s.id)
        return JSON.stringify(
          now ? [now.updated_at, now.name, ids, takeCount(ids), store.listStillRows(id).length] : 'gone'
        )
      },
      present: () => !!store.getSequenceRow(id),
      run: () => callApproved('sequences:delete', id)
    }
  )
}

async function planSegment(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const seg = store.getSegmentRow(id) ?? refuse(`There is no clip with id ${id}.`)
  const seqRow = store.getSequenceRow(seg.sequence_id) ?? refuse(`There is no clip with id ${id}.`)
  if (seg.from_board_id || store.kindOf(seqRow) === 'storyboard') refuse(TRANSITION_AS_CLIP)
  const sequence = (await r.sequence(seqRow.id)) ?? refuse(`The sequence ${q(seqRow.name)} couldn't be read.`)
  const all = store.listSegmentRows(seqRow.id)
  const i = all.findIndex((s) => s.id === id)
  const n = i + 1
  const next = all[i + 1]
  const previous = all[i - 1]
  const takes = takeCount([id])
  const effects: string[] = []
  if (takes) effects.push(takesToMedia(takes))
  if (next?.continue_from_previous) {
    effects.push(
      i > 0
        ? `Clip ${n + 1} continues from this clip – afterwards it continues from clip ${n - 1}`
        : `Clip ${n + 1} continues from this clip – afterwards it needs a start image of its own`
    )
  }
  if (previous?.end_from_next) {
    effects.push(
      next
        ? `Clip ${n - 1} ends on this clip's first frame – afterwards it ends on the first frame of clip ${n + 1}`
        : `Clip ${n - 1} ends on this clip's first frame – afterwards it needs an end image of its own`
    )
  }
  const segment = sequence.segments.find((s) => s.id === id)
  const take = segment?.takes.find((t) => t.id === segment.selectedGenerationId)
  const preview = take?.thumbPath ?? segment?.params.startImage
  return planned(
    input,
    {
      kind: 'segment',
      id,
      label: `Clip ${n} in ${q(seqRow.name)}`,
      group: 'Clips',
      ...(preview ? { preview } : {}),
      effects
    },
    {
      within: [`sequence:${seqRow.id}`],
      owner: seqRow.name,
      refusal: async (rr) => ((await rr.sequence(seqRow.id))?.running ? RUNNING(seqRow.name) : undefined),
      snapshot: async () => {
        const now = store.getSegmentRow(id)
        if (!now) return 'gone'
        const order = store.listSegmentRows(now.sequence_id)
        const at = order.findIndex((s) => s.id === id)
        return JSON.stringify([
          now.sequence_id,
          now.params,
          now.notes,
          at,
          now.selected_generation_id,
          now.continue_from_previous,
          now.end_from_next,
          store.takeIdsForSegments([id]),
          order[at - 1]?.end_from_next ?? null,
          order[at + 1]?.continue_from_previous ?? null,
          order.length
        ])
      },
      present: () => !!store.getSegmentRow(id),
      run: () => callApproved('segments:delete', id)
    }
  )
}

/** The storyboard's state a board or a move is planned against: its boards in order and its transitions. */
function storyboardState(storyboardId: string): string {
  const boards = rows<{ id: string; image_path: string | null; note: string }>(
    'SELECT id, image_path, note FROM storyboard_boards WHERE sequence_id = ? ORDER BY position, created_at',
    storyboardId
  )
  const transitions = store
    .listSegmentRows(storyboardId)
    .map((s) => [s.id, s.from_board_id, s.to_board_id, s.params, s.selected_generation_id, takeCount([s.id])])
  return JSON.stringify([boards, transitions])
}

const hasPrompt = (p: { prompt?: string; negativePrompt?: string }): boolean =>
  !!p.prompt?.trim() || !!p.negativePrompt?.trim()

async function planStoryboard(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const sbRow = store.getSequenceRow(id) ?? refuse(`There is no storyboard with id ${id}.`)
  if (store.kindOf(sbRow) !== 'storyboard') return planSequence(input, id, r)
  const storyboard = (await r.storyboard(id)) ?? refuse(`The storyboard ${q(sbRow.name)} couldn't be read.`)
  const takes = takeCount(storyboard.transitions.map((t) => t.id))
  const stills = store.listStillRows(id).length
  const exported = row<{ n: number }>('SELECT COUNT(*) AS n FROM exports WHERE sequence_id = ?', id)?.n ?? 0
  const effects: string[] = []
  const prompts = storyboard.transitions.filter((t) => hasPrompt(t.params)).length
  if (prompts) effects.push(`${count(prompts, 'transition', 'transitions')} with a prompt ${prompts === 1 ? 'is' : 'are'} lost`)
  if (takes) effects.push(takesToMedia(takes))
  if (stills) {
    effects.push(
      `${count(stills, 'image', 'images')} ${stills === 1 ? 'is' : 'are'} moved to ${TRASH} – whatever is used elsewhere is kept in “Referensbilder”`
    )
  }
  if (exported) effects.push(exported === 1 ? 'The exported film stays' : 'The exported films stay')
  const boards = count(storyboard.boards.length, 'board', 'boards')
  const preview = storyboard.boards.find((b) => b.imagePath)?.imagePath
  return planned(
    input,
    {
      kind: 'storyboard',
      id,
      label: `The storyboard ${q(sbRow.name)} (${boards})`,
      group: 'Storyboards',
      ...(preview ? { preview } : {}),
      effects,
      trash: { files: stills },
      container: true
    },
    {
      within: [],
      owner: sbRow.name,
      phrase: `the storyboard ${q(sbRow.name)} with ${boards}`,
      refusal: async (rr) => ((await rr.storyboard(id))?.running ? RUNNING(sbRow.name) : undefined),
      snapshot: async () => {
        const now = store.getSequenceRow(id)
        return JSON.stringify(now ? [now.name, storyboardState(id), store.listStillRows(id).length] : 'gone')
      },
      present: () => !!store.getSequenceRow(id),
      run: () => callApproved('storyboards:delete', id)
    }
  )
}

interface BoardRow {
  id: string
  sequence_id: string
  position: number
  image_path: string | null
  still_id: string | null
}

const boardRow = (id: string): BoardRow | undefined =>
  row<BoardRow>('SELECT id, sequence_id, position, image_path, still_id FROM storyboard_boards WHERE id = ?', id)

/** "Transition 2" / "Transitions 2 and 3". */
const transitionsText = (numbers: readonly number[]): string =>
  numbers.length === 1 ? `Transition ${numbers[0]}` : `Transitions ${andList(numbers.map(String))}`

async function planBoard(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const board = boardRow(id) ?? refuse(`There is no board with id ${id}.`)
  const storyboard = (await r.storyboard(board.sequence_id)) ?? refuse('The storyboard couldn\'t be read.')
  const i = storyboard.boards.findIndex((b) => b.id === id)
  const shown = storyboard.boards[i]
  const adjacent = storyboard.transitions
    .map((t, index) => ({ t, number: index + 1 }))
    .filter(({ t }) => t.fromBoardId === id || t.toBoardId === id)
  const lost = adjacent.filter(({ t }) => hasPrompt(t.params) || t.takes.length > 0)
  const takes = adjacent.reduce((sum, { t }) => sum + t.takes.length, 0)
  const effects: string[] = []
  if (lost.length) {
    const prompts = lost.some(({ t }) => hasPrompt(t.params))
    effects.push(
      `${transitionsText(lost.map((x) => x.number))} ${lost.length === 1 ? 'is' : 'are'} lost${prompts ? (lost.length === 1 ? ' with its prompt' : ' with their prompts') : ''}`
    )
  }
  if (takes) effects.push(takesToMedia(takes))
  if (i > 0 && i < storyboard.boards.length - 1) effects.push(`Board ${i} and board ${i + 2} get a new, empty transition`)
  if (shown?.stillId) effects.push('The picture stays among the storyboard\'s images')
  return planned(
    input,
    {
      kind: 'board',
      id,
      label: `Board ${i + 1} in ${q(storyboard.name)}`,
      group: 'Boards',
      ...(shown?.imagePath ? { preview: shown.imagePath } : {}),
      effects
    },
    {
      within: [`storyboard:${storyboard.id}`],
      owner: storyboard.name,
      storyboardId: storyboard.id,
      refusal: async (rr) => ((await rr.storyboard(board.sequence_id))?.running ? RUNNING(storyboard.name) : undefined),
      snapshot: async () => {
        const now = boardRow(id)
        return JSON.stringify(now ? [now.sequence_id, now.still_id, storyboardState(now.sequence_id)] : 'gone')
      },
      present: () => !!boardRow(id),
      run: () => callApproved('boards:delete', id)
    }
  )
}

/** What a board move would remove (StoryboardService.moveLoss). */
interface MoveLoss {
  transitions: { id: string; number: number; prompt: string; negativePrompt?: string; takeCount: number; selected: boolean }[]
}

async function planBoardMove(input: DeleteInput, id: string, toNumber: number, r: Reader): Promise<Planned> {
  const board = boardRow(id) ?? refuse(`There is no board with id ${id}.`)
  const storyboard = (await r.storyboard(board.sequence_id)) ?? refuse('The storyboard couldn\'t be read.')
  const i = storyboard.boards.findIndex((b) => b.id === id)
  const total = storyboard.boards.length
  if (toNumber > total) refuse(`Place ${toNumber} doesn't exist – the storyboard has ${count(total, 'board', 'boards')}.`)
  const toIndex = toNumber - 1
  const loss = (): Promise<MoveLoss> => callService<MoveLoss>('boards:moveLoss', id, toIndex)
  const lost = (await loss()).transitions.filter((t) => hasPrompt(t) || t.takeCount > 0)
  if (!lost.length) refuse(MOVE_REMOVES_NOTHING)
  const effects = lost.map(
    (t) =>
      `Transition ${t.number}${t.prompt.trim() ? ` (${q(excerpt(t.prompt, 40))})` : ''} is lost${hasPrompt(t) ? ' with its prompt' : ''}`
  )
  const takes = lost.reduce((sum, t) => sum + t.takeCount, 0)
  if (takes) effects.push(takesToMedia(takes))
  effects.push('The boards that end up next to each other get new, empty transitions')
  const shown = storyboard.boards[i]
  return planned(
    input,
    {
      kind: 'board-move',
      id,
      toIndex,
      label: `Move board ${i + 1} to place ${toNumber} in ${q(storyboard.name)}`,
      group: 'Moves',
      ...(shown?.imagePath ? { preview: shown.imagePath } : {}),
      effects
    },
    {
      within: [`storyboard:${storyboard.id}`, `board:${id}`],
      owner: storyboard.name,
      storyboardId: storyboard.id,
      refusal: async (rr) => ((await rr.storyboard(board.sequence_id))?.running ? RUNNING(storyboard.name) : undefined),
      snapshot: async () => {
        const now = boardRow(id)
        if (!now) return 'gone'
        const after = await loss().catch(() => undefined)
        return JSON.stringify([now.sequence_id, storyboardState(now.sequence_id), after?.transitions ?? 'unknown'])
      },
      present: () => !!boardRow(id),
      run: () => callApproved('boards:move', id, toIndex)
    }
  )
}

/** Where a generation is somebody's selected take, as the dialog names it. */
interface Selection {
  id: string
  sequence_id: string
  position: number
  from_board_id: string | null
  name: string
}

const selectionsOf = (generationId: string): Selection[] =>
  rows<Selection>(
    `SELECT s.id, s.sequence_id, s.position, s.from_board_id, q.name
     FROM segments s JOIN sequences q ON q.id = s.sequence_id
     WHERE s.selected_generation_id = ? ORDER BY q.name, s.position`,
    generationId
  )

/** "It is selected in clip 3 in “Sommar” – the clip is left without a selected take", and the transition's fallback. */
function selectionEffect(s: Selection, generationId: string, here = false): string {
  const where = here ? '' : ` in ${s.from_board_id ? 'transition' : 'clip'} ${s.position + 1} in ${q(s.name)}`
  if (!s.from_board_id) return `It is selected${where || ' in the clip'} – the clip is left without a selected take`
  // A transition falls back on its newest other finished take (reselectTransitionTake).
  const other = exists(
    "SELECT 1 FROM generations WHERE segment_id = ? AND id != ? AND status = 'completed' AND file_path IS NOT NULL",
    s.id,
    generationId
  )
  return `It is selected${where || ' in the transition'} – the transition ${other ? 'then uses another of its takes' : 'is left without a take'}`
}

const generationPending = (status: string | undefined): boolean => status === 'queued' || status === 'processing'

async function planGeneration(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const g = db.getGeneration(id) ?? refuse(`There is no video with id ${id}.`)
  // A version made in the Editor is removed the way the Editor removes versions (its children move up, the edit's
  // current falls back on its parent).
  if (g.source === 'edit' && g.editId && exists('SELECT 1 FROM edits WHERE id = ?', g.editId)) {
    return planVersion(input, id, r)
  }
  const segment = g.segmentId ? store.getSegmentRow(g.segmentId) : undefined
  const owner = segment ? store.getSequenceRow(segment.sequence_id) : undefined
  const transition = !!segment?.from_board_id
  const reviews =
    row<{ n: number }>('SELECT COUNT(*) AS n FROM generation_reviews WHERE generation_id = ?', id)?.n ?? 0
  const effects = selectionsOf(id).map((s) => selectionEffect(s, id, s.id === segment?.id))
  if (reviews) effects.push(`${count(reviews, 'review', 'reviews')} ${reviews === 1 ? 'is' : 'are'} removed with it`)
  // An import's untouched original goes too, unless another row still records it (a copy of the take elsewhere).
  const original =
    !!g.originalPath &&
    !exists(
      'SELECT 1 FROM generations WHERE original_path = (SELECT original_path FROM generations WHERE id = ?) AND id != ?',
      id,
      id
    )
  effects.push(original ? `The file and the original file are moved to ${TRASH}` : `The file is moved to ${TRASH}`)
  const label =
    segment && owner
      ? `The take ${clock(g.createdAt)} of ${transition ? 'transition' : 'clip'} ${segment.position + 1} in ${q(owner.name)}`
      : `The video ${q(generationTitle(g, 40))}`
  return planned(
    input,
    {
      kind: 'generation',
      id,
      label,
      group: segment ? 'Takes' : 'Videos',
      ...(g.thumbPath ? { preview: g.thumbPath } : {}),
      effects,
      trash: { files: g.filePath ? (original ? 2 : 1) : 0 }
    },
    {
      within: [],
      ...(owner ? { owner: owner.name } : {}),
      refusal: async (rr) => {
        const now = db.getGeneration(id)
        if (!now) return undefined
        if (generationPending(now.status)) return 'The video is still being generated – it can be removed when it is done.'
        // Its own clip's run, and every run where it is somebody's selected take.
        const own = now.segmentId ? store.getSegmentRow(now.segmentId)?.sequence_id : undefined
        const running = await runningIn([...(own ? [own] : []), ...selectionsOf(id).map((s) => s.sequence_id)], rr)
        return running ?? deleteRefusal(id)
      },
      snapshot: async () => {
        const now = db.getGeneration(id)
        return JSON.stringify(
          now
            ? [
                now.status,
                fileIdentity(now.filePath),
                now.segmentId ?? null,
                now.editId ?? null,
                selectionsOf(id).map((s) => s.id)
              ]
            : 'gone'
        )
      },
      present: () => !!db.getGeneration(id),
      run: () => callApproved('generations:delete', id)
    }
  )
}

async function planTake(input: DeleteInput, generationId: string, segmentId: string): Promise<Planned> {
  const g = db.getGeneration(generationId) ?? refuse(`There is no video with id ${generationId}.`)
  const segment = store.getSegmentRow(segmentId) ?? refuse(`There is no clip or transition with id ${segmentId}.`)
  const owner = store.getSequenceRow(segment.sequence_id) ?? refuse(`There is no clip with id ${segmentId}.`)
  const transition = !!segment.from_board_id
  const where = `${transition ? 'transition' : 'clip'} ${segment.position + 1}`
  /** Still a take of the clip: one of its takes, or its selected one (a version sent there from the Editor). */
  const isTake = (): boolean => {
    const now = db.getGeneration(generationId)
    const seg = store.getSegmentRow(segmentId)
    return !!now && !!seg && (now.segmentId === seg.id || seg.selected_generation_id === now.id)
  }
  if (!isTake()) refuse(`${q(generationTitle(g, 40))} is not a take of ${where} in ${q(owner.name)}.`)
  const home = g.source === 'edit' ? 'the Editor' : 'Media'
  const effects =
    segment.selected_generation_id === generationId
      ? [
          selectionEffect(
            { id: segment.id, sequence_id: owner.id, position: segment.position, from_board_id: segment.from_board_id ?? null, name: owner.name },
            generationId,
            true
          )
        ]
      : []
  return planned(
    input,
    {
      kind: 'take',
      id: generationId,
      segmentId,
      label: `Remove the take ${clock(g.createdAt)} from ${where} in ${q(owner.name)} (the film stays in ${home})`,
      group: 'Takes',
      ...(g.thumbPath ? { preview: g.thumbPath } : {}),
      effects
    },
    {
      within: [
        `generation:${generationId}`,
        `segment:${segmentId}`,
        `${transition ? 'storyboard' : 'sequence'}:${owner.id}`,
        // A transition goes with either of its boards; its takes become ordinary generations then anyway.
        ...(segment.from_board_id ? [`board:${segment.from_board_id}`] : []),
        ...(segment.to_board_id ? [`board:${segment.to_board_id}`] : [])
      ],
      owner: owner.name,
      refusal: async (rr) => {
        if (generationPending(db.getGeneration(generationId)?.status)) {
          return 'The take is still being generated – it can be removed when it is done.'
        }
        const seg = store.getSegmentRow(segmentId)
        return seg ? runningIn([seg.sequence_id], rr) : undefined
      },
      snapshot: async () => {
        const now = db.getGeneration(generationId)
        const seg = store.getSegmentRow(segmentId)
        return JSON.stringify(
          now && seg
            ? [now.status, fileIdentity(now.filePath), now.segmentId ?? null, seg.selected_generation_id, seg.position]
            : 'gone'
        )
      },
      present: isTake,
      run: () => callApproved('generations:delete', generationId, { segmentId, release: true })
    }
  )
}

async function planStill(input: DeleteInput, id: string): Promise<Planned> {
  const still = store.getStillRow(id) ?? refuse(`There is no still image with id ${id}.`)
  const path = fromStoredPath(still.file_path)
  const used = db.isStoredPathRecorded(still.file_path, { ignoreStillId: id })
  const boards = rows<{ position: number; name: string }>(
    `SELECT b.position, q.name FROM storyboard_boards b JOIN sequences q ON q.id = b.sequence_id
     WHERE b.image_path = ? COLLATE NOCASE ORDER BY q.name, b.position`,
    still.file_path
  )
  const clips = clipsUsing(still.file_path)
  const uses = [
    ...boards.slice(0, 2).map((b) => `board ${b.position + 1} in ${q(b.name)}`),
    boards.length > 2 ? count(boards.length - 2, 'more board', 'more boards') : '',
    clips ? count(clips, 'clip', 'clips') : ''
  ].filter(Boolean)
  const effects = used
    ? [
        uses.length
          ? `It is used by ${andList(uses)} and kept in “Referensbilder”`
          : 'It is used elsewhere and kept in “Referensbilder”',
        ...(boards.length ? [boards.length === 1 ? 'The board keeps the picture' : 'The boards keep the picture'] : [])
      ]
    : [`The file is moved to ${TRASH}`]
  const owner = still.sequence_id ? store.getSequenceRow(still.sequence_id) : undefined
  return planned(
    input,
    {
      kind: 'still',
      id,
      label: still.prompt.trim() ? `The still image ${q(excerpt(still.prompt, 40))}` : `The still image ${basename(path)}`,
      group: 'Still images',
      preview: path,
      effects,
      trash: { files: used ? 0 : 1 }
    },
    {
      within: [],
      ...(owner ? { owner: owner.name } : {}),
      refusal: none,
      // The file by identity, not by path: a renamed sequence or "Tidy up" moves it without changing it.
      snapshot: async () => {
        const now = store.getStillRow(id)
        return JSON.stringify(
          now
            ? [
                now.sequence_id,
                fileIdentity(fromStoredPath(now.file_path)),
                db.isStoredPathRecorded(now.file_path, { ignoreStillId: id })
              ]
            : 'gone'
        )
      },
      present: () => !!store.getStillRow(id),
      run: () => callApproved('stills:delete', id)
    }
  )
}

/** An Editor job that runs right now in the edit (a free render counts: EditSummary.running). */
const editBusy = (edit: Edit): boolean => edit.running || edit.jobs.some((j) => j.status === 'running')

const EDIT_BUSY = (name: string): string =>
  `An operation is running in the edit ${q(name)}. Wait until it is done (or cancel it), then ask again.`

/** An edit's state that removing it (or its versions) depends on. */
const editState = (edit: Edit): string =>
  JSON.stringify([
    edit.name,
    edit.currentId ?? null,
    edit.versions.map((v) => [v.id, v.parentId ?? null, v.usedBy.length]),
    edit.takes.map((t) => t.id)
  ])

async function planEdit(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const edit = (await r.edit(id)) ?? refuse(`There is no edit with id ${id}.`)
  const own = edit.versions.filter((v) => v.generation.editId === edit.id)
  const kept = own.filter((v) => v.usedBy.length > 0)
  const trashed = own.length - kept.length
  const effects: string[] = []
  if (kept.length) {
    effects.push(
      kept.length === 1 ? 'The version used in a sequence is kept' : 'The versions used in sequences are kept'
    )
  }
  if (trashed) effects.push(`${count(trashed, 'version', 'versions')} ${trashed === 1 ? 'is' : 'are'} moved to ${TRASH} with the folder`)
  if (edit.takes.length) effects.push(`${count(edit.takes.length, 'AI take', 'AI takes')} ${edit.takes.length === 1 ? 'stays' : 'stay'} in Media`)
  for (const job of edit.jobs) {
    if ((job.status === 'failed' || job.status === 'cancelled') && job.canResume && job.costUsd > 0) {
      effects.push(`The job ${q(job.label)} has already paid ${usd(job.costUsd)} and can't be continued once the edit is gone`)
    }
  }
  if (edit.origin.kind === 'generation' || edit.origin.kind === 'export' || edit.origin.kind === 'take') {
    effects.push('The film the edit started from is left untouched')
  }
  const versions = count(edit.versions.length, 'version', 'versions')
  return planned(
    input,
    {
      kind: 'edit',
      id,
      label: `The edit ${q(edit.name)} (${versions})`,
      group: 'Edits',
      ...(edit.posterPath ? { preview: edit.posterPath } : {}),
      effects,
      trash: { files: trashed },
      container: true
    },
    {
      within: [],
      owner: edit.name,
      phrase: `the edit ${q(edit.name)} with ${versions}`,
      refusal: async (rr) => {
        const now = await rr.edit(id)
        return now && editBusy(now) ? EDIT_BUSY(now.name) : undefined
      },
      snapshot: async (rr) => {
        const now = await rr.edit(id)
        return now ? editState(now) : 'gone'
      },
      present: () => exists('SELECT 1 FROM edits WHERE id = ?', id),
      run: () => callApproved('edits:delete', id)
    }
  )
}

async function planVersion(input: DeleteInput, id: string, r: Reader): Promise<Planned> {
  const g = db.getGeneration(id) ?? refuse(`There is no version with id ${id}.`)
  if (g.source !== 'edit' || !g.editId) {
    refuse(`${q(generationTitle(g, 40))} is not a version in the Editor – ask for {generation_id} instead.`)
  }
  const edit = (await r.edit(g.editId!)) ?? refuse(`There is no version with id ${id}.`)
  const v = edit.versions.find((x) => x.id === id) ?? refuse(`There is no version with id ${id}.`)
  const effects: string[] = []
  if (v.current) {
    const parent = edit.versions.find((x) => x.id === v.parentId)
    effects.push(`It is the current version – ${parent ? `v${parent.number}` : 'the original'} becomes current`)
  }
  const children = edit.versions.filter((x) => x.parentId === id).length
  if (children) {
    effects.push(
      `${count(children, 'version', 'versions')} made from it ${children === 1 ? 'moves' : 'move'} up one step in the tree`
    )
  }
  effects.push(`The file is moved to ${TRASH}`)
  return planned(
    input,
    {
      kind: 'version',
      id,
      label: `Version v${v.number} of ${q(edit.name)}`,
      group: 'Versions',
      ...(g.thumbPath ? { preview: g.thumbPath } : {}),
      effects,
      trash: { files: 1 }
    },
    {
      within: [`edit:${edit.id}`],
      owner: edit.name,
      refusal: async (rr) => {
        if (!db.getGeneration(id)) return undefined
        // A version sent to a clip as its take: not under a run that would make the clip again.
        return (await runningIn(selectionsOf(id).map((s) => s.sequence_id), rr)) ?? deleteRefusal(id)
      },
      snapshot: async (rr) => {
        const now = db.getGeneration(id)
        const e = now?.editId ? await rr.edit(now.editId) : undefined
        return now && e ? JSON.stringify([fileIdentity(now.filePath), editState(e)]) : 'gone'
      },
      present: () => !!db.getGeneration(id),
      run: () => callApproved('edits:deleteVersion', id)
    }
  )
}

async function planPrune(input: DeleteInput, editId: string, r: Reader): Promise<Planned> {
  const edit = (await r.edit(editId)) ?? refuse(`There is no edit with id ${editId}.`)
  // The dry run is read-only; Studio lets agents ask it (the real clean-up is only the user's, or approved).
  const dry = (): Promise<{ count: number; bytes: number }> =>
    callService<{ count: number; bytes: number }>('edits:prune', editId, true)
  const found = await dry()
  return planned(
    input,
    {
      kind: 'prune-versions',
      id: editId,
      label: `Clean up versions in ${q(edit.name)} (${count(found.count, 'version', 'versions')} · ${formatBytes(found.bytes)})`,
      group: 'Clean up versions',
      effects: [
        'The original, the current version and the versions it builds on are kept, as are those used in sequences or by other edits',
        found.count === 1 ? `The file is moved to ${TRASH}` : `The files are moved to ${TRASH}`
      ],
      trash: { files: found.count, bytes: found.bytes }
    },
    {
      within: [`edit:${editId}`],
      owner: edit.name,
      refusal: async (rr) => {
        const now = await rr.edit(editId)
        if (!now) return undefined
        return (await dry()).count === 0 ? `There are no versions to clean up in ${q(now.name)}.` : undefined
      },
      snapshot: async (rr) => {
        const now = await rr.edit(editId)
        if (!now) return 'gone'
        const again = await dry().catch(() => undefined)
        return JSON.stringify([editState(now), again?.count ?? null, again?.bytes ?? null])
      },
      present: () => exists('SELECT 1 FROM edits WHERE id = ?', editId),
      run: () => callApproved('edits:prune', editId, false)
    }
  )
}

/** Plans one item as the agent named it. Throws when it can't be asked for at all. */
function planItem(input: DeleteInput, r: Reader): Promise<Planned> {
  if ('asset_id' in input) return planAsset(input, input.asset_id)
  if ('asset_image_id' in input) return planAssetFile(input, input.asset_image_id, false)
  if ('asset_audio_id' in input) return planAssetFile(input, input.asset_audio_id, true)
  if ('prompt_id' in input) return planPrompt(input, input.prompt_id)
  if ('learning_id' in input) return planLearning(input, input.learning_id)
  if ('review_id' in input) return planReview(input, input.review_id)
  if ('sequence_id' in input) return planSequence(input, input.sequence_id, r)
  if ('segment_id' in input) return planSegment(input, input.segment_id, r)
  if ('storyboard_id' in input) return planStoryboard(input, input.storyboard_id, r)
  if ('board_id' in input) return planBoard(input, input.board_id, r)
  if ('board_move' in input) return planBoardMove(input, input.board_move.board_id, input.board_move.to_board_number, r)
  if ('generation_id' in input) return planGeneration(input, input.generation_id, r)
  if ('take' in input) return planTake(input, input.take.generation_id, input.take.segment_id)
  if ('still_id' in input) return planStill(input, input.still_id)
  if ('edit_id' in input) return planEdit(input, input.edit_id, r)
  if ('version_id' in input) return planVersion(input, input.version_id, r)
  return planPrune(input, input.prune_versions_of, r)
}

// ── The whole request ────────────────────────────────────────────────────────

interface Plan {
  items: Planned[]
  refused: { item: DeleteInput; label?: string; reason: string }[]
  folded: { item: DeleteInput; label: string; into: string }[]
}

/**
 * Plans every item, then what the request as a whole allows: duplicates and items another item removes anyway are
 * folded into it (before their own refusals are asked: what goes with its container needs nothing of its own), a
 * storyboard gets at most one move (each move's places depend on the one before), and nothing may be in another
 * pending delete request.
 */
async function planAll(inputs: readonly DeleteInput[], ctx: ToolContext): Promise<Plan> {
  const r = new Reader()
  const plan: Plan = { items: [], refused: [], folded: [] }
  const byKey = new Map<string, Planned>()
  for (const input of inputs) {
    try {
      const p = await planItem(input, r)
      const same = byKey.get(p.key)
      if (same) {
        plan.folded.push({ item: input, label: p.item.label, into: same.item.label })
        continue
      }
      byKey.set(p.key, p)
      plan.items.push(p)
    } catch (err) {
      plan.refused.push({ item: input, reason: errorText(err) })
    }
  }

  // Folded into what removes it anyway (a photo of a removed asset, a clip of a removed sequence …).
  const keep: Planned[] = []
  for (const p of plan.items) {
    const into = p.within.map((k) => byKey.get(k)).find((c): c is Planned => !!c && c !== p)
    if (into) plan.folded.push({ item: p.input, label: p.item.label, into: into.item.label })
    else keep.push(p)
  }
  plan.items = []
  for (const p of keep) {
    const reason = await p.refusal(r).catch((err: unknown) => errorText(err))
    if (reason) plan.refused.push({ item: p.input, label: p.item.label, reason })
    else plan.items.push(p)
  }

  // One move per storyboard, and none where boards of the same storyboard are removed in the same request.
  const moves = new Set<string>()
  const boardsRemoved = new Set(plan.items.filter((p) => p.item.kind === 'board').map((p) => p.storyboardId))
  plan.items = plan.items.filter((p) => {
    if (p.item.kind !== 'board-move' || !p.storyboardId) return true
    const reason = moves.has(p.storyboardId)
      ? ONE_MOVE
      : boardsRemoved.has(p.storyboardId)
        ? MOVE_WITH_BOARDS
        : undefined
    moves.add(p.storyboardId)
    if (reason) plan.refused.push({ item: p.input, label: p.item.label, reason })
    return !reason
  })

  // Nothing twice in requests waiting for the user: approving one would make the other lapse (or say "gone"). A
  // waiting request whose items changed since can never be approved: it lapses here, so asking again works.
  for (const request of ctx.approvals.list()) {
    if (request.status === 'pending' && request.kind === 'delete') await ctx.approvals.check(request.id)
  }
  const fingerprint = fingerprintOf(plan.items, await snapshots(plan.items, r))
  const same = ctx.approvals.findPending(fingerprint)
  const waiting = new Map<string, string>()
  for (const request of ctx.approvals.list()) {
    if (request.status !== 'pending' || request.kind !== 'delete' || request.id === same?.id) continue
    for (const item of request.delete?.items ?? []) waiting.set(deleteKey(item), request.id)
  }
  plan.items = plan.items.filter((p) => {
    const other = waiting.get(p.key)
    if (other) {
      plan.refused.push({
        item: p.input,
        label: p.item.label,
        reason: `${p.item.label} is already waiting for your OK in another request (${other}).`
      })
    }
    return !other
  })
  return plan
}

/** Every item's snapshot, in the request's order. */
async function snapshots(items: readonly Planned[], r: Reader): Promise<string[]> {
  const out: string[] = []
  for (const p of items) out.push(await p.snapshot(r))
  return out
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 20)

/**
 * The same items in the same state (each item's key and its snapshot, in any order): an identical pending request is
 * handed back instead of asking twice.
 */
function fingerprintOf(items: readonly Planned[], snaps: readonly string[]): string {
  const parts = items.map((p, i) => `${p.key}:${p.item.toIndex ?? ''}:${hash(snaps[i])}`)
  return `delete:${parts.sort().join(';')}`
}

/** "Delete 3 items in “Sommar”", "Delete the character “Anna”". */
function summaryOf(items: readonly Planned[]): string {
  if (items.length === 1) {
    const { kind, label } = items[0].item
    return kind === 'board-move' || kind === 'take' || kind === 'prune-versions' ? label : `Delete ${lowerFirst(label)}`
  }
  const owners = new Set(items.map((p) => p.owner))
  const owner = owners.size === 1 ? [...owners][0] : undefined
  return `Delete ${count(items.length, 'item', 'items')}${owner ? ` in ${q(owner)}` : ''}`
}

/** The second question: when a container (an asset, a sequence, a storyboard, an edit) or more than 5 items go. */
function confirmOf(items: readonly Planned[]): string | undefined {
  const phrases = items.filter((p) => p.item.container && p.phrase).map((p) => p.phrase!)
  if (!phrases.length && items.length <= 5) return undefined
  const shown = phrases.length > 3 ? [...phrases.slice(0, 3), `${phrases.length - 3} more`] : phrases
  if (items.length === 1) return `This removes ${shown[0]}. Continue?`
  const all = count(items.length, 'thing', 'things')
  return shown.length ? `This removes ${all}, among them ${andList(shown)}. Continue?` : `This removes ${all}. Continue?`
}

const byExecuteOrder = (a: Planned, b: Planned): number =>
  EXECUTE_ORDER.indexOf(a.item.kind) - EXECUTE_ORDER.indexOf(b.item.kind)

/** Removes every item with the user's authority, in EXECUTE_ORDER; each item ends deleted, gone or failed. */
async function executeAll(items: readonly Planned[]): Promise<ApprovalOutcome> {
  const outcomes = new Map<string, NonNullable<ApprovalDeleteItem['outcome']>>()
  // Array.prototype.sort is stable: items of one kind keep the agent's order.
  for (const p of [...items].sort(byExecuteOrder)) {
    if (!p.present()) {
      outcomes.set(p.key, { status: 'gone' })
      continue
    }
    try {
      await p.run()
      outcomes.set(p.key, { status: 'deleted' })
    } catch (err) {
      outcomes.set(p.key, { status: 'failed', error: errorText(err) })
    }
  }
  const deleteItems = items.map((p) => ({ ...p.item, outcome: outcomes.get(p.key) ?? { status: 'gone' as const } }))
  const failed = deleteItems.filter((i) => i.outcome.status === 'failed')
  const gone = deleteItems.filter((i) => i.outcome.status === 'gone')
  const deleted = deleteItems.length - failed.length - gone.length
  const failures = failed.map((i) => `${i.label}: ${i.outcome.error ?? 'unknown error'}`)
  if (!deleted) {
    return {
      deleteItems,
      failedError: failed.length
        ? `Nothing could be removed. ${failures.join(' ')}`
        : 'Nothing was removed – everything was already gone.'
    }
  }
  const notes = [
    failed.length ? `${count(failed.length, 'thing', 'things')} couldn't be removed: ${failures.join(' ')}` : '',
    gone.length ? `${count(gone.length, 'thing', 'things')} ${gone.length === 1 ? 'was' : 'were'} already gone.` : ''
  ].filter(Boolean)
  return { deleteItems, ...(notes.length ? { notice: notes.join(' ') } : {}) }
}

/** The answer's view of an item. */
function itemInfo(item: ApprovalDeleteItem): Record<string, unknown> {
  return {
    kind: item.kind,
    id: item.id,
    ...(item.segmentId ? { segment_id: item.segmentId } : {}),
    ...(item.toIndex !== undefined ? { to_board_number: item.toIndex + 1 } : {}),
    label: item.label,
    effects: item.effects,
    ...(item.trash?.files ? { trash: item.trash } : {}),
    ...(item.outcome ? { outcome: item.outcome.status, ...(item.outcome.error ? { error: item.outcome.error } : {}) } : {})
  }
}

/** get_approval's fields for a 'delete' request: what it removes, and – once approved – what became of each item. */
export function deleteApprovalInfo(request: ApprovalRequest): Record<string, unknown> {
  const d = request.delete
  if (!d) return {}
  const outcomes = d.items.map((i) => i.outcome?.status).filter(Boolean)
  return {
    summary: d.summary,
    items: d.items.map(itemInfo),
    ...(outcomes.length
      ? {
          outcome: {
            deleted: outcomes.filter((s) => s === 'deleted').length,
            gone: outcomes.filter((s) => s === 'gone').length,
            failed: outcomes.filter((s) => s === 'failed').length
          }
        }
      : {})
  }
}

export function registerDeleteTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    'request_delete',
    {
      title: 'Request removing things (needs approval)',
      description:
        `Asks the user to approve removing things from Studio – you can't delete anything yourself. Put every item in one request (1–50): {asset_id}, {asset_image_id} (a photo), {asset_audio_id} (a sound clip), {prompt_id}, {learning_id} and {review_id} (your own or another agent's – never the user's own review, nor a learning the user wrote, edited or pinned), {sequence_id}, {segment_id} (a sequence clip; a storyboard's transitions go with their boards), {storyboard_id}, {board_id}, {board_move: {board_id, to_board_number}} (a move that would drop a transition with a prompt or takes – move_board refuses those; one per storyboard per request), {generation_id} (a video and its file), {take: {generation_id, segment_id}} (takes a video off a clip or transition; the video stays), {still_id}, {edit_id}, {version_id} and {prune_versions_of: edit_id} (the Editor's \"Clean up versions\"). Studio plans every item first: what it is, what else changes (photos kept in \"Referensbilder\" for the clips that use them, takes that become ordinary generations, transitions lost with their prompts, a clip left without its selected take …) and what goes to ${TRASH}. An item another one removes anyway (a photo of an asset you also remove, a clip of a removed sequence) is folded into it. If any item can't be removed now, the whole call fails with every reason and nothing is asked. dry_run: true answers the plan without asking. Otherwise returns {approval_id, status: \"pending\", items}: the user sees the list in Studio and approves all or nothing. Poll get_approval every 15–30 seconds; each item ends deleted, gone (already removed) or failed. If anything in the request changes before the user answers, it lapses – ask again. Free. Prefer leaving a bad take unselected to deleting it.`,
      input: {
        items: z.array(deleteItem).min(1).max(MAX_ITEMS),
        note: z.string().max(500).optional().describe('Shown to the user in the approval dialog: why.'),
        dry_run: z.boolean().optional().describe('Only plan: what would be removed and what else changes; nothing is asked.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      summary: ({ items, dry_run }) =>
        dry_run
          ? `checked what would be removed (${count(items.length, 'thing', 'things')})`
          : `asked to remove ${count(items.length, 'thing', 'things')}`
    },
    async ({ items: inputs, note, dry_run }) => {
      const epoch = ctx.approvals.epoch()
      requireLibrary()
      const plan = await planAll(inputs, ctx)
      const refused = plan.refused.map((x) => ({ item: x.item, ...(x.label ? { label: x.label } : {}), reason: x.reason }))
      const folded = plan.folded.map((x) => ({ item: x.item, label: x.label, folded_into: x.into }))
      const summary = summaryOf(plan.items)
      if (dry_run) {
        return {
          data: {
            dry_run: true,
            ...(plan.items.length ? { summary } : {}),
            items: plan.items.map((p) => itemInfo(p.item)),
            refused,
            ...(folded.length ? { folded } : {}),
            ...(refused.length
              ? { note: 'A real request with these items would fail as a whole: leave the refused ones out (or fix what stands in their way).' }
              : {})
          },
          summary: `checked what would be removed (${count(plan.items.length, 'thing', 'things')})`
        }
      }
      if (refused.length) {
        const lines = plan.refused.map((x) => `- ${x.label ?? JSON.stringify(x.item)}: ${x.reason}`)
        throw new Error(
          `Nothing was sent to the user: ${count(refused.length, 'thing', 'things')} can't be removed.\n${lines.join('\n')}`
        )
      }
      if (!plan.items.length) throw new Error('There is nothing to remove.')
      if (!ctx.connected()) throw new Error('The agent connection is closed, so the request wasn\'t sent to the user.')

      const items = plan.items
      const then = await snapshots(items, new Reader())
      const confirm = confirmOf(items)
      const deleteRequest: ApprovalDeleteRequest = {
        summary,
        items: items.map((p) => p.item),
        ...(confirm ? { confirm } : {})
      }
      const approvalPlan: ApprovalPlan = {
        kind: 'delete',
        client: ctx.clientName(),
        note,
        delete: deleteRequest,
        fingerprint: fingerprintOf(items, then),
        epoch,
        // All or nothing: the user approves exactly what the dialog shows, so anything changed lapses the request.
        verify: async () => {
          const r = new Reader()
          for (const [i, p] of items.entries()) {
            if ((await p.snapshot(r)) !== then[i]) throw new ApprovalLapsed(changed(p.item.label))
            const reason = await p.refusal(r)
            if (reason) throw new Error(`${p.item.label}: ${reason}`)
          }
        },
        execute: () => executeAll(items)
      }
      const { request, reused } = ctx.approvals.create(approvalPlan)
      return {
        data: {
          approval_id: request.id,
          status: request.status,
          summary: request.delete?.summary ?? summary,
          items: (request.delete?.items ?? deleteRequest.items).map(itemInfo),
          ...(folded.length ? { folded } : {}),
          expires: localTime(request.expiresAt),
          ...(reused ? { reused: true } : {}),
          message: reused
            ? 'An identical request is already waiting for the user; this is that one.'
            : 'Waiting for the user to approve it in Studio. Tell them briefly what you asked to remove and why, then poll get_approval every 15–30 seconds.'
        },
        approvalId: request.id,
        summary: `asked to remove ${count(items.length, 'thing', 'things')} – waiting for your OK`
      }
    }
  )
}
